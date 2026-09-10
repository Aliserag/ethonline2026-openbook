/**
 * stale-proxy behavior tests (Task 7).
 *
 * Pure, keyless: the proxy's I/O rides the `fetchImpl` and `storage` seams
 * (never mocked inside production code), so these tests bind no sockets and
 * need no keys. They pin the money-shot contract: the FIRST proxied response
 * records the live `_meta` snapshot, every later one REPLAYS it — and
 * `--stale-block` forces a deterministic old block regardless of recording.
 *
 * The proxy patches `_meta.block` ONLY. The Gateway's `_Meta_` type has no
 * `chainHeadBlock` field (live probe 2026-09-09, funded-run bug #1) — the
 * freshness gate's chain head is read live from the dataset chain's RPC
 * downstream (`mcp/src/chainhead.ts`). A proxy that synthesized a head would
 * be writing a field no consumer reads; a proxy that required it (the old
 * behavior) patched nothing at all.
 */
import { describe, expect, it } from "bun:test";
import {
  handleProxyRequest,
  patchMeta,
  extractMetaView,
  stripMeta,
  DEFAULT_UPSTREAM,
  type StaleSnapshot,
  type SnapshotStorage,
} from "./stale-proxy";

/** Fake gateway `data` view: markets + _meta in the REAL Gateway shape (no chainHeadBlock). */
function gatewayData(block = 1000, hash = "0xabc123"): unknown {
  return {
    markets: [{ id: "0x1" }],
    _meta: { block: { number: block, hash }, hasIndexingErrors: false },
  };
}

/** Fake gateway payload: { data: gatewayData(...) }. */
function gatewayPayload(block = 1000, hash = "0xabc123"): unknown {
  return { data: gatewayData(block, hash) };
}

function memoryStorage(): { storage: SnapshotStorage; writeCount: () => number } {
  let current: StaleSnapshot | null = null;
  let writes = 0;
  return {
    storage: {
      read: () => current,
      write(snapshot: StaleSnapshot): void {
        current = snapshot;
        writes++;
      },
    },
    writeCount: () => writes,
  };
}

/** In-memory fetch seam that records the upstream URL + body and answers with a payload. */
function mockUpstream(
  respond: (url: string, body: string) => unknown,
): { fetchImpl: typeof fetch; urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    urls.push(url);
    const body = typeof init?.body === "string" ? init.body : "";
    bodies.push(body);
    const payload = respond(url, body);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl: fetchImpl as typeof fetch, urls, bodies };
}

const CLIENT_GRAPHQL = JSON.stringify({ query: "{ markets { id } }" });
const GATEWAY_PATH = "/api/test-key/subgraphs/id/4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf";

