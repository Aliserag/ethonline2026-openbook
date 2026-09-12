import { describe, expect, it } from "bun:test";
import { fetchJobs, scopedTotals } from "./subgraph";
import type { JobView } from "./types";

const HISTORICAL_BUYER = "0xAC548CFEfe70bb3199ee214F39bC9730a8A754De"; // treasury admin / CLI buyer
const OPERATOR = "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21"; // seller
const FOREIGN = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const job = (jobId: bigint, buyer: `0x${string}`, seller: `0x${string}`, amount: bigint, state: JobView["state"], refundReason?: string): JobView => ({
  jobId, buyer, seller, amount, minBlock: 0n, deadline: 0n, blockNumber: 0n, timestamp: 0, state, refundReason,
});

describe("fetchJobs", () => {
  it("keeps job 185853 refunded even when 25 newer refunds exist elsewhere (no global window eviction)", async () => {
    const paid185853 = {
      id: "0x2d5f5", jobId: "185853",
      buyer: HISTORICAL_BUYER.toLowerCase(), seller: OPERATOR.toLowerCase(),
      amount: "100000", minBlock: "0", deadline: "0", blockNumber: "0", timestamp: "1720000000",
    };
    const foreignPaid = {
      id: "0x10", jobId: "999999",
      buyer: FOREIGN.toLowerCase(), seller: FOREIGN.toLowerCase(),
      amount: "50000", minBlock: "0", deadline: "0", blockNumber: "0", timestamp: "1720000001",
    };
    // 25 refunds for OTHER jobs with ids > 185853's: a global refundIssueds
    // first-20, orderBy: id desc window would return 20 of these and evict 185853.
    const newerRefunds = Array.from({ length: 25 }, (_, i) => {
      const jid = 200_000 + i;
      return { id: `0x${jid.toString(16)}`, jobId: String(jid), reason: "stale-data" };
    });
    const refund185853 = { id: "0x2d5f5", jobId: "185853", reason: "client-refund" };
    const fulfilled185853 = {
      id: "0x2d5f5", jobId: "185853",
      payloadHash: `0x${"ab".repeat(32)}`, metaBlock: "445566",
    };
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      const events = body.query.includes("fulfilleds");
      return new Response(JSON.stringify({
        data: events
          ? {
              fulfilleds: [fulfilled185853],
              settleds: [],
              refundIssueds: [...newerRefunds, refund185853],
            }
          : {
              queryPaids: [paid185853, foreignPaid],
              _meta: { block: { number: 123_456 } },
            },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const jobs = await fetchJobs(undefined, fetchImpl);
    const refunded = jobs.find((j) => j.jobId === 185853n);
    expect(refunded).toBeDefined();
    expect(refunded?.state).toBe("refunded");
    expect(refunded?.refundReason).toBe("client-refund");
    expect(refunded?.payloadHash).toBe(`0x${"ab".repeat(32)}`);
    expect(jobs.some((j) => j.jobId === 999_999n)).toBe(false); // foreign buyer excluded
  });
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
