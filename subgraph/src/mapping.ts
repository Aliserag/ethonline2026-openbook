// OpenBook P&L subgraph — mapping handlers (Task 4).
//
// Semantic ledger built from ERC-8183 commerce events + PolicyWallet economics.
//   revenue  += QueryPaid.amount        (JobFunded — client pays for a query)
//   revenue  += Settled.amount          (PaymentReleased — provider payout)
//   refunds  += Refunded.amount         (money returned to client)
//   costs    += CostPaid.amount         (PolicyWallet WithdrawalExecuted)
// Policy blocked intents are surfaced via PolicyBlocked (no P&L impact).
//
// CRITICAL: we never index raw USDC Transfer events (EIP-7708 double-count trap).
// Amounts arrive as raw 6-dec BigInt units via the semantic events. Net =
// revenue - refunds - costs, all BigInt, day-bucket = block.number / 21600.

import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  JobFunded as JobFundedEvent,
  JobSubmitted as JobSubmittedEvent,
  PaymentReleased as PaymentReleasedEvent,
  Refunded as RefundedEvent,
} from "../generated/ERC8183/ERC8183";
import {
  WithdrawalExecuted as WithdrawalExecutedEvent,
  PolicyBlocked as PolicyBlockedEvent,
} from "../generated/PolicyWallet/PolicyWallet";
import {
  QueryPaid,
  Fulfilled,
  Settled,
  RefundIssued,
  CostPaid,
  PolicyBlocked,
  DailyPnL,
} from "../generated/schema";

// Arc testnet produces ~1 block/2s (6-dec USDC gas token); 21600 blocks ≈ one
// day bucket, matching the plan's aggregation interval.
const DAY_BLOCKS = BigInt.fromI32(21600);

function entityId(
  hash: Bytes,
  logIndex: i32
): Bytes {
  return hash.concatI32(logIndex);
}

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

// JobFunded(jobId, client, amount) — a buyer funds a query; first revenue event.
export function handleQueryPaid(event: JobFundedEvent): void {
  let id = entityId(event.transaction.hash, event.logIndex.toI32());
  let queryPaid = new QueryPaid(id);
  queryPaid.jobId = event.params.jobId;
  queryPaid.buyer = event.params.client;
  queryPaid.seller = event.params.client; // funder == responsible party at fund time
  queryPaid.amount = event.params.amount;
  queryPaid.minBlock = event.block.number;
  queryPaid.deadline = event.block.number;
  queryPaid.blockNumber = event.block.number;
  queryPaid.timestamp = event.block.timestamp;
  queryPaid.save();

  let day = loadOrCreateDay(event.block.number);
  addRevenue(day, event.params.amount);
  day.save();
}

// JobSubmitted(jobId, provider, deliverable) — provider fulfills the job.
export function handleFulfilled(event: JobSubmittedEvent): void {
  let id = entityId(event.transaction.hash, event.logIndex.toI32());
  let fulfilled = new Fulfilled(id);
  fulfilled.jobId = event.params.jobId;
  fulfilled.payloadHash = event.params.deliverable;
  fulfilled.metaBlock = event.block.number;
  fulfilled.save();
}

// PaymentReleased(jobId, provider, amount) — escrow settlement to seller.
export function handleSettled(event: PaymentReleasedEvent): void {
  let id = entityId(event.transaction.hash, event.logIndex.toI32());
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
  let id = entityId(event.transaction.hash, event.logIndex.toI32());
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
  let id = entityId(event.transaction.hash, event.logIndex.toI32());
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
  let id = entityId(event.transaction.hash, event.logIndex.toI32());
  let blocked = new PolicyBlocked(id);
  blocked.reason = event.params.reason;
  blocked.save();
}
