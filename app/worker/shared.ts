/**
 * Server-side pieces shared by the Cloudflare worker and the Vercel functions.
 *
 *   subgraphProxy   POST /api/subgraph  cached proxy to the open-book Studio endpoint
 *   gatewayProxy    POST /api/query     The Graph Gateway with the server-held key
 *   attest          POST /api/attest    the SlaHook attester, a server-held key that
 *                                       verifies the job and the submitted deliverable
 *                                       onchain before it posts the freshness proof
 *
 * Nothing here trusts the browser for money: the attester checks that the job
 * exists on the OpenBook escrow, is in the Submitted state, carries our hook,
 * that its SLA floor equals the one claimed, and that the deliverable hash the
 * browser sends is the one the provider actually submitted onchain. The
 * freshness block itself remains the operator's claim (the disclosed trust
 * boundary), but the key that can make it binding never leaves the server.
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const STUDIO_UPSTREAM = "https://api.studio.thegraph.com/query/1760032/open-book/v0.0.6";
export const GATEWAY_BASE = "https://gateway.thegraph.com/api";
export const ESCROW = "0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5" as const;
export const HOOK = "0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846" as const;
export const ARC_RPC = "https://rpc.testnet.arc.io";

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

export interface AttestRequest {
  jobId: string;
  deliverable: Hex;
  metaBlock: number;
  minBlock: number;
}

export type AttestResult = { ok: true; txHash: Hex } | { ok: false; status: number; error: string };

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function parseAttestRequest(raw: unknown): AttestRequest | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const r = raw as Record<string, unknown>;
  if (typeof r.jobId !== "string" || !/^\d{1,12}$/.test(r.jobId)) return "jobId must be a decimal string";
  if (typeof r.deliverable !== "string" || !HASH_RE.test(r.deliverable)) return "deliverable must be a 32-byte hex hash";
  if (typeof r.metaBlock !== "number" || !Number.isInteger(r.metaBlock) || r.metaBlock < 0) return "metaBlock must be a non-negative integer";
  if (typeof r.minBlock !== "number" || !Number.isInteger(r.minBlock) || r.minBlock < 0) return "minBlock must be a non-negative integer";
  return { jobId: r.jobId, deliverable: r.deliverable as Hex, metaBlock: r.metaBlock, minBlock: r.minBlock };
}

/** Verify the job onchain, then post the attestation from the server-held key. */
export async function attest(req: AttestRequest, attesterPk: string): Promise<AttestResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(attesterPk)) return { ok: false, status: 500, error: "attester key is not configured" };
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

export interface GatewayRequest {
  subgraphId: string;
  body: string;
}

export function parseGatewayRequest(raw: unknown): GatewayRequest | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const r = raw as Record<string, unknown>;
  if (typeof r.subgraphId !== "string" || !/^[A-Za-z0-9]{20,64}$/.test(r.subgraphId)) return "subgraphId must be a subgraph id";
  if (typeof r.body !== "string" || r.body.length > 20_000) return "body must be the JSON request string (max 20 kB)";
  return { subgraphId: r.subgraphId, body: r.body };
}

/** Forward a Gateway query with the server-held key; the response passes through. */
export async function gatewayProxy(req: GatewayRequest, key: string): Promise<{ status: number; text: string }> {
  if (!key) return { status: 500, text: JSON.stringify({ error: "gateway key is not configured" }) };
  const upstream = await fetch(`${GATEWAY_BASE}/${key}/subgraphs/id/${req.subgraphId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: req.body,
  });
  return { status: upstream.status, text: await upstream.text() };
}
