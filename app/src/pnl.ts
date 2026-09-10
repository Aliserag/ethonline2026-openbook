/**
 * P&L panel data: the open-book Studio subgraph (Task 4) via the SAME
 * hosted endpoint the MCP get_pnl tool uses (config.pnl). The Studio query
 * endpoint is account-scoped and PUBLIC — no key required. ({GRAPH_GATEWAY_KEY}
 * interpolation kept for configs that still carry the placeholder.)
 */
import { hostedQuery, type FetchLike } from "../../mcp/src/gateway";
import { CONFIG } from "./config";

export interface PnlRow {
  id: string;
  revenue: string;
  costs: string;
  refunds: string;
  net: string;
}

export interface PnlResult {
  rows: PnlRow[];
  metaBlock: number | null;
}

export async function fetchPnl(key?: string, fetchImpl?: FetchLike): Promise<PnlResult> {
  const endpoint = CONFIG.pnl.endpoint.replace("{GRAPH_GATEWAY_KEY}", key ?? "");
  const { data, meta } = await hostedQuery({ url: endpoint, query: CONFIG.pnl.query, fetchImpl });
  const rows: PnlRow[] = [];
  if (typeof data === "object" && data !== null) {
    const dailyRaw = (data as Record<string, unknown>)["dailyPnLs"];
    if (Array.isArray(dailyRaw)) {
      for (const entry of dailyRaw) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        rows.push({
          id: typeof row["id"] === "string" ? row["id"] : String(row["id"]),
          revenue: typeof row["revenue"] === "string" ? row["revenue"] : String(row["revenue"]),
          costs: typeof row["costs"] === "string" ? row["costs"] : String(row["costs"]),
          refunds: typeof row["refunds"] === "string" ? row["refunds"] : String(row["refunds"]),
          net: typeof row["net"] === "string" ? row["net"] : String(row["net"]),
        });
      }
    }
  }
  return { rows, metaBlock: meta.block };
}
