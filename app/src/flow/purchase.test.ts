import { describe, expect, test } from "bun:test";
import { previewOf, runPurchase, type PurchaseDeps, type PurchaseEvent } from "./purchase";

type Wallet = NonNullable<PurchaseDeps["signer"]>["wallet"];
const wallet = { account: { address: "0xbuyer" }, writeContract: async () => "0xhash" } as unknown as Wallet;

function deps(over: Partial<PurchaseDeps> = {}): PurchaseDeps {
  return {
    quote: async () => ({ price: "0.15 USDC/query", amountUsdc: 150000, maxBlockLag: 50, maxLatencyMs: 2000 }),
    signer: { kind: "demo", wallet, address: "0xbuyer" as `0x${string}` },
    balance: async () => 1_000_000n,
    chainHead: async () => 1000,
    createJob: async () => 42n,
    query: async () => ({ payloadHash: "0xab" as `0x${string}`, metaBlock: 990, proof: "deadbeef" }),
    submit: async () => "0xsubmit" as `0x${string}`,
    attest: async () => "0xattest" as `0x${string}`,
    simulateComplete: async () => ({ reverted: false }),
    verify: async (input) => ({
      verdict: input.metaBlock >= input.minBlock ? "APPROVE" : "REJECT",
      reason: input.metaBlock >= input.minBlock ? undefined : "STALE_DATA",
      minBlock: input.minBlock,
      txHash: "0xsettle",
    }),
    split: async () => ({ seller: 147000n, treasury: 3000n, total: 150000n, feeBP: 200 }),
    hasGatewayKey: true,
    ...over,
  };
}

function steps(events: PurchaseEvent[]): string[] {
  return events.map((e) => `${e.step}:${e.status}`);
}

describe("runPurchase", () => {
  test("fresh mode settles and reports the split", async () => {
    const events: PurchaseEvent[] = [];
    const result = await runPurchase(
      { datasetId: "aave-v3-arbitrum-lending", mode: "fresh", onEvent: (e) => events.push(e) },
      deps(),
    );
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("settled");
    expect(result.jobId).toBe("42");
    expect(steps(events)).toEqual([
      "quote:running", "quote:done",
      "pay:running", "pay:done",
      "deliver:running", "deliver:done",
      "verdict:running", "deliver:done",
      "verdict:done",
      "settle:running", "settle:done",
      "split:running", "split:done",
    ]);
  });

  test("fail mode floors one block above the delivery and refunds", async () => {
    const events: PurchaseEvent[] = [];
    let seenFloor = 0;
    const d = deps({
      createJob: async (params) => {
        seenFloor = params.minBlock;
        return 43n;
      },
      simulateComplete: async () => ({ reverted: true, reason: "SlaNotMet" }),
    });
    const result = await runPurchase(
      { datasetId: "aave-v3-arbitrum-lending", mode: "fail", onEvent: (e) => events.push(e) },
      d,
    );
    expect(seenFloor).toBe(991);
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("refunded");
    expect(result.refundReason).toBe("STALE_DATA");
    expect(steps(events)).toEqual([
      "quote:running", "quote:done",
      "deliver:running", "deliver:done",
      "pay:running", "pay:done",
      "verdict:running", "deliver:done",
      "verdict:done",
      "settle:running", "settle:done",
    ]);
    expect(events.find((e) => e.step === "verdict" && e.status === "done")?.detail).toContain("SlaNotMet");
  });

  test("low balance fails at pay with the faucet hint", async () => {
    const events: PurchaseEvent[] = [];
    const result = await runPurchase(
      { datasetId: "aave-v3-arbitrum-lending", mode: "fresh", onEvent: (e) => events.push(e) },
      deps({ balance: async () => 10n }),
    );
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("pay");
    expect(result.reason).toContain("faucet.circle.com");
    expect(steps(events).filter((s) => s.endsWith("failed"))).toEqual(["pay:failed"]);
  });

  test("missing gateway key fails at deliver", async () => {
    const events: PurchaseEvent[] = [];
    const result = await runPurchase(
      { datasetId: "aave-v3-arbitrum-lending", mode: "fresh", onEvent: (e) => events.push(e) },
      deps({ hasGatewayKey: false }),
    );
    expect(result.failedStep).toBe("deliver");
    expect(result.reason).toContain("server");
  });

  test("unknown dataset fails at quote", async () => {
    const result = await runPurchase({ datasetId: "nope", mode: "fresh", onEvent: () => {} }, deps());
    expect(result.failedStep).toBe("quote");
  });

  test("a failed settle stops the run with the cause", async () => {
    const events: PurchaseEvent[] = [];
    const result = await runPurchase(
      { datasetId: "aave-v3-arbitrum-lending", mode: "fresh", onEvent: (e) => events.push(e) },
      deps({ verify: async () => { throw new Error("complete reverted onchain (tx 0xdead)"); } }),
    );
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("settle");
    expect(steps(events).at(-1)).toBe("settle:failed");
  });
});

describe("previewOf", () => {
  test("names the first list field and up to three rows with one number each", () => {
    const text = previewOf({ markets: [{ id: "0x1", name: "Aave USDC", totalValueLockedUSD: "1234567.891" }, { id: "0x2", name: "Aave WETH", totalValueLockedUSD: "10" }] });
    expect(text).toBe("2 markets: Aave USDC (totalValueLockedUSD 1,234,567.89) · Aave WETH (totalValueLockedUSD 10)");
  });
  test("falls back to ids and to nested domain names", () => {
    expect(previewOf({ registrations: [{ registrationDate: "1", domain: { name: "vitalik.eth" } }] })).toBe("1 registrations: vitalik.eth (registrationDate 1)");
    expect(previewOf({ pools: [{ id: "0xabc" }] })).toBe("1 pools: 0xabc");
    expect(previewOf({})).toBe("");
  });
});
