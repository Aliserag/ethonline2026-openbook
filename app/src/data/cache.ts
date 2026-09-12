/**
 * Demo-resilience primitives for the Studio-backed reads (workspace-wide,
 * one year of observed 429s on api.studio.thegraph.com by IP):
 *
 *   - readLastGood / writeLastGood — the persistent last-good payload in
 *     localStorage under a versioned key (JSON, bigint-safe). Served only on
 *     a failed refresh and ALWAYS labeled (never presented as live).
 *   - isRateLimit — recognizes the gateway wall (HTTP 429, or a
 *     "rate limit"/"too many requests" GraphQL reason) so surfaces can
 *     degrade calmly instead of flashing the raw upstream text.
 *   - rateLimitBackoffMs — 30s → 60s → 120s → … capped at 5 min, jittered,
 *     per source, instead of hammering every poll.
 *   - the per-gate cooldown (markRateLimit / mayPoll / gateRemainingMs) so
 *     several surfaces sharing one upstream (the Studio gateway) pause
 *     together when it is walled.
 *   - shared() — a short-TTL in-flight-coalescing wrapper so simultaneous
 *     poll loops on the same read (map nodes, console chips, theater heads)
 *     fire ONE upstream request per window instead of one per node tick.
 *
 * Everything is environment-safe: no localStorage in tests/SSR, quota
 * exceptions, corrupt JSON — each degrades to "no cache" rather than
 * throwing into a live read.
 */
import { GatewayHttpError } from "../../../mcp/src/gateway";
import { clockTime } from "../format";

const KEY_PREFIX = "openbook.cache.v1.";
/** Any payload whose bigint fields must survive JSON round-trips. */
const BIGINT_MARK = "__openbook_bigint__";

export type CacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Test seam: without it, the browser's localStorage is used (absent → null). */
let injectedStorage: CacheStorage | null | undefined;

export function useCacheStorage(storage?: CacheStorage | null): void {
  injectedStorage = storage;
}

function storage(): CacheStorage | null {
  if (injectedStorage !== undefined) return injectedStorage;
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // privacy mode / sandboxed frame
  }
}

/** bigint-safe JSON round-trip (ProviderStats/JobView/FeeSplit carry bigints). */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_MARK]: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    BIGINT_MARK in (value as Record<string, unknown>) &&
    typeof (value as Record<string, unknown>)[BIGINT_MARK] === "string"
  ) {
    return BigInt((value as Record<string, unknown>)[BIGINT_MARK] as string);
  }
  return value;
}

interface CacheEnvelope<T> {
  at: number;
  value: T;
}

/** Last successful payload for a cacheKey, or null when absent/corrupt/fresh-forever. */
export function readLastGood<T>(key: string): { value: T; at: number } | null {
  const store = storage();
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(KEY_PREFIX + key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw, reviver) as CacheEnvelope<T>;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.at !== "number") return null;
    return { value: parsed.value, at: parsed.at };
  } catch {
    return null;
  }
}

/** Persist the last successful payload under a versioned key (best-effort). */
export function writeLastGood<T>(key: string, value: T): void {
  const store = storage();
  if (store === null) return;
  const envelope: CacheEnvelope<T> = { at: Date.now(), value };
  try {
    store.setItem(KEY_PREFIX + key, JSON.stringify(envelope, replacer));
  } catch {
    // quota/privacy — the live app still works, only the cache is lost
  }
}

/** Remove a cacheKey (used when a cached payload must not outlive its validity). */
export function clearLastGood(key: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(KEY_PREFIX + key);
  } catch {
    // best-effort
  }
}

/**
 * Recognize the gateway wall: HTTP 429 (GatewayHttpError carries .status) or
 * a message naming rate limiting / too many requests (GraphQL-level reasons
 * come back as GraphQueryError messages).
 */
export function isRateLimit(error: unknown): boolean {
  if (error instanceof GatewayHttpError) {
    if (error.status === 429) return true;
  }
  const text = error instanceof Error ? error.message : String(error);
  return /429|rate\s*limit|too many requests/i.test(text);
}

/** The rate-limit backoff base (pre-jitter): 30s → 60s → 120s → … cap 5 min. */
export function rateLimitBaseMs(failureCount: number): number {
  const base = RATE_LIMIT_BASE_MS * 2 ** Math.max(0, failureCount - 1);
  return Math.min(base, RATE_LIMIT_CAP_MS);
}

export const RATE_LIMIT_BASE_MS = 30_000;
export const RATE_LIMIT_CAP_MS = 300_000;

/** Jittered (±20%) rate-limit backoff for one source. */
export function rateLimitBackoffMs(failureCount: number): number {
  const base = rateLimitBaseMs(failureCount);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Shared per-upstream cooldown gate. When ONE Studio-backed surface hits the
 * wall, every surface polling the same gate pauses until the window passes —
 * the 429 is per-IP upstream, so parallel retries from sibling polls are
 * exactly what re-triggers it.
 */
const cooldownUntil = new Map<string, number>();
export const STUDIO_GATE = "studio";

export function markRateLimit(gateKey: string, at: number = Date.now()): void {
  const until = Math.max(cooldownUntil.get(gateKey) ?? 0, at + RATE_LIMIT_BASE_MS);
  cooldownUntil.set(gateKey, until);
}

export function gateRemainingMs(gateKey: string, now: number = Date.now()): number {
  return Math.max(0, (cooldownUntil.get(gateKey) ?? 0) - now);
}

/**
 * Short-TTL shared read with in-flight coalescing: concurrent callers within
 * one window share a single upstream request; a failure evicts itself so the
 * next poll genuinely retries. This is what keeps the map's 8 node polls
 * (and the console chips, and the theater heads) from re-firing the same
 * Studio query on every node tick. One `shared` instance per upstream read:
 * keep them at module scope so every caller shares the same window.
 */
export function shared<T>(read: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let at = 0;
  let value: Promise<T> | null = null;
  return (): Promise<T> => {
    const now = Date.now();
    if (value !== null && now - at < ttlMs) return value;
    at = now;
    value = read().catch((error) => {
      value = null;
      throw error;
    });
    return value;
  };
}

/** `as of 14:32:07 · cached` — the visible label for a last-good serve. */
export function cachedAsOfLabel(at: number): string {
  return `as of ${clockTime(at)} · cached`;
}

/** `snapshot taken 14:32:07` — the visible label for a build-time snapshot serve. */
export function snapshotLabel(at: number): string {
  return `snapshot taken ${clockTime(at)}`;
}
