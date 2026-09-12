/**
 * The page's server-side helpers (app/worker/*): on a deployed origin the
 * browser never holds the Gateway key, the hook attester key or the LLM key.
 *   /api/deliver   the attester runs the dataset query, hashes the payload,
 *                  records the indexed block and signs that observation
 *                  (EIP-191; the page recovers the signer and checks it
 *                  against the hook's attester onchain)
 *   /api/attest    the attester verifies the job onchain, requires its own
 *                  deliver signature, posts the freshness proof and, as the
 *                  job's evaluator, completes or refunds in the same request
 *   /api/ask       the console's LLM, key held server-side
 * Local dev without VITE_API_BASE falls back to a browser-side Gateway key for
 * queries (no signature, so attest will refuse) and has no ask mode.
 */
import { keccak256, recoverMessageAddress, toBytes } from "viem";
import { appendMeta, extractMeta, GatewayHttpError, GraphQueryError, stripMeta, type GatewayMeta } from "../../../mcp/src/gateway";
import { env, hasGraphKey } from "../env";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Base URL for /api/*, or null when running locally without an override. */
export function apiBase(
  loc: { hostname: string; origin: string } | undefined = typeof location !== "undefined" ? location : undefined,
  override: string | undefined = (import.meta.env?.VITE_API_BASE as string | undefined) || undefined,
): string | null {
  if (override) return override.replace(/\/$/, "");
  if (loc === undefined || LOCAL_HOSTS.has(loc.hostname)) return null;
  return loc.origin;
}

/** True when a delivery query can run: through the server, or with a local key. */
export function hasGatewayAccess(): boolean {
  return apiBase() !== null || hasGraphKey;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let text = await response.text();
  // an edge error page is HTML; never show markup as an error message
  if (/^\s*<!DOCTYPE|^\s*<html/i.test(text)) text = `the edge answered with an error page (HTTP ${response.status}); try again in a moment`;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

export interface Delivery {
  data: unknown;
  payloadHash: `0x${string}`;
  metaBlock: number;
  /** the attester's EIP-191 signature over `${payloadHash}|${metaBlock}` (empty on the local key path) */
  proof: string;
  /** who signed, as the server reports it; verify with recoverProofSigner */
  attester: `0x${string}` | null;
}

/** Recover who signed a delivery observation; null when the proof is not a signature. */
export async function recoverProofSigner(payloadHash: string, metaBlock: number, proof: string): Promise<`0x${string}` | null> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(proof)) return null;
  try {
    return await recoverMessageAddress({ message: `${payloadHash.toLowerCase()}|${metaBlock}`, signature: proof as `0x${string}` });
  } catch {
    return null;
  }
}

export interface Settlement {
  verdict: "APPROVE" | "REJECT";
  refusal?: string;
  reason?: string;
  txHash: `0x${string}`;
}

/** Deliver a dataset query: server-observed on deployed origins, key-local in dev. */
export async function deliverViaApi(opts: { subgraphId: string; query: string }): Promise<Delivery> {
  const base = apiBase();
  if (base !== null) {
    let { status, json, text } = await postJson(`${base}/api/deliver`, opts);
    if (status >= 500) ({ status, json, text } = await postJson(`${base}/api/deliver`, opts)); // one retry: the edge occasionally answers 502
    const root = (typeof json === "object" && json !== null ? json : {}) as Partial<Delivery> & { error?: string };
    if (status >= 400 || typeof root.payloadHash !== "string" || typeof root.metaBlock !== "number") {
      if (status === 429) throw new GatewayHttpError(429, root.error ?? text.slice(0, 160));
      throw new Error(root.error ?? `deliver failed (${status}): ${text.slice(0, 160)}`);
    }
    const attester = typeof root.attester === "string" && /^0x[0-9a-fA-F]{40}$/.test(root.attester) ? (root.attester as `0x${string}`) : null;
    return { data: root.data, payloadHash: root.payloadHash as `0x${string}`, metaBlock: root.metaBlock, proof: root.proof ?? "", attester };
  }
  const { status, json, text } = await postJson(
    `https://gateway.thegraph.com/api/${env.graphKey}/subgraphs/id/${opts.subgraphId}`,
    { query: appendMeta(opts.query) },
  );
  if (status >= 400) throw new GatewayHttpError(status, text.slice(0, 200));
  const root = (typeof json === "object" && json !== null ? json : {}) as { data?: unknown; errors?: { message?: string }[] };
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    throw new GraphQueryError(root.errors.map((e) => e.message ?? "error").join("; "), root.errors);
  }
  const meta: GatewayMeta = extractMeta(root.data);
  if (meta.block === null) throw new Error("the gateway answered without a freshness block, so nothing can be attested");
  const payload = stripMeta(root.data);
  return { data: payload, payloadHash: keccak256(toBytes(JSON.stringify(payload))), metaBlock: meta.block, proof: "", attester: null };
}

