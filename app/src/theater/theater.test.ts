import { describe, expect, it } from "bun:test";
import { isTerminalHeavy, type HeavyData } from "./Theater";
import type { FeeSplit, JobView } from "../data/types";

const BUYER = "0xAC548CFEfe70bb3199ee214F39bC9730a8A754De";
const SELLER = "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21";

const job = (state: JobView["state"]): JobView => ({
  jobId: 4n,
  buyer: BUYER as `0x${string}`,
  seller: SELLER as `0x${string}`,
  amount: 100_000n,
  minBlock: 61_667_127n,
  deadline: 1_789_185_965n,
  blockNumber: 61_667_206n,
  timestamp: 1_789_185_000,
  state,
  payloadHash: `0x${"1b".repeat(32)}`,
  metaBlock: 61_667_217,
});

const split: FeeSplit = { total: 100_000n, seller: 98_000n, treasury: 2_000n, feeBP: 200 };

const heavy = (state: JobView["state"], over: Partial<HeavyData> = {}): HeavyData => ({
  job: job(state),
  split: state === "settled" ? split : null,
  tx: "0xb4fbc8949598c9d940a8152618d891c545ab3be2cca94db9886fca07810c5512" as `0x${string}`,
  ...over,
});

describe("isTerminalHeavy — what the theater cache may keep", () => {
  it("an open job is NOT terminal: it must re-read on the next poll", () => {
    expect(isTerminalHeavy(heavy("open"))).toBe(false);
  });

  it("a settled job with a receipt split IS terminal and cacheable", () => {
    expect(isTerminalHeavy(heavy("settled"))).toBe(true);
  });

  it("a settled job with a transient splitError is NOT terminal: it must recover next poll", () => {
    expect(isTerminalHeavy(heavy("settled", { split: null, splitError: "fee split mismatch: …" }))).toBe(false);
  });

  it("a refunded job without a split error IS terminal and cacheable", () => {
    expect(isTerminalHeavy(heavy("refunded", { refundReason: "client-refund" } as Partial<HeavyData>))).toBe(true);
  });

  it("a refunded job that somehow carried a splitError stays uncached", () => {
    expect(isTerminalHeavy(heavy("refunded", { splitError: "no USDC transfer logs in receipt" }))).toBe(false);
  });
});
