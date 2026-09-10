/**
 * stale-proxy.ts — OpenBook money-shot tool (Task 7).
 *
 * A tiny fetch proxy that forwards The Graph Gateway queries upstream and
 * REPLAYS a cached old `_meta` block in every response. This is how the
 * rejected-delivery refund (the demo's money shot) fires DETERMINISTICALLY:
 * never rely on live staleness. The snapshot is RECORDED from a live upstream
 * response (first run) or read from a `--cache` file written earlier, then
 * replayed on every subsequent request — exactly the "cached old _meta
 * recorded earlier" shape the demo brief asks for.
 *
 * End to end:
 *   1. Run once against a live Gateway query  -> the proxy records the `_meta`
 *      snapshot to `<cache>` and serves the response unpatched.
 *   2. Later (or immediately with `--stale-block N`), any query through the
 *      proxy returns the OLD recorded block. The MCP freshness gate reads the
 *      chain head LIVE from the dataset chain's RPC (the Gateway `_meta` has
 *      no chainHeadBlock field — the proxy does not synthesize one), so
 *      `head - block > maxAge` AND `metaBlock < SLA minBlock` ->
 *      verify_delivery REJECTs with STALE_DATA -> rejectAndRefund ->
 *      Refunded onchain. The money shot, reproducible on demand.
 *
 * Standalone, zero dependencies (node:http + global fetch), runs with bun:
 *   bun scripts/stale-proxy.ts --port 8787 --upstream https://gateway.thegraph.com
 *
 * Options:
 *   --port <n>          listen port (default 8787)
 *   --upstream <url>    base URL requests are forwarded to (default https://gateway.thegraph.com)
 *   --cache <file>      snapshot file; written on the first proxied response and
 *                       replayed on every later run (default .superpowers/stale-meta.json)
 *   --stale-block <n>   force _meta.block.number to n (fully deterministic; wins
 *                       over the recorded snapshot; 0 = block 0)
 *
 * The proxy exposes:
 *   GET  /health        status + current replay mode
 *   POST /...           any path is forwarded to <upstream><path> with the
 *                       request body and the _meta patch applied to the JSON
 *                       response.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stripMeta } from "../mcp/src/gateway";

/** One recorded (previously-seen) `_meta` snapshot — the "cached old _meta". */
export interface StaleSnapshot {
  block: number;
  hash: string | null;
  recordedAt: string;
}

/** Test seam for the cache file (production persists to disk). */
export interface SnapshotStorage {
  read(): StaleSnapshot | null;
  write(snapshot: StaleSnapshot): void;
}

export interface StaleProxyOptions {
  upstreamBase?: string;
  cacheFile?: string;
  staleBlock?: number;
  fetchImpl?: typeof fetch;
  storage?: SnapshotStorage;
  now?: () => string;
}

/** Mutable state reported after each handled request (drives tests + /health). */
export interface StaleProxyState {
  snapshot: StaleSnapshot | null;
  patched: boolean;
  recorded: boolean;
  upstreamStatus: number;
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  state: StaleProxyState;
}

export const DEFAULT_UPSTREAM = "https://gateway.thegraph.com";
export const DEFAULT_CACHE_FILE = ".superpowers/stale-meta.json";

/** Disk-backed snapshot storage (production). */
function fileStorageRead(cacheFile: string): StaleSnapshot | null {
  try {
    if (!existsSync(cacheFile)) return null;
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const block = record["block"];
    if (typeof block !== "number" || !Number.isInteger(block)) return null;
    return {
      block,
      hash: typeof record["hash"] === "string" ? (record["hash"] as string) : null,
      recordedAt: typeof record["recordedAt"] === "string" ? (record["recordedAt"] as string) : "",
    };
  } catch {
    return null;
  }
}

