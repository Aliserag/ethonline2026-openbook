/**
 * Server-side pieces shared by the Cloudflare worker and the Vercel functions.
 *
 *   subgraph  POST /api/subgraph   cached proxy to the open-book Studio endpoint
 *   deliver   POST /api/deliver    runs a dataset query on The Graph Gateway with the
 *                                  server-held key, computes the deliverable hash and
 *                                  the indexed block itself, and signs that observation
 *   attest    POST /api/attest     the SlaHook attester, a server-held key that verifies
 *                                  the job and the submitted deliverable onchain and
 *                                  requires the deliver signature before it posts
 *   ask       POST /api/ask/...    the console's LLM, key held server-side
 *
 * Nothing here trusts the browser for money: the freshness block the hook binds
 * is the server's own observation of the Gateway response (bound to the payload
 * hash by an HMAC under the attester key), the job must exist on the OpenBook
 * escrow in the Submitted state with our hook, and the deliverable the browser
 * names must be the one the provider actually submitted onchain.
 */
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import openbook from "../../mcp/config/openbook.json";
import demo2 from "../../mcp/config/demo2.json";
import { appendMeta, extractMeta, stripMeta } from "../../mcp/src/gateway";

export const STUDIO_UPSTREAM = "https://api.studio.thegraph.com/query/1760032/open-book/v0.0.8";
export const GATEWAY_BASE = "https://gateway.thegraph.com/api";
export const ESCROW = "0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5" as const;
export const HOOK = "0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846" as const;
export const ARC_RPC = "https://rpc.testnet.arc.io";
export const LLM_BASE_DEFAULT = "https://api.fireworks.ai/inference/v1";
export const LLM_MODEL_DEFAULT = "accounts/fireworks/models/deepseek-v4-flash-0731";

/** The subgraphs this deployment sells: the only ones the Gateway key will query. */
const SOLD_SUBGRAPHS = new Set<string>(
  [...(openbook as { datasets: { subgraphId: string }[] }).datasets, ...(demo2 as { datasets: { subgraphId: string }[] }).datasets].map((d) => d.subgraphId),
);

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
});

const ESCROW_ABI = parseAbi([
  "function jobs(uint256 jobId) view returns (uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook)",
]);
const HOOK_ABI = parseAbi([
  "function submitted(uint256 jobId) view returns (bytes32)",
  "function attester() view returns (address)",
  "function attest(uint256 jobId, bytes32 deliverable, uint256 metaBlock, uint256 minBlock)",
]);

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// ---- the deliver signature (HMAC-SHA256 under the attester key) -------------

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function proofMessage(deliverable: string, metaBlock: number): string {
  return `${deliverable.toLowerCase()}|${metaBlock}`;
}

// ---- deliver ------------------------------------------------------------------

export interface DeliverRequest {
  subgraphId: string;
  query: string;
}

export function parseDeliverRequest(raw: unknown): DeliverRequest | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const r = raw as Record<string, unknown>;
  if (typeof r.subgraphId !== "string" || !SOLD_SUBGRAPHS.has(r.subgraphId)) return "subgraphId is not one of the datasets this deployment sells";
  if (typeof r.query !== "string" || r.query.length === 0 || r.query.length > 4000) return "query must be a GraphQL string (max 4 kB)";
  return { subgraphId: r.subgraphId, query: r.query };
}

export type DeliverResult =
  | { ok: true; data: unknown; payloadHash: Hex; metaBlock: number; hasIndexingErrors: boolean; proof: string }
  | { ok: false; status: number; error: string };

