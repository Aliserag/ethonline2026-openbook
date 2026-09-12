/**
 * Plain-English formatters for the landing page. Chain block times are
 * approximations used only for the human duration in parentheses.
 */
export type DatasetChain = "arbitrum" | "ethereum";

export const SECONDS_PER_BLOCK: Record<DatasetChain, number> = { arbitrum: 0.25, ethereum: 12 };

export function blocksToDuration(blocks: number, chain: DatasetChain): string {
  const seconds = blocks * SECONDS_PER_BLOCK[chain];
  if (seconds < 1) return "under a second";
  if (seconds < 90) return `about ${Math.round(seconds)} seconds`;
  const minutes = seconds / 60;
  if (minutes < 90) return `about ${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  return `about ${Math.round(hours)} hours`;
}

const CHAIN_NAME: Record<DatasetChain, string> = { arbitrum: "Arbitrum", ethereum: "Ethereum" };

export function freshnessPromise(maxBlockLag: number, chain: DatasetChain): string {
  return `fresh within ${maxBlockLag} ${CHAIN_NAME[chain]} blocks (${blocksToDuration(maxBlockLag, chain)})`;
}

export function stalenessLabel(metaBlock: number, minBlock: number, _chain: DatasetChain): string {
  const gap = Math.max(0, minBlock - metaBlock);
  return `${gap.toLocaleString("en-US")} block${gap === 1 ? "" : "s"} below the freshness floor`;
}

const TITLES: Record<string, string> = {
  "aave-v3-arbitrum-lending": "Aave V3 lending on Arbitrum",
  "uniswap-v3-arbitrum-dex": "Uniswap V3 pools on Arbitrum",
  "opensea-nft-trades": "OpenSea NFT trades",
  "ens-registrations": "ENS name registrations",
  "overtime-sports-odds": "Overtime sports odds",
};

export function datasetTitle(id: string): string {
  return TITLES[id] ?? id;
}

/** "0.15 USDC" from 6-decimal units; sub-cent amounts keep their digits. */
export function priceLabel(amount6: number | bigint): string {
  const n = Number(amount6) / 1_000_000;
  const text = n >= 0.01 ? n.toFixed(2) : n.toString();
  return `${text} USDC`;
}

export function relativeTime(unixSec: number, nowMs: number = Date.now()): string {
  const delta = Math.max(0, Math.floor(nowMs / 1000) - unixSec);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} h ago`;
  return `${Math.floor(delta / 86400)} d ago`;
}