/** Disk-backed snapshot storage (production). */
export function fileStorage(cacheFile: string): SnapshotStorage {
  return {
    read: () => fileStorageRead(cacheFile),
    write(snapshot: StaleSnapshot): void {
      mkdirSync(dirname(resolve(cacheFile)), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(snapshot, null, 2) + "\n");
    },
  };
}

interface MetaView {
  block: number | null;
  hash: string | null;
}

/** Extract the `_meta` view from a gateway payload (mirrors mcp/src/gateway). */
export function extractMetaView(data: unknown): MetaView {
  if (typeof data !== "object" || data === null) return { block: null, hash: null };
  const meta = (data as Record<string, unknown>)["_meta"];
  if (typeof meta !== "object" || meta === null) return { block: null, hash: null };
  const record = meta as Record<string, unknown>;
  const block = typeof record["block"] === "object" && record["block"] !== null
    ? (record["block"] as Record<string, unknown>)
    : null;
  return {
    block: typeof block?.["number"] === "number" ? (block["number"] as number) : null,
    hash: typeof block?.["hash"] === "string" ? (block["hash"] as string) : null,
  };
}

export { stripMeta };

/** Deterministic replay: patch `_meta` with the stale/recorded block. */
export function patchMeta(data: unknown, block: number, hash: string | null): unknown {
  if (typeof data !== "object" || data === null) return data;
  const copy: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  const metaRaw = copy["_meta"];
  if (typeof metaRaw !== "object" || metaRaw === null) return data; // nothing to patch
  const meta: Record<string, unknown> = { ...(metaRaw as Record<string, unknown>) };
  const blockRaw = meta["block"];
  const blockView =
    typeof blockRaw === "object" && blockRaw !== null ? { ...(blockRaw as Record<string, unknown>) } : {};
  blockView["number"] = block;
  if (hash !== null) blockView["hash"] = hash;
  meta["block"] = blockView;
  copy["_meta"] = meta;
  return copy;
}

/**
 * Handle a single proxied request. Pure-ish: all I/O goes through the
 * `fetchImpl` and `storage` seams so tests never bind a socket.
 *
 * @param pathname the request path, appended verbatim to the upstream base
 *                 (e.g. `/api/<KEY>/subgraphs/id/<SUBGRAPH_ID>`)
 * @param body     the raw request body (GraphQL POST JSON)
 */
