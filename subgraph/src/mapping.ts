// OpenBook P&L subgraph — mapping handlers (Task 4).
//
// Semantic ledger built from ERC-8183 commerce events + PolicyWallet economics.
//   revenue  += Settled.amount    (PaymentReleased — the ONLY revenue line:
//                                  seller payout; a funded+settled job books its
//                                  amount exactly once)
//   refunds  += Refunded.amount   (money returned to client)
//   costs    += CostPaid.amount   (PolicyWallet WithdrawalExecuted)
// JobFunded is a buyer->escrow commitment, NOT earnings — it only records the
// QueryPaid entity (seller/deadline from JobCreated) and never touches P&L.
// Policy blocked intents are surfaced via PolicyBlocked (no P&L impact);
// PolicySet records the current caps into PolicyConfig (Task 7 admin story).
//
// CRITICAL: we never index raw USDC Transfer events (EIP-7708 double-count trap).
// Amounts arrive as raw 6-dec BigInt units via the semantic events. Net =
// revenue - refunds - costs, all BigInt, day-bucket = block.number / 21600.

import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  JobCreated as JobCreatedEvent,
  JobFunded as JobFundedEvent,
  JobSubmitted as JobSubmittedEvent,
  PaymentReleased as PaymentReleasedEvent,
  Refunded as RefundedEvent,
} from "../generated/ERC8183/ERC8183";
import {
  WithdrawalExecuted as WithdrawalExecutedEvent,
  PolicyBlocked as PolicyBlockedEvent,
  PolicySet as PolicySetEvent,
} from "../generated/PolicyWallet/PolicyWallet";
import {
  QueryPaid,
  Fulfilled,
  Settled,
  RefundIssued,
  CostPaid,
  PolicyBlocked,
  PolicyConfig,
  DailyPnL,
} from "../generated/schema";

// Arc testnet produces ~1 block/2s (6-dec USDC gas token); 21600 blocks ≈ one
// day bucket, matching the plan's aggregation interval.
const DAY_BLOCKS = BigInt.fromI32(21600);

// SELLER — the operator/seller address whose P&L this subgraph books. The
// ERC-8183 reference contract (0x0747…4583) is SHARED with other ETHOnline
// agents, so every job-scoped handler must skip foreign providers — otherwise
// their jobs would land in OpenBook's DailyPnL (consumed by get_pnl and the
// frontend P&L panel). The seller address is the ERC-8004-registered operator,
// config-pinned.
// TODO(deploy): deploy-subgraph.sh substitutes $SELLER_ADDRESS for this
// placeholder before codegen (see scripts/deploy-subgraph.sh + docs/keys-needed.md).
// The zero address = index nothing: keyless-safe default, but a deploy that
// skips substitution books NO P&L.
export const SELLER = "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21";

/** True when the job's provider is the OpenBook seller (scopes all job events). */
function isSeller(provider: Address): boolean {
  return provider.toHexString().toLowerCase() == SELLER.toLowerCase();
}

function logIndexId(hash: Bytes, logIndex: i32): Bytes {
  return hash.concatI32(logIndex);
}

// Stable per-job id for QueryPaid so JobCreated + JobFunded merge on one row.

function dayId(blockNumber: BigInt): string {
  return "day-" + blockNumber.div(DAY_BLOCKS).toString();
}

function loadOrCreateDay(blockNumber: BigInt): DailyPnL {
  let id = dayId(blockNumber);
  let day = DailyPnL.load(id);
  if (day == null) {
    day = new DailyPnL(id);
    day.revenue = BigInt.zero();
    day.costs = BigInt.zero();
    day.refunds = BigInt.zero();
    day.net = BigInt.zero();
  }
  return day;
}

function addRevenue(day: DailyPnL, amount: BigInt): void {
  day.revenue = day.revenue.plus(amount);
  day.net = day.revenue.minus(day.refunds).minus(day.costs);
}

function addRefund(day: DailyPnL, amount: BigInt): void {
  day.refunds = day.refunds.plus(amount);
  day.net = day.revenue.minus(day.refunds).minus(day.costs);
}

function addCost(day: DailyPnL, amount: BigInt): void {
  day.costs = day.costs.plus(amount);
  day.net = day.revenue.minus(day.refunds).minus(day.costs);
}

// JobCreated(jobId, client, provider, evaluator, expiredAt, hook) — provider
// (seller) and expiredAt (deadline) exist ONLY here, so we create the QueryPaid
// row at creation time with real values; jobId is its stable id.
export function handleJobCreated(event: JobCreatedEvent): void {
  // Shared reference contract — skip foreign jobs (their provider isn't SELLER).
  if (!isSeller(event.params.provider)) {
    return;
  }
  let id = Bytes.fromUTF8("qp-" + event.params.jobId.toString());
  let queryPaid = QueryPaid.load(id);
  if (queryPaid == null) {
    queryPaid = new QueryPaid(id);
  }
  queryPaid.jobId = event.params.jobId;
  queryPaid.buyer = event.params.client;
  queryPaid.seller = event.params.provider;
  queryPaid.minBlock = event.block.number; // earliest acceptable block: job creation
  queryPaid.deadline = event.params.expiredAt;
  queryPaid.amount = BigInt.zero(); // filled at JobFunded
  queryPaid.blockNumber = event.block.number;
  queryPaid.timestamp = event.block.timestamp;
  queryPaid.save();
}

