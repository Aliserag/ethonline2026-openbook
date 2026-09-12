import { describe, expect, it } from "bun:test";
import { checkWithdrawal, DAY_BLOCKS } from "./policy";

const base = {
  to: `0x${"11".repeat(20)}` as `0x${string}`,
  perTxCap: 1_000_000n,
  dailyCap: 10_000_000n,
  spentToday: 200_000n,
  allowlisted: true,
};

describe("checkWithdrawal", () => {
  it("ok within caps + allowlisted", () => {
    expect(checkWithdrawal({ ...base, amount: 500_000n })).toEqual({ ok: true });
  });
  it("amount > perTxCap → per-tx cap", () => {
    expect(checkWithdrawal({ ...base, amount: 1_500_000n })).toEqual({ ok: false, reason: "per-tx cap" });
  });
  it("spentToday + amount > dailyCap → daily cap", () => {
    expect(checkWithdrawal({ ...base, spentToday: 9_800_000n, amount: 500_000n })).toEqual({ ok: false, reason: "daily cap" });
  });
  it("not allowlisted → allowlist", () => {
    expect(checkWithdrawal({ ...base, amount: 500_000n, allowlisted: false })).toEqual({ ok: false, reason: "allowlist" });
  });
  it("rolls the block-day bucket like PolicyWallet.sol", () => {
    expect(
      checkWithdrawal({
        ...base,
        amount: 500_000n,
        spentToday: 9_999_999n,
        lastDayStart: 100n,
        headBlock: 100n + DAY_BLOCKS,
      }),
    ).toEqual({ ok: true });
  });
  it("zero amount reverts", () => {
    expect(checkWithdrawal({ ...base, amount: 0n })).toEqual({ ok: false, reason: "zero amount" });
  });
});
