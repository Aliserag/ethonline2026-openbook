/**
 * TxBlock — the transaction card: verdict stamp, ArcScan link, copyable
 * hash, and the kv fee/split rows. Links to the Arc testnet explorer and
 * copies the FULL hash on demand (never the truncated display).
 */
import type { JSX } from "react";
import { explorerUrl, truncateHash } from "../../format";
import type { TxData } from "../registry";
import { HashChip } from "./HashChip";
import { KvBlock } from "./KvBlock";

export function TxBlock({
  data,
  onCopy,
}: {
  data: TxData;
  onCopy?: (hash: string) => void;
}): JSX.Element {
  const kindClass = data.kind !== undefined ? ` tape__tx-stamp--${data.kind}` : "";
  const stampText = data.kind !== undefined ? data.kind.toUpperCase() : "TX";
  return (
    <div className="tape__tx">
      <div className="tape__txhead">
        <span className={`tape__tx-stamp${kindClass}`}>{stampText}</span>
        <span className="tape__txlink">
          <a href={explorerUrl(data.hash)} target="_blank" rel="noreferrer">
            {truncateHash(data.hash, 10, 8)} ↗
          </a>
          {onCopy !== undefined && (
            <>
              {" · "}
              <HashChip hash={data.hash} onCopy={onCopy} />
            </>
          )}
        </span>
      </div>
      {data.title !== undefined && <div className="tape__tx-title">{data.title}</div>}
      {data.rows !== undefined && <KvBlock data={{ rows: data.rows }} onCopy={onCopy} />}
      {data.note !== undefined && <div className="tape__note">{data.note}</div>}
    </div>
  );
}
