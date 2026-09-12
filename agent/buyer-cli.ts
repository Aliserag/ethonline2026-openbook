/**
 * buyer-cli.ts — OpenBook buyer driver (Task 7, marketplace W2).
 *
 * The buyer side of the loop, driven from the terminal:
 *
 *   quote    → ENSv2 svc.* records (Sepolia) → price/SLA/payee (HARD-FAILS
 *              on any missing record — never quotes a hard-coded value).
 *              Resolves the parent storefront PLUS the dataset-subname
 *              override (`<dataset>.openbook.eth`) — the SAME resolution the
 *              MCP get_quote uses, so quote == charge everywhere.
 *   pay      → createJobWithSla: buyer signs createJob/approve/fund, the
 *              provider (seller key) signs setBudget → jobId + fund tx
 *   deliver  → run the dataset query through the Gateway (fresh) — or through
 *              the stale proxy with --stale — and submit (payloadHash,
 *              metaBlock); hash committed onchain, block logged
 *   verify   → deterministic verdict: metaBlock >= SLA minBlock + well-formed
 *              payloadHash → APPROVE, else REJECT (STALE_DATA/INVALID_HASH)
 *   settle   → APPROVE → complete() (PaymentReleased) · REJECT →
 *              rejectAndRefund() (Refunded — the money shot)
 *
 * Marketplace mode (W2): `--schema <schema> --compare` lists every seller
 * offering that schema from the live ENS directory (each with its ENS price
 * and SLA); `--prefer fresh|cheap` (default `fresh`: tighter maxBlockLag
 * wins, price breaks ties) picks one and the flow runs against the chosen
 * seller — listing, quote and charge all read the same ENS records. The job
 * is funded FOR the chosen seller (onchain provider = their svc.operator):
 * the CLI never signs setBudget/submit for them; their own loop quotes and
 * serves, and the CLI polls it (≤120s) before verifying/settling as buyer.
 *
 * --stale routes the delivery query through the stale proxy (default
 * http://127.0.0.1:8787, scripts/stale-proxy.ts) which replays a cached old
 * `_meta` block — the ONLY deterministic way to fire the refund money shot
 * (never rely on live staleness).
 *
 * Key-guarded: pay/deliver/verify need ARC_TESTNET_PK (buyer) + a provider
 * key (ARC_RECIPIENT_PK or the config operator key — the job's provider
 * signs setBudget) + GRAPH_GATEWAY_KEY (deliver). quote --only-quote and
 * --compare run fully keyless. Missing keys → clean skip, exit 0.
 *
 * OPENBOOK_ATTESTER_PK — who signs the onchain freshness attestation
 * (SlaHook.attest) when a hook is configured; default = the provider key.
 * Living-protocol T13 flips the hook's attester to the demo-buyer key, so
 * the CLI attests as that key while still acting as provider.
 *
 * Run: bun agent/buyer-cli.ts [--config mcp/config/openbook.json] [--dataset aave-v3-arbitrum-lending]
 *                              [--schema lending/3.1.0] [--compare] [--prefer fresh|cheap]
 *                              [--stale] [--only-quote] [--expiry 3600] [--json]
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  keccak256,
  parseAbiItem,
  toBytes,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARC_RPC_URL,
  attestDelivery,
  createJobWithSla,
  escrowAddress,
  getJob,
  JOB_STATUS,
  setEscrowAddress,
  setUsdcAddress,
  submitDeliverable,
  type Sla,
} from "./escrow";
import { gatewayQuery, stripMeta, type FetchLike } from "../mcp/src/gateway";
import { defaultChainHeadResolver } from "../mcp/src/chainhead";
import {
  createEnsTextReader,
  parsePriceToAmount6dec,
  parseSlaRecord,
  resolveDatasetRecords,
  type EnsTextReader,
  type ServiceRecords,
} from "../mcp/src/ens";
import { listSellers, sellersForSchema } from "../mcp/src/directory";
import { pickSeller, type SellerQuote } from "../mcp/src/router";
import { defaultQueryFor } from "./src/queries";
import { verifyDelivery } from "../mcp/src/escrow";
import {
  loadConfigFile,
  resolveGatewayKey,
  resolveOperatorKey,
  type OpenBookConfig,
} from "../mcp/src/datasets";

/** JobFunded event — used to recover the fund tx hash from the receipt logs. */
const JOB_FUNDED = parseAbiItem(
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)",
);

