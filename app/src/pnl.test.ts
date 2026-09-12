import { beforeEach, describe, expect, it } from "bun:test";
import {
  fetchPnlResilient,
  loadSnapshotProvidersView,
  parsePnlPayload,
  type PnlResult,
} from "./pnl";
import { CONFIG } from "./config";
import { useCacheStorage, type CacheStorage } from "./data/cache";
import type { FetchLike } from "../../mcp/src/gateway";

const DAILY_ROW = { id: "day-1", startedAt: "1789000000", revenue: "1000000", costs: "0", refunds: "0", net: "1000000" };
const REFUND_EVENT = { id: "0x2d5f5", jobId: "185853", reason: "client-refund" };

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>): FetchLike {
  return async (url: string, init?: RequestInit) => handler(url, init) as unknown as Response;
}

function okJson(data: unknown): { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> } {
  return { ok: true, status: 200, json: async () => data, text: async () => "" };
}

function failJson(status: number): { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> } {
  return { ok: false, status, json: async () => ({}), text: async () => "rate limited" };
}

function memStorage(): CacheStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

const STUDIO = CONFIG.pnl.endpoint;
const SNAPSHOT = "/pnl-snapshot.json";

describe("parsePnlPayload", () => {
  it("maps the Studio payload to rows + refund events", () => {
    const result = parsePnlPayload({ dailyPnLs: [DAILY_ROW], refundIssueds: [REFUND_EVENT] });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: "day-1", startedAt: 1_789_000_000, revenue: "1000000" });
    expect(result.refundEvents[0]).toMatchObject({ jobId: "185853", reason: "client-refund" });
  });

  it("degrades junk shapes without throwing", () => {
    const result = parsePnlPayload(null);
    expect(result.rows).toEqual([]);
    expect(result.refundEvents).toEqual([]);
  });
});

describe("fetchPnlResilient — live → cache → snapshot, labeled", () => {
  beforeEach(() => useCacheStorage(memStorage()));

  it("serves live from the Studio endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl = mockFetch((url) => {
      urls.push(url);
      return okJson({ data: { dailyPnLs: [DAILY_ROW], refundIssueds: [REFUND_EVENT], _meta: { block: { number: 42 } } } });
    });
    const out = await fetchPnlResilient(undefined, fetchImpl);
    expect(out.source).toBe("live");
    expect(out.rows).toHaveLength(1);
    expect(out.metaBlock).toBe(42);
    expect(urls).toEqual([STUDIO]);
  });

  it("serves the last-good cache when the live read fails (labeled)", async () => {
    let liveCalls = 0;
    const cached: PnlResult = { rows: [{ id: "cached", startedAt: 1, revenue: "5", costs: "0", refunds: "0", net: "5" }], refundEvents: [], metaBlock: null };
    useCacheStorage({
      getItem: (key) => (key === "openbook.cache.v1.pnl.rows" ? JSON.stringify({ at: 1_700_000_000_000, value: cached }) : null),
      setItem: () => {},
      removeItem: () => {},
    });
    const fetchImpl = mockFetch(() => {
      liveCalls += 1;
      return failJson(429);
    });
    const out = await fetchPnlResilient(undefined, fetchImpl);
    expect(out.source).toBe("cache");
    expect(out.takenAt).toBe(1_700_000_000_000);
    expect(out.rows[0].id).toBe("cached");
    expect(liveCalls).toBe(1);
    expect(out.liveError).toBeDefined(); // the precise live reason survives for hover
  });

  it("serves the build-time snapshot when live AND cache are unavailable", async () => {
    const fetchImpl = mockFetch((url) => {
      if (url === SNAPSHOT) {
        return okJson({ takenAt: "2026-09-12T10:00:00.000Z", dailyPnLs: [DAILY_ROW], refundIssueds: [REFUND_EVENT], providers: [] });
      }
      return failJson(429);
    });
    const out = await fetchPnlResilient(undefined, fetchImpl);
    expect(out.source).toBe("snapshot");
    expect(out.takenAt).toBe(Date.parse("2026-09-12T10:00:00.000Z"));
    expect(out.rows).toHaveLength(1);
  });

  it("throws only when every source is unavailable", async () => {
    const fetchImpl = mockFetch(() => failJson(429));
    await expect(fetchPnlResilient(undefined, fetchImpl)).rejects.toMatchObject({ status: 429 });
  });
});

describe("loadSnapshotProvidersView", () => {
  it("returns the providers payload + takenAt", async () => {
    const fetchImpl = mockFetch(() =>
      okJson({ takenAt: "2026-09-12T10:00:00.000Z", providers: [{ id: "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21", jobs: "83" }], dailyPnLs: [], refundIssueds: [] }),
    );
    const view = await loadSnapshotProvidersView(fetchImpl);
    expect(view).not.toBeNull();
    expect(view!.providers).toHaveLength(1);
    expect(view!.takenAt).toBe(Date.parse("2026-09-12T10:00:00.000Z"));
  });

  it("is null for a missing asset", async () => {
    const fetchImpl = mockFetch(() => failJson(404));
    expect(await loadSnapshotProvidersView(fetchImpl)).toBeNull();
  });
});
