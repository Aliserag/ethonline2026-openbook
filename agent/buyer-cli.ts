/**
 * buyer-cli.ts — OpenBook buyer driver (Task 7).
 *
 * The buyer side of the loop, driven from the terminal:
 *
 *   quote    → ENSv2 svc.* records (Sepolia) → price/SLA/payee (HARD-FAILS
 *              on any missing record — never quotes a hard-coded value)
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
 * --stale routes the delivery query through the stale proxy (default
 * http://127.0.0.1:8787, scripts/stale-proxy.ts) which replays a cached old
 * `_meta` block — the ONLY deterministic way to fire the refund money shot
 * (never rely on live staleness).
 *
 * Key-guarded: pay/deliver/verify need ARC_TESTNET_PK (buyer) + a provider
 * key (ARC_RECIPIENT_PK or the config operator key — the job's provider
 * signs setBudget) + GRAPH_GATEWAY_KEY (deliver). quote --only-quote runs
 * fully keyless. Missing keys → clean skip, exit 0.
 *
 * Run: bun agent/buyer-cli.ts [--config mcp/config/openbook.json] [--dataset aave-v3-arbitrum-lending]
 *                              [--stale] [--only-quote] [--expiry 3600] [--json]
 */

import {
  createPublicClient,
  createWalletClient,
  http,
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
  ERC8183,
  createJobWithSla,
  submitDeliverable,
  type Sla,
} from "./escrow";
import { gatewayQuery, stripMeta, type FetchLike } from "../mcp/src/gateway";
import {
  createEnsTextReader,
  parsePriceToAmount6dec,
  parseSlaRecord,
  resolveServiceRecords,
  type EnsTextReader,
} from "../mcp/src/ens";
import { verifyDelivery } from "../mcp/src/escrow";
import {
  loadConfigFile,
  resolveGatewayKey,
  resolveOperatorKey,
  type DatasetConfig,
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
}

export interface BuyerDeps {
  env?: Record<string, string | undefined>;
  readEnsText?: EnsTextReader;
  fetchImpl?: FetchLike;
  publicClient?: PublicClient;
  buyerWallet?: WalletClient;
  providerWallet?: WalletClient;
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
  deps: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike } = {},
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
  const freshness: DeliveryRecord["freshness"] =
    meta.block === null || meta.chainHeadBlock === null
      ? "no-meta"
      : meta.chainHeadBlock - meta.block <= dataset.freshness.maxAge
        ? "fresh"
        : "stale";
  return {
    query: requestedQuery,
    url: `${baseUrl}/api/${gatewayKey}/subgraphs/id/${dataset.subgraphId}`,
    payloadHash,
    metaBlock: meta.block,
    chainHeadBlock: meta.chainHeadBlock,
    freshness,
    via: options.stale ? "stale-proxy" : "gateway",
  };
}

/** Deterministic default query for a dataset (mirrors agent/seller.ts). */
export function defaultQueryFor(dataset: DatasetConfig): string {
  const queries: Record<string, string> = {
    "lending/3.1.0": "{ markets(first: 3) { id } }",
    "dex-amm/4.0.1": "{ pools(first: 3) { id } }",
  };
  return queries[dataset.schema] ?? "{ __typename }";
}

export function requiredEnv(env: Record<string, string | undefined>, key: string): `0x${string}` {
  const value = env[key];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`buyer-cli: ${key} missing (0x + 64 hex) — needed for this keyed step`);
  }
  return value as `0x${string}`;
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

  // 1. quote — ENS-gated, hard-fails without records
  const readEnsText = deps.readEnsText ?? createEnsTextReader({ rpcUrl: env["SEPOLIA_RPC"] });
  const records = await resolveServiceRecords(config.ens, readEnsText);
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

  const head = await publicClient.getBlockNumber();
  const sla: Sla = {
    minBlock: Number(head) - slaRecord.maxBlockLag, // fresh data must be newer than maxBlockLag blocks
    schemaHash: keccak256(toBytes(dataset.schema)),
    maxLatencyMs: slaRecord.maxLatencyMs,
  };
  const jobId = await createJobWithSla(publicClient, {
    buyer: buyerWallet,
    provider: providerWallet,
    evaluator: buyerAddress,
    sla,
    amount6dec: BigInt(amount),
    expirySeconds: options.expirySeconds ?? 3600,
  });
  log(`paid: jobId=${jobId} amount=${quote.amountUsdc} USDC escrow=${ERC8183}`);

  // recover the fund tx hash from the JobFunded log mined after `head`
  let fundHash: string | undefined;
  const fundLogs = await publicClient.getLogs({
    address: ERC8183,
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
  await submitDeliverable(publicClient, providerWallet, jobId, delivery.payloadHash);
  log(`submitted: jobId=${jobId} payloadHash=${delivery.payloadHash} metaBlock=${delivery.metaBlock}`);

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
  if (args.includes("--stale")) options.stale = true;
  if (args.includes("--only-quote")) options.onlyQuote = true;
  if (args.includes("--json")) options.json = true;
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

export async function main(argv: string[]): Promise<void> {
  loadDotEnv(process.env);
  const options = parseCli(argv);
  const config = loadConfigFile(options.config);

  // keyless discipline: only the quote is keyless; anything else needs keys
  const hasBuyerKey = /^0x[0-9a-fA-F]{64}$/.test(process.env["ARC_TESTNET_PK"] ?? "");
  const hasGatewayKey = (resolveGatewayKey(config, process.env) ?? "").length > 0;
  if (!options.onlyQuote && (!hasBuyerKey || !hasGatewayKey)) {
    console.log(
      `[buyer] SKIP: ${!hasBuyerKey ? "ARC_TESTNET_PK" : ""}${!hasBuyerKey && !hasGatewayKey ? " and " : ""}${!hasGatewayKey ? "GRAPH_GATEWAY_KEY" : ""} ` +
        `missing — pay/deliver/verify are keyed steps; run --only-quote keyless, or set the keys (docs/keys-needed.md).`,
    );
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