export interface QuoteView {
  datasetId: string;
  /** price in 6-decimal USDC units, resolved live from the ENS svc.price record */
  amount: number;
  amountUsdc: string;
  minBlockLag: number;
  maxLatencyMs: number;
  payee: string;
  priceRecord: string;
  slaRecord: { maxBlockLag: number; maxLatencyMs: number };
}

export interface DeliveryRecord {
  /** the GraphQL query actually sent (freshness fragment appended) */
  query: string;
  /** the URL the query went to (gateway, or the stale proxy with --stale) */
  url: string;
  /** keccak256 of the deliverable payload (stripMeta) — committed onchain */
  payloadHash: `0x${string}`;
  metaBlock: number | null;
  chainHeadBlock: number | null;
  freshness: "fresh" | "stale" | "no-meta";
  /** how the delivery was fetched: live Gateway or replayed stale proxy */
  via: "gateway" | "stale-proxy";
}

export interface BuyerFlowResult {
  quote: QuoteView;
  jobId?: string;
  fundHash?: string;
  delivery?: DeliveryRecord;
  verify?: { verdict: "APPROVE" | "REJECT"; reason?: string; minBlock: number };
  settleTxHash?: string;
  refunded?: boolean;
  /** true when the job's provider is another seller and the CLI handed it to
   * their loop instead of serving — verify/settle only ran if they served */
  waitingOnSeller?: boolean;
}

export interface BuyerFlowOptions {
  datasetId: string;
  /** override the dataset's default demo query */
  query?: string;
  /** route the delivery query through the stale proxy (deterministic refund) */
  stale?: boolean;
  /** stale proxy base URL (default http://127.0.0.1:8787) */
  staleProxyUrl?: string;
  /** escrow deadline in seconds from now (default 3600) */
  expirySeconds?: number;
  /** stop after the quote — fully keyless */
  onlyQuote?: boolean;
  /** optional SlaHook address — enables onchain SLA adjudication for the job */
  hook?: string;
  /**
   * Marketplace mode (W2): the chosen seller's serving address
   * (`SellerQuote.operator`) — the job's onchain provider. The CLI funds the
   * job for that seller and does NOT sign setBudget/submit on its behalf;
   * the seller's own loop quotes and serves. Omit to keep the CLI's own
   * provider wallet as the job's provider (single-seller demo, unchanged).
   */
  providerOverride?: Address;
}

export interface BuyerDeps {
  env?: Record<string, string | undefined>;
  readEnsText?: EnsTextReader;
  fetchImpl?: FetchLike;
  publicClient?: PublicClient;
  buyerWallet?: WalletClient;
  providerWallet?: WalletClient;
  /** who signs the onchain freshness attestation — defaults to the
   * OPENBOOK_ATTESTER_PK override, then the provider wallet (via the same
   * walletFromKey path); injectable for tests */
  attesterWallet?: WalletClient;
  /** freshness head resolver — defaults to Alchemy via mcp/src/chainhead.ts
   * (the Gateway's _meta has no chainHeadBlock field; live probe 2026-09-09) */
  chainHead?: (chain: "arbitrum" | "ethereum") => Promise<number>;
  log?: (line: string) => void;
}

function defaultLog(line: string): void {
  console.log(`[buyer] ${line}`);
}

function walletFromKey(key: `0x${string}`, rpcUrl: string): WalletClient {
  return createWalletClient({ chain: arcTestnet, transport: http(rpcUrl), account: privateKeyToAccount(key) });
}

/**
 * The delivery step: run the dataset query through the Gateway — or through
 * the stale proxy when `stale` — and compute the deliverable record. Purely
 * keyless: needs only GRAPH_GATEWAY_KEY + (for stale) the proxy URL.
 */
