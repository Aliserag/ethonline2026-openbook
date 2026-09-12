/**
 * The page's server-side helpers (app/worker/*): on a deployed origin the
 * browser never holds the Gateway key or the hook attester key. It POSTs to
 *   /api/query    a Gateway query with the server-held key
 *   /api/attest   the SlaHook attestation, verified onchain by the server
 * Local dev without VITE_API_BASE falls back to the browser-side key path for
 * queries and cannot attest (the attester key lives only on the server).
 */
import { appendMeta, extractMeta, GatewayHttpError, GraphQueryError, type GatewayMeta } from "../../../mcp/src/gateway";
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

/** Gateway query with the freshness fragment appended, like mcp's gatewayQuery. */
export async function appGatewayQuery(opts: { subgraphId: string; query: string }): Promise<{ data: unknown; meta: GatewayMeta }> {
  const base = apiBase();
  const payload = JSON.stringify({ query: appendMeta(opts.query) });
  const url = base !== null
    ? `${base}/api/query`
    : `https://gateway.thegraph.com/api/${env.graphKey}/subgraphs/id/${opts.subgraphId}`;
  const body = base !== null ? { subgraphId: opts.subgraphId, body: payload } : JSON.parse(payload);
  const { status, json, text } = await postJson(url, body);
  if (status >= 400) throw new GatewayHttpError(status, text.slice(0, 200));
  const root = (typeof json === "object" && json !== null ? json : {}) as { data?: unknown; errors?: { message?: string }[] };
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    throw new GraphQueryError(root.errors.map((e) => e.message ?? "error").join("; "), root.errors);
  }
  return { data: root.data, meta: extractMeta(root.data) };
}

/** Ask the server to attest a delivery; returns the attest tx hash. */
export async function attestViaApi(input: { jobId: string; deliverable: `0x${string}`; metaBlock: number; minBlock: number }): Promise<`0x${string}`> {
  const base = apiBase();
  if (base === null) throw new Error("attestation runs on the server; set VITE_API_BASE to a deployed origin for local runs");
  const { status, json, text } = await postJson(`${base}/api/attest`, input);
  const root = (typeof json === "object" && json !== null ? json : {}) as { txHash?: string; error?: string };
  if (status >= 400 || typeof root.txHash !== "string") {
    throw new Error(root.error ?? `attest failed (${status}): ${text.slice(0, 160)}`);
  }
  return root.txHash as `0x${string}`;
}
