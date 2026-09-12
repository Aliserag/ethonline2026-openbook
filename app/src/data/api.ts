/**
 * The page's server-side helpers (app/worker/*): on a deployed origin the
 * browser never holds the Gateway key, the hook attester key or the LLM key.
 *   /api/deliver   the server runs the dataset query, hashes the payload,
 *                  records the indexed block and signs that observation
 *   /api/attest    the server verifies the job onchain and requires the deliver
 *                  signature before it posts the freshness proof
 *   /api/ask       the console's LLM, key held server-side
 * Local dev without VITE_API_BASE falls back to a browser-side Gateway key for
 * queries (no signature, so attest will refuse) and has no ask mode.
 */
import { keccak256, toBytes } from "viem";
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
  const text = await response.text();
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
  /** the server's signature over `${payloadHash}|${metaBlock}` (empty on the local key path) */
  proof: string;
}

/** Deliver a dataset query: server-observed on deployed origins, key-local in dev. */
export async function deliverViaApi(opts: { subgraphId: string; query: string }): Promise<Delivery> {
  const base = apiBase();
  if (base !== null) {
    const { status, json, text } = await postJson(`${base}/api/deliver`, opts);
    const root = (typeof json === "object" && json !== null ? json : {}) as Partial<Delivery> & { error?: string };
    if (status >= 400 || typeof root.payloadHash !== "string" || typeof root.metaBlock !== "number") {
      if (status === 429) throw new GatewayHttpError(429, root.error ?? text.slice(0, 160));
      throw new Error(root.error ?? `deliver failed (${status}): ${text.slice(0, 160)}`);
    }
    return { data: root.data, payloadHash: root.payloadHash as `0x${string}`, metaBlock: root.metaBlock, proof: root.proof ?? "" };
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
  return { data: payload, payloadHash: keccak256(toBytes(JSON.stringify(payload))), metaBlock: meta.block, proof: "" };
}

/** Ask the server to attest a delivery; returns the attest tx hash. */
export async function attestViaApi(input: {
  jobId: string;
  deliverable: `0x${string}`;
  metaBlock: number;
  minBlock: number;
  proof: string;
}): Promise<`0x${string}`> {
  const base = apiBase();
  if (base === null) throw new Error("attestation runs on the server; set VITE_API_BASE to a deployed origin for local runs");
  const { status, json, text } = await postJson(`${base}/api/attest`, input);
  const root = (typeof json === "object" && json !== null ? json : {}) as { txHash?: string; error?: string };
  if (status >= 400 || typeof root.txHash !== "string") {
    throw new Error(root.error ?? `attest failed (${status}): ${text.slice(0, 160)}`);
  }
  return root.txHash as `0x${string}`;
}

/** Where the console's ask mode sends chat requests: the server route on deployed origins. */
export function askConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const base = apiBase();
  if (base !== null) return { baseUrl: `${base}/api/ask`, apiKey: "server", model: "server" };
  if (env.llmApiKey.length > 0) return { baseUrl: env.llmBaseUrl, apiKey: env.llmApiKey, model: env.llmModel };
  return null;
}