export async function deliverQuery(
  config: OpenBookConfig,
  options: { datasetId: string; query?: string; stale?: boolean; staleProxyUrl?: string },
  deps: {
    env?: Record<string, string | undefined>;
    fetchImpl?: FetchLike;
    chainHead?: (chain: "arbitrum" | "ethereum") => Promise<number>;
  } = {},
): Promise<DeliveryRecord> {
  const env = deps.env ?? {};
  const gatewayKey = resolveGatewayKey(config, env);
  if (!gatewayKey) {
    throw new Error(
      "buyer-cli: GRAPH_GATEWAY_KEY missing — the delivery query is a live Gateway query (key-gated)",
    );
  }
  const dataset = config.datasets.find((d) => d.id === options.datasetId);
  if (dataset === undefined) throw new Error(`unknown dataset: ${options.datasetId}`);

  const baseUrl = options.stale ? (options.staleProxyUrl ?? "http://127.0.0.1:8787") : config.gateway.baseUrl;
  const requestedQuery = options.query ?? defaultQueryFor(dataset);
  const { data, meta } = await gatewayQuery({
    key: gatewayKey,
    subgraphId: dataset.subgraphId,
    query: requestedQuery,
    baseUrl,
    fetchImpl: deps.fetchImpl,
  });
  const payloadHash: `0x${string}` = keccak256(toBytes(JSON.stringify(stripMeta(data))));
  let head: number | null;
  try {
    head = meta.block === null
      ? null
      : await (deps.chainHead ?? defaultChainHeadResolver(deps.env?.["ALCHEMY_API_KEY"]))(dataset.chain);
  } catch {
    head = null; // fail-closed: no reference head → no-meta, never settle blind
  }
  const freshness: DeliveryRecord["freshness"] =
    meta.block === null || head === null
      ? "no-meta"
      : head - meta.block <= dataset.freshness.maxAge
        ? "fresh"
        : "stale";
  return {
    query: requestedQuery,
    url: `${baseUrl}/api/${gatewayKey}/subgraphs/id/${dataset.subgraphId}`,
    payloadHash,
    metaBlock: meta.block,
    chainHeadBlock: head,
    freshness,
    via: options.stale ? "stale-proxy" : "gateway",
  };
}

export function requiredEnv(env: Record<string, string | undefined>, key: string): `0x${string}` {
  const value = env[key];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`buyer-cli: ${key} missing (0x + 64 hex) — needed for this keyed step`);
  }
  return value as `0x${string}`;
}

/**
 * Which key signs the onchain freshness attestation (SlaHook.attest) when a
 * hook is configured. OPENBOOK_ATTESTER_PK overrides the provider key —
 * living-protocol T13 flips the hook's attester to the demo-buyer key so the
 * CLI attests as that identity while still acting as provider (both worlds
 * share one attester). Default = provider key, so current behavior is
 * unchanged when the env var is unset.
 */
export function resolveAttesterPk(
  env: Record<string, string | undefined>,
  providerPk: `0x${string}`,
): `0x${string}` {
  const override = env["OPENBOOK_ATTESTER_PK"];
  if (override === undefined) return providerPk;
  if (!/^0x[0-9a-fA-F]{64}$/.test(override)) {
    throw new Error("buyer-cli: OPENBOOK_ATTESTER_PK must be a 0x + 64 hex private key");
  }
  return override as `0x${string}`;
}

/**
 * The address a seller's jobs are funded to (their loop's provider identity):
 * svc.operator, falling back to svc.payee when the operator record is unset.
 * Null when neither record is a valid address — such a seller cannot receive
 * a job.
 */
export function servingAddressOf(operator: string | null, payee: string | null): Address | null {
  if (operator !== null && isAddress(operator)) return operator;
  if (payee !== null && isAddress(payee)) return payee;
  return null;
}

/**
 * Whether the job's onchain provider is one of OUR wallets (the CLI's own
 * provider key). When it is, the CLI signs setBudget/submit itself (the
 * single-seller demo); when it is the chosen seller's serving address, the
 * CLI funds the job for them and their loop serves it. Case-insensitive
 * (addresses differ in casing across records/signers).
 */
export function isOurProvider(providerAddress: Address, ourAddresses: readonly Address[]): boolean {
  const needle = providerAddress.toLowerCase();
  return ourAddresses.some((address) => address.toLowerCase() === needle);
}

/**
 * The SLA freshness floor: the DATASET chain's head minus the seller's
 * maxBlockLag. The deliverable's `_meta.block` lives on the dataset chain
 * (Arbitrum/Ethereum mainnets), so the floor MUST come from that chain's
 * head — never another chain's (a floor computed from Arc's head is vacuous:
 * every Arbitrum metaBlock clears it, so the hook would pass stale data).
 * Refuses loudly when the dataset chain's head cannot be resolved — a buy
 * with an unresolvable floor is a truthfulness defect, not a fallback.
 */
