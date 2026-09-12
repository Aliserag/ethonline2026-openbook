import { useEffect, useRef, useState, type JSX } from "react";
import { CONFIG } from "../config";
import { env } from "../env";
import { createEnsTextReader } from "../../../mcp/src/ens";
import { resolveDatasetQuote, type DatasetQuote } from "../console/commands/act";
import { datasetTitle, freshnessPromise, priceLabel } from "../copy/plain";
import { runPurchase, type PurchaseEvent } from "../flow/purchase";
import { recordRun } from "../flow/session";
import { Stepper } from "../ui/Stepper";

const ENS = createEnsTextReader({ rpcUrl: env.sepoliaRpc });

type Summary = { kind: "settled" | "refunded" | "failed"; text: string };

export function TryIt({ armed }: { armed: "fresh" | "fail" | null }): JSX.Element {
  const [datasetId, setDatasetId] = useState(CONFIG.datasets[0]?.id ?? "");
  const [quote, setQuote] = useState<DatasetQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [mode, setMode] = useState<"fresh" | "fail">("fresh");
  const [events, setEvents] = useState<PurchaseEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const failBtn = useRef<HTMLButtonElement>(null);
  const buyBtn = useRef<HTMLButtonElement>(null);
  const dataset = CONFIG.datasets.find((d) => d.id === datasetId) ?? CONFIG.datasets[0]!;

  useEffect(() => {
    let cancelled = false;
    setQuote(null);
    setQuoteError(null);
    resolveDatasetQuote(dataset, ENS)
      .then((q) => {
        if (!cancelled) setQuote(q);
      })
      .catch((e) => {
        if (!cancelled) setQuoteError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [dataset]);

  useEffect(() => {
    if (armed === "fail") failBtn.current?.focus();
    if (armed === "fresh") buyBtn.current?.focus();
  }, [armed]);

  const run = async (m: "fresh" | "fail"): Promise<void> => {
    if (busy) return;
    setMode(m);
    setEvents([]);
    setSummary(null);
    setBusy(true);
    const result = await runPurchase({
      datasetId: dataset.id,
      mode: m,
      onEvent: (e) => setEvents((prev) => [...prev, e]),
    });
    setBusy(false);
    if (result.ok && result.jobId) {
      recordRun({
        jobId: result.jobId,
        datasetId: dataset.id,
        amount: BigInt(result.amount ?? 0),
        outcome: result.outcome ?? "open",
        txHash: result.txHash,
        at: Math.floor(Date.now() / 1000),
        refundReason: result.refundReason,
      });
      setSummary(
        result.outcome === "settled"
          ? {
              kind: "settled",
              text: `Settled. The seller was paid ${priceLabel(result.amount ?? 0)} minus the 2% venue fee. Every step above is a real transaction on Arc.`,
            }
          : {
              kind: "refunded",
              text: `Refunded. ${priceLabel(result.amount ?? 0)} went back to the buyer because the delivery missed the freshness floor. Nobody approved it; the escrow did it.`,
            },
      );
    } else if (!result.ok) {
      setSummary({ kind: "failed", text: result.reason ?? "The run stopped." });
    }
  };

  return (
    <section id="try" className="section wrap" aria-labelledby="try-title">
      <div className="section__head">
        <h2 id="try-title">Try it. No wallet needed.</h2>
        <p className="lede">
          Pick a dataset and buy one query on the live escrow. Then make the same purchase fail on purpose and
          watch the escrow give the money back.
        </p>
      </div>
      <div className="try">
        <div className="try__pick">
          <label htmlFor="dataset" className="small">
            Dataset
          </label>
          <select id="dataset" value={datasetId} disabled={busy} onChange={(e) => setDatasetId(e.target.value)}>
            {CONFIG.datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {datasetTitle(d.id)}
              </option>
            ))}
          </select>
          <p className="small try__quote" aria-live="polite">
            {quote ? (
              <>
                {priceLabel(quote.amountUsdc)} per query · {freshnessPromise(quote.maxBlockLag, dataset.chain)} ·
                sold by openbook.eth
              </>
            ) : quoteError ? (
              `The price could not be read from ENS: ${quoteError}`
            ) : (
              "Reading the price from ENS…"
            )}
          </p>
          <div className="try__actions">
            <button ref={buyBtn} type="button" className="btn" disabled={busy || quote === null} onClick={() => run("fresh")}>
              {busy && mode === "fresh" ? "Buying…" : `Buy for ${quote ? priceLabel(quote.amountUsdc) : "…"}`}
            </button>
            <button
              ref={failBtn}
              type="button"
              className="btn btn--ghost"
              disabled={busy || quote === null}
              onClick={() => run("fail")}
            >
              {busy && mode === "fail" ? "Failing on purpose…" : "Make it fail"}
            </button>
          </div>
          <p className="tiny try__hint">
            Buy runs the real purchase. Make it fail sets the freshness floor one block above the delivery, so the
            contract must refuse payment and refund. Both spend our demo wallet's testnet USDC on Arc.
          </p>
        </div>
        <div className="try__run">
          {events.length === 0 ? (
            <p className="small try__idle">
              The steps appear here as they happen onchain. A run takes about twenty seconds.
            </p>
          ) : (
            <Stepper events={events} mode={mode} />
          )}
          {summary && (
            <p
              className={`try__summary${summary.kind === "refunded" ? " try__summary--back" : summary.kind === "failed" ? " try__summary--fail" : ""}`}
              role="status"
            >
              {summary.text}
            </p>
          )}
          {events.some((e) => e.data) && (
            <details className="details">
              <summary>Details</summary>
              <dl className="kv">
                {events
                  .filter((e) => e.data)
                  .flatMap((e) =>
                    Object.entries(e.data!).map(([k, v]) => (
                      <div key={`${e.step}-${k}`} style={{ display: "contents" }}>
                        <dt>
                          {e.step} · {k}
                        </dt>
                        <dd>{v}</dd>
                      </div>
                    )),
                  )}
              </dl>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
