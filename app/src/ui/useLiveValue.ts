/**
 * useLiveValue — one degrade contract for every live surface (console panels,
 * map nodes, drawers). The hook polls `read` on an interval and degrades
 * truthfully; consumers render the `reason` field in every degraded state:
 *
 *   live    — the last read succeeded
 *   stale   — a previous value exists but the read keeps failing (value kept,
 *             reason set) or no fresh read landed within staleAfterMs
 *   error   — the first read failed and there is NO value to show
 *   loading — initial, before the first read settles
 *
 * Failure polling backs off: 2s → 4s → 8s → … capped at 30s; a rate limit
 * (429 / "rate limit" reason) backs off 30s → 60s → 120s → … capped at 5 min
 * with jitter, per `cacheKey`/`gateKey` source, instead of hammering every
 * poll. `refresh()` triggers an immediate read (the console's status chips
 * reuse it).
 *
 * Persistence (demo resilience): pass `cacheKey` and the last successful
 * payload is stored in localStorage; on a failed refresh (or a reload during
 * an upstream wall) the cached payload is served with state `stale`,
 * `source: "cache"` and an explicit `as of HH:MM:SS · cached` reason — a
 * degraded read is never presented as live. Pass `gateKey` to pause all
 * surfaces polling the same upstream together while it is walled.
 *
 * A value is never invented: an error with no prior value is `error`, never
 * a fake `live`.
 */
import { useEffect, useRef, useState } from "react";
import type { Live, LiveState } from "../data/types";
import {
  cachedAsOfLabel,
  gateRemainingMs,
  isRateLimit,
  markRateLimit,
  readLastGood,
  rateLimitBackoffMs,
  writeLastGood,
} from "../data/cache";

export type LiveEvent = "loading" | "ok" | "err" | "stale";

/** Nothing read yet — the hook's first state. */
export const INITIAL_LIVE_STATE: LiveState = "loading";

/**
 * Pure reducer for the live/stale/error transitions.
 *
 * - "ok" always lands `live` (recovery after failure included).
 * - "err" degrades to `stale` ONLY when a previous value exists to keep
 *   (prev live/stale) and `silent` is true; otherwise it is a hard `error`
 *   (a source that never produced a value must never be shown as stale).
 * - "stale" (staleAfterMs fired mid-poll) demotes a live value and keeps it.
 * - "loading" (background refetch) never demotes a healthy value.
 */
export function nextLiveState(
  prev: LiveState,
  event: LiveEvent,
  silent: boolean,
): LiveState {
  switch (event) {
    case "ok":
      return "live";
    case "err":
      return silent && (prev === "live" || prev === "stale") ? "stale" : "error";
    case "stale":
      return prev === "live" ? "stale" : prev;
    case "loading":
      return prev === "live" || prev === "stale" ? prev : "loading";
  }
}

/** Failure backoff schedule: 2s → 4s → 8s → … capped at 30s. */
export function backoffMs(failureCount: number): number {
  const base = 2_000 * 2 ** Math.max(0, failureCount - 1);
  return Math.min(base, 30_000);
}

export const DEFAULT_POLL_MS = 15_000;
export const DEFAULT_STALE_AFTER_MS = 45_000;

export interface UseLiveValueOptions {
  pollMs?: number;
  staleAfterMs?: number;
  /** versioned localStorage last-good key; served labeled on failed reads */
  cacheKey?: string;
  /** shared upstream cooldown gate: a rate limit pauses every surface on it */
  gateKey?: string;
}

/**
 * Poll a live source, truthfully degrading. `refresh()` triggers an immediate
 * read. `read` may change identity every render — the latest is used for the
 * next poll without restarting the polling loop.
 */
export function useLiveValue<T>(
  read: () => Promise<T>,
  opts: UseLiveValueOptions = {},
): Live<T> & { refresh(): void } {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const cacheKey = opts.cacheKey;
  const gateKey = opts.gateKey;
  const [snap, setSnap] = useState<Live<T>>(() => {
    if (cacheKey !== undefined) {
      const cached = readLastGood<T>(cacheKey);
      if (cached !== null) {
        // reload during an upstream wall: seed from the last good payload,
        // honestly labeled — never as live
        return { value: cached.value, state: "stale", at: cached.at, source: "cache", reason: cachedAsOfLabel(cached.at) };
      }
    }
    return { value: null, state: INITIAL_LIVE_STATE, at: 0 };
  });
  const [nonce, setNonce] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  const failuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let delay: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;

    // Armed after every successful read: no fresh ok within staleAfterMs
    // demotes the (kept) value to stale so it is never shown as live past
    // its freshness window.
    const armStale = (): void => {
      clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        if (cancelled) return;
        setSnap((prev) => {
          const state = nextLiveState(prev.state, "stale", prev.value !== null);
          if (state === prev.state) return prev;
          return { ...prev, state, reason: `no fresh read within ${Math.round(staleAfterMs / 1000)}s` };
        });
      }, staleAfterMs);
    };

    const run = async (): Promise<void> => {
      if (cancelled) return;
      if (gateKey !== undefined) {
        const remaining = gateRemainingMs(gateKey);
        if (remaining > 0) {
          // the shared upstream is cooling down — do not fire; preserve state
          delay = setTimeout(run, remaining + 250);
          return;
        }
      }
      setSnap((prev) => ({
        ...prev,
        state: nextLiveState(prev.state, "loading", prev.value !== null),
      }));
      try {
        const value = await readRef.current();
        if (cancelled) return;
        failuresRef.current = 0;
        if (cacheKey !== undefined) writeLastGood(cacheKey, value);
        setSnap({ value, state: "live", at: Date.now(), source: "live" });
        armStale();
        delay = setTimeout(run, pollMs);
      } catch (error) {
        if (cancelled) return;
        failuresRef.current += 1;
        const limited = isRateLimit(error);
        if (limited && gateKey !== undefined) markRateLimit(gateKey);
        const reason = error instanceof Error ? error.message : String(error);
        setSnap((prev) => {
          const cached = cacheKey !== undefined ? readLastGood<T>(cacheKey) : null;
          if (cached !== null) {
            return {
              value: cached.value,
              state: "stale",
              at: cached.at,
              source: "cache",
              reason: cachedAsOfLabel(cached.at),
            };
          }
          return {
            ...prev,
            state: nextLiveState(prev.state, "err", prev.value !== null),
            reason,
          };
        });
        delay = setTimeout(
          run,
          limited ? rateLimitBackoffMs(failuresRef.current) : backoffMs(failuresRef.current),
        );
      }
    };

    run();

    return () => {
      cancelled = true;
      clearTimeout(delay);
      clearTimeout(staleTimer);
    };
  }, [nonce, pollMs, staleAfterMs, cacheKey, gateKey]);

  return {
    ...snap,
    refresh: () => setNonce((n) => n + 1),
  };
}
