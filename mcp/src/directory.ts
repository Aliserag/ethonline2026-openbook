/**
 * OpenBook marketplace directory (W3) — sellers discovered LIVE from ENSv2,
 * never from a hardcoded list.
 *
 * A seller is an ENSv2 subname of a parent storefront (openbook.eth) that
 * publishes `svc.menu` (the datasets it offers). Each listed subname's
 * storefront records (`svc.menu/price/sla/payee/operator`) are resolved
 * through the same UniversalResolverV2 text path the MCP quote uses
 * (mcp/src/ens.ts) — no new resolver, no cached state.
 *
 * Enumeration is chain-derived, not event-less guessing: the parent's
 * subregistry is located by walking `getSubregistry(label)` from the ENSv2
 * registry, every subname ever minted is recovered from the subregistry's
 * `LabelRegistered` events (the label string is in the event args), and each
 * label is validated as currently REGISTERED and unexpired via `getState`
 * at call time. Because the scan always runs to the latest block, a seller
 * registered mid-session appears on the next `listSellers` call with no code
 * change; nothing is cached across calls.
 */
import {
  createPublicClient,
  http,
  isAddress,
  isAddressEqual,
  labelhash,
  parseAbiItem,
  zeroAddress,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import {
  createEnsTextReader,
  parseSlaRecord,
  type EnsTextReader,
  type SlaRecord,
} from "./ens";

// --- ENSv2 anchors (Sepolia canonical deployment, verified live) ------------

/** ENSv2 ETHRegistry on Sepolia — owns every `.eth` 2LD. */
export const ENSV2_ETHREGISTRY: Address = "0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2";

/**
 * First block scanned for `LabelRegistered` events. Anchor: openbook.eth's
 * UserRegistry subregistry was initialized 2026-09-11 and its first subname
 * (aave-v3-arbitrum-lending.openbook.eth) was created in tx
 * 0x5a16b79e22eac7acdc214343f3d9ac925f9d49db82c19eec7dea76f543833c88 at
 * block 11684470 (verified live). Scanning from 11_680_000 is a clean buffer
 * before that tx and covers every subname ever minted under the storefront;
 * the scan runs to the latest block on every call, so nothing goes stale and
 * a subname registered later is still found. Override per parent via
 * `fromBlock` (listSellers / listRegisteredSubnames).
 */
export const ENSV2_FROM_BLOCK = 11_680_000n;

/** Registry capabilities needed for the walk + freshness gate. */
const ENSV2_REGISTRY_ABI = [
  {
    type: "function",
    name: "getSubregistry",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getState",
    stateMutability: "view",
    inputs: [{ name: "anyId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        name: "",
        components: [
          { name: "status", type: "uint8" },
          { name: "expiry", type: "uint64" },
          { name: "latestOwner", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "resource", type: "uint256" },
        ],
      },
    ],
  },
] as const satisfies Abi;

/** AVAILABLE / RESERVED / REGISTERED (IPermissionedRegistry.Status). */
const STATUS_REGISTERED = 2;

/**
 * ERC1155 mint event carrying the label STRING (indexers rebuild names from
 * it). Layout verified against the Blockscout-verified UserRegistry proxy
 * 0x8eC443d5e7BCB2E9182c83CE96295dFc35085f29 on Sepolia: tokenId, labelHash
 * and sender are indexed; label, owner and expiry ride in data.
 */
const LABEL_REGISTERED_EVENT = parseAbiItem(
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
);

// --- domain types (frozen by the marketplace brief, spec §3 W3) -------------

/** One advertised dataset on a seller's `svc.menu`. */
export interface MenuEntry {
  id: string;
  schema: string;
}

/** A seller discovered from the storefront, with everything ENS resolves. */
export interface SellerRef {
  /** full name, e.g. "alpha.openbook.eth" */
  name: string;
  /** datasets advertised on `svc.menu` (a subname without a menu is not a seller) */
  menu: MenuEntry[];
  /** raw `svc.price` record, e.g. "0.12 USDC/query" (null = not set) */
  price: string | null;
  /** parsed `svc.sla` record (null = not set / unparseable) */
  sla: SlaRecord | null;
  /** `svc.payee` record (null = not set / not an address) */
  payee: Address | null;
  /** `svc.operator` record (null = not set / not an address) */
  operator: Address | null;
}

/** A subname enumerated from the parent's subregistry (onchain truth). */
export interface EnumeratedSubname {
  label: string;
  owner: Address;
  expiry: bigint;
}

/** Seam injected in tests so unit tests never touch the network. */
export interface DirectoryDeps {
  readEnsText?: EnsTextReader;
  client?: PublicClient;
  fromBlock?: bigint;
  rootRegistry?: Address;
}

/**
 * Dependable public Sepolia RPC for the directory's default client. Verified
 * 2026-09-12: serves 2000-block eth_getLogs ranges (alchemy free tier caps at
 * 10; viem's chain default, thirdweb, rate-limits). The SEPOLIA_RPC env
 * override matches mcp/src/ens.ts's createEnsTextReader seam, so deployments
 * that already pin a keyed RPC use it for enumeration too.
 */
export const DIRECTORY_RPC_FALLBACK = "https://ethereum-sepolia.publicnode.com";

/** viem public client over Sepolia, honoring the repo's SEPOLIA_RPC env seam. */
export function createDirectoryClient(rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl ?? process.env.SEPOLIA_RPC ?? DIRECTORY_RPC_FALLBACK, {
      timeout: 20_000,
      retryCount: 3,
    }),
  });
}

