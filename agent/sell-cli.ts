/**
 * sell-cli.ts — OpenBook marketplace seller CLI (marketplace brief §3 W1).
 *
 * A second seller runs end-to-end from a fresh config, no code edits:
 *
 *   sell init --name alpha --schema lending/3.1.0 --price 0.12
 *       writes sellers/alpha.json (a SellerConfig; see sellers/README.md)
 *   sell register --config sellers/alpha.json
 *       creates alpha.openbook.eth as an ENSv2 subname of the openbook.eth
 *       storefront, writes svc.menu/price/sla/payee/operator through the same
 *       ens CLI + cast pipeline as scripts/ens/setup.sh, then READS THE
 *       RECORDS BACK (viem through mcp/src/ens.ts — the same read path
 *       listSellers and the app use) and prints them
 *   sell serve --config sellers/alpha.json [--once]
 *       delegates to the existing seller loop (agent/seller.ts serveFundedJobs)
 *
 * Keyless discipline (repo convention): register needs SEPOLIA_PK + SEPOLIA_RPC
 * (broadcasts via cast, exactly like scripts/ens/setup.sh), serve needs the
 * config operator key + GRAPH_GATEWAY_KEY. Missing keys print a clean SKIP
 * notice and exit 0 — nothing is ever broadcast or signed without the key that
 * authorizes it.
 *
 * Run:  bun agent/sell-cli.ts <init|register|serve> [flags]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { setEscrowAddress } from "./escrow";
import {
  createEnsTextReader,
  parsePriceToAmount6dec,
  parseSlaRecord,
  resolveServiceRecords,
  type EnsTextReader,
  type ServiceRecords,
} from "../mcp/src/ens";
import {
  DEFAULT_GATEWAY_BASE,
  DEFAULT_KEY_ENV,
  DEFAULT_PNL_ENDPOINT,
  DEFAULT_PNL_QUERY,
  PINNED_SUBGRAPH_IDS,
  resolveGatewayKey,
  resolveOperatorKey,
  type DatasetConfig,
  type OpenBookConfig,
} from "../mcp/src/datasets";
import { serveFundedJobs } from "./seller";

// ---------------------------------------------------------------------------
// Marketplace ground truth (docs/marketplace-brief.md §1, verified 2026-09-12)
// ---------------------------------------------------------------------------

/** Shared ERC-8183 escrow instance (fee-configured: 2% to the PolicyWallet). */
export const MARKET_ESCROW: Address = "0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5";
/** SlaHook (v2, ERC-165) whitelisted on the marketplace escrow. */
export const MARKET_HOOK: Address = "0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846";
/** Reference operator / seller address of the openbook.eth storefront. */
export const MARKET_OPERATOR: Address = "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21";
/** Parent storefront name; sellers register as <slug>.openbook.eth subnames. */
export const STOREFRONT_ENS = "openbook.eth";

// ---------------------------------------------------------------------------
// SellerConfig (frozen interface, brief §3 W1) and the config→dataset mapping
// ---------------------------------------------------------------------------

export interface SellerGatewayConfig {
  /** The Graph Gateway base URL (no trailing slash). */
  url: string;
  /** env var NAME holding the Subgraph Studio gateway key. */
  gatewayKeyEnv: string;
}

/** A seller storefront config. operatorKey is an env var NAME, never a literal key. */
export interface SellerConfig {
  name: string;
  /** ENSv2 name (Sepolia) whose svc.* records price and gate the service. */
  ens: string;
  /** ERC-8183 escrow address (Arc testnet) this seller serves on. */
  escrow: Address;
  /** onchain SLA hook whitelisted on the escrow, when the seller uses one. */
  hook?: Address;
  /** seller payout address (written as svc.payee at register time). */
  payee: Address;
  /** env var NAME holding the seller's signing key (never a literal key). */
  operatorKey: string;
  gateway: SellerGatewayConfig;
  datasets: DatasetConfig[];
}

