/**
 * One live feed for the landing page: scoped jobs, policy refusals and the
 * Arc head. Every landing surface reads it through context, so the page
 * makes one subgraph poll per 20 s instead of one per panel.
 */
import { createContext, createElement, useContext, type JSX, type ReactNode } from "react";
import { STUDIO_GATE } from "./cache";
import { getPublicClient } from "./chain";
import { fetchJobs, fetchPolicyRefusals, type PolicyRefusalView } from "./subgraph";
import type { JobView, Live } from "./types";
import { useLiveValue } from "../ui/useLiveValue";

export interface Feed {
  jobs: JobView[];
  refusals: PolicyRefusalView[];
  indexed: number | null;
  head: number | null;
}

/** A purchase executed in this browser session (shown before the subgraph indexes it). */
export interface SessionRun {
  jobId: string;
  /** blocks below the floor (fail runs) */
  gap?: number;
  datasetId: string;
  amount: bigint;
  outcome: "settled" | "refunded" | "open";
  txHash?: string;
  /** unix seconds */
  at: number;
  refundReason?: string;
}

export interface BoardRow {
  jobId: string;
  datasetId: string;
  amount: bigint;
  outcome: "settled" | "refunded" | "open";
  txHash?: string;
  at: number;
  /** true while only the session knows about the job (subgraph has not indexed it yet) */
  confirming: boolean;
  refundReason?: string;
  seller: `0x${string}` | null;
  /** ENS name of the seller when the address is a listed seller's operator */
  sellerName?: string;
  /** a deliverable was submitted onchain (so a refund means a failed check, not a no-show) */
  delivered: boolean;
  /** blocks the delivery fell short of the freshness floor, when both are known and positive */
  gap?: number;
  /** job deadline, unix seconds (subgraph rows) */
  deadline?: number;
}

/**
 * The OpenBook market escrow (0x967e…) is a fresh instance: its job ids are
 * small (52 at submission). The shared reference escrow (0x0747…) is at six
 * digits. The landing page books only the market escrow, so prices, ids and
 * counts on the page describe one venue; the reference-escrow history stays
 * reachable through the console and the replay theater.
 */
export const MARKET_ESCROW_MAX_JOB_ID = 100_000n;

export function marketJobs(jobs: JobView[]): JobView[] {
  // created-but-never-funded jobs (amount 0, still open) are not purchases
  return jobs.filter((j) => j.jobId < MARKET_ESCROW_MAX_JOB_ID && !(j.state === "open" && j.amount === 0n));
}

export function latestRefund(jobs: JobView[]): JobView | null {
  let best: JobView | null = null;
  for (const j of jobs) {
    if (j.state === "refunded" && (best === null || j.timestamp > best.timestamp)) best = j;
  }
  return best;
}

export interface Totals {
  settledCount: number;
  settledUsdc: bigint;
  refundedCount: number;
  refundedUsdc: bigint;
  feesUsdc: bigint;
}

export function totals(jobs: JobView[], feeBP: number): Totals {
  let settledCount = 0;
  let refundedCount = 0;
  let settledUsdc = 0n;
  let refundedUsdc = 0n;
  for (const j of jobs) {
    if (j.state === "settled") {
      settledCount += 1;
      settledUsdc += j.amount;
    } else if (j.state === "refunded") {
      refundedCount += 1;
      refundedUsdc += j.amount;
    }
  }
  return { settledCount, settledUsdc, refundedCount, refundedUsdc, feesUsdc: (settledUsdc * BigInt(feeBP)) / 10000n };
}

/** Totals with this session's finished runs the subgraph has not indexed yet. */
export function totalsWithRuns(jobs: JobView[], runs: SessionRun[], feeBP: number): Totals {
  const indexed = new Set(jobs.map((j) => j.jobId.toString()));
  const t = totals(jobs, feeBP);
  for (const r of runs) {
    if (indexed.has(r.jobId)) continue;
    if (r.outcome === "settled") {
      t.settledCount += 1;
      t.settledUsdc += r.amount;
    } else if (r.outcome === "refunded") {
      t.refundedCount += 1;
      t.refundedUsdc += r.amount;
    }
  }
  t.feesUsdc = (t.settledUsdc * BigInt(feeBP)) / 10000n;
  return t;
}

export function boardRows(
  jobs: JobView[],
  runs: SessionRun[],
  limit = 12,
  sellerNames: Record<string, string> = {},
): BoardRow[] {
  const byId = new Map<string, BoardRow>();
  for (const j of jobs) {
    byId.set(j.jobId.toString(), {
      jobId: j.jobId.toString(),
      datasetId: "",
      amount: j.amount,
      outcome: j.state,
      at: j.timestamp,
      confirming: false,
      refundReason: j.refundReason,
      seller: j.seller,
      sellerName: sellerNames[j.seller.toLowerCase()],
      delivered: j.metaBlock !== undefined,
      gap: j.metaBlock !== undefined && Number(j.minBlock) > j.metaBlock ? Number(j.minBlock) - j.metaBlock : undefined,
      deadline: Number(j.deadline),
    });
  }
  for (const r of runs) {
    const existing = byId.get(r.jobId);
    if (existing) {
      existing.datasetId = r.datasetId;
      if (r.txHash) existing.txHash = r.txHash;
      continue;
    }
    byId.set(r.jobId, {
      jobId: r.jobId,
      datasetId: r.datasetId,
      amount: r.amount,
      outcome: r.outcome,
      txHash: r.txHash,
      at: r.at,
      confirming: true,
      refundReason: r.refundReason,
      seller: null,
      delivered: true,
      gap: r.gap,
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.at - a.at || Number(BigInt(b.jobId) - BigInt(a.jobId)))
    .slice(0, limit);
}

export async function fetchFeed(): Promise<Feed> {
  const [jobs, refusals, head] = await Promise.all([
    fetchJobs(),
    fetchPolicyRefusals().catch(() => [] as PolicyRefusalView[]),
    getPublicClient()
      .getBlockNumber()
      .then(Number)
      .catch(() => null),
  ]);
  return { jobs: marketJobs(jobs), refusals, indexed: null, head };
}

type FeedLive = Live<Feed> & { refresh(): void };

const FeedContext = createContext<FeedLive | null>(null);

export function FeedProvider({ children }: { children: ReactNode }): JSX.Element {
  const live = useLiveValue(fetchFeed, {
    pollMs: 20_000,
    staleAfterMs: 60_000,
    cacheKey: "feed.v1",
    gateKey: STUDIO_GATE,
  });
  return createElement(FeedContext.Provider, { value: live }, children);
}

export function useFeed(): FeedLive {
  const ctx = useContext(FeedContext);
  if (ctx === null) throw new Error("useFeed must be used inside FeedProvider");
  return ctx;
}
