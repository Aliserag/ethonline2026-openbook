import { beforeEach, describe, expect, it, vi } from "bun:test";
import { GatewayHttpError, GraphQueryError } from "../../../mcp/src/gateway";
import {
  isRateLimit,
  rateLimitBackoffMs,
  rateLimitBaseMs,
  readLastGood,
  shared,
  useCacheStorage,
  writeLastGood,
  type CacheStorage,
} from "./cache";

/** In-memory CacheStorage seam (bun has no localStorage). */
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

describe("isRateLimit — the gateway wall", () => {
  it("recognizes HTTP 429 as a rate limit", () => {
    expect(isRateLimit(new GatewayHttpError(429, "Too many requests"))).toBe(true);
  });

  it("recognizes rate-limit wording from GraphQL-level failures", () => {
    expect(isRateLimit(new GraphQueryError("rate limit exceeded, retry later", []))).toBe(true);
    expect(isRateLimit(new Error("gateway HTTP 429: Too many requests…"))).toBe(true);
    expect(isRateLimit(new Error("upstream: too many requests in a short time window"))).toBe(true);
  });

  it("leaves unrelated failures alone", () => {
    expect(isRateLimit(new GatewayHttpError(500, "gateway exploded"))).toBe(false);
    expect(isRateLimit(new Error("fetch failed"))).toBe(false);
    expect(isRateLimit("boom")).toBe(false);
  });
});

describe("rateLimitBaseMs — 30s → 60s → 120s → …, cap 5 min", () => {
  it("doubles per consecutive failure and caps", () => {
    expect(rateLimitBaseMs(1)).toBe(30_000);
    expect(rateLimitBaseMs(2)).toBe(60_000);
    expect(rateLimitBaseMs(3)).toBe(120_000);
    expect(rateLimitBaseMs(4)).toBe(240_000);
    expect(rateLimitBaseMs(5)).toBe(300_000);
    expect(rateLimitBaseMs(20)).toBe(300_000);
    expect(rateLimitBaseMs(0)).toBe(30_000); // safety: never below the base
  });
});

describe("rateLimitBackoffMs — jittered within ±20% of the base", () => {
  it("stays within the jitter band", () => {
    for (const hits of [1, 2, 3, 5]) {
      const base = rateLimitBaseMs(hits);
      for (let i = 0; i < 50; i++) {
        const got = rateLimitBackoffMs(hits);
        expect(got).toBeGreaterThanOrEqual(Math.round(base * 0.8));
        expect(got).toBeLessThanOrEqual(Math.round(base * 1.2));
      }
    }
  });
});

describe("readLastGood / writeLastGood — the persistent last-good cache", () => {
  beforeEach(() => useCacheStorage(memStorage()));

  it("round-trips a payload (bigint fields survive JSON)", () => {
    writeLastGood("test.roundtrip", { jobs: [{ amount: 123_000n, state: "settled" }] });
    const hit = readLastGood<{ jobs: Array<{ amount: bigint; state: string }> }>("test.roundtrip");
    expect(hit).not.toBeNull();
    expect(hit!.value.jobs[0].amount).toBe(123_000n);
    expect(hit!.value.jobs[0].state).toBe("settled");
    expect(hit!.at).toBeGreaterThan(0);
  });

  it("returns null for an unknown key and tolerates corrupt JSON", () => {
    expect(readLastGood("test.missing")).toBeNull();
    const store = memStorage();
    useCacheStorage(store);
    writeLastGood("test.corrupt", { ok: true });
    store.setItem("openbook.cache.v1.test.corrupt", "{not json");
    expect(readLastGood("test.corrupt")).toBeNull();
  });

  it("behaves as no-cache when no storage exists", () => {
    useCacheStorage(null);
    writeLastGood("test.nostore", { ok: true }); // must not throw
    expect(readLastGood("test.nostore")).toBeNull();
  });
});

describe("shared — in-flight coalescing with a short TTL", () => {
  it("serves one upstream read to concurrent callers", async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    let upstreamCalls = 0;
    const read = shared(() => {
      upstreamCalls += 1;
      return promise;
    }, 15_000);
    const first = read();
    const second = read();
    expect(upstreamCalls).toBe(1);
    resolve("payload");
    expect(await first).toBe("payload");
    expect(await second).toBe("payload");
  });

  it("serves the TTL-fresh value and retries after the window", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const read = shared(async () => {
        calls += 1;
        return `v${calls}`;
      }, 50);
      expect(await read()).toBe("v1");
      expect(await read()).toBe("v1"); // within TTL
      vi.advanceTimersByTime(60);
      expect(await read()).toBe("v2"); // window passed
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts itself on failure so the next poll genuinely retries", async () => {
    let fail = true;
    const read = shared(async () => {
      if (fail) throw new Error("boom");
      return "recovered";
    }, 15_000);
    await expect(read()).rejects.toThrow("boom");
    fail = false;
    expect(await read()).toBe("recovered");
  });
});
