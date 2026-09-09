/**
 * ENSv2 storefront reader for sla-subgraph-mcp (OpenBook Task 5).
 *
 * get_quote is ENS-gated: price, SLA and payee are resolved LIVE from the
 * Sepolia ENSv2 `svc.*` text records of the configured name. A missing record
 * hard-fails (ENS_RESOLUTION_FAILED) — the server NEVER silently falls back to
 * a default price (ENS clause: records are central, not cosmetic).
 *
 * Reads go through viem's getEnsText with the ENSv2 UniversalResolverV2 for
 * Sepolia. The resolver itself is injectable so tests never touch the network.
 */
import { createPublicClient, http, type Address } from "viem";
import { sepolia } from "viem/chains";
import { UNIVERSAL_RESOLVER_V2 } from "./constants";

export type EnsTextReader = (name: string, key: string) => Promise<string | null>;

export interface ServiceRecords {
  menu: string | null;
  price: string | null;
  sla: string | null;
  payee: string | null;
}

export const SERVICE_RECORD_KEYS = ["menu", "price", "sla", "payee"] as const;

export const ENS_RESOLUTION_FAILED = "ENS_RESOLUTION_FAILED";

/** Live ENSv2 text reader bound to a viem public client on Sepolia. */
export function createEnsTextReader(opts?: {
  rpcUrl?: string;
  universalResolverAddress?: Address;
}): EnsTextReader {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(opts?.rpcUrl),
  });
  const resolver = opts?.universalResolverAddress ?? UNIVERSAL_RESOLVER_V2;
  return (name, key) =>
    client.getEnsText({ name, key, universalResolverAddress: resolver });
}

/**
 * Read the svc.* records of a name. HARD-FAILS when price/sla/payee are unset
 * — a storefront without records is not a storefront. `menu` is informational
 * only (list_datasets merges it tolerantly).
 */
export async function resolveServiceRecords(
  name: string,
  readEnsText: EnsTextReader,
): Promise<ServiceRecords> {
  const [menu, price, sla, payee] = await Promise.all(
    SERVICE_RECORD_KEYS.map((key) => readEnsText(name, `svc.${key}`)),
  );
  const records: ServiceRecords = { menu: menu ?? null, price: price ?? null, sla: sla ?? null, payee: payee ?? null };
  for (const key of ["price", "sla", "payee"] as const) {
    if (records[key] === null) {
      throw new Error(
        `${ENS_RESOLUTION_FAILED}: svc.${key} is not set on ${name} (sepolia ENSv2) — refusing to quote a hard-coded value`,
      );
    }
  }
  return records;
}

/** Parse "0.10 USDC/query" into 6-decimal USDC units (100000). Throws on junk. */
export function parsePriceToAmount6dec(price: string): number {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*USDC\/query\s*$/i.exec(price);
  if (!match) throw new Error(`invalid svc.price record: "${price}"`);
  return Math.round(parseFloat(match[1]) * 1_000_000);
}

export interface SlaRecord {
  /** max tolerated chain-head lag in blocks (=> quote minBlockLag) */
  maxBlockLag: number;
  /** max tolerated latency in ms (=> escrow deadlineBlocks) */
  maxLatencyMs: number;
}

/** Parse the svc.sla JSON record; maxBlockLag is required, maxLatencyMs defaults to 2000. */
export function parseSlaRecord(sla: string): SlaRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sla) as unknown;
  } catch {
    throw new Error(`invalid svc.sla record: not JSON (${sla})`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`invalid svc.sla record: expected an object`);
  }
  const record = parsed as Record<string, unknown>;
  const maxBlockLag = record["maxBlockLag"];
  if (typeof maxBlockLag !== "number" || !Number.isInteger(maxBlockLag) || maxBlockLag <= 0) {
    throw new Error(`invalid svc.sla record: maxBlockLag must be a positive integer`);
  }
  const maxLatencyMs = record["maxLatencyMs"];
  return {
    maxBlockLag,
    maxLatencyMs:
      typeof maxLatencyMs === "number" && Number.isInteger(maxLatencyMs) && maxLatencyMs > 0
        ? maxLatencyMs
        : 2000,
  };
}
