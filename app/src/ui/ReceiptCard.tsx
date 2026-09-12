import type { JSX } from "react";
import type { BoardRow } from "../data/feed";
import type { LiveState } from "../data/types";
import { datasetTitle, priceLabel, relativeTime, stalenessLabel } from "../copy/plain";
import { explorerUrl, truncateHash } from "../format";
import { Badge } from "./Badge";

export function refundWhy(reason: string | undefined, delivered = true, gap?: number): string {
  if (gap !== undefined && gap > 0) return `the delivery was ${stalenessLabel(0, gap, "arbitrum")}`;
  if (reason === "STALE_DATA") return "the delivery missed the freshness floor";
  if (reason === "INVALID_HASH") return "the delivery did not match its proof";
  if (delivered) return "the delivery did not clear the freshness check, so the escrow returned the payment";
  return "no valid delivery arrived before the deadline, so the escrow returned the payment";
}

export function ReceiptCard({
  row,
  state,
  reason,
}: {
  row: BoardRow | null;
  state: LiveState;
  reason?: string;
}): JSX.Element {
  if (row === null) {
    return (
      <div className="receipt receipt--empty" aria-live="polite">
        <p className="tiny">Latest refund</p>
        <p className="small" style={{ marginTop: 10 }}>
          {state === "loading"
            ? "Reading the escrow's history…"
            : state === "error"
              ? `The refund history could not be read right now${reason ? ` (${reason})` : ""}. The buttons below still run live.`
              : "No refunds yet. Click Make it fail below to watch one happen."}
        </p>
      </div>
    );
  }
  return (
    <div className="receipt" aria-label="latest refund">
      <div className="receipt__head">
        <span className="tiny">
          Latest refund · {relativeTime(row.at)}
          {row.confirming ? " · confirming" : ""}
        </span>
        <Badge kind="refunded">Refunded</Badge>
      </div>
      <p className="receipt__amount">+{priceLabel(row.amount)}</p>
      <p className="small receipt__sub">back to the buyer: the contract refused to pay, so the escrow returned it</p>
      <dl className="kv">
        <dt>{row.datasetId ? "dataset" : "seller"}</dt>
        <dd>{row.datasetId ? datasetTitle(row.datasetId) : (row.sellerName ?? (row.seller ? truncateHash(row.seller) : "onchain data query"))}</dd>
        <dt>why</dt>
        <dd>{refundWhy(row.refundReason, row.delivered, row.gap)}</dd>
        <dt>job</dt>
        <dd>{row.jobId}</dd>
        {row.txHash && (
          <>
            <dt>receipt</dt>
            <dd>
              <a href={explorerUrl(row.txHash)} target="_blank" rel="noreferrer">
                {truncateHash(row.txHash, 10, 8)} on ArcScan
              </a>
            </dd>
          </>
        )}
        {!row.txHash && (
          <>
            <dt>replay</dt>
            <dd>
              <a href={`#theater/${row.jobId}`}>frame by frame</a>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
