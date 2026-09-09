/**
 * seller.ts — OpenBook autonomous seller loop (Task 7).
 *
 * Watches ERC-8183 on Arc testnet for funded jobs, serves each from the live
 * Graph Gateway through the same freshness gate the Task 5 MCP uses, and
 * submits the deliverable (`payloadHash` + `metaBlock` — hash committed
 * onchain, block logged) exactly like the MCP would. Completed jobs are
 * revenue-logged from the `PaymentReleased` event; stale deliverables are
 * NEVER submitted (they would only guarantee a refund).
 *
 * Key-guarded (repo discipline): the loop needs a provider key (the config
 * operator key / ARC_TESTNET_PK / ARC_RECIPIENT_PK) AND GRAPH_GATEWAY_KEY.
 * Without either it exits cleanly with a skip notice and exit 0 — same
 * keyless behavior as mcp and the escrow lifecycle tests.
 *
 * Flow per pass:
 *   1. scan recent `JobFunded` logs (window: --lookback blocks or --since)
 *   2. `getJob` per id — skip unless status == Funded (1)
 *   3. `parseSla(job.description)`; find the configured dataset by schemaHash
 *   4. `gatewayQuery` (+_meta) — submit only when `meta.block >= sla.minBlock`
 *      AND within the dataset freshness window
 *   5. `PaymentReleased` -> revenue, `Refunded` -> refund; running totals
 *
 * Run:  bun agent/seller.ts [--config mcp/config/openbook.json] [--once]
 *                           [--interval 15000] [--lookback 1000] [--since <N>]
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
  type TransactionReceipt,
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
  getJob,
  parseSla,
  submitDeliverable,
  type Sla,
} from "./escrow";
import { gatewayQuery, stripMeta, type FetchLike } from "../mcp/src/gateway";
import {
  loadConfigFile,
  resolveGatewayKey,
  resolveOperatorKey,
  type DatasetConfig,
  type OpenBookConfig,
} from "../mcp/src/datasets";

/** Events the loop keys on (exact signatures from the verified 71-entry ABI). */
const JOB_FUNDED = parseAbiItem(
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)",
);
const PAYMENT_RELEASED = parseAbiItem(
  "event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)",
);
const REFUNDED = parseAbiItem(
  "event Refunded(uint256 indexed jobId, address indexed client, uint256 amount)",
);

/** Default per-schema demo queries (both serve against the pinned Messari pins). */
const DEFAULT_QUERIES: Record<string, string> = {
  "lending/3.1.0": "{ markets(first: 3) { id } }",
  "dex-amm/4.0.1": "{ pools(first: 3) { id } }",
};

/** Deterministic default query for a dataset (falls back to a shape query). */
export function defaultQueryFor(dataset: DatasetConfig): string {
  return DEFAULT_QUERIES[dataset.schema] ?? "{ __typename }";
}

/**
 * Match the job's SLA schemaHash to a configured dataset. The buyer packs
 * schemaHash = keccak256(toBytes(dataset.schema)) at pay time; the seller
 * resolves the same way. Returns undefined when no configured dataset matches.
 */
export function findDatasetForSla(
  config: OpenBookConfig,
  schemaHash: `0x${string}`,
): DatasetConfig | undefined {
  return config.datasets.find((dataset) => keccak256(toBytes(dataset.schema)) === schemaHash);
}

export interface SellerStats {
  scannedJobs: number;
  served: number;
  staleSkipped: number;
  alreadyServed: number;
  revenue6dec: bigint;
  refunded6dec: bigint;
  completedCount: number;
  refundCount: number;
  errors: string[];
}