describe("handleProxyRequest — record then replay", () => {
  it("forwards the POST verbatim to <upstream><path> (the Gateway path shape)", async () => {
    const { fetchImpl, urls, bodies } = mockUpstream(() => gatewayPayload());
    const { storage } = memoryStorage();
    await handleProxyRequest({ fetchImpl, storage }, GATEWAY_PATH, CLIENT_GRAPHQL);
    expect(urls).toEqual([`${DEFAULT_UPSTREAM}${GATEWAY_PATH}`]);
    expect(bodies).toEqual([CLIENT_GRAPHQL]);
  });

  it("records the live _meta snapshot on the first request and serves the current block", async () => {
    const { fetchImpl } = mockUpstream(() => gatewayPayload());
    const { storage, writeCount } = memoryStorage();
    const result = await handleProxyRequest({ fetchImpl, storage }, GATEWAY_PATH, CLIENT_GRAPHQL);
    expect(result.status).toBe(200);
    expect(result.state.recorded).toBe(true);
    expect(result.state.patched).toBe(true);
    expect(writeCount()).toBe(1);
    expect(result.state.snapshot).toMatchObject({ block: 1000, hash: "0xabc123" });
    const body = result.body as { data: { _meta: { block: { number: number } } } };
    expect(body.data._meta.block.number).toBe(1000);
  });

  it("replays the cached old _meta on the second request (fresh -> stale, deterministic)", async () => {
    // pre-seed a snapshot recorded "earlier" (block 90, long before the current head)
    const seeded: StaleSnapshot = {
      block: 90,
      hash: "0xoldblock",
      recordedAt: "2026-09-08T00:00:00.000Z",
    };
    const storage: SnapshotStorage = { read: () => seeded, write: () => {} };
    const { fetchImpl } = mockUpstream(() => gatewayPayload(1000));
    const result = await handleProxyRequest({ fetchImpl, storage }, GATEWAY_PATH, CLIENT_GRAPHQL);
    expect(result.state.recorded).toBe(false);
    const body = result.body as {
      data: { _meta: { block: { number: number; hash: string }; chainHeadBlock?: unknown } };
    };
    expect(body.data._meta.block.number).toBe(90); // the old recorded block, not 1000
    expect(body.data._meta.block.hash).toBe("0xoldblock");
    // The proxy never synthesizes a chain head — downstream reads it live from
    // the dataset chain's RPC, and head - 90 >> maxAge trips the stale gate.
    expect(body.data._meta.chainHeadBlock).toBeUndefined();
    expect(body.data.markets).toEqual([{ id: "0x1" }]); // data + meta both arrive
  });

  it("--stale-block forces the block number regardless of any recording (fully deterministic)", async () => {
    const { fetchImpl } = mockUpstream(() => gatewayPayload(1000));
    const { storage } = memoryStorage();
    const result = await handleProxyRequest(
      { fetchImpl, storage, staleBlock: 0 },
      GATEWAY_PATH,
      CLIENT_GRAPHQL,
    );
    const body = result.body as { data: { _meta: { block: { number: number }; chainHeadBlock?: unknown } } };
    expect(body.data._meta.block.number).toBe(0);
    expect(body.data._meta.chainHeadBlock).toBeUndefined();
    expect(result.state.snapshot).toBeNull(); // forced mode never depends on the cache
  });

  it("patches even when the upstream _meta carries no head field (the real Gateway shape)", async () => {
    // Regression pin for the funded-run defect: keying the patch on a
    // chainHeadBlock that never arrives left every response unpatched, so the
    // money shot delivered FRESH data and settled instead of refunding.
    const { fetchImpl } = mockUpstream(() => gatewayPayload(1000));
    const { storage } = memoryStorage();
    const result = await handleProxyRequest(
      { fetchImpl, storage, staleBlock: 0 },
      GATEWAY_PATH,
      CLIENT_GRAPHQL,
    );
    expect(result.state.patched).toBe(true);
    const body = result.body as { data: { _meta: { block: { number: number } } } };
    expect(body.data._meta.block.number).toBe(0);
  });

  it("passes through responses whose data carries no _meta (nothing to replay)", async () => {
    const { fetchImpl } = mockUpstream(() => ({ data: { markets: [{ id: "0x1" }] } }));
    const { storage } = memoryStorage();
    const result = await handleProxyRequest({ fetchImpl, storage }, GATEWAY_PATH, CLIENT_GRAPHQL);
    expect(result.state.patched).toBe(false);
    const body = result.body as { data: { markets: unknown[]; _meta?: unknown } };
    expect(body.data.markets).toEqual([{ id: "0x1" }]);
    expect(body.data._meta).toBeUndefined();
  });

  it("surfaces upstream failures as 502s with the failure reason", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("connection refused");
    };
    const { storage } = memoryStorage();
    const result = await handleProxyRequest({ fetchImpl, storage }, GATEWAY_PATH, CLIENT_GRAPHQL);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: expect.stringContaining("connection refused") });
  });

  it("rejects upstream HTTP errors verbatim (gateway errors are never masked)", async () => {
    const { fetchImpl } = mockUpstream(() => ({ errors: [{ message: "query parse error" }] }));
    const { storage } = memoryStorage();
    const result = await handleProxyRequest({ fetchImpl, storage }, GATEWAY_PATH, CLIENT_GRAPHQL);
    expect(result.status).toBe(200);
    const body = result.body as { errors: { message: string }[] };
    expect(body.errors[0].message).toBe("query parse error");
  });
});

describe("extractMetaView / stripMeta / patchMeta", () => {
  it("extracts block and hash from gateway data", () => {
    expect(extractMetaView(gatewayData(1000, "0xbeef"))).toEqual({
      block: 1000,
      hash: "0xbeef",
    });
    expect(extractMetaView({ markets: [] })).toEqual({ block: null, hash: null });
    expect(extractMetaView(null)).toEqual({ block: null, hash: null });
  });

  it("stripMeta removes only _meta (the deliverable payload is hash-of-stripMeta)", () => {
    const data = gatewayData(1000, "0xbeef");
    const stripped = stripMeta(data);
    expect(stripped).toEqual({ markets: [{ id: "0x1" }] });
    const second = stripMeta(gatewayData(1000, "0xbeef"));
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(second)); // deterministic
  });

  it("patchMeta never mutates its input", () => {
    const data = gatewayData(1000, "0xbeef");
    const patched = patchMeta(data, 90, "0xold");
    // original untouched
    expect(extractMetaView(data)).toEqual({ block: 1000, hash: "0xbeef" });
    expect(extractMetaView(patched)).toEqual({ block: 90, hash: "0xold" });
  });
});