/**
 * Ask the attester to post the freshness proof. When the attester is the job's
 * evaluator (every page purchase), the same call settles: `settle` carries the
 * complete() or reject() tx the contract allowed.
 */
export async function attestViaApi(input: {
  jobId: string;
  deliverable: `0x${string}`;
  metaBlock: number;
  minBlock: number;
  proof: string;
}): Promise<{ txHash: `0x${string}`; settle?: Settlement }> {
  const base = apiBase();
  if (base === null) throw new Error("attestation runs on the server; set VITE_API_BASE to a deployed origin for local runs");
  const { status, json, text } = await postJson(`${base}/api/attest`, input);
  const root = (typeof json === "object" && json !== null ? json : {}) as { txHash?: string; settle?: Settlement; error?: string };
  if (status >= 400 || typeof root.txHash !== "string") {
    throw new Error(root.error ?? `attest failed (${status}): ${text.slice(0, 160)}`);
  }
  const settle = root.settle && (root.settle.verdict === "APPROVE" || root.settle.verdict === "REJECT") && typeof root.settle.txHash === "string" ? root.settle : undefined;
  return { txHash: root.txHash as `0x${string}`, settle };
}

// ---- Circle developer-controlled wallets (buyer + seller, server-signed) ----------------

export interface CircleStatus {
  enabled: boolean;
  buyer: `0x${string}` | null;
  seller: `0x${string}` | null;
  gas: string;
}

let circleStatusCache: Promise<CircleStatus> | null = null;

/** Whether this deployment buys and sells through Circle wallets (the browser signs nothing). */
export function circleStatus(): Promise<CircleStatus> {
  if (circleStatusCache) return circleStatusCache;
  const base = apiBase();
  circleStatusCache = (async () => {
    if (base === null) return { enabled: false, buyer: null, seller: null, gas: "" };
    try {
      const { status, json } = await postJson(`${base}/api/circle/status`, {});
      const root = (typeof json === "object" && json !== null ? json : {}) as Partial<CircleStatus>;
      if (status !== 200 || root.enabled !== true || typeof root.buyer !== "string" || typeof root.seller !== "string") {
        return { enabled: false, buyer: null, seller: null, gas: "" };
      }
      return { enabled: true, buyer: root.buyer, seller: root.seller, gas: root.gas ?? "" };
    } catch {
      return { enabled: false, buyer: null, seller: null, gas: "" };
    }
  })();
  return circleStatusCache;
}

export interface CircleJob {
  jobId: string;
  buyer: `0x${string}`;
  seller: `0x${string}`;
  evaluator: `0x${string}`;
  txs: { createJob: `0x${string}`; setBudget: `0x${string}`; approve?: `0x${string}`; fund: `0x${string}` };
}

/** The Circle buyer wallet opens and funds a job for the Circle seller wallet (four sponsored txs). */
export async function circleCreateJob(input: { datasetId: string; minBlock: number; schemaHash: `0x${string}`; maxLatencyMs: number; amount: string }): Promise<CircleJob> {
  const base = apiBase();
  if (base === null) throw new Error("Circle wallets run on the server; local runs use the demo key");
  const { status, json, text } = await postJson(`${base}/api/circle/job`, input);
  const root = (typeof json === "object" && json !== null ? json : {}) as Partial<CircleJob> & { error?: string };
  if (status >= 400 || typeof root.jobId !== "string" || !root.txs) throw new Error(root.error ?? `circle job failed (${status}): ${text.slice(0, 160)}`);
  return root as CircleJob;
}

/** The Circle seller wallet submits the deliverable the attester signed. */
export async function circleSubmit(input: { jobId: string; deliverable: `0x${string}`; metaBlock: number; proof: string }): Promise<`0x${string}`> {
  const base = apiBase();
  if (base === null) throw new Error("Circle wallets run on the server; local runs use the demo key");
  const { status, json, text } = await postJson(`${base}/api/circle/submit`, input);
  const root = (typeof json === "object" && json !== null ? json : {}) as { txHash?: string; error?: string };
  if (status >= 400 || typeof root.txHash !== "string") throw new Error(root.error ?? `circle submit failed (${status}): ${text.slice(0, 160)}`);
  return root.txHash as `0x${string}`;
}

/** Where the console's ask mode sends chat requests: the server route on deployed origins. */
export function askConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const base = apiBase();
  if (base !== null) return { baseUrl: `${base}/api/ask`, apiKey: "server", model: "server" };
  if (env.llmApiKey.length > 0) return { baseUrl: env.llmBaseUrl, apiKey: env.llmApiKey, model: env.llmModel };
  return null;
}
