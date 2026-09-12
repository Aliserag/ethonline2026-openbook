import type { JSX } from "react";
import type { PurchaseEvent, PurchaseStep } from "../flow/purchase";
import { explorerUrl, truncateHash } from "../format";

const LABELS: Record<PurchaseStep, { title: string; what: string }> = {
  quote: { title: "Price read from ENS", what: "the seller's price and freshness promise, read live from its name" },
  pay: { title: "Paid into escrow", what: "the freshness floor is locked in with the payment" },
  deliver: { title: "Data delivered", what: "one live query through The Graph, stamped with the block it was indexed at" },
  verdict: { title: "Freshness checked", what: "the delivered block is compared with the floor, onchain" },
  settle: { title: "Settled or refunded", what: "the escrow pays the seller, or returns the money" },
  split: { title: "Fee split", what: "98% to the seller, 2% to the venue treasury" },
};

export type StepStatus = "waiting" | "running" | "done" | "failed";

export function stepOrder(mode: "fresh" | "fail"): PurchaseStep[] {
  return mode === "fail"
    ? ["quote", "deliver", "pay", "verdict", "settle"]
    : ["quote", "pay", "deliver", "verdict", "settle", "split"];
}

export function Stepper({ events, mode }: { events: PurchaseEvent[]; mode: "fresh" | "fail" }): JSX.Element {
  const latest = new Map<PurchaseStep, PurchaseEvent>();
  for (const e of events) latest.set(e.step, e);
  const settleVerdict = latest.get("settle")?.data?.verdict;
  return (
    <ol className="stepper" aria-live="polite">
      {stepOrder(mode).map((step, i) => {
        const e = latest.get(step);
        const status: StepStatus = e ? e.status : "waiting";
        const title =
          step === "settle" && status === "done" && settleVerdict
            ? settleVerdict === "APPROVE"
              ? "Settled"
              : "Refunded"
            : LABELS[step].title;
        const outcome = step === "settle" && settleVerdict === "REJECT" ? "refunded" : undefined;
        return (
          <li key={step} className="step" data-status={status} data-outcome={outcome}>
            <span className="step__mark" aria-hidden="true">
              {status === "done" ? "✓" : status === "failed" ? "!" : i + 1}
            </span>
            <div>
              <strong>{title}</strong>
              <p className="small">{e?.detail ?? LABELS[step].what}</p>
            </div>
            <span className="tiny step__tx">
              {status === "running" && "working…"}
              {e?.txHash && (
                <a href={explorerUrl(e.txHash)} target="_blank" rel="noreferrer">
                  {truncateHash(e.txHash, 8, 6)}
                </a>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