/** Schema → pinned reference dataset defaults (mirrors mcp/config/openbook.json). */
interface SchemaDefault {
  id: string;
  subgraphId: string;
  description: string;
  chain: "arbitrum" | "ethereum";
  freshnessMaxAge: number;
}

const SCHEMA_CATALOG: Record<string, SchemaDefault> = {
  "lending/3.1.0": {
    id: "aave-v3-arbitrum-lending",
    subgraphId: PINNED_SUBGRAPH_IDS["aave-v3-arbitrum-lending"],
    description: "Aave V3 lending markets on Arbitrum (Messari lending schema)",
    chain: "arbitrum",
    freshnessMaxAge: 50,
  },
  "dex-amm/4.0.1": {
    id: "uniswap-v3-arbitrum-dex",
    subgraphId: PINNED_SUBGRAPH_IDS["uniswap-v3-arbitrum-dex"],
    description: "Uniswap V3 AMM pools on Arbitrum (Messari dex schema)",
    chain: "arbitrum",
    freshnessMaxAge: 50,
  },
  "nft-marketplace/2.1.0": {
    id: "opensea-nft-trades",
    subgraphId: "2GmLsgYGWoFoouZzKjp8biYDkfmeLTkEY3VDQyZqSJHA",
    description: "OpenSea (Seaport) NFT trades on Ethereum (Messari nft-marketplace schema)",
    chain: "ethereum",
    freshnessMaxAge: 50,
  },
  "ens/1.0.0": {
    id: "ens-registrations",
    subgraphId: "5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH",
    description: "ENS name registrations as they happen (Messari ens schema)",
    chain: "ethereum",
    freshnessMaxAge: 50,
  },
  "sports-odds/1.0.0": {
    id: "overtime-sports-odds",
    subgraphId: "DFNKpS95y26V3kuTa9MtD2J3ws65QF6RPP7RFLRjaHFx",
    description: "Live sports prediction-market odds on Arbitrum (Overtime) (Messari sports-odds schema)",
    chain: "arbitrum",
    freshnessMaxAge: 50,
  },
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Parse a bare decimal USDC amount ("0.12", "0.005") into 6-decimal units
 * (120000, 5000). Exact integer arithmetic: more than 6 decimals cannot be
 * represented in the 6-dec svc.price record and is rejected, never rounded.
 */
export function parsePriceToUsdc6dec(raw: string): number {
  const match = /^\s*([0-9]+)(?:\.([0-9]+))?\s*$/.exec(raw);
  if (!match) {
    throw new Error(`sell init: --price must be a decimal USDC amount (got "${raw}")`);
  }
  const fraction = match[2] ?? "";
  if (fraction.length > 6) {
    throw new Error(
      `sell init: --price ${raw} has ${fraction.length} decimals; the svc.price record is 6-decimal USDC (max 6)`,
    );
  }
  const units = Number(`${match[1]}${fraction.padEnd(6, "0")}`);
  if (!Number.isSafeInteger(units)) {
    throw new Error(`sell init: --price ${raw} is too large for 6-decimal USDC units`);
  }
  return units;
}

/**
 * Render 6-decimal USDC units as the exact decimal string of the record value
 * ("0.005", "0.12") — never rounded. toString() of an integer-unit amount is
 * exact for every 6-dec value ≥ 1 unit (1e-6 floor: "0.000001").
 */
export function usdc6decToDisplay(amount6dec: number): string {
  return (amount6dec / 1_000_000).toString();
}

export interface InitOptions {
  name: string;
  schema: string;
  price: string;
  subgraph?: string;
  payee?: string;
  force?: boolean;
  dir?: string;
}

/** Build a fresh SellerConfig from the sell init flags. Deterministic and pure. */
export function buildSellerConfig(opts: InitOptions): SellerConfig {
  const slug = opts.name.trim();
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `sell init: --name must be a lowercase ENS label (a-z, 0-9, hyphen; got "${opts.name}")`,
    );
  }
  const schema = opts.schema.trim();
  if (schema.length === 0) {
    throw new Error("sell init: --schema is required (e.g. lending/3.1.0)");
  }
  const priceUsdc = parsePriceToUsdc6dec(opts.price.trim());
  if (opts.payee !== undefined && !ADDRESS_RE.test(opts.payee)) {
    throw new Error(`sell init: --payee must be a 0x-prefixed 40-hex address (got "${opts.payee}")`);
  }
  const catalog = SCHEMA_CATALOG[schema];
  const subgraph = opts.subgraph?.trim();
  if (subgraph !== undefined && /^0x/.test(subgraph)) {
    throw new Error("sell init: --subgraph expects a The Graph subgraph id (not an address)");
  }

  // Deterministic dataset: catalog pins by default; an explicit --subgraph that
  // matches the pin keeps the pinned identity, anything else is a custom dataset.
  const pinnedSubgraph = catalog?.subgraphId;
  let dataset: DatasetConfig;
  if (subgraph !== undefined && pinnedSubgraph !== undefined && subgraph === pinnedSubgraph) {
    dataset = {
      id: catalog.id,
      subgraphId: subgraph,
      schema,
      description: catalog.description,
      freshness: { maxAge: catalog.freshnessMaxAge },
      priceUsdc,
      pinned: true,
      chain: catalog.chain,
    };
  } else if (subgraph !== undefined) {
    dataset = {
      id: `${slug}-${schema.replaceAll("/", "-")}`,
      subgraphId: subgraph,
      schema,
      description: `${schema} via subgraph ${subgraph} (self-listed by ${slug})`,
      freshness: { maxAge: catalog?.freshnessMaxAge ?? 50 },
      priceUsdc,
      pinned: false,
      chain: catalog?.chain ?? "arbitrum",
    };
  } else if (catalog !== undefined) {
    dataset = {
      id: catalog.id,
      subgraphId: catalog.subgraphId,
      schema,
      description: catalog.description,
      freshness: { maxAge: catalog.freshnessMaxAge },
      priceUsdc,
      pinned: true,
      chain: catalog.chain,
    };
  } else {
    throw new Error(
      `sell init: schema "${schema}" has no pinned default subgraph; pass --subgraph <id>`,
    );
  }

  return {
    name: slug,
    ens: `${slug}.${STOREFRONT_ENS}`,
    escrow: MARKET_ESCROW,
    hook: MARKET_HOOK,
    payee: (opts.payee?.trim() as Address) ?? MARKET_OPERATOR,
    operatorKey: `SELLER_${slug.replaceAll("-", "_").toUpperCase()}_PK`,
    gateway: { url: DEFAULT_GATEWAY_BASE, gatewayKeyEnv: DEFAULT_KEY_ENV },
    datasets: [dataset],
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`seller config: ${field} must be a non-empty string`);
  }
  return value;
}

function requireAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Error(`seller config: ${field} must be a 0x-prefixed 40-hex address`);
  }
  return value as Address;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`seller config: ${field} must be a positive integer`);
  }
  return value;
}

function validateDataset(entry: unknown, index: number): DatasetConfig {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`seller config: datasets[${index}] must be an object`);
  }
  const raw = entry as Record<string, unknown>;
  const id = requireText(raw["id"], `datasets[${index}].id`);
  const subgraphId = requireText(raw["subgraphId"], `datasets[${index}].subgraphId`);
  const schema = requireText(raw["schema"], `datasets[${index}].schema`);
  const freshnessRaw = raw["freshness"];
  const freshness =
    typeof freshnessRaw === "object" && freshnessRaw !== null
      ? (freshnessRaw as Record<string, unknown>)
      : null;
  if (!freshness) throw new Error(`seller config: datasets[${index}].freshness must be an object`);
  const maxAge = requirePositiveInt(freshness["maxAge"], `datasets[${index}].freshness.maxAge`);
  const priceUsdc = raw["priceUsdc"];
  if (typeof priceUsdc !== "number" || !Number.isInteger(priceUsdc) || priceUsdc < 0) {
    throw new Error(
      `seller config: datasets[${index}].priceUsdc must be a non-negative integer (6-dec USDC)`,
    );
  }
  const chainRaw = raw["chain"];
  if (chainRaw !== "arbitrum" && chainRaw !== "ethereum") {
    throw new Error(
      `seller config: datasets[${index}].chain must be "arbitrum" or "ethereum" (the freshness head reference chain)`,
    );
  }
  return {
    id,
    subgraphId,
    schema,
    description: requireText(raw["description"] ?? schema, `datasets[${index}].description`),
    freshness: { maxAge },
    priceUsdc,
    pinned: PINNED_SUBGRAPH_IDS[id] !== undefined && PINNED_SUBGRAPH_IDS[id] === subgraphId,
    chain: chainRaw,
  };
}