/** Run the query with the server-held key, hash the payload, sign the observation. */
export async function deliver(req: DeliverRequest, gatewayKey: string, attesterPk: string): Promise<DeliverResult> {
  if (!gatewayKey) return { ok: false, status: 500, error: "gateway key is not configured" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(attesterPk)) return { ok: false, status: 500, error: "attester key is not configured" };
  const upstream = await fetch(`${GATEWAY_BASE}/${gatewayKey}/subgraphs/id/${req.subgraphId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: appendMeta(req.query) }),
  });
  const text = await upstream.text();
  if (!upstream.ok) return { ok: false, status: upstream.status === 429 ? 429 : 502, error: `gateway ${upstream.status}: ${text.slice(0, 160)}` };
  let root: { data?: unknown; errors?: { message?: string }[] };
  try {
    root = JSON.parse(text) as typeof root;
  } catch {
    return { ok: false, status: 502, error: "gateway returned non-JSON" };
  }
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    return { ok: false, status: 502, error: `gateway error: ${root.errors.map((e) => e.message ?? "error").join("; ").slice(0, 200)}` };
  }
  const meta = extractMeta(root.data);
  if (meta.block === null) return { ok: false, status: 502, error: "the gateway answered without a freshness block, so nothing can be attested" };
  const payload = stripMeta(root.data);
  const payloadHash = keccak256(toBytes(JSON.stringify(payload)));
  const proof = await hmacHex(attesterPk, proofMessage(payloadHash, meta.block));
  return { ok: true, data: payload, payloadHash, metaBlock: meta.block, hasIndexingErrors: meta.hasIndexingErrors, proof };
}

// ---- attest -------------------------------------------------------------------

export interface AttestRequest {
  jobId: string;
  deliverable: Hex;
  metaBlock: number;
  minBlock: number;
  /** the deliver signature over `${deliverable}|${metaBlock}` */
  proof: string;
}

export type AttestResult = { ok: true; txHash: Hex } | { ok: false; status: number; error: string };

export function parseAttestRequest(raw: unknown): AttestRequest | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const r = raw as Record<string, unknown>;
  if (typeof r.jobId !== "string" || !/^\d{1,12}$/.test(r.jobId)) return "jobId must be a decimal string";
  if (typeof r.deliverable !== "string" || !HASH_RE.test(r.deliverable)) return "deliverable must be a 32-byte hex hash";
  if (typeof r.metaBlock !== "number" || !Number.isInteger(r.metaBlock) || r.metaBlock < 0) return "metaBlock must be a non-negative integer";
  if (typeof r.minBlock !== "number" || !Number.isInteger(r.minBlock) || r.minBlock < 0) return "minBlock must be a non-negative integer";
  if (typeof r.proof !== "string" || !/^[0-9a-f]{64}$/.test(r.proof)) return "proof must be the deliver signature (64 hex)";
  return { jobId: r.jobId, deliverable: r.deliverable as Hex, metaBlock: r.metaBlock, minBlock: r.minBlock, proof: r.proof };
}

/** Verify the deliver signature and the job onchain, then post the attestation. */
export async function attest(req: AttestRequest, attesterPk: string): Promise<AttestResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(attesterPk)) return { ok: false, status: 500, error: "attester key is not configured" };
  const expected = await hmacHex(attesterPk, proofMessage(req.deliverable, req.metaBlock));
  if (expected !== req.proof) {
    return { ok: false, status: 403, error: "the freshness block was not observed by this server for that deliverable (deliver signature mismatch)" };
  }
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });
  const jobId = BigInt(req.jobId);
  const job = await publicClient.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "jobs", args: [jobId] });
  const [, , , , description, , , status, hook] = job;
  if (status !== 2) return { ok: false, status: 409, error: `job ${req.jobId} is not in the Submitted state (status ${status})` };
  if (hook.toLowerCase() !== HOOK.toLowerCase()) return { ok: false, status: 409, error: `job ${req.jobId} does not use the OpenBook hook` };
  let floor: number;
  try {
    const sla = JSON.parse(description) as { minBlock?: unknown };
    floor = typeof sla.minBlock === "number" ? sla.minBlock : Number(sla.minBlock);
  } catch {
    return { ok: false, status: 409, error: "the job's SLA description is not readable" };
  }
  if (!Number.isFinite(floor) || floor !== req.minBlock) {
    return { ok: false, status: 409, error: `the SLA floor onchain is ${floor}, not ${req.minBlock}` };
  }
  const submitted = await publicClient.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "submitted", args: [jobId] });
  if (submitted.toLowerCase() !== req.deliverable.toLowerCase()) {
    return { ok: false, status: 409, error: "the deliverable hash does not match what the provider submitted onchain" };
  }
  const account = privateKeyToAccount(attesterPk as Hex);
  const attesterOnchain = await publicClient.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "attester" });
  if (attesterOnchain.toLowerCase() !== account.address.toLowerCase()) {
    return { ok: false, status: 500, error: "the configured attester key is not the hook's attester" };
  }
  const wallet = createWalletClient({ chain: arcTestnet, transport: http(ARC_RPC), account });
  const gasPrice = await publicClient.getGasPrice();
  const hash = await wallet.writeContract({
    address: HOOK,
    abi: HOOK_ABI,
    functionName: "attest",
    args: [jobId, req.deliverable, BigInt(req.metaBlock), BigInt(req.minBlock)],
    maxFeePerGas: gasPrice < 20_000_000_000n ? 25_000_000_000n : gasPrice + 5_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") return { ok: false, status: 502, error: `attest reverted onchain (tx ${hash})` };
  return { ok: true, txHash: hash };
}

// ---- ask (the console's LLM, key held here) ------------------------------------

export interface LlmEnv {
  key: string;
  baseUrl: string;
  model: string;
}

/** Forward a chat-completions body to the LLM with the server key; the model is pinned server-side. */
export async function ask(bodyText: string, env: LlmEnv): Promise<{ status: number; text: string }> {
  if (!env.key) return { status: 503, text: JSON.stringify({ error: "ask mode is off on this deployment (no LLM key configured)" }) };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return { status: 400, text: JSON.stringify({ error: "body must be a chat-completions JSON object" }) };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 6) {
    return { status: 400, text: JSON.stringify({ error: "messages must be a short array" }) };
  }
  const forwarded = { ...body, model: env.model, max_tokens: Math.min(Number(body.max_tokens ?? 800) || 800, 1200) };
  const upstream = await fetch(`${env.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.key}` },
    body: JSON.stringify(forwarded),
  });
  return { status: upstream.status, text: await upstream.text() };
}
