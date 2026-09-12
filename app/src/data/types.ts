/** Shared vocabulary for every live surface. Live<T> is the one contract all
 *  readers (map nodes, drawers, console renderers) consume. */
import type { DeliveryVerdict } from "../../../mcp/src/escrow";

export type LiveState = "live" | "loading" | "stale" | "error";

/** Where a shown value came from — live is the default; cache/snapshot are
 *  ALWAYS labeled when rendered (a degraded read must never look fresh). */
export type LiveSource = "live" | "cache" | "snapshot";

export interface Live<T> {
  value: T | null;
  state: LiveState;
  reason?: string; // human-readable, shown in degraded states
  /** the raw upstream reason behind a degraded serve (e.g. the 429 message),
   *  kept for hover/detail surfaces while `reason` stays the calm label */
  detail?: string;
  at: number;      // epoch ms of the value's read (0 = never); for cache/snapshot
                   // serves this is the time the payload was taken, not now
  source?: LiveSource;
}

export interface JobView {
  jobId: bigint;
  buyer: `0x${string}`;
  seller: `0x${string}`;
  amount: bigint;       // USDC, 6dp raw
  minBlock: bigint;
  deadline: bigint;     // unix seconds
  blockNumber: bigint;  // Arc block of JobCreated
  timestamp: number;    // unix seconds
  state: "open" | "settled" | "refunded";
  payloadHash?: `0x${string}`;
  metaBlock?: number;
  refundReason?: string;
}

/** Derived from the settlement receipt's USDC Transfer logs — never from config. */
export interface FeeSplit {
  total: bigint;
  seller: bigint;
  treasury: bigint;
  feeBP: number;
}

export type SignerKind = "demo" | "injected" | "circle" | "none";

/** Delivery verdict — re-exported verbatim from mcp/src/escrow (decideDelivery's return). */
export type Verdict = DeliveryVerdict;