/** Validate an untrusted seller config JSON blob into a typed SellerConfig. */
export function validateSellerConfig(parsed: unknown): SellerConfig {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`seller config: must contain a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;
  const datasetsRaw = raw["datasets"];
  if (!Array.isArray(datasetsRaw) || datasetsRaw.length === 0) {
    throw new Error(`seller config: datasets must be a non-empty array`);
  }
  const gatewayRaw = raw["gateway"];
  const gateway =
    typeof gatewayRaw === "object" && gatewayRaw !== null
      ? (gatewayRaw as Record<string, unknown>)
      : null;
  if (!gateway) throw new Error(`seller config: gateway must be an object`);
  const config: SellerConfig = {
    name: requireText(raw["name"], "name"),
    ens: requireText(raw["ens"], "ens"),
    escrow: requireAddress(raw["escrow"], "escrow"),
    payee: requireAddress(raw["payee"], "payee"),
    operatorKey: requireText(raw["operatorKey"], "operatorKey"),
    gateway: {
      url: requireText(gateway["url"], "gateway.url"),
      gatewayKeyEnv: requireText(gateway["gatewayKeyEnv"], "gateway.gatewayKeyEnv"),
    },
    datasets: datasetsRaw.map(validateDataset),
  };
  const hook = raw["hook"];
  if (hook !== undefined && hook !== null && !ADDRESS_RE.test(hook as string)) {
    throw new Error(`seller config: hook must be a 0x-prefixed 40-hex address`);
  }
  if (typeof hook === "string" && hook.length > 0) config.hook = hook as Address;
  return config;
}

/** Load + validate sellers/<slug>.json. */
export function loadSellerConfig(configPath: string): SellerConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`seller config: cannot load ${configPath}: ${message}`);
  }
  return validateSellerConfig(parsed);
}

/**
 * Map a SellerConfig onto the existing OpenBookConfig consumed by the seller
 * loop (agent/seller.ts serveFundedJobs). gateway {url, gatewayKeyEnv} is the
 * frozen marketplace shape; the loop's shape is {baseUrl, keyEnv} plus a pnl
 * section — both mapped here, nothing reinvented.
 */
export function toOpenBookConfig(seller: SellerConfig): OpenBookConfig {
  return {
    name: seller.name,
    ens: seller.ens,
    escrow: seller.escrow,
    payee: seller.payee,
    operatorKey: seller.operatorKey,
    gateway: { keyEnv: seller.gateway.gatewayKeyEnv, baseUrl: seller.gateway.url },
    pnl: { endpoint: DEFAULT_PNL_ENDPOINT, query: DEFAULT_PNL_QUERY },
    datasets: seller.datasets.map((dataset) => ({
      ...dataset,
      pinned:
        PINNED_SUBGRAPH_IDS[dataset.id] !== undefined &&
        PINNED_SUBGRAPH_IDS[dataset.id] === dataset.subgraphId,
    })),
  };
}

/** Write the sellers/<slug>.json file. Refuses to overwrite without --force. */
export function initSeller(opts: InitOptions): string {
  const config = buildSellerConfig(opts);
  const dir = opts.dir ?? resolve("sellers");
  const path = resolve(dir, `${config.name}.json`);
  if (existsSync(path) && !opts.force) {
    throw new Error(`sell init: ${path} already exists (pass --force to overwrite)`);
  }
  mkdirSync(dir, { recursive: true });
  // `pinned` is loader-derived (same rule as mcp/src/datasets.ts) — not stored.
  const stored = {
    ...config,
    datasets: config.datasets.map(({ pinned: _pinned, ...rest }) => rest),
  };
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
  return path;
}

// ---------------------------------------------------------------------------
// register — subname + svc.* records, then live read-back
// ---------------------------------------------------------------------------

export interface SvcRecordOp {
  type: "text";
  key: string;
  value: string;
}

/**
 * Records written for a seller: svc.menu/price/sla/payee/operator. The price
 * record is name-level (one svc.price per storefront), so every dataset must
 * share a price; the SLA record carries the tightest freshness guarantee.
 */
export function buildSvcRecords(
  seller: SellerConfig,
  operatorAddress: Address,
): SvcRecordOp[] {
  const prices = new Set(seller.datasets.map((dataset) => dataset.priceUsdc));
  if (prices.size !== 1) {
    throw new Error(
      `sell register: all datasets must share one price (svc.price is name-level); got ${[...prices].join(", ")}`,
    );
  }
  const maxBlockLag = Math.min(...seller.datasets.map((dataset) => dataset.freshness.maxAge));
  return [
    {
      type: "text",
      key: "svc.menu",
      value: JSON.stringify(
        seller.datasets.map((dataset) => ({ id: dataset.id, schema: dataset.schema })),
      ),
    },
    {
      type: "text",
      key: "svc.price",
      value: `${usdc6decToDisplay(seller.datasets[0].priceUsdc)} USDC/query`,
    },
    { type: "text", key: "svc.sla", value: JSON.stringify({ maxBlockLag, maxLatencyMs: 2000 }) },
    { type: "text", key: "svc.payee", value: seller.payee },
    { type: "text", key: "svc.operator", value: operatorAddress },
  ];
}

export interface RegisteredSeller {
  /** tx hashes of the subname-create broadcasts (empty when already registered). */
  subnameTxs: string[];
  /** tx hashes of the record-set broadcasts. */
  recordsTxs: string[];
  /** records read back from the chain after registration. */
  records: ServiceRecords & { operator: string | null };
  priceUsdc: number;
  sla: { maxBlockLag: number; maxLatencyMs: number };
}

export type EnsRunner = (args: string[]) => string;
export type CastRunner = (to: string, data: string, label: string) => string;

/** Extract the JSON object from a cast/ens CLI stdout envelope. */
function extractJsonObject(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`expected JSON output, got: ${stdout.slice(0, 200)}`);
  }
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

/** Broadcast one or more ops from an ens CLI calldata envelope. */
function broadcastOps(
  stdout: string,
  label: string,
  castSend: CastRunner,
  log: (line: string) => void,
): string[] {
  const parsed = extractJsonObject(stdout);
  const ops = Array.isArray(parsed["operations"])
    ? (parsed["operations"] as Record<string, unknown>[])
    : [parsed];
  const hashes: string[] = [];
  for (const op of ops) {
    const to = op["to"];
    const data = op["data"];
    if (typeof to !== "string" || typeof data !== "string") {
      throw new Error(`${label}: calldata op missing to/data`);
    }
    const hash = castSend(to, data, label);
    hashes.push(hash);
    log(`${label} broadcast -> ${to} tx=${hash}`);
  }
  return hashes;
}

export interface RegisterDeps {
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** ens CLI runner — default shells out to the repo's ens CLI (like scripts/ens/setup.sh). */
  ensCli?: EnsRunner;
  /** cast send runner — default shells out to foundry cast with SEPOLIA_PK. */
  castSend?: CastRunner;
  /** ENS text reader — defaults to the live viem reader (mcp/src/ens.ts). */
  readEnsText?: EnsTextReader;
}

/** Child-process env with a usable PATH (the harness runs bun with PATH unset). */
function childEnv(extraDirs: string[]): Record<string, string> {
  const existing = process.env["PATH"] ?? "";
  const dirs = [
    ...new Set([
      ...extraDirs,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      ...(existing.length > 0 ? existing.split(":") : []),
    ]),
  ];
  return { ...process.env, PATH: dirs.join(":") };
}

function defaultEnsRunner(rpcUrl: string, binary: string): EnsRunner {
  return (args) =>
    execFileSync(binary, [...args, "--chain", "sepolia", "--rpc", rpcUrl, "--format", "json"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: childEnv([dirname(binary)]),
    });
}

function defaultCastRunner(rpcUrl: string, operatorPk: string, binary: string): CastRunner {
  return (to, data, label) => {
    const out = execFileSync(
      binary,
      ["send", to, data, "--rpc-url", rpcUrl, "--private-key", operatorPk, "--json"],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: childEnv([dirname(binary)]),
      },
    );
    const hash = extractJsonObject(out)["transactionHash"];
    if (typeof hash !== "string") {
      throw new Error(`${label}: cast send returned no transactionHash: ${out.slice(0, 200)}`);
    }
    return hash;
  };
}

/**
 * Resolve a CLI binary. bun in this repo's harness runs with an empty PATH
 * (bun -e prints PATH: undefined), so ens/cast are pinned to their known
 * install dirs first, with PATH resolution as the fallback for normal shells.
 */
function resolveBinary(name: string, candidates: string[], home: string): string {
  const all = [...candidates, join(home, ".local", "bin", name), join(home, ".foundry", "bin", name)];
  for (const candidate of all) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // unreadable candidate — try the next one
    }
  }
  return name;
}

/**
 * Register a seller: create <slug>.openbook.eth as an ENSv2 subname (owner =
 * the seller's payee, signed by SEPOLIA_PK exactly like scripts/ens/setup.sh),
 * set the svc.* records through the ens CLI + cast, then READ THE RECORDS BACK
 * through mcp/src/ens.ts (the same live viem path the directory and the app
 * use) and return the verified records.
 */
export async function registerSeller(
  seller: SellerConfig,
  deps: RegisterDeps = {},
): Promise<RegisteredSeller> {
  const env = deps.env ?? {};
  const log = deps.log ?? ((line: string) => console.log(line));
  const rpcUrl = env["SEPOLIA_RPC"];
  const sepoliaPk = env["SEPOLIA_PK"];
  if (!rpcUrl || !sepoliaPk) {
    throw new Error("sell register: SEPOLIA_PK + SEPOLIA_RPC required (register broadcasts like scripts/ens/setup.sh)");
  }
  const ensCli = deps.ensCli ?? defaultEnsRunner(rpcUrl, resolveBinary("ens", [], homedir()));
  const castSend =
    deps.castSend ??
    defaultCastRunner(rpcUrl, sepoliaPk, resolveBinary("cast", [join(homedir(), ".foundry", "bin", "cast")], homedir()));
  const readEnsText = deps.readEnsText ?? createEnsTextReader({ rpcUrl });

  // The seller operator identity: derived from the config's named env key when
  // present, else the seller's own payee address.
  const envKey = env[seller.operatorKey];
  const hasEnvKey = typeof envKey === "string" && HEX_KEY_RE.test(envKey);
  const operatorAddress: Address = hasEnvKey
    ? privateKeyToAccount(envKey as `0x${string}`).address
    : seller.payee;
  if (hasEnvKey) {
    log(
      `[register] operator identity = ${operatorAddress} (derived from ${seller.operatorKey}` +
        `${operatorAddress.toLowerCase() === seller.payee.toLowerCase() ? ", matches payee" : ""})`,
    );
  } else {
    log(
      `[register] operator identity = payee ${seller.payee} (no ${seller.operatorKey} in env; ${seller.operatorKey} holds the seller's signing key)`,
    );
  }

  const subnameTxs: string[] = [];

  // 1. subname create — the only op with an "already registered" recovery:
  //    a re-run finds svc.price set and skips to the read-back.
  try {
    const calldata = ensCli(["subname", "create", seller.ens, "--owner", seller.payee]);
    subnameTxs.push(...broadcastOps(calldata, "subname create", castSend, log));
    log(`[register] created subname ${seller.ens} (owner ${seller.payee})`);
  } catch (error) {
    const probe = ensCli(["get", "text", seller.ens, "--key", "svc.price"]);
    const probed = extractJsonObject(probe)["value"];
    if (typeof probed === "string" && probed.length > 0) {
      log(`[register] ${seller.ens} already registered with records — reusing`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `sell register: subname create failed for ${seller.ens}: ${message} ` +
          `(if the subname already exists without records, resolve the subregistry state onchain then re-run)`,
      );
    }
  }

  // 2. write svc.menu/price/sla/payee/operator through the ens CLI + cast.
  const records = buildSvcRecords(seller, operatorAddress);
  const recordsJson = JSON.stringify(records);
  const setCalldata = ensCli(["set", "batch", seller.ens, "--data", recordsJson]);
  const recordsTxs = broadcastOps(setCalldata, "records set", castSend, log);
  log(`[register] wrote ${records.length} svc.* records to ${seller.ens}`);

  // 3. read the records back — hard-fails on a missing price/sla/payee.
  const service = await resolveServiceRecords(seller.ens, readEnsText);
  const operator = await readEnsText(seller.ens, "svc.operator");
  const priceUsdc = parsePriceToAmount6dec(service.price as string);
  const sla = parseSlaRecord(service.sla as string);
  const result: RegisteredSeller = {
    subnameTxs,
    recordsTxs,
    records: { ...service, operator },
    priceUsdc,
    sla,
  };
  log(`[register] read-back (live ENSv2 Sepolia via ${seller.ens}):`);
  log(`  svc.menu     = ${service.menu ?? "(unset)"}`);
  log(`  svc.price    = ${service.price}  (${priceUsdc} = 6-dec USDC units)`);
  log(`  svc.sla      = ${service.sla}  (parses: maxBlockLag=${sla.maxBlockLag}, maxLatencyMs=${sla.maxLatencyMs})`);
  log(`  svc.payee    = ${service.payee}`);
  log(`  svc.operator = ${operator ?? "(unset)"}`);
  log(`[register] OK — ${seller.ens} is a live storefront`);
  return result;
}

