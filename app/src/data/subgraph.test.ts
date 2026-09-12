import { describe, expect, it } from "bun:test";
import { scopedTotals } from "./subgraph";
import type { JobView } from "./types";

const HISTORICAL_BUYER = "0xAC548CFEfe70bb3199ee214F39bC9730a8A754De"; // treasury admin / CLI buyer
const OPERATOR = "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21"; // seller
const FOREIGN = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const job = (jobId: bigint, buyer: `0x${string}`, seller: `0x${string}`, amount: bigint, state: JobView["state"], refundReason?: string): JobView => ({
  jobId, buyer, seller, amount, minBlock: 0n, deadline: 0n, blockNumber: 0n, timestamp: 0, state, refundReason,
});

describe("scopedTotals", () => {
  it("keeps the README-cited refund (job 185853) and counts it", () => {
    const jobs = [
      job(185853n, HISTORICAL_BUYER as `0x${string}`, OPERATOR as `0x${string}`, 100_000n, "refunded", "client-refund"),
      job(186145n, HISTORICAL_BUYER as `0x${string}`, OPERATOR as `0x${string}`, 100_000n, "settled"),
    ];
    const totals = scopedTotals(jobs);
    expect(totals).toEqual({ revenue: 100_000n, refunds: 100_000n, net: 0n });
  });
  it("excludes foreign jobs (neither buyer nor seller ours)", () => {
    const jobs = [
      job(1n, OPERATOR as `0x${string}`, OPERATOR as `0x${string}`, 50_000n, "settled"),
      job(185853n, HISTORICAL_BUYER as `0x${string}`, OPERATOR as `0x${string}`, 100_000n, "refunded", "client-refund"),
      job(2n, FOREIGN as `0x${string}`, FOREIGN as `0x${string}`, 999_999n, "settled"),
    ];
    const totals = scopedTotals(jobs);
    expect(totals).toEqual({ revenue: 50_000n, refunds: 100_000n, net: -50_000n });
  });
});