export async function slaFloorBlocks(
  chain: "arbitrum" | "ethereum",
  maxBlockLag: number,
  resolveHead: (chain: "arbitrum" | "ethereum") => Promise<number>,
): Promise<number> {
  let head: number;
  try {
    head = await resolveHead(chain);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `buyer-cli: cannot resolve the ${chain} chain head (${message}) — refusing to fund a job with an unresolvable SLA floor`,
    );
  }
  if (!Number.isInteger(head) || head <= 0) {
    throw new Error(
      `buyer-cli: cannot resolve the ${chain} chain head (got ${head}) — refusing to fund a job with an unresolvable SLA floor`,
    );
  }
  return Math.max(1, head - maxBlockLag);
}

/**
 * Marketplace mode (W2): every offer for a schema — the parent storefront's
 * datasets plus every ENS-discovered subname seller advertising the schema —
 * with prices/SLAs/payees/operators resolved through the SAME
 * `resolveDatasetRecords` the quote and the MCP use, so listing == quote ==
 * charge. A seller whose namespace is unpriceable today is skipped honestly:
 * the buy path hard-fails on it too, so the comparison lists only
 * purchasable offers.
 */
export async function offersForSchema(
  config: OpenBookConfig,
  schema: string,
  readEnsText: EnsTextReader,
): Promise<SellerQuote[]> {
  const offers: SellerQuote[] = [];
  const parentOperator = servingAddressOf(
    await readEnsText(config.ens, "svc.operator"),
    null,
  );
  for (const dataset of config.datasets) {
    if (dataset.schema !== schema) continue;
    const records = await resolveDatasetRecords(config.ens, dataset.id, readEnsText);
    offers.push({
      name: config.ens,
      datasetId: dataset.id,
      priceUsdc: parsePriceToAmount6dec(records.price as string),
      maxBlockLag: parseSlaRecord(records.sla as string).maxBlockLag,
      payee: records.payee as Address,
      operator: parentOperator ?? (records.payee as Address),
      stats: null,
    });
  }
  const sellers = await listSellers(config.ens, { readEnsText });
  for (const seller of sellersForSchema(sellers, schema)) {
    for (const entry of seller.menu) {
      if (entry.schema !== schema) continue;
      let records: ServiceRecords;
      try {
        records = await resolveDatasetRecords(seller.name, entry.id, readEnsText);
      } catch {
        continue; // no priceable records → the buy path would hard-fail; skip
      }
      const operator = servingAddressOf(seller.operator, seller.payee);
      if (operator === null) continue; // no serving address → cannot receive a job
      offers.push({
        name: seller.name,
        datasetId: entry.id,
        priceUsdc: parsePriceToAmount6dec(records.price as string),
        maxBlockLag: parseSlaRecord(records.sla as string).maxBlockLag,
        payee: records.payee as Address,
        operator,
        stats: null,
      });
    }
  }
  return offers.sort((a, b) => a.name.localeCompare(b.name) || a.datasetId.localeCompare(b.datasetId));
}

/** How long the CLI waits for the chosen seller's loop to serve a funded job. */
const SELLER_SERVE_TIMEOUT_MS = 120_000;
/** Poll spacing while waiting for the seller's loop. */
const SELLER_SERVE_POLL_MS = 10_000;

/**
 * Marketplace mode: the job's provider is the chosen seller's loop running in
 * its own process — the CLI must NOT sign submit for them. Poll the job
 * (bounded, ≤120s by default) until that loop submits, printing each state
 * transition. Returns false when the window expires or the job goes Expired —
 * the caller then hands back with the honest "not served yet" message and the
 * job stays in escrow until the deadline.
 */
