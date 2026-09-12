/**
 * Escrow-module init test: App.tsx's module-scope init must point every app
 * write (legacy step flow AND the console buy/deliver/settle/sandbox) at the
 * MARKET escrow (ADDR.escrow), not agent/escrow.ts's shared-reference default
 * 0x0747… — the shared instance does not whitelist our SlaHook, so createJob
 * reverts HookNotWhitelisted() there (root cause, controller-confirmed).
 */
import { describe, expect, it } from "bun:test";
import { escrowAddress } from "../../../agent/escrow";
import { ADDR } from "../data/addresses";
// Side-effect: runs App's init block (setEscrowAddress(ADDR.escrow) beside
// setUsdcAddress) — the same import the app makes.
import "../App";

describe("app escrow init", () => {
  it("the escrow module write target equals ADDR.escrow (the market instance)", () => {
    expect(escrowAddress().toLowerCase()).toBe(ADDR.escrow.toLowerCase());
  });

  it("the market instance is NOT the shared reference default", () => {
    expect(ADDR.escrow.toLowerCase()).not.toBe("0x0747eef0706327138c69792bf28cd525089e4583");
  });
});
