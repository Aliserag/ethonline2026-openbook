/**
 * Journal step-state derivation (adversarial E2E finding F1):
 * a settled hard-fail must read as "failed", never as in-flight "live".
 */
import { describe, expect, test } from "bun:test";
import { chipClass, deriveSteps, missingHardFailKeys, type StepState } from "./App";

function base(): StepState {
  return {
    quote: null,
    job: null,
    paying: false,
    delivery: null,
    querying: false,
    settling: false,
    settle: null,
  };
}

describe("deriveSteps", () => {
  test("hard-failed storefront resolves to 'failed', not 'live'", () => {
    const steps = deriveSteps(false, false, base());
    expect(steps.resolve).toBe("failed");
  });

  test("resolving (loading) is neutral, not failed", () => {
    const steps = deriveSteps(false, true, base());
    expect(steps.resolve).toBe("");
  });

  test("resolved storefront marks resolve done", () => {
    const steps = deriveSteps(true, false, base());
    expect(steps.resolve).toBe("done");
  });

  test("live pay only while paying with a quote and no job yet", () => {
    const s = base();
    s.quote = { datasetId: "a", amount: 100000, amountUsdc: "0.10", minBlockLag: 50, maxLatencyMs: 2000, payee: "0x1234" };
    expect(deriveSteps(true, false, s).pay).toBe("live");
    s.paying = true;
    expect(deriveSteps(true, false, s).pay).toBe("live");
  });

  test("pay settles to done once funded; settle live only while settling", () => {
    const s = base();
    s.quote = { datasetId: "a", amount: 100000, amountUsdc: "0.10", minBlockLag: 50, maxLatencyMs: 2000, payee: "0x1234" };
    s.job = { jobId: "7", minBlock: 100, hashes: [] };
    expect(deriveSteps(true, false, s).pay).toBe("done");
    s.settling = true;
    expect(deriveSteps(true, false, s).settle).toBe("live");
    s.settling = false;
    s.settle = { verdict: "APPROVE", minBlock: 100 };
    expect(deriveSteps(true, false, s).settle).toBe("done");
  });

  test("deliver done once delivered; querying is live", () => {
    const s = base();
    s.querying = true;
    expect(deriveSteps(true, false, s).deliver).toBe("live");
    s.querying = false;
    s.delivery = {
      dataset: { id: "a", subgraphId: "0x1", schema: "lending/3.1.0", description: "t", freshness: { maxAge: 50 }, priceUsdc: 0.1, pinned: true },
      payloadHash: `0x${"ab".repeat(32)}` as `0x${string}`,
      metaBlock: 100,
      chainHeadBlock: 102,
      freshness: "fresh",
      result: {},
    };
    expect(deriveSteps(true, false, s).deliver).toBe("done");
  });
});

describe("chipClass", () => {
  test("failed maps to 'failed' css class, never blank or live", () => {
    expect(chipClass("failed")).toBe("failed");
  });
  test("neutral maps to blank; done/live pass through", () => {
    expect(chipClass("")).toBe("");
    expect(chipClass("done")).toBe("done");
    expect(chipClass("live")).toBe("live");
  });
});

describe("missingHardFailKeys", () => {
  const rec = (key: string, value: string | null) => ({ key, value });
  const all = () => [
    rec("svc.menu", null), rec("svc.price", null), rec("svc.sla", null),
    rec("svc.payee", null), rec("svc.operator", null), rec("svc.pnl", null),
  ];
  test("all null: exactly price, sla, payee (the HARD_FAIL set)", () => {
    expect(missingHardFailKeys(all())).toEqual(["svc.price", "svc.sla", "svc.payee"]);
  });
  test("price set, menu/sla/payee null: blames sla+payee, never price or menu", () => {
    const r = all(); r[1] = rec("svc.price", "0.10 USDC/query");
    expect(missingHardFailKeys(r)).toEqual(["svc.sla", "svc.payee"]);
  });
  test("menu set, price/sla/payee null: blames price+sla+payee, never menu", () => {
    const r = all(); r[0] = rec("svc.menu", "[]");
    expect(missingHardFailKeys(r)).toEqual(["svc.price", "svc.sla", "svc.payee"]);
  });
  test("payee set only: blames price+sla, never payee", () => {
    const r = all(); r[3] = rec("svc.payee", "0x1234");
    expect(missingHardFailKeys(r)).toEqual(["svc.price", "svc.sla"]);
  });
});