export async function waitForSellerSubmission(
  publicClient: PublicClient,
  jobId: bigint,
  log: (line: string) => void,
  timeoutMs: number = SELLER_SERVE_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = -1;
  while (Date.now() < deadline) {
    const job = await getJob(publicClient, jobId);
    if (job.status !== lastStatus) {
      log(`poll job=${String(jobId)} status=${JOB_STATUS[job.status] ?? job.status} provider=${job.provider}`);
      lastStatus = job.status;
    }
    if (job.status >= 2) return true; // Submitted / further: the seller served it
    if (job.status >= 5) return false; // Expired — window closed onchain
    const waitMs = Math.min(SELLER_SERVE_POLL_MS, Math.max(0, deadline - Date.now()));
    if (waitMs <= 0) break;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, waitMs);
    await promise;
  }
  return false;
}

/**
 * Full buyer flow. `onlyQuote` stops after the ENS quote and is the keyless
 * path tests exercise; everything after it requires the buyer key.
 */
export async function runBuyerFlow(
  config: OpenBookConfig,
  options: BuyerFlowOptions,
  deps: BuyerDeps = {},
): Promise<BuyerFlowResult> {
  const env = deps.env ?? {};
  const log = deps.log ?? defaultLog;

  // 1. quote — ENS-gated, hard-fails without records. Same resolution the MCP
  // get_quote uses (parent + dataset-subname override): quote == charge.
  const readEnsText = deps.readEnsText ?? createEnsTextReader({ rpcUrl: env["SEPOLIA_RPC"] });
  const records = await resolveDatasetRecords(config.ens, options.datasetId, readEnsText);
  const amount = parsePriceToAmount6dec(records.price as string);
  const slaRecord = parseSlaRecord(records.sla as string);
  const dataset = config.datasets.find((d) => d.id === options.datasetId);
  if (dataset === undefined) throw new Error(`unknown dataset: ${options.datasetId}`);
  const quote: QuoteView = {
    datasetId: options.datasetId,
    amount,
    amountUsdc: (amount / 1_000_000).toFixed(2),
    minBlockLag: slaRecord.maxBlockLag,
    maxLatencyMs: slaRecord.maxLatencyMs,
    payee: records.payee as string,
    priceRecord: records.price as string,
    slaRecord,
  };
  log(
    `quote: ${dataset.id} — ${quote.amountUsdc} USDC/query, SLA maxBlockLag=${slaRecord.maxBlockLag} maxLatencyMs=${slaRecord.maxLatencyMs}, payee=${quote.payee} (ENS:${config.ens})`,
  );
  if (options.onlyQuote) return { quote };

  // 2. pay — buyer funds the escrow; provider signs setBudget
  // Escrow target: OPENBOOK_ESCROW flips the whole escrow module (e.g. to a
  // dedicated instance whose admin whitelists the onchain SLA hook).
  const escrowEnv = env["OPENBOOK_ESCROW"];
  if (escrowEnv !== undefined && /^0x[0-9a-fA-F]{40}$/.test(escrowEnv)) {
    setEscrowAddress(escrowEnv as `0x${string}`);
  }
  const usdcEnv = env["OPENBOOK_USDC"];
  if (usdcEnv !== undefined && /^0x[0-9a-fA-F]{40}$/.test(usdcEnv)) {
    setUsdcAddress(usdcEnv as `0x${string}`);
  }
  const hookAddress = (options.hook ?? env["OPENBOOK_HOOK"]) as `0x${string}` | undefined;
  if (hookAddress !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(hookAddress)) {
    throw new Error(`buyer-cli: invalid hook address '${hookAddress}'`);
  }
  const rpcUrl = env["ARC_TESTNET_RPC"] ?? ARC_RPC_URL;
  const buyerPk = requiredEnv(env, "ARC_TESTNET_PK");
  const publicClient = deps.publicClient ?? createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
  const buyerWallet = deps.buyerWallet ?? walletFromKey(buyerPk, rpcUrl);
  const buyerAddress = buyerWallet.account?.address;
  if (!buyerAddress) throw new Error("buyer-cli: buyer wallet has no attached account");
  // provider (the job's seller) signs setBudget: ARC_RECIPIENT_PK wins, then the
  // config operator key, then the buyer key (single-key demo is legal per spec)
  const providerPk = env["ARC_RECIPIENT_PK"] ?? resolveOperatorKey(config, env) ?? buyerPk;
  const providerWallet = deps.providerWallet ?? walletFromKey(providerPk as `0x${string}`, rpcUrl);
  const providerAddress = providerWallet.account?.address;
  if (!providerAddress) throw new Error("buyer-cli: provider wallet has no attached account");
  // attester: who signs the freshness proof the hook enforces at complete().
  // OPENBOOK_ATTESTER_PK overrides the provider key (living-protocol T13 flips
  // the hook's attester to the demo-buyer key; the CLI keeps acting as the
  // provider everywhere else).
  const attesterWallet =
    deps.attesterWallet ?? walletFromKey(resolveAttesterPk(env, providerPk as `0x${string}`), rpcUrl);

  const head = await publicClient.getBlockNumber();
  // SLA freshness floor = head(DATASET chain) − maxBlockLag: the deliverable's
  // _meta.block lives on the dataset chain (Arbitrum/Ethereum), so the floor
  // comes from THAT chain — never Arc's (a wrong-chain floor is vacuous and
  // would let the hook pass stale data). Refuses when unresolvable.
  const minBlock = await slaFloorBlocks(
    dataset.chain,
    slaRecord.maxBlockLag,
    deps.chainHead ?? defaultChainHeadResolver(env["ALCHEMY_API_KEY"]),
  );
  const sla: Sla = {
    minBlock, // fresh data must be newer than maxBlockLag blocks
    schemaHash: keccak256(toBytes(dataset.schema)),
    maxLatencyMs: slaRecord.maxLatencyMs,
  };
  // Marketplace mode funds the job FOR the chosen seller: the job's provider
  // is their serving address (not our key), so their loop picks it up. The
  // single-seller path keeps our own wallet as provider (setBudget signed).
  const jobProvider = options.providerOverride ?? providerAddress;
  const servingOurselves = isOurProvider(jobProvider, [providerAddress]);
  const jobId = await createJobWithSla(publicClient, {
    buyer: buyerWallet,
    provider: options.providerOverride ?? providerWallet,
    evaluator: buyerAddress,
    sla,
    amount6dec: BigInt(amount),
    expirySeconds: options.expirySeconds ?? 3600,
    hook: hookAddress,
  });
  log(
    servingOurselves
      ? `paid: jobId=${jobId} amount=${quote.amountUsdc} USDC escrow=${escrowAddress()}`
      : `paid: jobId=${jobId} amount=${quote.amountUsdc} USDC escrow=${escrowAddress()} provider=${jobProvider} (chosen seller — their loop quotes + serves)`,
  );

  // recover the fund tx hash from the JobFunded log mined after `head`
  let fundHash: string | undefined;
  const fundLogs = await publicClient.getLogs({
    address: escrowAddress(),
    event: JOB_FUNDED,
    args: { jobId },
    fromBlock: head,
    toBlock: await publicClient.getBlockNumber(),
  });
  fundHash = fundLogs[0]?.transactionHash;

  // 3. deliver — live Gateway or stale-proxy replay, then submit
  const delivery = await deliverQuery(
    config,
    {
      datasetId: options.datasetId,
      query: options.query,
      stale: options.stale,
      staleProxyUrl: options.staleProxyUrl,
    },
    { env, fetchImpl: deps.fetchImpl },
  );
  log(
    `delivery: via=${delivery.via} metaBlock=${delivery.metaBlock} chainHead=${delivery.chainHeadBlock} freshness=${delivery.freshness} payloadHash=${delivery.payloadHash}`,
  );
  if (delivery.freshness === "no-meta" || delivery.metaBlock === null) {
    throw new Error("buyer-cli: delivery carries no _meta — nothing to verify against the SLA");
  }
  if (servingOurselves) {
    // the job's provider is our key — sign submit as today
    await submitDeliverable(publicClient, providerWallet, jobId, delivery.payloadHash);
    log(`submitted: jobId=${jobId} payloadHash=${delivery.payloadHash} metaBlock=${delivery.metaBlock}`);
  } else {
    // the job's provider is the chosen seller — never sign submit for them;
    // give their loop a bounded window to serve (they need to see the
    // JobFunded log, run the gateway query, and sign submit)
    const served = await waitForSellerSubmission(publicClient, jobId, log);
    if (!served) {
      log(
        "RESULT: the seller's loop has not served this job yet — re-run deliver/verify later; " +
          "the funds stay in escrow until the deadline",
      );
      return { quote, jobId: String(jobId), fundHash, delivery, waitingOnSeller: true };
    }
  }

  // Onchain SLA adjudication (optional): when a hook is configured, the
  // operator posts the freshness proof BEFORE settlement. A fresh delivery
  // attests metaBlock >= floor and complete() passes the hook; a stale one
  // would carry a below-floor attestation and complete() REVERTS onchain —
  // the hook is the enforcement, not the client.
  if (hookAddress !== undefined) {
    await attestDelivery(
      publicClient,
      attesterWallet,
      hookAddress,
      jobId,
      delivery.payloadHash,
      delivery.metaBlock,
      sla.minBlock,
    );
    log(`attested: hook=${hookAddress} metaBlock=${delivery.metaBlock} minBlock=${sla.minBlock}`);
  }

  // 4.+5. verify (deterministic) → settle or refund (evaluator = buyer key)
  const verifyResult = await verifyDelivery(
    {
      jobId: String(jobId),
      payloadHash: delivery.payloadHash,
      metaBlock: delivery.metaBlock,
      minBlock: sla.minBlock,
      settle: true,
    },
    { publicClient, walletClient: buyerWallet },
  );
  log(
    `verify: verdict=${verifyResult.verdict}${verifyResult.reason ? ` (${verifyResult.reason})` : ""} minBlock=${verifyResult.minBlock} tx=${verifyResult.txHash}`,
  );
  const refunded = verifyResult.verdict === "REJECT";
  log(
    refunded
      ? `RESULT: stale delivery refunded — Refunded tx=${verifyResult.txHash} (money shot)`
      : `RESULT: SLA met — PaymentReleased tx=${verifyResult.txHash} (seller paid ${quote.amountUsdc} USDC)`,
  );
  return {
    quote,
    jobId: String(jobId),
    fundHash,
    delivery,
    verify: {
      verdict: verifyResult.verdict,
      reason: verifyResult.reason,
      minBlock: verifyResult.minBlock,
    },
    settleTxHash: verifyResult.txHash,
    refunded,
    waitingOnSeller: !servingOurselves,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface CliOptions {
  config: string;
  datasetId: string;
  query?: string;
  stale: boolean;
  staleProxyUrl?: string;
  expirySeconds?: number;
  onlyQuote: boolean;
  json: boolean;
  /** optional SlaHook address — enables onchain SLA adjudication for the job */
  hook?: string;
  /** marketplace mode (W2): only consider offers for this schema */
  schema?: string;
  /** marketplace mode: list every seller offering the schema, then stop (keyless) */
  compare: boolean;
  /** marketplace mode: which seller wins — fresh (tighter maxBlockLag) or cheap */
  prefer: "fresh" | "cheap";
}

function parseCli(argv: string[]): CliOptions {
  const args = [...argv];
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
  };
  const options: CliOptions = {
    config: "mcp/config/openbook.json",
    datasetId: "aave-v3-arbitrum-lending",
    stale: false,
    onlyQuote: false,
    json: false,
    compare: false,
    prefer: "fresh",
  };
  const config = value("--config") ?? value("-c");
  if (config !== undefined) options.config = config;
  const dataset = value("--dataset") ?? value("-d");
  if (dataset !== undefined) options.datasetId = dataset;
  const query = value("--query");
  if (query !== undefined) options.query = query;
  const staleProxyUrl = value("--stale-proxy");
  if (staleProxyUrl !== undefined) options.staleProxyUrl = staleProxyUrl;
  const expiry = value("--expiry");
  if (expiry !== undefined) options.expirySeconds = Number.parseInt(expiry, 10);
  const hook = value("--hook");
  if (hook !== undefined) options.hook = hook;
  const schema = value("--schema");
  if (schema !== undefined) options.schema = schema;
  const prefer = value("--prefer");
  if (prefer !== undefined) {
    if (prefer !== "fresh" && prefer !== "cheap") {
      throw new Error(`buyer-cli: --prefer must be fresh or cheap (got '${prefer}')`);
    }
    options.prefer = prefer;
  }
  if (args.includes("--stale")) options.stale = true;
  if (args.includes("--only-quote")) options.onlyQuote = true;
  if (args.includes("--json")) options.json = true;
  if (args.includes("--compare")) options.compare = true;
  return options;
}

/** Minimal .env loader (loads only unset keys — mirrors mcp/src/server.ts). */
function loadDotEnv(env: Record<string, string | undefined>): void {
  try {
    const text = readFileSync(resolve(".env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (env[key] === undefined || env[key] === "") env[key] = value;
    }
  } catch {
    // no .env — env must come from the shell
  }
}

/**
 * Marketplace mode (W2): compare every seller offering a schema, print the
 * offers with their live ENS prices/SLAs, then — unless `--compare` — buy
 * from the `pickSeller`-chosen seller. The chosen seller's ENS namespace
 * becomes the flow's quote root, so compare == quote == charge.
 */
export async function runMarketplaceFlow(
  config: OpenBookConfig,
  options: CliOptions,
  env: Record<string, string | undefined>,
): Promise<void> {
  const readEnsText = createEnsTextReader({ rpcUrl: env["SEPOLIA_RPC"] });
  const schema = options.schema as string;
  const offers = await offersForSchema(config, schema, readEnsText);
  if (offers.length === 0) {
    console.log(
      `[buyer] compare: no seller offers schema=${schema} (checked ${config.ens} and its ENS subnames)`,
    );
    return;
  }
  console.log(`[buyer] compare schema=${schema}: ${offers.length} offer${offers.length === 1 ? "" : "s"}`);
  offers.forEach((offer, index) => {
    console.log(
      `  ${index + 1}. ${offer.name} (${offer.datasetId}): ${(offer.priceUsdc / 1_000_000).toFixed(2)} USDC/query, ` +
        `maxBlockLag=${offer.maxBlockLag}, payee=${offer.payee}`,
    );
  });
  if (options.compare) return;

  const chosen = pickSeller(offers, options.prefer);
  console.log(
    `[buyer] router: prefer=${options.prefer} -> ${chosen.name} (${chosen.datasetId}) ` +
      `${(chosen.priceUsdc / 1_000_000).toFixed(2)} USDC/query maxBlockLag=${chosen.maxBlockLag} ` +
      `provider=${chosen.operator}`,
  );
  const sellerConfig: OpenBookConfig = {
    ...config,
    ens: chosen.name,
    datasets: config.datasets.filter((d) => d.id === chosen.datasetId),
  };
  if (sellerConfig.datasets.length === 0) {
    throw new Error(
      `buyer-cli: no local dataset config for ${chosen.datasetId} (offer of ${chosen.name}) — cannot build the delivery query`,
    );
  }
  const result = await runBuyerFlow(
    sellerConfig,
    {
      datasetId: chosen.datasetId,
      query: options.query,
      stale: options.stale,
      staleProxyUrl: options.staleProxyUrl,
      expirySeconds: options.expirySeconds,
      onlyQuote: options.onlyQuote,
      hook: options.hook,
      providerOverride: chosen.operator, // the job's onchain provider is the chosen seller
    },
    { env },
  );
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  }
}

export async function main(argv: string[]): Promise<void> {
  loadDotEnv(process.env);
  const options = parseCli(argv);
  const config = loadConfigFile(options.config);

  // keyless discipline: only the quote (and the compare listing) are keyless;
  // anything else needs keys
  const hasBuyerKey = /^0x[0-9a-fA-F]{64}$/.test(process.env["ARC_TESTNET_PK"] ?? "");
  const hasGatewayKey = (resolveGatewayKey(config, process.env) ?? "").length > 0;
  if (!options.onlyQuote && !options.compare && (!hasBuyerKey || !hasGatewayKey)) {
    console.log(
      `[buyer] SKIP: ${!hasBuyerKey ? "ARC_TESTNET_PK" : ""}${!hasBuyerKey && !hasGatewayKey ? " and " : ""}${!hasGatewayKey ? "GRAPH_GATEWAY_KEY" : ""} ` +
        `missing — pay/deliver/verify are keyed steps; run --only-quote or --compare keyless, or set the keys (the setup notes).`,
    );
    return;
  }

  if (options.schema !== undefined) {
    await runMarketplaceFlow(config, options, process.env);
    return;
  }
  const result = await runBuyerFlow(config, options, { env: process.env });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  }
}

const IS_ENTRY =
  typeof import.meta.main === "boolean"
    ? import.meta.main
    : process.argv[1] !== undefined &&
      resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (IS_ENTRY) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[buyer] ${message}`);
    process.exit(1);
  });
}
