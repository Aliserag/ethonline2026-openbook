import { useMemo, type JSX } from "react";
import { boardRows, latestRefund, totals, useFeed } from "../data/feed";
import { useSessionRuns } from "../flow/session";
import { useLiveValue } from "../ui/useLiveValue";
import { getPublicClient } from "../data/chain";
import { platformFee } from "../data/escrow";
import { readSellers } from "../components/Market";
import { priceLabel } from "../copy/plain";
import { ReceiptCard } from "../ui/ReceiptCard";

export function Hero({ onBuy, onFail }: { onBuy(): void; onFail(): void }): JSX.Element {
  const feed = useFeed();
  const runs = useSessionRuns();
  const fee = useLiveValue(() => platformFee(getPublicClient()), { pollMs: 60_000, staleAfterMs: 180_000 });
  const sellers = useLiveValue(readSellers, { pollMs: 60_000, staleAfterMs: 180_000, cacheKey: "market.sellers" });
  const jobs = feed.value?.jobs ?? [];

  const refund = useMemo(() => {
    const rows = boardRows(jobs, runs, 200);
    const sessionRefund = runs.find((r) => r.outcome === "refunded");
    if (sessionRefund) return rows.find((r) => r.jobId === sessionRefund.jobId) ?? null;
    const lr = latestRefund(jobs);
    return lr ? (rows.find((r) => r.jobId === lr.jobId.toString()) ?? null) : null;
  }, [jobs, runs]);

  const t = totals(jobs, fee.value?.feeBP ?? 200);
  const sellerCount = sellers.value ? sellers.value.sellers.length : null;

  return (
    <section className="hero wrap" aria-labelledby="hero-title">
      <div className="hero__top">
        <span className="hero__brand">
          <span className="hero__mark" aria-hidden="true">
            OB
          </span>
          OpenBook
          <span className="tiny">a data marketplace for AI agents</span>
        </span>
        <nav className="hero__nav" aria-label="sections">
          <a href="#try">Try it</a>
          <a href="#market">Market</a>
          <a href="#books">Books</a>
          <a href="#how">How it works</a>
        </nav>
      </div>
      <div className="hero__grid">
        <div>
          <h1 id="hero-title">When an agent buys stale data, the money comes back. Automatically.</h1>
          <p className="lede">
            Every purchase carries a freshness promise, locked into an escrow on Arc the moment it is paid.
            Fresh data settles and the seller is paid. Stale data is refunded onchain, with nobody asked.
          </p>
          <div className="hero__actions">
            <button type="button" className="btn" onClick={onBuy}>
              Buy a query
            </button>
            <button type="button" className="btn btn--ghost" onClick={onFail}>
              Watch a refund happen
            </button>
          </div>
          <p className="tiny hero__note">
            No wallet, no keys. Our demo wallet pays with testnet USDC on the live escrow. Arc testnet, ENSv2 on
            Sepolia, The Graph.
          </p>
        </div>
        <ReceiptCard row={refund} state={feed.state} reason={feed.reason} />
      </div>
      <div className="counters" aria-label="live totals">
        <div className="figure figure--back">
          <strong>{feed.value ? t.refundedCount : feed.state === "error" ? "?" : "…"}</strong>
          <span className="small">
            {feed.value
              ? `refunds executed by the escrow · ${priceLabel(t.refundedUsdc)} returned to buyers`
              : feed.state === "error"
                ? "refunds executed by the escrow · the ledger could not be read right now"
                : "refunds executed by the escrow"}
          </span>
        </div>
        <div className="figure">
          <strong>{feed.value ? priceLabel(t.settledUsdc) : feed.state === "error" ? "?" : "…"}</strong>
          <span className="small">
            {feed.value
              ? `settled across ${t.settledCount} purchases · ${priceLabel(t.feesUsdc)} earned by the venue`
              : "settled to sellers"}
          </span>
        </div>
        <div className="figure">
          <strong>{sellerCount ?? "…"}</strong>
          <span className="small">sellers listed under openbook.eth, read from ENS</span>
        </div>
      </div>
    </section>
  );
}
