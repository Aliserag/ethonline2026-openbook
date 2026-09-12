import { describe, expect, test } from "bun:test";
import { boardRows, latestRefund, totals } from "./feed";
import type { JobView } from "./types";

function job(over: Partial<JobView>): JobView {
  return {
    jobId: 1n,
    buyer: "0x1",
    seller: "0x2",
    amount: 100000n,
    minBlock: 0n,
    deadline: 0n,
    blockNumber: 0n,
    timestamp: 1000,
    state: "open",
    ...over,
  } as JobView;
}

describe("feed derivations", () => {
  test("latestRefund picks the newest refunded job", () => {
    const jobs = [
      job({ jobId: 1n, state: "refunded", timestamp: 10 }),
      job({ jobId: 2n, state: "refunded", timestamp: 30 }),
      job({ jobId: 3n, state: "settled", timestamp: 40 }),
    ];
    expect(latestRefund(jobs)?.jobId).toBe(2n);
    expect(latestRefund([job({ state: "settled" })])).toBeNull();
  });
  test("totals count and sum by state, fees from settled at feeBP", () => {
    const jobs = [
      job({ state: "settled", amount: 100000n }),
      job({ state: "settled", amount: 120000n }),
      job({ state: "refunded", amount: 150000n }),
      job({ state: "open" }),
    ];
    expect(totals(jobs, 200)).toEqual({
      settledCount: 2,
      settledUsdc: 220000n,
      refundedCount: 1,
      refundedUsdc: 150000n,
      feesUsdc: 4400n,
    });
  });
  test("boardRows merges session runs, newest first, flags unconfirmed", () => {
    const jobs = [
      job({ jobId: 5n, state: "settled", timestamp: 50 }),
      job({ jobId: 4n, state: "refunded", timestamp: 40, refundReason: "STALE_DATA" }),
    ];
    const runs = [
      { jobId: "9", datasetId: "x", amount: 1n, outcome: "refunded" as const, at: 90 },
      { jobId: "5", datasetId: "x", amount: 1n, outcome: "settled" as const, at: 51 },
    ];
    const rows = boardRows(jobs, runs, 10);
    expect(rows.map((r) => r.jobId)).toEqual(["9", "5", "4"]);
    expect(rows[0]!.confirming).toBe(true);
    expect(rows[1]!.confirming).toBe(false);
    expect(rows[1]!.datasetId).toBe("x");
    expect(rows[2]!.refundReason).toBe("STALE_DATA");
    expect(rows[2]!.delivered).toBe(false);
    expect(rows[0]!.delivered).toBe(true);
  });
  test("boardRows marks delivered when the job carries a metaBlock", () => {
    const jobs = [job({ jobId: 6n, state: "refunded", metaBlock: 123 })];
    expect(boardRows(jobs, [], 5)[0]!.delivered).toBe(true);
  });
  test("boardRows names sellers by operator address", () => {
    const jobs = [job({ jobId: 7n, seller: "0xAbC" as `0x${string}`, state: "settled" })];
    expect(boardRows(jobs, [], 5, { "0xabc": "alpha.openbook.eth" })[0]!.sellerName).toBe("alpha.openbook.eth");
    expect(boardRows(jobs, [], 5)[0]!.sellerName).toBeUndefined();
  });
  test("boardRows respects the limit", () => {
    const jobs = Array.from({ length: 20 }, (_, i) => job({ jobId: BigInt(i), timestamp: i }));
    expect(boardRows(jobs, [], 12)).toHaveLength(12);
  });
});
