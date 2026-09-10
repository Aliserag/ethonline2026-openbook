/**
 * The Graph Gateway client for sla-subgraph-mcp (OpenBook Task 5).
 *
 * Every query gets the freshness fragment appended so the server can gate on
 * `_meta.block` vs the chain head BEFORE ever charging. The Gateway's _Meta_
 * type has NO chainHeadBlock field (live probe 2026-09-09 — requesting it
 * errors the whole query); the head reference comes from the dataset's own
 * chain via mcp/src/chainhead.ts (Alchemy eth_blockNumber). HTTP is only
 * ever touched through the injectable `fetchImpl` seam (unit tests inject
 * mocks; production always uses the real global fetch).
 */
import { GATEWAY_BASE } from "./constants";

export const META_FRAGMENT = "_meta { block { number hash timestamp } hasIndexingErrors }";

export interface GatewayMeta {
  block: number | null;
  hash: string | null;
  timestamp: number | null;
  hasIndexingErrors: boolean;
}

export interface GatewayResult {
  data: unknown;
  meta: GatewayMeta;
}

/** Gateway/GraphQL-level failure (HTTP ok, GraphQL errors). Never treated as data. */
export class GraphQueryError extends Error {
  readonly errors: unknown[];
  constructor(message: string, errors: unknown[]) {
    super(message);
    this.name = "GraphQueryError";
    this.errors = errors;
  }
}

/** HTTP-level failure (non-2xx). */
export class GatewayHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`gateway HTTP ${status}: ${detail}`);
    this.name = "GatewayHttpError";
    this.status = status;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Append the freshness fragment to a GraphQL query. Idempotent: when the query
 * already selects `_meta`, it is left untouched (the gateway will return what
 * was asked and the gate reads it from the response).
 */
export function appendMeta(query: string): string {
  if (/\b_meta\s*\{/.test(query)) return query;
  const trimmed = query.trimEnd();
  if (!trimmed.endsWith("}")) {
    // Malformed or fragment-only input: still append so errors surface at the
    // gateway rather than being silently masked.
    return `${trimmed}\n${META_FRAGMENT}`;
  }
  const closing = trimmed.lastIndexOf("}");
  return `${trimmed.slice(0, closing).trimEnd()} ${META_FRAGMENT} }`;
}

/**
 * Copy of the gateway data WITHOUT the `_meta` selection — the deliverable
 * payload whose keccak256 becomes the job's payloadHash. Single source of
 * truth shared by the MCP server, seller/buyer agents and the app: key order
 * is preserved (object iteration order) so identical payloads hash identically.
 */
export function stripMeta(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const copy: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  delete copy["_meta"];
  return copy;
}

/** Extract the freshness view from a gateway payload (nulls when _meta absent). */
export function extractMeta(data: unknown): GatewayMeta {
  if (typeof data !== "object" || data === null) {
    return { block: null, hash: null, timestamp: null, hasIndexingErrors: false };
  }
  const metaRaw = (data as Record<string, unknown>)["_meta"];
  if (typeof metaRaw !== "object" || metaRaw === null) {
    return { block: null, hash: null, timestamp: null, hasIndexingErrors: false };
  }
  const meta = metaRaw as Record<string, unknown>;
  const blockRaw = meta["block"];
  const block = typeof blockRaw === "object" && blockRaw !== null ? (blockRaw as Record<string, unknown>) : null;
  const numberOrNull = (value: unknown): number | null =>
    typeof value === "number" ? value : null;
  return {
    block: numberOrNull(block?.["number"]),
    hash: typeof block?.["hash"] === "string" ? (block?.["hash"] as string) : null,
    timestamp: numberOrNull(block?.["timestamp"]),
    hasIndexingErrors: meta["hasIndexingErrors"] === true,
  };
}

async function postJson(
  url: string,
  query: string,
  fetchImpl: FetchLike,
): Promise<{ data: unknown; payload: unknown }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new GatewayHttpError(response.status, (await response.text()).slice(0, 500));
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GraphQueryError(`gateway returned non-JSON: ${message}`, []);
  }
  if (typeof payload !== "object" || payload === null) {
    throw new GraphQueryError("gateway returned an empty body", []);
  }
  const record = payload as Record<string, unknown>;
  const errors = record["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors
      .map((entry) => {
        const text = typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>)["message"]
          : entry;
        return typeof text === "string" ? text : String(text);
      })
      .join("; ");
    throw new GraphQueryError(messages, errors);
  }
  return { data: record["data"], payload };
}

/**
 * Query a pinned subgraph via the Gateway with the freshness fragment appended.
 * URL: {baseUrl}/api/{key}/subgraphs/id/{subgraphId}
 */
export async function gatewayQuery(opts: {
  key: string;
  subgraphId: string;
  query: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<GatewayResult> {
  const baseUrl = opts.baseUrl ?? GATEWAY_BASE;
  const url = `${baseUrl}/api/${opts.key}/subgraphs/id/${opts.subgraphId}`;
  const { data } = await postJson(url, appendMeta(opts.query), opts.fetchImpl ?? fetch);
  return { data, meta: extractMeta(data) };
}

/**
 * POST an arbitrary GraphQL query to a hosted endpoint (used for the Task 4
 * openbook-pnl Studio query). The query is sent verbatim (it carries its own
 * `_meta` selection).
 */
export async function hostedQuery(opts: {
  url: string;
  query: string;
  fetchImpl?: FetchLike;
}): Promise<GatewayResult> {
  const { data } = await postJson(opts.url, opts.query, opts.fetchImpl ?? fetch);
  return { data, meta: extractMeta(data) };
}
