/**
 * Dataset registry + config loading for sla-subgraph-mcp (OpenBook Task 5).
 *
 * The global "Start Fresh" data spine is two pinned live Messari subgraphs
 * (verified anchors from the plan). Configs may also self-register datasets:
 * anything not in PINNED_SUBGRAPH_IDS is served from the config's own
 * subgraphId — that is how the Compound V3 demo config reuses this server.
 *
 * Secrecy rule: configs NEVER hold private keys. `operatorKey` is either a hex
 * key (user-authored local configs) or, in committed configs, the NAME of an
 * environment variable (e.g. "OPERATOR_PRIVATE_KEY") that holds the key.
 */
import { readFileSync } from "node:fs";

/** Pinned, verified Messari subgraph ids (live on the The Graph Gateway). */
export const PINNED_SUBGRAPH_IDS: Record<string, string> = {
  "aave-v3-arbitrum-lending": "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
  "uniswap-v3-arbitrum-dex": "FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX",
};

export const DEFAULT_GATEWAY_BASE = "https://gateway.thegraph.com";
export const DEFAULT_KEY_ENV = "GRAPH_GATEWAY_KEY";
export const DEFAULT_PNL_ENDPOINT =
  "https://api.studio.thegraph.com/query/{GRAPH_GATEWAY_KEY}/openbook-pnl/version/latest";
export const DEFAULT_PNL_QUERY =
  "{ dailyPnLs { id revenue costs refunds net } _meta { block { number } } }";

export interface FreshnessConfig {
  /** maximum tolerated chain head lag in blocks; beyond it the query is STALE */
  maxAge: number;
}

export interface DatasetConfig {
  id: string;
  /** pinned subgraph id served via the Gateway /subgraphs/id/<id> endpoint */
  subgraphId: string;
  /** dataset schema label, e.g. "lending/3.1.0" */
  schema: string;
  description: string;
  freshness: FreshnessConfig;
  /** price in 6-decimal USDC units (100000 = 0.10 USDC) — display only; the
   * authoritative price comes from the ENS svc.price record at quote time */
  priceUsdc: number;
  /** true for the global Start Fresh pins; configs set pseudo-field via loader */
  pinned: boolean;
  /** the dataset's settlement chain — the freshness head reference (Alchemy
   * eth_blockNumber); the Gateway _meta has no chainHeadBlock field */
  chain: "arbitrum" | "ethereum";
}

export interface GatewayConfig {
  /** env var name holding the Subgraph Studio gateway key */
  keyEnv: string;
  baseUrl: string;
}

export interface PnlConfig {
  /** Studio query endpoint; "{GRAPH_GATEWAY_KEY}" is substituted from env */
  endpoint: string;
  query: string;
}

export interface OpenBookConfig {
  name: string;
  /** ENSv2 name (Sepolia) whose svc.* records price and gate the service */
  ens: string;
  /** ERC-8183 AgenticCommerce address on Arc testnet */
  escrow: `0x${string}`;
  /** seller payout address — DISPLAY-ONLY fallback; get_quote resolves svc.payee LIVE from ENSv2, so "" (unset) is valid */
  payee: string;
  operatorKey: string;
  gateway: GatewayConfig;
  pnl: PnlConfig;
  datasets: DatasetConfig[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`mcp config: ${field} must be a non-empty string`);
  }
  return value;
}

function requireAddress(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Error(`mcp config: ${field} must be a 0x-prefixed 40-hex address`);
  }
  return value as `0x${string}`;
}

/**
 * Optional address: "" means unset. Config payee is display-only — get_quote
 * resolves svc.payee LIVE from the ENS records, so a zero-address placeholder
 * is worse than absent (it reads as a real payout target).
 */
function requireAddressOrEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || (value.length !== 0 && !ADDRESS_RE.test(value))) {
    throw new Error(
      `mcp config: ${field} must be a 0x-prefixed 40-hex address or "" (unset — display-only; get_quote resolves svc.payee live)`,
    );
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`mcp config: ${field} must be a positive integer`);
  }
  return value;
}

