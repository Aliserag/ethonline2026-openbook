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
    "lending/3.1.0": "{ markets(first: 3) { id } }",
    "dex-amm/4.0.1": "{ pools(first: 3) { id } }",
  };
  return queries[dataset.schema] ?? "{ __typename }";
}
