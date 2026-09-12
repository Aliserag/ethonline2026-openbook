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
//
// W4 market aggregates (marketplace plan, spec §3): alongside the seller-scoped
// ledger above, the same handlers ALSO book GLOBAL per-provider stats (Provider)
// and per-day market buckets (MarketDay) for EVERY provider on every indexed
// escrow (shared reference contract + the OpenBook instance). The seller-scoped
// logic below is untouched — same rows, same bookkeeping. Refunds and lag need
// a jobId -> provider registry (JobMeta), because Refunded carries no provider
// and fulfillment lag needs the job creation block.

import { Address, BigDecimal, BigInt, Bytes } from "@graphprotocol/graph-ts";

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
  Provider,
  MarketDay,
  JobMeta,
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
// placeholder before codegen (see scripts/deploy-subgraph.sh + the setup notes).
// The zero address = index nothing: keyless-safe default, but a deploy that
// skips substitution books NO P&L.
export const SELLER = "0x0000000000000000000000000000000000000000";

/** True when the job's provider is the OpenBook seller (scopes all job events). */
function isSeller(provider: Address): boolean {
  return provider.toHexString().toLowerCase() == SELLER.toLowerCase();
}

// The OpenBook escrow instance (living-protocol T14, 2% fee → PolicyWallet).
// Every job on OUR instance is OpenBook's market by construction (keyless
// demo buyers, the console, external sellers listed under openbook.eth), so
// its ledger rows are booked for every provider. The SELLER filter stays for
// the SHARED reference contract, where foreign agents' jobs must be skipped.
const OPENBOOK_ESCROW = "0x967e005154d0f62c33eac8e2f44b44d4c4c07dd5";

/** True when this job belongs in OpenBook's ledger: any job on our own escrow
 *  instance, or a SELLER-provided job on the shared reference contract. */
function booksJob(emitter: Address, provider: Address): boolean {
  return emitter.toHexString().toLowerCase() == OPENBOOK_ESCROW || isSeller(provider);
}

function logIndexId(hash: Bytes, logIndex: i32): Bytes {
  return hash.concatI32(logIndex);
}

// Stable per-job id for QueryPaid so JobCreated + JobFunded merge on one row.

function dayId(blockNumber: BigInt): string {
  return "day-" + blockNumber.div(DAY_BLOCKS).toString();
}

