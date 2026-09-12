import { describe, expect, it } from "bun:test";
import { buildFrames, type Frame } from "./replay";
import type { FeeSplit, JobView } from "../data/types";

const BUYER = "0xAC548CFEfe70bb3199ee214F39bC9730a8A754De";
const SELLER = "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21";
const HEAD = { arc: 61_678_977n, subgraph: 61_678_900n };
const ENS = { price: "0.10 USDC/query", maxBlockLag: 50 };

/** The canonical settled-with-fee example (our instance's job 4, receipt-verified). */
const settledJob: JobView = {
  jobId: 4n,
  buyer: BUYER as `0x${string}`,
  seller: SELLER as `0x${string}`,
  amount: 100_000n,
  minBlock: 61_667_127n,
  deadline: 1_789_185_965n,
  blockNumber: 61_667_206n,
  timestamp: 1_789_185_000,
  state: "settled",
  payloadHash: `0x${"1b".repeat(32)}`,
  metaBlock: 61_667_217,
};

/** The receipt-derived split of the same settlement (200 BP -> 2000 treasury + 98000 seller). */
const settledSplit: FeeSplit = { total: 100_000n, seller: 98_000n, treasury: 2_000n, feeBP: 200 };

/** The canonical refund example (job 185853, shared escrow, indexed). */
const refundedJob: JobView = {
  jobId: 185_853n,
  buyer: BUYER as `0x${string}`,
  seller: SELLER as `0x${string}`,
  amount: 100_000n,
  minBlock: 61_341_495n,
  deadline: 1_789_018_061n,
  blockNumber: 61_341_534n,
  timestamp: 1_789_014_482,
  state: "refunded",
  payloadHash: `0x${"1b".repeat(32)}`,
  metaBlock: 61_341_543,
  refundReason: "client-refund",
};

function frame(frames: Frame[], id: string): Frame {
  const found = frames.find((f) => f.id === id);
  if (!found) throw new Error(`missing frame ${id}`);
  return found;
}

/** Raw units from the "2000 (0.002 USDC)" value format — exact, not display-rounded. */
function rawUnits(value: string): bigint {
  const match = /^\s*(\d+)/.exec(value);
  if (!match) throw new Error(`value has no raw-units prefix: ${value}`);
  return BigInt(match[1]);
}

describe("buildFrames — settled job", () => {
  const frames = buildFrames(settledJob, settledSplit, HEAD, ENS);

  it("yields exactly the six frames in order: quote pay deliver verdict money books", () => {
    expect(frames.map((f) => f.id)).toEqual([
      "quote",
      "pay",
      "deliver",
      "verdict",
      "money",
      "books",
    ]);
  });

  it("verdict frame carries the exact comparison row metaBlock ≥ minBlock with both live values", () => {
    const verdict = frame(frames, "verdict");
    const comparison = verdict.rows.find(([key]) => key === "metaBlock ≥ minBlock");
    expect(comparison).toBeDefined();
    expect(comparison?.[1]).toContain("≥");
    expect(comparison?.[1]).toContain(String(settledJob.metaBlock));
    expect(comparison?.[1]).toContain(settledJob.minBlock.toString());
  });

  it("verdict frame derives APPROVE from the deterministic gate", () => {
    const verdict = frame(frames, "verdict");
    const label = verdict.rows.find(([key]) => key === "verdict");
    expect(label?.[1]).toBe("APPROVE");
  });

  it("money frame's split rows sum exactly to the job amount", () => {
    const money = frame(frames, "money");
    const treasury = money.rows.find(([key]) => key.startsWith("treasury"));
    const seller = money.rows.find(([key]) => key.startsWith("seller"));
    expect(treasury).toBeDefined();
    expect(seller).toBeDefined();
    expect(rawUnits(treasury?.[1] ?? "")).toBe(2_000n);
    expect(rawUnits(seller?.[1] ?? "")).toBe(98_000n);
    expect(rawUnits(treasury?.[1] ?? "") + rawUnits(seller?.[1] ?? "")).toBe(settledJob.amount);
    const total = money.rows.find(([key]) => key === "total");
    expect(rawUnits(total?.[1] ?? "")).toBe(settledJob.amount);
  });

  it("quote frame shows the live ENS price and the SLA window", () => {
    const quote = frame(frames, "quote");
    expect(quote.rows.find(([key]) => key === "ens price")?.[1]).toBe("0.10 USDC/query");
    expect(quote.rows.find(([key]) => key === "sla maxBlockLag")?.[1]).toBe("50 blocks");
  });
});

describe("buildFrames — refunded job", () => {
  const frames = buildFrames(refundedJob, null, HEAD, ENS);

  it("yields the same six frames (the replay covers the whole life)", () => {
    expect(frames.map((f) => f.id)).toEqual([
      "quote",
      "pay",
      "deliver",
      "verdict",
      "money",
      "books",
    ]);
  });

  it("money frame has a full-amount refund row and NO fee row", () => {
    const money = frame(frames, "money");
    const refund = money.rows.find(([key]) => key.toLowerCase().includes("refund"));
    expect(refund).toBeDefined();
    expect(rawUnits(refund?.[1] ?? "")).toBe(refundedJob.amount);
    expect(money.rows.some(([key]) => key.toLowerCase().includes("fee"))).toBe(false);
    expect(money.rows.some(([key]) => key.toLowerCase().includes("treasury"))).toBe(false);
  });

  it("verdict frame reads REJECT (client-refund) — the onchain outcome outranks the pure gate", () => {
    const verdict = frame(frames, "verdict");
    const label = verdict.rows.find(([key]) => key === "verdict");
    expect(label?.[1]).toBe("REJECT (client-refund)");
    expect(verdict.rows.some(([key]) => key === "metaBlock ≥ minBlock")).toBe(true);
  });

  it("books frame books a refund line", () => {
    const books = frame(frames, "books");
    expect(books.rows.find(([key]) => key === "books line")?.[1]).toContain("refund");
  });
});

describe("buildFrames — open job", () => {
  const openJob: JobView = { ...settledJob, state: "open", metaBlock: undefined, payloadHash: undefined };
  const frames = buildFrames(openJob, null, HEAD, ENS);

  it("still yields all six frames; verdict and money degrade truthfully", () => {
    expect(frames.map((f) => f.id)).toHaveLength(6);
    expect(frame(frames, "verdict").rows.find(([key]) => key === "verdict")?.[1]).toBe("· pending settlement");
    expect(frame(frames, "money").rows.find(([key]) => key === "state")?.[1]).toContain("open");
  });
});
