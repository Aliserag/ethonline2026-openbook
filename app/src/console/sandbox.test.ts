/**
 * T9 sandbox command tests: canClaimRefund boundaries, classifyRevert (the
 * shared helper re-exported from act.ts — the T9 surfaces own the exercise
 * of it per the brief), the escrow deadline clamp, and registry registration
 * of the sandbox command names. Network-free dispatch smoke for the two
 * guards that short-circuit before any live read.
 */
import { describe, expect, it } from "bun:test";
import { keccak256, toBytes } from "viem";
import { commands, dispatch } from "./registry";
import {
  canClaimRefund,
  clampDeadline,
  classifyRevert,
  getSandboxState,
} from "./commands/sandbox";
// Side-effect: registers policy refusals / policy try-overspend /
// sandbox stale / sandbox claim (same import the app will make).
import "./commands/sandbox";

describe("canClaimRefund", () => {
  const deadline = 1_800_000_000n; // a fixed unix second

  it("before the deadline → false", () => {
    expect(canClaimRefund(deadline, 1_799_999_999)).toBe(false);
  });

  it("at the deadline → true", () => {
    expect(canClaimRefund(deadline, 1_800_000_000)).toBe(true);
  });

  it("after the deadline → true", () => {
    expect(canClaimRefund(deadline, 1_800_000_001)).toBe(true);
  });
});

describe("clampDeadline", () => {
  it("clamps below the escrow floor (5 min, ExpiryTooShort)", () => {
    expect(clampDeadline(120)).toBe(360);
  });
  it("keeps requested deadlines above the floor", () => {
    expect(clampDeadline(7200)).toBe(7200);
  });
});

describe("classifyRevert (shared with act, exercised here per the T9 brief)", () => {
  const selector = (sig: string): `0x${string}` =>
    keccak256(toBytes(sig)).slice(0, 10) as `0x${string}`;
  const data = (sel: string, tail = ""): `0x${string}` => `${sel}${tail}` as `0x${string}`;

  it("SlaNotMet — the stale complete() revert the sandbox captures", () => {
    expect(classifyRevert(data(selector("SlaNotMet(uint256,uint256)"), "00".repeat(64)))).toBe("SlaNotMet");
  });

  it("onlyAgentOrOwner — the PolicyWallet require(...) error decoded by name", () => {
    const message = "not agent";
    const hex = Buffer.from(message, "utf8").toString("hex");
    const offset = "0".repeat(62) + "20";
    const len = message.length.toString(16).padStart(64, "0");
    const body = (hex + "0".repeat(64)).slice(0, 64);
    expect(classifyRevert(data("0x08c379a0", `${offset}${len}${body}`))).toBe("onlyAgentOrOwner");
  });
});

describe("registry registration (carry-in names)", () => {
  it("all four sandbox/policy command names are registered", () => {
    const names = commands().map((c) => c.name);
    for (const name of [
      "policy refusals",
      "policy try-overspend",
      "sandbox stale",
      "sandbox claim",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("policy try-overspend without an amount prints usage (no live reads)", async () => {
    const ctx = {
      publicClient: {} as never,
      signer: { kind: "none", address: null },
      config: { ens: "openbook.eth", datasets: [] } as never,
      navigate: () => undefined,
    };
    const result = await dispatch("policy try-overspend", ctx);
    expect(result.render).toBe("text");
    if (result.render === "text") expect(result.data).toContain("usage: policy try-overspend");
  });

  it("sandbox claim with no sandbox job prints the instruct line (no live reads)", async () => {
    expect(getSandboxState()).toBeNull();
    const ctx = {
      publicClient: {} as never,
      signer: { kind: "none", address: null },
      config: { ens: "openbook.eth", datasets: [] } as never,
      navigate: () => undefined,
    };
    const result = await dispatch("sandbox claim", ctx);
    expect(result.render).toBe("text");
    if (result.render === "text") expect(result.data).toContain("run `sandbox stale` first");
  });
});
