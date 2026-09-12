import { useMemo, type JSX } from "react";
import { boardRows, latestRefund, totalsWithRuns, useFeed } from "../data/feed";
import { useSessionRuns } from "../flow/session";
import { useLiveValue } from "../ui/useLiveValue";
import { getPublicClient } from "../data/chain";
import { platformFee } from "../data/escrow";
import { readSellers } from "../components/Market";
import { priceLabel } from "../copy/plain";
import { ReceiptCard } from "../ui/ReceiptCard";
import { sellerNameMap } from "../data/sellers";

export function Hero({ onBuy, onFail }: { onBuy(): void; onFail(): void }): JSX.Element {
  const feed = useFeed();
  const runs = useSessionRuns();
  const fee = useLiveValue(() => platformFee(getPublicClient()), { pollMs: 60_000, staleAfterMs: 180_000 });
  const sellers = useLiveValue(readSellers, { pollMs: 120_000, staleAfterMs: 360_000, cacheKey: "market.sellers" });
  const jobs = feed.value?.jobs ?? [];

  const refund = useMemo(() => {
    const rows = boardRows(jobs, runs, 200, sellerNameMap(sellers.value));
    const sessionRefund = runs.find((r) => r.outcome === "refunded");
    if (sessionRefund) return rows.find((r) => r.jobId === sessionRefund.jobId) ?? null;
    const lr = latestRefund(jobs);
    return lr ? (rows.find((r) => r.jobId === lr.jobId.toString()) ?? null) : null;
  }, [jobs, runs, sellers.value]);

  const t = totalsWithRuns(jobs, runs, fee.value?.feeBP ?? 200);
  const sellerCount = sellers.value ? sellers.value.sellers.length : null;

  return (
    <section className="hero wrap" aria-labelledby="hero-title">
      <div className="hero__top">
        <span className="hero__brand">
          <span className="hero__mark" aria-hidden="true">
            OB
          </span>
          OpenBook
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
            OpenBook is a data marketplace for AI agents. Every purchase carries a freshness promise, locked into
            an escrow on Arc the moment it is paid. Fresh data settles and the seller is paid. Stale data cannot be paid for:
            the contract refuses, and the escrow returns the money.
          </p>
          <div className="hero__actions">
            <button type="button" className="btn" onClick={onBuy}>
              Buy a query
            </button>
            <button type="button" className="linkbtn hero__alt" onClick={onFail}>
              or watch a refund happen
            </button>
          </div>
          <p className="tiny hero__note">
            Both run a real purchase on the live escrow, right here, in about twenty seconds. No wallet, no keys:
            our demo wallet pays with testnet USDC. Arc testnet, ENSv2 on Sepolia, The Graph.
          </p>
        </div>
        <ReceiptCard row={refund} state={feed.state} reason={feed.reason} />
      </div>
      <div className="counters" aria-label="live totals">
        <div className="figure">
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
          <strong>{feed.value ? priceLabel(t.settledUsdc - t.feesUsdc) : feed.state === "error" ? "?" : "…"}</strong>
          <span className="small">
            {feed.value
              ? `paid out to sellers after the venue fee · ${priceLabel(t.feesUsdc)} earned by the venue`
              : "paid out to sellers"}
          </span>
        </div>
        <div className="figure">
          <strong>{sellerCount ?? "…"}</strong>
          <span className="small">sellers listed on ENS (openbook.eth and its subnames)</span>
        </div>
      </div>
    </section>
  );
}
