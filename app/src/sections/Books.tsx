import { useEffect, useRef, type JSX } from "react";
import { boardRows, totals, useFeed, type BoardRow } from "../data/feed";
import { useSessionRuns } from "../flow/session";
import { useLiveValue } from "../ui/useLiveValue";
import { getPublicClient } from "../data/chain";
import { platformFee } from "../data/escrow";
import { ADDR } from "../data/addresses";
import { datasetTitle, priceLabel, relativeTime } from "../copy/plain";
import { explorerUrl, truncateHash } from "../format";
import { Badge } from "../ui/Badge";
import { readSellers } from "../components/Market";
import { sellerNameMap } from "../data/sellers";

const BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256", name: "" }],
  },
] as const;

function Row({ row, isNew }: { row: BoardRow; isNew: boolean }): JSX.Element {
  const kind = row.outcome === "settled" ? "settled" : row.outcome === "refunded" ? "refunded" : "open";
  const expired = row.outcome === "open" && row.deadline !== undefined && row.deadline < Math.floor(Date.now() / 1000);
  return (
    <li className={`board__row${isNew ? " board__row--new" : ""}`}>
      <span className="tiny">{relativeTime(row.at)}</span>
      <span className="mono">#{row.jobId}</span>
      <span>{row.datasetId ? datasetTitle(row.datasetId) : `sold by ${row.sellerName ?? (row.seller ? truncateHash(row.seller) : "an unlisted seller")}`}</span>
      <span className="mono">{priceLabel(row.amount)}</span>
      <span>
        <Badge kind={kind}>
          {row.outcome === "settled" ? "Settled" : row.outcome === "refunded" ? "Refunded" : expired ? "Expired, refundable" : "In progress"}
        </Badge>
        {row.confirming && <span className="tiny"> confirming</span>}
      </span>
      <span className="tiny">
        {row.txHash ? (
          <a href={explorerUrl(row.txHash)} target="_blank" rel="noreferrer">
            {truncateHash(row.txHash, 8, 6)}
          </a>
        ) : (
          <a href={`#theater/${row.jobId}`}>replay</a>
        )}
      </span>
    </li>
  );
}

export function Books(): JSX.Element {
  const feed = useFeed();
  const runs = useSessionRuns();
  const fee = useLiveValue(() => platformFee(getPublicClient()), { pollMs: 60_000, staleAfterMs: 180_000 });
  const treasury = useLiveValue(
    () =>
      getPublicClient().readContract({
        address: ADDR.usdc,
        abi: BALANCE_ABI,
        functionName: "balanceOf",
        args: [ADDR.policy],
      }) as Promise<bigint>,
    { pollMs: 30_000, staleAfterMs: 90_000 },
  );
  const sellers = useLiveValue(readSellers, { pollMs: 120_000, staleAfterMs: 360_000, cacheKey: "market.sellers" });
  const jobs = feed.value?.jobs ?? [];
  const rows = boardRows(jobs, runs, 12, sellerNameMap(sellers.value));
  const t = totals(jobs, fee.value?.feeBP ?? 200);
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const fresh = new Set(primed.current ? rows.filter((r) => !seen.current.has(r.jobId)).map((r) => r.jobId) : []);
  useEffect(() => {
    for (const r of rows) seen.current.add(r.jobId);
    if (rows.length > 0) primed.current = true;
  });
  const refusals = feed.value?.refusals ?? [];

  return (
    <section id="books" className="section wrap" aria-labelledby="books-title">
      <div className="section__head">
        <h2 id="books-title">The books are public</h2>
        <p className="lede">
          Every payment, refund and fee on the OpenBook escrow, indexed straight from Arc by The Graph. Nothing on
          this page is typed in.
        </p>
      </div>
      <div className="books__figures">
        <div className="figure">
          <strong>{feed.value ? priceLabel(t.settledUsdc) : feed.state === "error" ? "?" : "…"}</strong>
          <span className="small">settled to sellers</span>
        </div>
        <div className="figure figure--back">
          <strong>{feed.value ? priceLabel(t.refundedUsdc) : feed.state === "error" ? "?" : "…"}</strong>
          <span className="small">refunded to buyers</span>
        </div>
        <div className="figure">
          <strong>{feed.value ? priceLabel(t.feesUsdc) : feed.state === "error" ? "?" : "…"}</strong>
          <span className="small">venue fees earned</span>
        </div>
        <div className="figure">
          <strong>{treasury.value !== null ? priceLabel(treasury.value) : "…"}</strong>
          <span className="small">treasury balance, live from Arc (fees plus seller revenue held under policy)</span>
        </div>
      </div>
      <p className="tiny books__state" aria-live="polite">
        {feed.state === "live"
          ? `live · updated ${new Date(feed.at).toLocaleTimeString()}`
          : feed.state === "stale"
            ? `last read ${new Date(feed.at).toLocaleTimeString()} · ${feed.reason ?? "refreshing"}`
            : feed.state === "error"
              ? `the ledger could not be read right now (${feed.reason ?? "unknown"})`
              : "reading the ledger…"}{" "}
        <button type="button" className="linkbtn" onClick={feed.refresh}>
          refresh
        </button>
      </p>
      <ol className="board" aria-label="latest settlements and refunds">
        {rows.length === 0 && (
          <li className="board__empty">
            {feed.state === "loading"
              ? "Reading the ledger…"
              : feed.state === "error"
                ? "The ledger could not be read right now. Runs you start above still appear here."
                : "No purchases indexed yet."}
          </li>
        )}
        {rows.map((r) => (
          <Row key={r.jobId} row={r} isNew={fresh.has(r.jobId)} />
        ))}
      </ol>
      <div className="refusals">
        <h3>
          {feed.value
            ? `The treasury refused ${refusals.length} withdrawal${refusals.length === 1 ? "" : "s"}`
            : "The treasury refuses withdrawals, onchain"}
        </h3>
        <p className="small">
          Seller revenue lands in a treasury with a per-transaction cap, a daily cap and an allowlist. Every refused
          withdrawal is published onchain, so the books show the refusals too.
        </p>
        {refusals.length > 0 && (
          <ul className="refusals__list">
            {refusals.slice(0, 6).map((r) => (
              <li key={r.id}>
                <span className="mono">{r.reason.replace(/_/g, " ").toLowerCase()}</span>
                <a href={explorerUrl(r.id.slice(0, 66))} target="_blank" rel="noreferrer">
                  {truncateHash(r.id.slice(0, 66), 8, 6)}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
