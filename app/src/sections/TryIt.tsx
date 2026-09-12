import { useEffect, useRef, useState, type JSX } from "react";
import { CONFIG } from "../config";
import { env } from "../env";
import { createEnsTextReader } from "../../../mcp/src/ens";
import { resolveDatasetQuote, type DatasetQuote } from "../console/commands/act";
import { datasetTitle, freshnessPromise, priceLabel } from "../copy/plain";
import { runPurchase, type PurchaseEvent } from "../flow/purchase";
import { recordRun } from "../flow/session";
import { Stepper } from "../ui/Stepper";
import { explorerUrl, truncateHash } from "../format";

const TX_RE = /^0x[0-9a-fA-F]{64}$/;

/** Detail values: transaction hashes become ArcScan links; everything else prints as is. */
function DetailValue({ value }: { value: string }): JSX.Element {
  const parts = value.split(",").map((v) => v.trim()).filter(Boolean);
  if (parts.length > 0 && parts.every((v) => TX_RE.test(v))) {
    return (
      <>
        {parts.map((hash, i) => (
          <span key={hash}>
            {i > 0 && ", "}
            <a href={explorerUrl(hash)} target="_blank" rel="noreferrer">
              {truncateHash(hash, 10, 8)}
            </a>
          </span>
        ))}
      </>
    );
  }
  return <>{value}</>;
}

const ENS = createEnsTextReader({ rpcUrl: env.sepoliaRpc });

type Summary = { kind: "settled" | "refunded" | "failed"; text: string };

export function TryIt({ armed, onArmedConsumed }: { armed: "fresh" | "fail" | null; onArmedConsumed(): void }): JSX.Element {
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

  // A hero button is the real action: once the quote is in, it runs the purchase.
  useEffect(() => {
    if (armed === null || busy || quote === null) return;
    (armed === "fail" ? failBtn : buyBtn).current?.focus();
    onArmedConsumed();
    void run(armed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, busy, quote]);

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
        gap: result.metaBlock !== undefined && result.minBlock !== undefined && result.minBlock > result.metaBlock ? result.minBlock - result.metaBlock : undefined,
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
            <button ref={buyBtn} type="button" className="btn btn--ghost" disabled={busy || quote === null} onClick={() => run("fresh")}>
              {busy && mode === "fresh" ? "Buying…" : `Buy a query · ${quote ? priceLabel(quote.amountUsdc) : "…"}`}
            </button>
            <button
              ref={failBtn}
              type="button"
              className="linkbtn hero__alt"
              disabled={busy || quote === null}
              onClick={() => run("fail")}
            >
              {busy && mode === "fail" ? "failing on purpose…" : "or make it fail"}
            </button>
          </div>
          <p className="tiny try__hint">
            Buy runs the real purchase. Make it fail runs the same purchase but demands data newer than what
            arrives, so the contract has to refuse payment and the escrow refunds. Both spend our demo wallet's
            testnet USDC on Arc; that wallet is the buyer and the seller in these runs.
          </p>
        </div>
        <div className="try__run">
          {events.length === 0 ? (
            <>
              <p className="small try__idle">What happens when you buy, step by step. Each row turns green as its transaction lands on Arc; a run takes about twenty seconds.</p>
              <Stepper events={[]} mode="fresh" />
            </>
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
                        <dd>
                          <DetailValue value={v} />
                        </dd>
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
