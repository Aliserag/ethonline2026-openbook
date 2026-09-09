/**
 * Shared demo query shapes (agent package). One canonical copy for both the
 * seller serve loop (agent/seller.ts) and the buyer delivery step
 * (agent/buyer-cli.ts) — both serve against the same pinned Messari pins.
 */
import type { DatasetConfig } from "../../mcp/src/datasets";

const DEFAULT_QUERIES: Record<string, string> = {
  "lending/3.1.0": "{ markets(first: 3) { id } }",
  "dex-amm/4.0.1": "{ pools(first: 3) { id } }",
};

/** Deterministic default query for a dataset (falls back to a shape query). */
export function defaultQueryFor(dataset: DatasetConfig): string {
  return DEFAULT_QUERIES[dataset.schema] ?? "{ __typename }";
}
