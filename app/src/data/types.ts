/** Shared vocabulary for every live surface. Live<T> is the one contract all
 *  readers (map nodes, drawers, console renderers) consume. */
export type LiveState = "live" | "loading" | "stale" | "error";

export interface Live<T> {
  value: T | null;
  state: LiveState;
  reason?: string; // human-readable, shown in degraded states
  at: number;      // epoch ms of the last successful read (0 = never)
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

export type SignerKind = "demo" | "injected" | "none";
