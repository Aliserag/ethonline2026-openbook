import { describe, expect, it } from "bun:test";
import { backoffMs, INITIAL_LIVE_STATE, nextLiveState } from "./useLiveValue";
import type { LiveState } from "../data/types";

describe("nextLiveState — the live/stale/error reducer (spec §3)", () => {
  it("starts loading (initial state, nothing read yet)", () => {
    expect(INITIAL_LIVE_STATE).toBe("loading");
    // the reducer keeps an unreached state as loading while a background
    // poll is in flight
    expect(nextLiveState("loading", "loading", false)).toBe("loading");
  });

  it("ok → live from any prior state (recovery included)", () => {
    for (const prev of ["loading", "live", "stale", "error"] as const) {
      expect(nextLiveState(prev, "ok", true)).toBe("live");
    }
    expect(nextLiveState("error", "ok", false)).toBe("live");
    expect(nextLiveState("stale", "ok", false)).toBe("live");
  });

  it("err after an ok with silent=true → stale (value kept)", () => {
    expect(nextLiveState("live", "err", true)).toBe("stale");
    // already-stale stays stale — the last good value is still on screen
    expect(nextLiveState("stale", "err", true)).toBe("stale");
  });

  it("err with no prior value → error (never a fake stale)", () => {
    expect(nextLiveState("loading", "err", false)).toBe("error");
    // even with silent=true there is no value to keep
    expect(nextLiveState("loading", "err", true)).toBe("error");
  });

  it("non-silent err drops even a live value → error", () => {
    expect(nextLiveState("live", "err", false)).toBe("error");
  });

  it("background refetch never demotes a healthy value", () => {
    expect(nextLiveState("live", "loading", true)).toBe("live");
    expect(nextLiveState("stale", "loading", true)).toBe("stale");
    expect(nextLiveState("error", "loading", true)).toBe("loading");
  });

  it("stale timer demotes live (kept) and leaves error untouched", () => {
    expect(nextLiveState("live", "stale", true)).toBe("stale");
    expect(nextLiveState("stale", "stale", true)).toBe("stale");
    expect(nextLiveState("error", "stale", true)).toBe("error");
  });
});

describe("backoffMs — 2s → 4s → 8s, cap 30s", () => {
  it("doubles the base and caps", () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(2)).toBe(4_000);
    expect(backoffMs(3)).toBe(8_000);
    expect(backoffMs(4)).toBe(16_000);
    expect(backoffMs(5)).toBe(30_000);
    expect(backoffMs(20)).toBe(30_000);
    expect(backoffMs(0)).toBe(2_000); // safety: never below the base
  });
});

describe("live/stale/error lifecycle — success after failure is live again", () => {
  it("walks the full degrade-and-recover cycle", () => {
    let state: LiveState = INITIAL_LIVE_STATE;
    state = nextLiveState(state, "ok", false);
    expect(state).toBe("live");
    state = nextLiveState(state, "err", true); // silent: keep the value
    expect(state).toBe("stale");
    state = nextLiveState(state, "err", true); // still failing
    expect(state).toBe("stale");
    state = nextLiveState(state, "ok", true); // recovered
    expect(state).toBe("live");
  });
});
