/**
 * Marketplace buyer router (W2) — compare the sellers offering a schema and
 * pick one per strategy. Pure and deterministic: no network, no keys, no
 * state. The buyer CLI builds `SellerQuote`s from live ENS records
 * (mcp/src/ens.ts) and hands them to `pickSeller`; the app surfaces the same
 * picks for display.
 *
 * Strategy (frozen by the marketplace brief, spec §3 W2):
 *   fresh — tighter maxBlockLag wins; price breaks ties.
 *   cheap — lower price wins; tighter maxBlockLag breaks ties.
 */
import type { Address } from "viem";

/** Per-provider market stats over the shared escrow (frozen W4 shape). */
export interface ProviderStats {
  id: Address;
  jobs: number;
  settled: bigint;
  refunded: bigint;
  delivered: number;
  avgLagBlocks: number;
  lastJobAt: bigint;
}

/** One priceable offer for a dataset (frozen W2 shape + serving address). */
export interface SellerQuote {
  /** seller ENS name, e.g. "openbook.eth" or "alpha.openbook.eth" */
  name: string;
  /** dataset id the offer prices, e.g. "aave-v3-arbitrum-lending" */
  datasetId: string;
  /** price in 6-decimal USDC units, resolved live from the svc.price record */
  priceUsdc: number;
  /** SLA min block lag (blocks behind chain head the data must satisfy) */
  maxBlockLag: number;
  /** payout address from svc.payee */
  payee: Address;
  /** the address the seller's loop serves as (svc.operator, falling back to
   * svc.payee) — the job's onchain provider when buying from this seller */
  operator: Address;
  /** per-provider market stats over the shared escrow (null until queried) */
  stats: ProviderStats | null;
}

export type PickStrategy = "fresh" | "cheap";

/**
 * Pick the seller to buy from. Ties in both dimensions keep the earlier
 * offer (stable sort — deterministic output for identical offers).
 */
export function pickSeller(
  quotes: readonly SellerQuote[],
  strategy: PickStrategy = "fresh",
): SellerQuote {
  if (quotes.length === 0) {
    throw new Error(`pickSeller: no quotes to pick from (strategy=${strategy})`);
  }
  const sorted = [...quotes].sort((a, b) => {
    if (strategy === "fresh") {
      return a.maxBlockLag - b.maxBlockLag || a.priceUsdc - b.priceUsdc;
    }
    return a.priceUsdc - b.priceUsdc || a.maxBlockLag - b.maxBlockLag;
  });
  return sorted[0] as SellerQuote;
}
