/**
 * The OpenBook reference config is the single source of truth: the app loads
 * the same mcp/config/openbook.json the MCP server and the agent CLIs run —
 * datasets, ENS name, escrow, freshness windows, and the P&L endpoint. Only
 * the JSON is imported (mcp/src/datasets.ts pulls node:fs, which is server
 * only); the shape mirrors its OpenBookConfig interface.
 */
import openbookConfig from "../../mcp/config/openbook.json";

export interface DatasetConfig {
  id: string;
  subgraphId: string;
  schema: string;
  description: string;
  freshness: { maxAge: number };
  priceUsdc: number;
  pinned: boolean;
  /** the dataset's settlement chain — the freshness head reference (Alchemy);
   * the Gateway _meta has no chainHeadBlock field */
  chain: "arbitrum" | "ethereum";
}

export interface AppConfig {
  name: string;
  ens: string;
  escrow: `0x${string}`;
  payee: `0x${string}`;
  operatorKey: string;
  gateway: { keyEnv: string; baseUrl: string };
  pnl: { endpoint: string; query: string };
  datasets: DatasetConfig[];
}

export const CONFIG = openbookConfig as unknown as AppConfig;

/** Deterministic default query per dataset schema (mirrors agent/seller.ts). */
export function defaultQueryFor(dataset: DatasetConfig): string {
  const queries: Record<string, string> = {
    "lending/3.1.0": "{ markets(first: 3, orderBy: totalValueLockedUSD, orderDirection: desc) { id name totalValueLockedUSD } }",
    "dex-amm/4.0.1": "{ pools(first: 3, orderBy: totalValueLockedUSD, orderDirection: desc) { id name totalValueLockedUSD } }",
    "nft-marketplace/2.1.0":
      "{ trades(first: 3, orderBy: timestamp, orderDirection: desc) { timestamp priceETH } marketplaces(first: 1) { name tradeCount cumulativeTradeVolumeETH } }",
    "sports-odds/1.0.0":
      "{ sportMarkets(first: 3, orderBy: timestamp, orderDirection: desc, where: {isOpen: true}) { homeTeam awayTeam homeOdds awayOdds } }",
    "ens/1.0.0":
      "{ registrations(first: 3, orderBy: registrationDate, orderDirection: desc) { registrationDate domain { name } } }",
  };
  return queries[dataset.schema] ?? "{ __typename }";
}