// --- pure resolution (menu gate + record reads) -----------------------------

/**
 * Parse an `svc.menu` record. Returns null when absent, not JSON, or not an
 * array of {id, schema} entries — never a synthesized menu.
 */
export function parseMenu(menu: string | null): MenuEntry[] | null {
  if (menu === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(menu) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: MenuEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record["id"] !== "string" || typeof record["schema"] !== "string") continue;
    entries.push({ id: record["id"], schema: record["schema"] });
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Build the seller list from enumerated subnames + a live ENS text reader.
 * Only subnames advertising a non-empty `svc.menu` are sellers; every other
 * record is surfaced as-is (null when unset) — nothing is defaulted.
 */
export async function resolveSellers(
  parentName: string,
  subnames: readonly EnumeratedSubname[],
  readEnsText: EnsTextReader,
): Promise<SellerRef[]> {
  const sellers: SellerRef[] = [];
  for (const sub of subnames) {
    const name = `${sub.label}.${parentName}`;
    const [menuRaw, price, slaRaw, payee, operator] = await Promise.all([
      readEnsText(name, "svc.menu"),
      readEnsText(name, "svc.price"),
      readEnsText(name, "svc.sla"),
      readEnsText(name, "svc.payee"),
      readEnsText(name, "svc.operator"),
    ]);
    const menu = parseMenu(menuRaw);
    if (menu === null) continue; // no storefront menu → not a seller
    let sla: SlaRecord | null = null;
    if (slaRaw !== null) {
      try {
        sla = parseSlaRecord(slaRaw);
      } catch {
        sla = null; // tolerate junk on the directory; the quote path still hard-fails
      }
    }
    sellers.push({
      name,
      menu,
      price,
      sla,
      payee: payee !== null && isAddress(payee) ? payee : null,
      operator: operator !== null && isAddress(operator) ? operator : null,
    });
  }
  return sellers.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Narrow the discovered sellers to those advertising the given schema on
 * their `svc.menu`.
 */
export function sellersForSchema(refs: readonly SellerRef[], schema: string): SellerRef[] {
  return refs.filter((seller) => seller.menu.some((entry) => entry.schema === schema));
}

// --- live enumeration (registry walk + LabelRegistered scan + getState) ------

/**
 * Walk `getSubregistry(label)` from the root registry to find the registry
 * that owns `parentName`'s subnames (mirrors the ens-cli ENSv2 walk; every
 * step is an onchain read, no resolver involved).
 */
export async function subregistryFor(
  parentName: string,
  client: PublicClient,
  rootRegistry: Address = ENSV2_ETHREGISTRY,
): Promise<Address> {
  const labels = parentName.split(".");
  if (labels.length < 2 || labels[labels.length - 1] !== "eth") {
    throw new Error(`subregistryFor: expected an ENSv2 .eth name, got "${parentName}"`);
  }
  let registry: Address = rootRegistry;
  for (let i = labels.length - 2; i >= 0; i--) {
    const label = labels[i] as string;
    const subregistry = await client.readContract({
      address: registry,
      abi: ENSV2_REGISTRY_ABI,
      functionName: "getSubregistry",
      args: [label],
    });
    if (isAddressEqual(subregistry, zeroAddress)) {
      throw new Error(`subregistryFor: "${parentName}" has no ENSv2 subregistry at "${label}"`);
    }
    registry = subregistry;
  }
  return registry;
}

/**
 * Every label ever registered under the parent's subregistry, from
 * `LabelRegistered` events, paged to the latest block. Page size starts
 * generous and halves when the RPC rejects the range (Alchemy free tier caps
 * eth_getLogs at 10 Sepolia blocks; publicnode/PAYG accept thousands) — so
 * discovery works identically on any endpoint. Cheap on young subregistries
 * (openbook.eth: a few thousand blocks) and always fresh.
 */
export async function registeredLabels(
  subregistry: Address,
  client: PublicClient,
  fromBlock: bigint,
): Promise<string[]> {
  const latest = await client.getBlockNumber();
  if (latest < fromBlock) return [];
  const labels = new Set<string>();
  let batch = 2_000n;
  let cursor = fromBlock;
  while (cursor <= latest) {
    const end = cursor + batch - 1n < latest ? cursor + batch - 1n : latest;
    try {
      const logs = await client.getLogs({
        address: subregistry,
        event: LABEL_REGISTERED_EVENT,
        fromBlock: cursor,
        toBlock: end,
      });
      for (const log of logs) {
        // viem provides decoded args when the event is passed to getLogs.
        const label = log.args.label;
        if (label !== undefined) labels.add(label);
      }
      cursor = end + 1n;
    } catch (error) {
      const message = String((error as Error).message);
      const rangeRejected =
        /block range|too wide|too large|exceeds.*limit|limit.*exceeded/i.test(message);
      if (rangeRejected && batch > 10n) {
        batch /= 2n;
        continue; // retry the same window with a narrower range
      }
      throw error;
    }
  }
  return [...labels];
}

/** Current REGISTERED + unexpired subnames of the parent (onchain state). */
export async function listRegisteredSubnames(
  parentName: string,
  opts: DirectoryDeps = {},
): Promise<EnumeratedSubname[]> {
  const client = opts.client ?? createDirectoryClient();
  const subregistry = await subregistryFor(parentName, client, opts.rootRegistry);
  const labels = await registeredLabels(
    subregistry,
    client,
    opts.fromBlock ?? ENSV2_FROM_BLOCK,
  );
  const now = BigInt(Math.floor(Date.now() / 1000));
  const live: EnumeratedSubname[] = [];
  for (const label of labels) {
    const state = await client.readContract({
      address: subregistry,
      abi: ENSV2_REGISTRY_ABI,
      functionName: "getState",
      args: [BigInt(labelhash(label))],
    });
    if (state.status !== STATUS_REGISTERED) continue;
    if (state.expiry !== 0n && state.expiry <= now) continue;
    live.push({ label, owner: state.latestOwner, expiry: state.expiry });
  }
  return live.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The directory: enumerate the parent's subregistry subnames and resolve each
 * subname's `svc.*` records through ENS. Everything is read live per call —
 * a seller registered onchain after this call started appears on the next one.
 */
export async function listSellers(
  parentName: string,
  opts: DirectoryDeps = {},
): Promise<SellerRef[]> {
  const readEnsText =
    opts.readEnsText ??
    createEnsTextReader({ rpcUrl: process.env.SEPOLIA_RPC ?? DIRECTORY_RPC_FALLBACK });
  const subnames = await listRegisteredSubnames(parentName, opts);
  return resolveSellers(parentName, subnames, readEnsText);
}