function loadOrCreateDay(blockNumber: BigInt, timestamp: BigInt): DailyPnL {
  let id = dayId(blockNumber);
  let day = DailyPnL.load(id);
  if (day == null) {
    day = new DailyPnL(id);
    day.startedAt = timestamp; // human-readable day label in the UI
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

// ---- W4 market aggregates (global, every provider) ----

// JobMeta ids are contract-scoped: the shared reference escrow and the OpenBook
// instance each own a uint256 jobId counter, so "jm-" + jobId alone could
// collide across the two dataSources. Prefix with the emitting contract.
function jobMetaId(contract: Address, jobId: BigInt): Bytes {
  return Bytes.fromUTF8("jm-" + contract.toHexString() + "-" + jobId.toString());
}

function loadOrCreateProvider(provider: Address): Provider {
  let p = Provider.load(provider);
  if (p == null) {
    p = new Provider(provider);
    p.jobs = 0;
    p.settled = BigInt.zero();
    p.refunded = BigInt.zero();
    p.delivered = 0;
    p.avgLagBlocks = BigDecimal.zero();
    p.lastJobAt = BigInt.zero();
    p._lastActiveDay = "";
    p._lagSamples = 0;
  }
  return p;
}

function loadOrCreateMarketDay(blockNumber: BigInt): MarketDay {
  let id = "day-" + blockNumber.div(DAY_BLOCKS).toString();
  let day = MarketDay.load(id);
  if (day == null) {
    day = new MarketDay(id);
    day.jobs = 0;
    day.volume = BigInt.zero();
    day.refunds = BigInt.zero();
    day.providers = 0;
  }
  return day;
}

// JobCreated(jobId, client, provider, evaluator, expiredAt, hook) — provider
// (seller) and expiredAt (deadline) exist ONLY here, so we create the QueryPaid
// row at creation time with real values; jobId is its stable id.
export function handleJobCreated(event: JobCreatedEvent): void {
  // W4 market (GLOBAL — every provider on every indexed escrow):
  // register the job for later refund/lag attribution, count the provider's
  // jobs + the day's jobs, and mark the provider active this day exactly once.
  let meta = new JobMeta(jobMetaId(event.address, event.params.jobId));
  meta.provider = event.params.provider;
  meta.createdAt = event.block.number;
  meta.save();

  let day = loadOrCreateMarketDay(event.block.number);
  day.jobs += 1;

  let provider = loadOrCreateProvider(event.params.provider);
  provider.jobs += 1;
  provider.lastJobAt = event.block.timestamp;
  if (provider._lastActiveDay != dayId(event.block.number)) {
    day.providers += 1;
    provider._lastActiveDay = dayId(event.block.number);
  }
  provider.save();
  day.save();

  // Seller-scoped ledger below is unchanged (foreign jobs skipped as before).
  // Shared reference contract — skip foreign jobs (their provider isn't SELLER).
  if (!booksJob(event.address, event.params.provider)) {
    return;
  }
  // PINNED RISK (accept-and-pin ruling): the "qp-"+jobId key is UNPREFIXED —
  // the shared reference escrow and the OpenBook instance (ERC8183OpenBook)
  // each own a uint256 jobId counter. A row-id collision would require a
  // shared-escrow lifecycle event for a jobId that the instance later mints,
  // landing AFTER the instance's JobCreated in chain order — impossible today
  // (instance counter 1-4 vs shared 185k+, and the instance mints first in
  // any interleaving). The same key is loaded in handleQueryPaid/handleRefund.
  // Migrating to a contract-prefixed key would break the frozen row-id
  // contract and needs a coordinated reindex — deliberately NOT done.
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
  // W4 market (GLOBAL): count the delivery + running mean lag in blocks
  // (fulfillment block - job creation block) for every provider. Jobs whose
  // JobCreated predates this dataSource's startBlock have no JobMeta row —
  // they count as delivered but contribute NO lag sample to the mean.
  let provider = loadOrCreateProvider(event.params.provider);
  provider.delivered += 1;
  let meta = JobMeta.load(jobMetaId(event.address, event.params.jobId));
  if (meta != null) {
    // Running mean over LAG SAMPLES ONLY. The mean denominator is
    // _lagSamples, never delivered: a meta-less delivery must not dilute the
    // averages of later in-range deliveries (avg = (avg*(n-1) + lag) / n).
    let n = provider._lagSamples + 1;
    let lag = event.block.number.minus(meta.createdAt);
    provider.avgLagBlocks = provider.avgLagBlocks
      .times(BigDecimal.fromString((n - 1).toString()))
      .plus(BigDecimal.fromString(lag.toString()))
      .div(BigDecimal.fromString(n.toString()));
    provider._lagSamples = n;
  }
  provider.save();

  // Seller-scoped ledger below is unchanged (foreign deliveries skipped).
  if (!booksJob(event.address, event.params.provider)) {
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
  // W4 market (GLOBAL): per-provider settled volume + per-day market volume.
  let provider = loadOrCreateProvider(event.params.provider);
  provider.settled = provider.settled.plus(event.params.amount);
  provider.save();
  let marketDay = loadOrCreateMarketDay(event.block.number);
  marketDay.volume = marketDay.volume.plus(event.params.amount);
  marketDay.save();

  // THE revenue line — must be SELLER-scoped or foreign settlements inflate
  // OpenBook's DailyPnL on the shared reference contract.
  if (!booksJob(event.address, event.params.provider)) {
    return;
  }
  let id = logIndexId(event.transaction.hash, event.logIndex.toI32());
  let settled = new Settled(id);
  settled.jobId = event.params.jobId;
  settled.seller = event.params.provider;
  settled.amount = event.params.amount;
  settled.save();

  let day = loadOrCreateDay(event.block.number, event.block.timestamp);
  addRevenue(day, event.params.amount);
  day.save();
}

// Refunded(jobId, client, amount) — money returned to the client.
export function handleRefund(event: RefundedEvent): void {
  // W4 market (GLOBAL): day refund volume always; per-provider attribution via
  // the JobMeta registry (Refunded carries no provider). Refunds for jobs that
  // predate this dataSource's startBlock have no JobMeta — they book into the
  // day bucket but cannot be attributed to a provider row.
  let meta = JobMeta.load(jobMetaId(event.address, event.params.jobId));
  if (meta != null) {
    let provider = loadOrCreateProvider(Address.fromBytes(meta.provider));
    provider.refunded = provider.refunded.plus(event.params.amount);
    provider.save();
  }
  let marketDay = loadOrCreateMarketDay(event.block.number);
  marketDay.refunds = marketDay.refunds.plus(event.params.amount);
  marketDay.save();

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

  let day = loadOrCreateDay(event.block.number, event.block.timestamp);
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

  let day = loadOrCreateDay(event.block.number, event.block.timestamp);
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
