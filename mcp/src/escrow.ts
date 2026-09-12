/**
 * Deterministic deliverable verification + ERC-8183 settlement for
 * sla-subgraph-mcp (OpenBook Task 5).
 *
 * The gate is pure and deterministic: `metaBlock >= minBlock` and a
 * well-formed payload hash decide APPROVE vs REJECT with NO chain access — the
 * same inputs always produce the same verdict (that is what lets an evaluator
 * settle without trusting the seller). minBlock comes from the job's packed
 * SLA description (Task 3 format) unless the caller supplies it directly.
 *
 * Settlement (complete / rejectAndRefund) reuses the Task 3 escrow helpers and
 * only runs when live Arc clients are supplied AND verdict/job are decidable.
 */
import { keccak256, toBytes, type PublicClient, type WalletClient } from "viem";
import {
  ERC8183 as ERC8183_ADDRESS,
  complete as completeJob,
  getJob,
  parseSla,
  rejectAndRefund as rejectJobAndRefund,
} from "../../agent/escrow";
import type { OpenBookConfig } from "./datasets";

export { ERC8183_ADDRESS, parseSla };

export type RejectReason = "STALE_DATA" | "INVALID_HASH";

export type DeliveryVerdict =
  | { verdict: "APPROVE" }
  | { verdict: "REJECT"; reason: RejectReason };

export interface VerifyDeliveryResult {
  verdict: "APPROVE" | "REJECT";
  reason?: RejectReason;
  /** decimal jobId as received (echo for traceability) */
  jobId?: string;
  /** the SLA minimum freshness block the verdict was decided against */
  minBlock: number;
  /** present when an onchain settlement tx was sent */
  txHash?: string;
}

export interface VerifyDeliveryInput {
  jobId?: bigint | string;
  payloadHash?: `0x${string}`;
  metaBlock: number;
  /** SLA minBlock; when absent it is resolved from the onchain job description */
  minBlock?: number;
  /**
   * Execute the onchain settlement (complete / rejectAndRefund) after the
   * deterministic verdict. Default false: the verdict is returned WITHOUT any
   * chain write — the evaluator agent opts into gas spending with settle:true.
   */
  settle?: boolean;
}

export interface ArcClients {
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Pure, deterministic gate — never touches the chain. */
export function decideDelivery(opts: {
  metaBlock: number;
  minBlock: number;
  payloadHash?: string;
}): DeliveryVerdict {
  if (opts.payloadHash !== undefined && !HASH_RE.test(opts.payloadHash)) {
    return { verdict: "REJECT", reason: "INVALID_HASH" };
  }
  if (opts.metaBlock < opts.minBlock) {
    return { verdict: "REJECT", reason: "STALE_DATA" };
  }
  return { verdict: "APPROVE" };
}

/** Deterministic onchain reason hash for complete()/reject(). */
export function reasonHash(reason: string): `0x${string}` {
  return keccak256(toBytes(reason));
}

/**
 * Verify a delivery and (optionally) settle it on ERC-8183.
 *
 * - minBlock: explicit input wins; otherwise read from the onchain job's packed
 *   SLA (parseSla) via publicClient.
 * - verdict: decideDelivery (pure). Settlement txs are ONLY sent when both Arc
 *   clients and a jobId are present; a pure verdict with no clients never
 *   touches the network and never charges.
 */
export async function verifyDelivery(
  input: VerifyDeliveryInput,
  clients?: ArcClients,
): Promise<VerifyDeliveryResult> {
  let minBlock = input.minBlock;
  if (minBlock === undefined) {
    if (input.jobId === undefined || clients?.publicClient === undefined) {
      throw new Error(
        "verify_delivery: minBlock is required. Pass it explicitly, or provide a live publicClient + jobId to resolve it from the onchain SLA",
      );
    }
    const job = await getJob(clients.publicClient, toBigInt(input.jobId));
    minBlock = parseSla(job.description).minBlock;
  }
  const decision = decideDelivery({
    metaBlock: input.metaBlock,
    minBlock,
    payloadHash: input.payloadHash,
  });

  let txHash: string | undefined;
  const walletClient = clients?.walletClient;
  const publicClient = clients?.publicClient;
  const settle = input.settle === true && input.jobId !== undefined && publicClient !== undefined && walletClient !== undefined;
  if (settle) {
    const jobId = toBigInt(input.jobId as bigint | string);
    const receipt =
      decision.verdict === "APPROVE"
        ? await completeJob(publicClient, walletClient, jobId, reasonHash("SLA_MET"))
        : await rejectJobAndRefund(publicClient, walletClient, jobId, reasonHash(decision.reason));
    txHash = receipt.transactionHash;
  }

  return {
    verdict: decision.verdict,
    reason: decision.verdict === "REJECT" ? decision.reason : undefined,
    jobId: input.jobId !== undefined ? String(input.jobId) : undefined,
    minBlock,
    txHash,
  };
}

function toBigInt(jobId: bigint | string): bigint {
  return typeof jobId === "bigint" ? jobId : BigInt(jobId);
}

/** Resolve the escrow address for a config (single source of truth). */
export function escrowAddress(config: OpenBookConfig): `0x${string}` {
  return config.escrow ?? ERC8183_ADDRESS;
}