function validateDataset(entry: unknown, index: number): DatasetConfig {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`mcp config: datasets[${index}] must be an object`);
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
  if (!freshness) throw new Error(`mcp config: datasets[${index}].freshness must be an object`);
  const maxAge = requirePositiveInt(freshness["maxAge"], `datasets[${index}].freshness.maxAge`);
  const priceUsdc = raw["priceUsdc"];
  if (typeof priceUsdc !== "number" || !Number.isInteger(priceUsdc) || priceUsdc < 0) {
    throw new Error(`mcp config: datasets[${index}].priceUsdc must be a non-negative integer (6-dec USDC)`);
  }
  const pinnedId = PINNED_SUBGRAPH_IDS[id];
  if (pinnedId !== undefined && pinnedId !== subgraphId) {
    throw new Error(
      `mcp config: dataset "${id}" is a Global Start Fresh pin; its subgraphId must be ${pinnedId} (got ${subgraphId})`,
    );
  }
  const chainRaw = raw["chain"];
  if (chainRaw !== "arbitrum" && chainRaw !== "ethereum") {
    throw new Error(
      `mcp config: datasets[${index}].chain must be "arbitrum" or "ethereum" (the freshness head reference chain)`,
    );
  }
  return {
    id,
    subgraphId,
    schema,
    description: requireText(raw["description"] ?? schema, `datasets[${index}].description`),
    freshness: { maxAge },
    priceUsdc,
    pinned: pinnedId !== undefined,
    chain: chainRaw,
  };
}

/** Load + validate an OpenBook config JSON file. */
export function loadConfigFile(configPath: string): OpenBookConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`mcp config: cannot load ${configPath}: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`mcp config: ${configPath} must contain a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;
  const datasetsRaw = raw["datasets"];
  if (!Array.isArray(datasetsRaw) || datasetsRaw.length === 0) {
    throw new Error(`mcp config: datasets must be a non-empty array`);
  }
  const gatewayRaw = raw["gateway"];
  const gateway =
    typeof gatewayRaw === "object" && gatewayRaw !== null
      ? (gatewayRaw as Record<string, unknown>)
      : null;
  const pnlRaw = raw["pnl"];
  const pnl = typeof pnlRaw === "object" && pnlRaw !== null ? (pnlRaw as Record<string, unknown>) : null;
  return {
    name: requireText(raw["name"], "name"),
    ens: requireText(raw["ens"], "ens"),
    escrow: requireAddress(raw["escrow"], "escrow"),
    payee: requireAddressOrEmpty(raw["payee"], "payee"),
    operatorKey: requireText(raw["operatorKey"], "operatorKey"),
    gateway: {
      keyEnv: requireText(gateway?.["keyEnv"] ?? DEFAULT_KEY_ENV, "gateway.keyEnv"),
      baseUrl: requireText(gateway?.["baseUrl"] ?? DEFAULT_GATEWAY_BASE, "gateway.baseUrl"),
    },
    pnl: {
      endpoint: requireText(pnl?.["endpoint"] ?? DEFAULT_PNL_ENDPOINT, "pnl.endpoint"),
      query: requireText(pnl?.["query"] ?? DEFAULT_PNL_QUERY, "pnl.query"),
    },
    datasets: datasetsRaw.map(validateDataset),
  };
}

const HEX_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Resolve the operator (seller) signing key: a literal hex key, or the value of
 * the env var named by config.operatorKey (ARC_TESTNET_PK as last-resort
 * fallback). Never throws; returns undefined when none is configured.
 */
export function resolveOperatorKey(
  config: OpenBookConfig,
  env: Record<string, string | undefined>,
): `0x${string}` | undefined {
  if (HEX_KEY_RE.test(config.operatorKey)) return config.operatorKey as `0x${string}`;
  const viaEnv = env[config.operatorKey] ?? env["ARC_TESTNET_PK"] ?? env["ARC_RECIPIENT_PK"];
  if (typeof viaEnv === "string" && HEX_KEY_RE.test(viaEnv)) return viaEnv as `0x${string}`;
  return undefined;
}

/** Resolve the Graph gateway key from env (keyEnv override honored). */
export function resolveGatewayKey(config: OpenBookConfig, env: Record<string, string | undefined>): string | undefined {
  const key = env[config.gateway.keyEnv];
  return typeof key === "string" && key.length > 0 ? key : undefined;
}