// JobFunded(jobId, client, amount) — buyer escrows for the query. This is a
// commitment, NOT revenue: it updates the QueryPaid.amount and records the
// funding block, but books nothing on DailyPnL (earnings land at PaymentReleased).
export function handleQueryPaid(event: JobFundedEvent): void {
  let id = Bytes.fromUTF8("qp-" + event.params.jobId.toString());
  let queryPaid = QueryPaid.load(id);
  if (queryPaid == null) {
    // No scoped JobCreated row ⇒ the job is not one of SELLER's (shared
    // contract; JobFunded carries no provider) or it predates the index start
    // — never book foreign funding. JobCreated always precedes JobFunded on
    // the reference contract, so a missing row means "not ours".
    return;
  }
  queryPaid.amount = event.params.amount;
  queryPaid.blockNumber = event.block.number;
  queryPaid.timestamp = event.block.timestamp;
  queryPaid.save();
}

// JobSubmitted(jobId, provider, deliverable) — provider fulfills the job.
export function handleFulfilled(event: JobSubmittedEvent): void {
  if (!isSeller(event.params.provider)) {
    return;
  }
  let id = logIndexId(event.transaction.hash, event.logIndex.toI32());
  let fulfilled = new Fulfilled(id);
  fulfilled.jobId = event.params.jobId;
  fulfilled.payloadHash = event.params.deliverable;
  fulfilled.metaBlock = event.block.number;
  fulfilled.save();
}

// PaymentReleased(jobId, provider, amount) — escrow settlement to seller. This
// is the sole revenue event: a funded+settled job books its amount exactly once.
export function handleSettled(event: PaymentReleasedEvent): void {
  // THE revenue line — must be SELLER-scoped or foreign settlements inflate
  // OpenBook's DailyPnL on the shared reference contract.
  if (!isSeller(event.params.provider)) {
    return;
  }
  let id = logIndexId(event.transaction.hash, event.logIndex.toI32());
  let settled = new Settled(id);
  settled.jobId = event.params.jobId;
  settled.seller = event.params.provider;
  settled.amount = event.params.amount;
  settled.save();

  let day = loadOrCreateDay(event.block.number);
  addRevenue(day, event.params.amount);
  day.save();
}

// Refunded(jobId, client, amount) — money returned to the client.
export function handleRefund(event: RefundedEvent): void {
  // Refunded(jobId, client, amount) carries no provider — resolve the job row
  // (created only by scoped handleJobCreated) so foreign refunds are skipped.
  let queryPaid = QueryPaid.load(Bytes.fromUTF8("qp-" + event.params.jobId.toString()));
  if (queryPaid == null) {
    return;
  }
  let id = logIndexId(event.transaction.hash, event.logIndex.toI32());
  let refund = new RefundIssued(id);
  refund.jobId = event.params.jobId;
  refund.reason = "client-refund";
  refund.save();

  let day = loadOrCreateDay(event.block.number);
  addRefund(day, event.params.amount);
  day.save();
}

// PolicyWallet: WithdrawalExecuted(to, amount) — operating cost paid out.
export function handleCostPaid(event: WithdrawalExecutedEvent): void {
  let id = logIndexId(event.transaction.hash, event.logIndex.toI32());
  let costPaid = new CostPaid(id);
  costPaid.to = event.params.to;
  costPaid.amount = event.params.amount;
  costPaid.save();

  let day = loadOrCreateDay(event.block.number);
  addCost(day, event.params.amount);
  day.save();
}

// PolicyWallet: PolicyBlocked(reason) — an intent was blocked by policy. No P&L.
export function handlePolicyBlocked(event: PolicyBlockedEvent): void {
  let id = logIndexId(event.transaction.hash, event.logIndex.toI32());
  let blocked = new PolicyBlocked(id);
  blocked.reason = event.params.reason;
  blocked.save();
}

// PolicyWallet: PolicySet(perTxCap, dailyCap) — current caps for the Task 7
// admin "caps" panel. Singleton row `current`, updated on every PolicySet.
export function handlePolicySet(event: PolicySetEvent): void {
  let config = PolicyConfig.load("current");
  if (config == null) {
    config = new PolicyConfig("current");
  }
  config.perTxCap = event.params.perTxCap;
  config.dailyCap = event.params.dailyCap;
  config.save();
}
