import type { JSX } from "react";
import { readSellers, venuePercent, type MarketSellerRow } from "../components/Market";
import { getPublicClient } from "../data/chain";
import { platformFee } from "../data/escrow";
import { useLiveValue } from "../ui/useLiveValue";
import { datasetTitle, freshnessPromise, priceLabel } from "../copy/plain";
import { ensRecordUrl, explorerAddressUrl, truncateHash, usdc6 } from "../format";
import { CONFIG } from "../config";
import { parsePriceToAmount6dec } from "../../../mcp/src/ens";

function chainOf(datasetId: string): "arbitrum" | "ethereum" {
  return CONFIG.datasets.find((d) => d.id === datasetId)?.chain ?? "arbitrum";
}

function priceText(raw: string | null): string {
  if (raw === null) return "price not set";
  try {
    return priceLabel(parsePriceToAmount6dec(raw));
  } catch {
    return raw;
  }
}

function SellerCard({ row, statsNote }: { row: MarketSellerRow; statsNote: string | null }): JSX.Element {
  return (
    <article className="seller">
      <h3>
        <a href={ensRecordUrl(row.name)} target="_blank" rel="noreferrer" title="the live ENSv2 records on Sepolia">
          {row.name}
        </a>
      </h3>
      <p className="small seller__promise">
        {row.sla ? freshnessPromise(row.sla.maxBlockLag, chainOf(row.menu[0]?.id ?? "")) : "no freshness promise published"}
      </p>
      <ul className="seller__menu">
        {row.menu.map((m) => (
          <li key={m.id}>
            <span>{datasetTitle(m.id)}</span>
            <span className="mono">{priceText(row.priceByDataset[m.id] ?? null)}</span>
          </li>
        ))}
      </ul>
      <dl className="kv">
        <dt>jobs</dt>
        <dd>{row.stats ? `${row.stats.jobs} created · ${row.stats.delivered} delivered` : "none indexed yet"}</dd>
        <dt>settled</dt>
        <dd>{row.stats ? `${usdc6(row.stats.settled)} USDC` : "0.00 USDC"}</dd>
        <dt>refunded</dt>
        <dd>{row.stats ? `${usdc6(row.stats.refunded)} USDC` : "0.00 USDC"}</dd>
        {statsNote && row.stats && (
          <>
            <dt>stats</dt>
            <dd>{statsNote}</dd>
          </>
        )}
        {row.operator && (
          <>
            <dt>operator</dt>
            <dd>
              <a href={explorerAddressUrl(row.operator)} target="_blank" rel="noreferrer">
                {truncateHash(row.operator)}
              </a>
            </dd>
          </>
        )}
      </dl>
    </article>
  );
}

export function MarketSection(): JSX.Element {
  const sellers = useLiveValue(readSellers, { pollMs: 120_000, staleAfterMs: 360_000, cacheKey: "market.sellers" });
  const venue = useLiveValue(() => platformFee(getPublicClient()), { pollMs: 60_000, staleAfterMs: 180_000 });
  return (
    <section id="market" className="section wrap" aria-labelledby="market-title">
      <div className="section__head">
        <h2 id="market-title">The market</h2>
        <p className="lede">
          A seller is an ENS name with four records: what it sells, the price, the freshness promise, and where to
          pay. Publish them under openbook.eth and buyers can find you. Two reference sellers we operate are listed
          today. Purchases made from this page pay the Circle seller wallet named by the dataset's ENS record,
          so they appear in the books below.
        </p>
      </div>
      {sellers.value === null && (
        <p className="small">
          {sellers.state === "error"
            ? `The seller list could not be read right now (${sellers.reason ?? "unknown"}).`
            : "Reading the sellers from ENS…"}
        </p>
      )}
      {sellers.value !== null && (
        <div className="market__grid">
          {sellers.value.sellers.map((row) => (
            <SellerCard
              key={row.name}
              row={row}
              statsNote={
                sellers.value!.statsSource === "live"
                  ? null
                  : `${sellers.value!.statsSource === "cache" ? "last read" : "snapshot from"} ${new Date(sellers.value!.statsAt).toLocaleTimeString()}`
              }
            />
          ))}
        </div>
      )}
      <p className="venue small">
        The venue takes {venue.value ? venuePercent(venue.value.feeBP) : "2%"} of every settlement, paid to a
        treasury that can only spend within onchain limits
        {venue.value ? (
          <>
            {" "}
            (
            <a href={explorerAddressUrl(venue.value.treasury)} target="_blank" rel="noreferrer">
              {truncateHash(venue.value.treasury)}
            </a>
            )
          </>
        ) : null}
        . Read live from the escrow.
      </p>
    </section>
  );
}