// ---------------------------------------------------------------------------
// serve — delegate to the existing seller loop
// ---------------------------------------------------------------------------

export interface ServeOptions {
  once?: boolean;
  intervalMs?: number;
  lookback?: bigint;
  since?: bigint;
}

/**
 * Point the agent escrow module at the config's escrow — the same seam
 * buyer-cli honors via OPENBOOK_ESCROW. The loop's state reads, submits and
 * tallies then target the seller's escrow (SellerConfig.escrow is the market
 * instance), never the module default.
 */
export function applySellerEscrow(seller: SellerConfig): void {
  setEscrowAddress(seller.escrow);
}

/**
 * Mirror agent/seller.ts main(): the loop body is serveFundedJobs, delegated.
 * The escrow seam is applied BEFORE the keyless skip so a skip leaves no stale
 * module target behind and the keyed loop always serves the config's escrow.
 */
export async function serveSellerConfig(
  seller: SellerConfig,
  opts: ServeOptions,
  env: Record<string, string | undefined>,
): Promise<{ skipped: boolean }> {
  applySellerEscrow(seller);
  const config = toOpenBookConfig(seller);
  const operatorKey = resolveOperatorKey(config, env);
  const gatewayKey = resolveGatewayKey(config, env);
  if (!operatorKey || !gatewayKey) {
    console.log(
      `[sell serve] SKIP: missing ${!operatorKey ? "seller key (" + seller.operatorKey + ")" : ""}` +
        `${!operatorKey && !gatewayKey ? " and " : ""}${!gatewayKey ? "GRAPH_GATEWAY_KEY" : ""} — ` +
        `the seller loop serves live Gateway data and signs onchain submits; keyless runs exit here.`,
    );
    return { skipped: true };
  }
  for (;;) {
    const started = Date.now();
    await serveFundedJobs(
      { config, env },
      { sinceBlock: opts.since, lookback: opts.lookback },
    );
    if (opts.once) return { skipped: false };
    const elapsed = Date.now() - started;
    if (elapsed >= (opts.intervalMs ?? 15_000)) continue;
    const { promise, resolve: sleepResolve } = Promise.withResolvers<void>();
    setTimeout(sleepResolve, (opts.intervalMs ?? 15_000) - elapsed);
    await promise;
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

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

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function usage(): void {
  console.log(
    [
      "sell — OpenBook marketplace seller CLI",
      "",
      "Usage:",
      "  sell init --name <slug> --schema <schema> --price <usdc> [--subgraph <id>]",
      "          [--payee <address>] [--force]",
      "      writes sellers/<slug>.json (a SellerConfig)",
      "",
      "  sell register --config sellers/<slug>.json",
      "      creates <slug>.openbook.eth + sets svc.menu/price/sla/payee/operator,",
      "      then READS THE RECORDS BACK and prints them (needs SEPOLIA_PK + SEPOLIA_RPC)",
      "",
      "  sell serve --config sellers/<slug>.json [--once] [--interval <ms>]",
      "          [--lookback <blocks>] [--since <block>]",
      "      runs the existing seller loop (agent/seller.ts) with that config",
      "",
      "Keyless runs (missing keys) print a SKIP notice and exit 0 — nothing is broadcast.",
    ].join("\n"),
  );
}

export async function main(argv: string[]): Promise<void> {
  loadDotEnv(process.env);
  const sub = argv[0];
  try {
    if (sub === "init") {
      const name = flagValue(argv, "--name");
      const schema = flagValue(argv, "--schema");
      const price = flagValue(argv, "--price");
      if (name === undefined || schema === undefined || price === undefined) {
        throw new Error(
          "sell init: --name <slug> --schema <schema> --price <usdc> are required [--subgraph <id>] [--payee <address>] [--force]",
        );
      }
      const path = initSeller({
        name,
        schema,
        price,
        subgraph: flagValue(argv, "--subgraph"),
        payee: flagValue(argv, "--payee"),
        force: hasFlag(argv, "--force"),
      });
      console.log(`[sell init] wrote ${path}`);
    } else if (sub === "register") {
      const configPath = flagValue(argv, "--config");
      if (configPath === undefined) throw new Error("sell register: --config <path> is required");
      const seller = loadSellerConfig(configPath);
      if (!process.env["SEPOLIA_PK"] || !process.env["SEPOLIA_RPC"]) {
        console.log(
          `[sell register] SKIP: SEPOLIA_PK + SEPOLIA_RPC missing — register broadcasts subname + records ` +
            `(via cast, like scripts/ens/setup.sh); keyless runs exit here.`,
        );
        return;
      }
      await registerSeller(seller, { env: process.env });
    } else if (sub === "serve") {
      const configPath = flagValue(argv, "--config");
      if (configPath === undefined) throw new Error("sell serve: --config <path> is required");
      const seller = loadSellerConfig(configPath);
      const once = hasFlag(argv, "--once");
      const intervalRaw = flagValue(argv, "--interval");
      const lookbackRaw = flagValue(argv, "--lookback");
      const sinceRaw = flagValue(argv, "--since");
      await serveSellerConfig(
        seller,
        {
          once,
          intervalMs: intervalRaw !== undefined ? Number.parseInt(intervalRaw, 10) : 15_000,
          lookback: lookbackRaw !== undefined ? BigInt(Number.parseInt(lookbackRaw, 10)) : undefined,
          since: sinceRaw !== undefined ? BigInt(Number.parseInt(sinceRaw, 10)) : undefined,
        },
        process.env,
      );
    } else {
      usage();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sell ${sub}] ${message}`);
    process.exit(1);
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
    console.error(`[sell] ${message}`);
    process.exit(1);
  });
}
