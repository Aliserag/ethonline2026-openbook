/**
 * T12 tour read-model tests (fix 2/5): `actJobView` must keep the walk's
 * terminal state — a spent job stays on record (settled/refunded), so BOTH
 * step 4 and step 5 read done, including after a reload (the record is
 * rehydrated from storage by the act module). A fresh lifecycle clears the
 * old verdict; a spent job is never mistaken for an active one.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { actJobView } from "./Tour";
import { getActJob, setActJob, type ActJob } from "../console/commands/act";

function baseState() {
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

const live: ActJob = {
  datasetId: "aave-v3-arbitrum-lending",
  jobId: "19",
  minBlock: 504_310_000,
  amountUsdc: 150000,
  deadline: 1_789_220_000n,
  createdAt: 1_789_210_000,
};

describe("actJobView (tour chips over the shared act lifecycle)", () => {
  afterEach(() => {
    setActJob(null);
  });

  it("no act job: pay/deliver/settle chips stay neutral and an old verdict is NOT erased", () => {
    const prev = { ...baseState(), settle: { verdict: "APPROVE", minBlock: 0 } };
    const view = actJobView(prev);
    expect(view.job).toBeNull();
    expect(view.delivery).toBeNull();
    expect(view.settle).toEqual(prev.settle);
  });

  it("live funded job (no payload): pay done, deliver + settle not", () => {
    setActJob(live);
    const view = actJobView(baseState());
    expect(view.job?.jobId).toBe("19");
    expect(view.delivery).toBeNull();
    expect(view.settle).toBeNull();
  });

  it("delivered job: step 4 done, settle chip still waits for the verdict", () => {
    setActJob({ ...live, payloadHash: `0x${"ab".repeat(32)}`, metaBlock: 100 });
    const view = actJobView({ ...baseState(), settle: { verdict: "APPROVE", minBlock: 0 } });
    expect(view.delivery).not.toBeNull();
    expect(view.settle).toBeNull(); // the old verdict belongs to a prior lifecycle… here: none
  });

  it("TERMINAL settled record: step 4 AND step 5 both read done (walk completes, stable on reload)", () => {
    setActJob({ ...live, payloadHash: `0x${"ab".repeat(32)}`, metaBlock: 100, outcome: "settled", txHash: `0xc79ea5a3${"1".repeat(56)}` });
    const view = actJobView(baseState()); // fresh session (reload): no local settle state
    expect(view.delivery).not.toBeNull();
    expect(view.settle).not.toBeNull();
    expect(view.settle?.verdict).toBe("APPROVE");
  });

  it("TERMINAL refunded record: step 5 reads done as a refund", () => {
    setActJob({ ...live, payloadHash: `0x${"ab".repeat(32)}`, metaBlock: 100, outcome: "refunded" });
    const view = actJobView(baseState());
    expect(view.delivery).not.toBeNull();
    expect(view.settle?.verdict).toBe("REJECT");
  });

  it("a fresh buy (new non-terminal record) wipes the previous verdict", () => {
    setActJob({ ...live, outcome: "settled", txHash: `0xc79ea5a3${"1".repeat(56)}` });
    const prev = actJobView(baseState());
    expect(prev.settle).not.toBeNull();
    setActJob({ ...live, jobId: "20", minBlock: 504_310_100 }); // buy B: no payload yet
    const next = actJobView(prev);
    expect(next.job?.jobId).toBe("20");
    expect(next.delivery).toBeNull(); // the OLD payload must not show as delivered
    expect(next.settle).toBeNull(); // and the old verdict must not stamp the new lifecycle
  });

  it("a refreshed act job (same id, terminal) keeps its derived verdict", () => {
    setActJob({ ...live, payloadHash: `0x${"ab".repeat(32)}`, metaBlock: 100, outcome: "settled" });
    const first = actJobView(baseState());
    expect(first.settle?.verdict).toBe("APPROVE");
    // a rehydrate-style re-set of the same terminal record (module state is
    // the source of truth, never a cached read)
    setActJob({ ...live, payloadHash: `0x${"ab".repeat(32)}`, metaBlock: 100, outcome: "settled" });
    const second = actJobView(first);
    expect(second.settle?.verdict).toBe("APPROVE");
    expect(second.delivery).not.toBeNull();
    expect(getActJob()?.outcome).toBe("settled");
  });
});