export interface SellerServices {
  config: OpenBookConfig;
  env?: Record<string, string | undefined>;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

function defaultLog(line: string): void {
  console.log(`[seller] ${line}`);
}

const STATUS_FUNDED = 1;

/**
 * One seller pass: fund-scan → serve → revenue/refund tally.
 * Throws with a precise message when a required key is missing so the CLI can
 * print a clean skip notice (keyless runs never touch this function).
 */
export async function serveFundedJobs(
  services: SellerServices,
  opts: { sinceBlock?: bigint; lookback?: bigint } = {},
): Promise<SellerStats> {
  const env = services.env ?? {};
  const log = services.log ?? defaultLog;
  const config = services.config;

  const operatorKey = resolveOperatorKey(config, env);
  if (!operatorKey) {
    throw new Error(
      `seller: provider key missing — set ${config.operatorKey} (or ARC_TESTNET_PK) so the seller can sign setBudget/submit`,
    );
  }
  const gatewayKey = resolveGatewayKey(config, env);
  if (!gatewayKey) {
    throw new Error(
      "seller: GRAPH_GATEWAY_KEY missing — the seller serves live Gateway data and cannot run without it",
    );
  }

  const rpcUrl = env["ARC_TESTNET_RPC"] ?? ARC_RPC_URL;
  const publicClient =
    services.publicClient ?? createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
  const walletClient =
    services.walletClient ??
    createWalletClient({
      chain: arcTestnet,
      transport: http(rpcUrl),
      account: privateKeyToAccount(operatorKey),
    });

  const stats: SellerStats = {
    scannedJobs: 0,
    served: 0,
    staleSkipped: 0,
    alreadyServed: 0,
    revenue6dec: 0n,
    refunded6dec: 0n,
    completedCount: 0,
    refundCount: 0,
    errors: [],
  };

  const head: bigint = await publicClient.getBlockNumber();
  const lookback = opts.lookback ?? 1000n;
  const fromBlock = opts.sinceBlock ?? (head > lookback ? head - lookback : 1n);

  // 1. funded jobs in the window
  const fundedLogs = await publicClient.getLogs({
    address: ERC8183,
    event: JOB_FUNDED,
    fromBlock,
    toBlock: head,
  });

  // 4+5. revenue/refund tally across the same window (before the serve loop so
  // totals reflect everything the window saw, served or not)
  const [releasedLogs, refundedLogs] = await Promise.all([
    publicClient.getLogs({ address: ERC8183, event: PAYMENT_RELEASED, fromBlock, toBlock: head }),
    publicClient.getLogs({ address: ERC8183, event: REFUNDED, fromBlock, toBlock: head }),
  ]);
  for (const logEntry of releasedLogs) {
    stats.revenue6dec += logEntry.args.amount ?? 0n;
    stats.completedCount++;
    log(
      `REVENUE job=${logEntry.args.jobId} amount=${logEntry.args.amount} (6-dec USDC) tx=${logEntry.transactionHash}`,
    );
  }
  for (const logEntry of refundedLogs) {
    stats.refunded6dec += logEntry.args.amount ?? 0n;
    stats.refundCount++;
    log(
      `REFUND  job=${logEntry.args.jobId} amount=${logEntry.args.amount} (6-dec USDC) tx=${logEntry.transactionHash}`,
    );
  }

  // 2.+3.+4. serve each funded job
  for (const logEntry of fundedLogs) {
    const jobId = logEntry.args.jobId;
    if (jobId === undefined) continue;
    stats.scannedJobs++;
    let job;
    try {
      job = await getJob(publicClient, jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push(`getJob(${jobId}): ${message}`);
      continue;
    }
    if (job.status !== STATUS_FUNDED) {
      stats.alreadyServed++; // submitted/completed/rejected/expired in an earlier pass
      continue;
    }
    let sla: Sla;
    try {
      sla = parseSla(job.description);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push(`job ${jobId}: ${message}`);
      continue;
    }
    const dataset = findDatasetForSla(config, sla.schemaHash) ?? config.datasets[0];
    if (dataset === undefined) {
      stats.errors.push(`job ${jobId}: no dataset configured to serve`);
      continue;
    }
    let gatewayResult;
    try {
      gatewayResult = await gatewayQuery({
        key: gatewayKey,
        subgraphId: dataset.subgraphId,
        query: defaultQueryFor(dataset),
        fetchImpl: services.fetchImpl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push(`job ${jobId}: gateway query failed: ${message}`);
      continue;
    }
    const { data, meta } = gatewayResult;
    if (meta.block === null || meta.chainHeadBlock === null) {
      stats.staleSkipped++;
      log(`SKIP job=${jobId}: gateway returned no _meta — cannot attest freshness`);
      continue;
    }
    const inWindow = meta.chainHeadBlock - meta.block <= dataset.freshness.maxAge;
    const meetsSla = meta.block >= sla.minBlock;
    if (!inWindow || !meetsSla) {
      stats.staleSkipped++;
      log(
        `SKIP job=${jobId}: deliverable stale metaBlock=${meta.block} (window: head - block = ${meta.chainHeadBlock - meta.block}, SLA minBlock=${sla.minBlock}) — submitting would guarantee a refund`,
      );
      continue;
    }

    // deliverable hash over the payload WITHOUT _meta (deterministic, matches the MCP attestation)
    const payloadHash = keccak256(toBytes(JSON.stringify(stripMeta(data))));
    let receipt: TransactionReceipt;
    try {
      receipt = await submitDeliverable(publicClient, walletClient, jobId, payloadHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push(`job ${jobId}: submit failed: ${message}`);
      continue;
    }
    stats.served++;
    log(
      `SUBMITTED job=${jobId} dataset=${dataset.id} metaBlock=${meta.block} payloadHash=${payloadHash} tx=${receipt.transactionHash}`,
    );
  }

  log(
    `pass done: scanned=${stats.scannedJobs} served=${stats.served} stale=${stats.staleSkipped} ` +
      `revenue=${stats.revenue6dec} refunded=${stats.refunded6dec} (6-dec USDC) errors=${stats.errors.length}`,
  );
  return stats;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface CliOptions {
  config: string;
  once: boolean;
  intervalMs: number;
  lookback: bigint;
  since?: bigint;
}

function parseCli(argv: string[]): CliOptions {
  const args = [...argv];
  const options: CliOptions = {
    config: "mcp/config/openbook.json",
    once: false,
    intervalMs: 15_000,
    lookback: 1000n,
  };
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
  };
  const config = value("--config") ?? value("-c");
  if (config !== undefined) options.config = config;
  const interval = value("--interval");
  if (interval !== undefined) options.intervalMs = Number.parseInt(interval, 10);
  const lookback = value("--lookback");
  if (lookback !== undefined) options.lookback = BigInt(Number.parseInt(lookback, 10));
  const since = value("--since");
  if (since !== undefined) options.since = BigInt(Number.parseInt(since, 10));
  if (args.includes("--once")) options.once = true;
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

  // keyless discipline: clean skip notice, exit 0 (mirrors the repo's guards)
  const operatorKey = resolveOperatorKey(config, process.env);
  const gatewayKey = resolveGatewayKey(config, process.env);
  if (!operatorKey || !gatewayKey) {
    console.log(
      `[seller] SKIP: missing ${!operatorKey ? "provider key (" + config.operatorKey + "/ARC_TESTNET_PK)" : ""}` +
        `${!operatorKey && !gatewayKey ? " and " : ""}${!gatewayKey ? "GRAPH_GATEWAY_KEY" : ""} — ` +
        `the seller loop serves live Gateway data and signs onchain submits; keyless runs exit here (docs/keys-needed.md).`,
    );
    return;
  }

  for (;;) {
    const started = Date.now();
    await serveFundedJobs({ config, env: process.env }, { sinceBlock: options.since, lookback: options.lookback });
    if (options.once) return;
    const elapsed = Date.now() - started;
    if (elapsed >= options.intervalMs) continue;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, options.intervalMs - elapsed);
    await promise;
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
    console.error(`[seller] ${message}`);
    process.exit(1);
  });
}
