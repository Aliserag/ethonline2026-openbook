/**
 * P&L panel data: the open-book Studio subgraph (Task 4) via the SAME
 * hosted endpoint the MCP get_pnl tool uses (config.pnl). The Studio query
 * endpoint is account-scoped and PUBLIC — no key required. ({GRAPH_GATEWAY_KEY}
 * interpolation kept for configs that still carry the placeholder.)
 *
 * Demo resilience: `fetchPnlResilient` serves live by default, falls back to
 * the persistent last-good payload (localStorage) on a failed refresh, then
 * to the build-time snapshot asset (`pnl-snapshot.json`, written by
 * scripts/fetch-pnl-snapshot.mjs). Every degraded serve is labeled with its
 * source and the time the payload was taken — never presented as live.
 */
import { hostedQuery, type FetchLike } from "../../mcp/src/gateway";
import { readLastGood, writeLastGood } from "./data/cache";
import { CONFIG } from "./config";

export interface PnlRow {
  id: string;
  /** Unix seconds of the bucket's first event — the human day label. */
  startedAt: number | null;
  revenue: string;
  costs: string;
  refunds: string;
  net: string;
}

export interface RefundEvent {
  id: string;
  jobId: string;
  reason: string;
}

export interface PnlResult {
  rows: PnlRow[];
  refundEvents: RefundEvent[];
  metaBlock: number | null;
}

/** Where a served P&L payload came from (labeled in the UI when not live). */
export type PnlSource = "live" | "cache" | "snapshot";

/** The build-time snapshot asset shape (scripts/fetch-pnl-snapshot.mjs). */
export interface PnlSnapshotFile {
  takenAt: string;
  dailyPnLs?: Array<Record<string, unknown>>;
  refundIssueds?: Array<Record<string, unknown>>;
  providers?: Array<Record<string, unknown>>;
}

export interface PnlOutcome extends PnlResult {
  source: PnlSource;
  /** when the payload was taken: now for live, otherwise the cache/snapshot time */
  takenAt: number;
  /** the LIVE read failed but a fallback served; keep the reason available */
  liveError?: unknown;
}

const PNL_CACHE_KEY = "pnl.rows";

/** Map a Studio payload to the P&L view (shared by the live fetch and the snapshot loader). */
export function parsePnlPayload(data: unknown): PnlResult {
  const rows: PnlRow[] = [];
  if (typeof data === "object" && data !== null) {
    const dailyRaw = (data as Record<string, unknown>)["dailyPnLs"];
    if (Array.isArray(dailyRaw)) {
      for (const entry of dailyRaw) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        const ts = row["startedAt"];
        rows.push({
          id: typeof row["id"] === "string" ? row["id"] : String(row["id"]),
          startedAt: typeof ts === "string" ? Number(ts) : typeof ts === "number" ? ts : null,
          revenue: typeof row["revenue"] === "string" ? row["revenue"] : String(row["revenue"]),
          costs: typeof row["costs"] === "string" ? row["costs"] : String(row["costs"]),
          refunds: typeof row["refunds"] === "string" ? row["refunds"] : String(row["refunds"]),
          net: typeof row["net"] === "string" ? row["net"] : String(row["net"]),
        });
      }
    }
  }
  const refundEvents: RefundEvent[] = [];
  if (typeof data === "object" && data !== null) {
    const raw = (data as Record<string, unknown>)["refundIssueds"];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const ev = entry as Record<string, unknown>;
        refundEvents.push({
          id: typeof ev["id"] === "string" ? ev["id"] : String(ev["id"]),
          jobId: typeof ev["jobId"] === "string" ? ev["jobId"] : String(ev["jobId"]),
          reason: typeof ev["reason"] === "string" ? ev["reason"] : String(ev["reason"]),
        });
      }
    }
  }
  return { rows, refundEvents, metaBlock: null };
}

export async function fetchPnl(key?: string, fetchImpl?: FetchLike): Promise<PnlResult> {
  const endpoint = CONFIG.pnl.endpoint.replace("{GRAPH_GATEWAY_KEY}", key ?? "");
  const { data, meta } = await hostedQuery({ url: endpoint, query: CONFIG.pnl.query, fetchImpl });
  return { ...parsePnlPayload(data), metaBlock: meta.block };
}

function snapshotUrl(): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? "/";
  return `${base}pnl-snapshot.json`;
}

async function fetchSnapshotRaw(fetchImpl?: FetchLike): Promise<PnlSnapshotFile | null> {
  try {
    const response = await (fetchImpl ?? fetch)(snapshotUrl());
    if (!response.ok) return null;
    const file = (await response.json()) as unknown;
    if (typeof file !== "object" || file === null) return null;
    const record = file as PnlSnapshotFile;
    if (typeof record.takenAt !== "string" || !Number.isFinite(Date.parse(record.takenAt))) return null;
    return record;
  } catch {
    return null; // no snapshot asset (never built / not deployed) — not an error
  }
}

interface SnapshotView {
  rows: PnlRow[];
  refundEvents: RefundEvent[];
  takenAt: number;
}

async function loadSnapshotImpl(fetchImpl?: FetchLike): Promise<SnapshotView | null> {
  const record = await fetchSnapshotRaw(fetchImpl);
  if (record === null) return null;
  const result = parsePnlPayload({
    dailyPnLs: record.dailyPnLs ?? [],
    refundIssueds: record.refundIssueds ?? [],
  });
  return { rows: result.rows, refundEvents: result.refundEvents, takenAt: Date.parse(record.takenAt) };
}

let snapshotPromise: Promise<SnapshotView | null> | null = null;

/** The build-time snapshot payload (memoized). `fetchImpl` is a test seam. */
export function loadSnapshotFile(fetchImpl?: FetchLike): Promise<SnapshotView | null> {
  if (fetchImpl !== undefined) return loadSnapshotImpl(fetchImpl);
  snapshotPromise ??= loadSnapshotImpl();
  return snapshotPromise;
}

export interface SnapshotProvidersView {
  providers: Array<Record<string, unknown>>;
  takenAt: number;
}

/** The providers array the snapshot carries (Market's provider-stats fallback). */
export async function loadSnapshotProvidersView(fetchImpl?: FetchLike): Promise<SnapshotProvidersView | null> {
  const record = await fetchSnapshotRaw(fetchImpl);
  if (record === null) return null;
  return { providers: record.providers ?? [], takenAt: Date.parse(record.takenAt) };
}

/**
 * Live → last-good cache → build-time snapshot, in that order, every degraded
 * serve labeled. Throws only when ALL sources are unavailable (the caller
 * then shows a calm error with the live reason on hover).
 */
export async function fetchPnlResilient(key?: string, fetchImpl?: FetchLike): Promise<PnlOutcome> {
  try {
    const result = await fetchPnl(key, fetchImpl);
    if (fetchImpl === undefined) writeLastGood(PNL_CACHE_KEY, result);
    return { ...result, source: "live", takenAt: Date.now() };
  } catch (liveError) {
    const cached = readLastGood<PnlResult>(PNL_CACHE_KEY);
    if (cached !== null) {
      return { ...cached.value, source: "cache", takenAt: cached.at, liveError };
    }
    const snapshot = await loadSnapshotFile(fetchImpl);
    if (snapshot !== null) {
      return { rows: snapshot.rows, refundEvents: snapshot.refundEvents, metaBlock: null, source: "snapshot", takenAt: snapshot.takenAt, liveError };
    }
    throw liveError;
  }
}