export async function handleProxyRequest(
  options: StaleProxyOptions,
  pathname: string,
  body: string,
): Promise<ProxyResult> {
  const upstreamBase = options.upstreamBase ?? DEFAULT_UPSTREAM;
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage = options.storage ?? fileStorage(options.cacheFile ?? DEFAULT_CACHE_FILE);

  let response: Response;
  try {
    response = await fetchImpl(`${upstreamBase}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 502,
      headers: { "content-type": "application/json" },
      body: { error: `stale-proxy: upstream request failed: ${message}` },
      state: { snapshot: storage.read(), patched: false, recorded: false, upstreamStatus: 0 },
    };
  }
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    return {
      status: 502,
      headers,
      body: { error: `stale-proxy: upstream returned non-JSON (HTTP ${response.status})` },
      state: { snapshot: storage.read(), patched: false, recorded: false, upstreamStatus: response.status },
    };
  }

  if (!response.ok) {
    return { status: response.status, headers, body: payload, state: { snapshot: storage.read(), patched: false, recorded: false, upstreamStatus: response.status } };
  }

  if (typeof payload !== "object" || payload === null) {
    return { status: 502, headers, body: payload, state: { snapshot: storage.read(), patched: false, recorded: false, upstreamStatus: response.status } };
  }
  const record = payload as Record<string, unknown>;
  const data = record["data"];
  const meta = extractMetaView(data);
  const stored = storage.read();

  // Decide which block to replay.
  let patchBlock: number | null = null;
  let replayHash: string | null = null;
  let recorded = false;

  if (options.staleBlock !== undefined) {
    // Explicit deterministic override wins over any recording.
    patchBlock = options.staleBlock;
  } else if (meta.block !== null && stored !== null) {
    // We have a snapshot recorded earlier: replay it (the "cached old _meta").
    patchBlock = stored.block;
    replayHash = stored.hash;
  } else if (meta.block !== null) {
    // First record: snapshot the CURRENT live _meta and serve it as-is.
    const snapshot: StaleSnapshot = {
      block: meta.block,
      hash: meta.hash,
      recordedAt: (options.now ?? (() => new Date().toISOString()))(),
    };
    storage.write(snapshot);
    patchBlock = snapshot.block;
    replayHash = snapshot.hash;
    recorded = true;
  }

  // Patch the block alone. The freshness gate's chain head is read live from
  // the dataset chain's RPC downstream — the Gateway `_meta` has no head field
  // (funded-run bug #1), so keying the patch on it skipped every patch.
  const patchedData = patchBlock !== null
    ? patchMeta(data, patchBlock, replayHash)
    : data;

  const patched = patchBlock !== null;
  const snapshot = storage.read();
  return {
    status: 200,
    headers,
    body: { ...record, data: patchedData },
    state: {
      snapshot,
      patched,
      recorded,
      upstreamStatus: response.status,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP server entry
// ---------------------------------------------------------------------------

async function readBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  request.on("error", reject);
  return promise;
}

function parseCli(argv: string[]): { port: number; options: StaleProxyOptions } {
  const args = [...argv];
  const options: StaleProxyOptions = {};
  let port = 8787;
  const takeValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index >= 0 && index + 1 < args.length) return args[index + 1];
    return undefined;
  };
  const portValue = takeValue("--port");
  if (portValue !== undefined) port = Number.parseInt(portValue, 10);
  const upstream = takeValue("--upstream");
  if (upstream !== undefined) options.upstreamBase = upstream;
  const cache = takeValue("--cache");
  if (cache !== undefined) options.cacheFile = cache;
  const staleBlock = takeValue("--stale-block");
  if (staleBlock !== undefined) options.staleBlock = Number.parseInt(staleBlock, 10);
  return { port, options };
}

function isMain(): boolean {
  return typeof import.meta.main === "boolean"
    ? import.meta.main
    : process.argv[1] !== undefined &&
        resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname);
}

export async function main(argv: string[]): Promise<void> {
  const { port, options } = parseCli(argv);
  const cacheFile = options.cacheFile ?? DEFAULT_CACHE_FILE;

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        const stored = (options.storage ?? fileStorage(cacheFile)).read();
        const body = JSON.stringify(
          {
            ok: true,
            service: "openbook-stale-proxy",
            mode: options.staleBlock !== undefined ? "forced" : stored !== null ? "replaying" : "recording",
            staleBlock: options.staleBlock ?? stored?.block ?? null,
            recordedAt: stored?.recordedAt ?? null,
            upstream: options.upstreamBase ?? DEFAULT_UPSTREAM,
          },
          null,
          2,
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "method not allowed — POST GraphQL bodies, GET /health" }));
        return;
      }
      const body = await readBody(request);
      const result = await handleProxyRequest(options, url.pathname, body);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
      if (result.state.recorded) {
        console.log(`[stale-proxy] recorded live _meta snapshot: block ${result.state.snapshot?.block ?? "?"}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `stale-proxy: ${message}` }));
    }
  });

  server.listen(port, () => {
    console.log(`[stale-proxy] listening on http://127.0.0.1:${port}`);
    console.log(
      `[stale-proxy] mode: ${
        options.staleBlock !== undefined
          ? `forced stale block ${options.staleBlock}`
          : `cache ${cacheFile} (records on first query, replays afterwards)`
      }`,
    );
    console.log(`[stale-proxy] forward POST bodies to ${options.upstreamBase ?? DEFAULT_UPSTREAM}<path>`);
  });
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`stale-proxy: ${message}`);
    process.exit(1);
  });
}
