/**
 * Escrow reader: receipt-derived fee split, onchain job views, freshness
 * ruler, and the platform fee. Reuses the verified ABI + SLA packing from
 * agent/escrow.ts — no forks. The fee split is ALWAYS derived from the
 * settlement receipt's USDC Transfer logs (never config).
 *
 * Note: agent/escrow.ts's USDC_ABI carries only approve/balanceOf/transfer —
 * no Transfer event — so the decode ABI lives here as a minimal single-event
 * entry (topic0 is the canonical ERC-20 Transfer selector).
 */
import {
  decodeEventLog,
  type Abi,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { ADDR } from "./addresses";
import { ERC8183_ABI, parseSla } from "../../../agent/escrow";
import type { FeeSplit, JobView } from "./types";

export const USDC_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const USDC_TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { type: "address", name: "from", indexed: true },
      { type: "address", name: "to", indexed: true },
      { type: "uint256", name: "value", indexed: false },
    ],
  },
] as const satisfies Abi;

/**
 * Split a settlement receipt by its actual USDC Transfer logs: transfers to
 * ADDR.policy are the platform cut, every other outgoing transfer is the
 * seller's. Throws when the logs do not match the fee rate exactly.
 */
export function feeSplitFromReceipt(receipt: TransactionReceipt, feeBP: number): FeeSplit {
  const usdc = ADDR.usdc.toLowerCase();
  const treasuryAddr = ADDR.policy.toLowerCase();
  let treasury = 0n;
  let seller = 0n;
  for (const log of receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== usdc) continue;
    if (!log.topics || log.topics[0] !== USDC_TRANSFER_TOPIC) continue;
    const decoded = decodeEventLog({ abi: USDC_TRANSFER_ABI, data: log.data, topics: log.topics });
    if (decoded.eventName !== "Transfer") continue;
    const { to, value } = decoded.args;
    if (to.toLowerCase() === treasuryAddr) treasury += value;
    else seller += value;
  }
  const total = treasury + seller;
  if (total === 0n) {
    throw new Error(`fee split: no USDC transfer logs in receipt`);
  }
  const expected = (total * BigInt(feeBP)) / 10_000n;
  if (treasury !== expected) {
    throw new Error(
      `fee split mismatch: treasury ${treasury} but ${total} × ${feeBP}/10000 = ${expected}`,
    );
  }
  return { total, seller, treasury, feeBP };
}

/**
 * Onchain job view (chain-only — blockNumber/timestamp are 0 until a subgraph
 * overlay lands). State derives from the ERC-8183 status: Completed = settled,
 * Rejected/Expired = refunded (client auto-refund), else open.
 */
export async function readJob(
  publicClient: PublicClient,
  jobId: bigint,
): Promise<JobView | null> {
  try {
    const raw = (await publicClient.readContract({
      address: ADDR.escrow,
      abi: ERC8183_ABI,
      functionName: "jobs",
      args: [jobId],
    })) as unknown as readonly unknown[] | Record<string, unknown>;
    const arr = Array.isArray(raw) ? raw : null;
    const obj = arr ? null : (raw as Record<string, unknown>);
    const field = (key: string, index: number): unknown => (arr ? arr[index] : obj?.[key]);
    const description = field("description", 4) as string;
    let minBlock = 0n;
    try {
      minBlock = BigInt(parseSla(description).minBlock);
    } catch {
      // description without a parseable SLA — no freshness floor known
    }
    const status = Number(field("status", 7) as bigint | number);
    const state: JobView["state"] =
      status === 3 ? "settled" : status === 4 || status === 5 ? "refunded" : "open";
    return {
      jobId: BigInt(field("id", 0) as bigint),
      buyer: field("client", 1) as `0x${string}`,
      seller: field("provider", 2) as `0x${string}`,
      amount: BigInt(field("budget", 5) as bigint),
      minBlock,
      deadline: BigInt(field("expiredAt", 6) as bigint),
      blockNumber: 0n,
      timestamp: 0,
      state,
    };
  } catch {
    return null; // unknown jobId reverts onchain
  }
}

/** Freshness gate over the deliverable's _meta.block vs the SLA floor. */
export function freshnessRuler(
  delivered: number,
  floor: bigint,
  head: bigint,
): { ok: boolean; delta: number } {
  const delta = head - BigInt(delivered);
  return { ok: BigInt(delivered) >= floor, delta: Number(delta) };
}

/** Platform fee terms from the escrow itself (platformFeeBP + platformTreasury). */
export async function platformFee(publicClient: PublicClient): Promise<{
  feeBP: number;
  treasury: `0x${string}`;
}> {
  const [feeBP, treasury] = await Promise.all([
    publicClient.readContract({
      address: ADDR.escrow,
      abi: ERC8183_ABI,
      functionName: "platformFeeBP",
    }),
    publicClient.readContract({
      address: ADDR.escrow,
      abi: ERC8183_ABI,
      functionName: "platformTreasury",
    }),
  ]);
  return { feeBP: Number(feeBP), treasury: treasury as `0x${string}` };
}
