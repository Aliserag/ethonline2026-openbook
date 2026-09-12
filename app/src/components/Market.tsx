/**
 * Market panel (M5) - the venue surface of the marketplace: every seller
 * discovered LIVE from the ENS storefront (`openbook.eth`), each with its
 * datasets, prices, freshness guarantee and per-provider market stats from
 * the subgraph, plus the venue row read live from the escrow
 * (`platformFeeBP` + `platformTreasury` -> "2% → PolicyWallet").
 *
 * No mocked, static or synthesized data: every figure comes from ENS, the
 * subgraph or the chain, or the panel degrades truthfully through
 * `useLiveValue`. The inventory is labelled honestly: these are the two
 * reference sellers we operate, not third-party liquidity.
 *
 * The enumeration walks the parent's subregistry (eth_getLogs), so the app
 * passes its own Sepolia RPC/reader via `listSellers`' optional deps instead
 * of hammering the module's default public RPC.
 */
import { type JSX } from "react";
import { createDirectoryClient, listSellers, parseMenu, type MenuEntry, type SellerRef } from "../../../mcp/src/directory";
import {
  createEnsTextReader,
  parseSlaRecord,
  type SlaRecord,
} from "../../../mcp/src/ens";
import { hostedQuery } from "../../../mcp/src/gateway";
import type { ProviderStats } from "../../../mcp/src/router";
import { CONFIG } from "../config";
import { ADDR } from "../data/addresses";
import { getPublicClient } from "../data/chain";
import { platformFee } from "../data/escrow";
import type { Live, LiveState } from "../data/types";
import { env } from "../env";
import { truncateHash, usdc6 } from "../format";
import { useLiveValue } from "../ui/useLiveValue";

/** The storefront every seller row is discovered from (the app's own namespace). */
export const STOREFRONT = "openbook.eth";

/** Seller/venue poll cadence: the enumeration is RPC-hungry, so it runs at
 *  30s like the system map, with a 90s staleness window. */
const MARKET_POLL_MS = 30_000;
const MARKET_STALE_MS = 90_000;

/** W4 market aggregates on the shared Studio endpoint (public, no key). */
const PROVIDERS_QUERY = `{ providers(orderBy: lastJobAt, orderDirection: desc) { id jobs settled refunded delivered avgLagBlocks lastJobAt } }`;

/** Parent storefront record keys (live ENS text records on openbook.eth). */
const SERVICE_KEYS = ["svc.menu", "svc.price", "svc.sla", "svc.payee", "svc.operator"] as const;

/** The app's OWN Sepolia reader + enumeration client, shared across polls
 *  (never the directory module's default client). */
const marketEnsReader = createEnsTextReader({ rpcUrl: env.sepoliaRpc });
const directoryClient = createDirectoryClient(env.sepoliaRpc);

/** One seller row: ENS identity + records + per-dataset prices + subgraph stats. */
export interface MarketSellerRow {
  name: string;
  menu: MenuEntry[];
  /** seller-level `svc.price` record, raw ("0.12 USDC/query"); null = unset */
  price: string | null;
  /** seller-level published freshness guarantee; null = unset/unparseable */
  sla: SlaRecord | null;
  payee: `0x${string}` | null;
  operator: `0x${string}` | null;
  /** effective price per dataset id (dataset-subname overrides win) */
  priceByDataset: Record<string, string | null>;
  /** W4 provider stats matched by operator address; null = no indexed row */
  stats: ProviderStats | null;
}

export interface MarketView {
  sellers: MarketSellerRow[];
}

/** Live parent storefront records, tolerantly read (null when unset). */
interface ParentRecords {
  menuRaw: string | null;
  price: string | null;
  slaRaw: string | null;
  operator: `0x${string}` | null;
}

// --- pure helpers -----------------------------------------------------------

/** Map the subgraph's `providers` payload to the frozen ProviderStats shape. */
export function parseProviderRows(data: unknown): ProviderStats[] {
  if (typeof data !== "object" || data === null) return [];
  const raw = (data as Record<string, unknown>)["providers"];
  if (!Array.isArray(raw)) return [];
  const rows: ProviderStats[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = row["id"];
    if (typeof id !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(id)) continue;
    rows.push({
      id: id.toLowerCase() as `0x${string}`,
      jobs: num(row["jobs"]),
      settled: usdcBig(row["settled"]),
      refunded: usdcBig(row["refunded"]),
      delivered: num(row["delivered"]),
      avgLagBlocks: num(row["avgLagBlocks"]),
      lastJobAt: usdcBig(row["lastJobAt"]),
    });
  }
  return rows;
}

/** Stats for a seller's operator address (lowercase-insensitive match). */
export function statsFor(operator: `0x${string}` | null, providers: readonly ProviderStats[]): ProviderStats | null {
  if (operator === null) return null;
  const needle = operator.toLowerCase();
  return providers.find((p) => p.id.toLowerCase() === needle) ?? null;
}

/** Basis points -> percentage text ("200" -> "2%", "250" -> "2.5%"). */
export function venuePercent(feeBP: number): string {
  const pct = feeBP / 100;
  if (pct % 1 === 0) return `${pct}%`;
  return `${pct.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/** The venue treasury, named when it is the live-read PolicyWallet address. */
export function venueTreasuryLabel(treasury: `0x${string}`): string {
  return treasury.toLowerCase() === ADDR.policy.toLowerCase() ? "PolicyWallet" : truncateHash(treasury);
}

function num(v: unknown): number {
  if (typeof v === "string") return Number(v);
  if (typeof v === "number") return v;
  return 0;
}

/** BigInt for the subgraph's integer strings; anything else degrades to 0n. */
function usdcBig(v: unknown): bigint {
  return typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : 0n;
}

function parseParentRecords(records: readonly { key: string; value: string | null }[]): ParentRecords {
  const rec = (key: string): string | null => records.find((r) => r.key === key)?.value ?? null;
  const operator = rec("svc.operator");
  return {
    menuRaw: rec("svc.menu"),
    price: rec("svc.price"),
    slaRaw: rec("svc.sla"),
    operator: operator !== null && /^0x[0-9a-fA-F]{40}$/.test(operator) ? (operator as `0x${string}`) : null,
  };
}

// --- live reads -------------------------------------------------------------

/** Parent storefront records (the app's own seller), read live from ENS. */
async function readParentRecords(): Promise<ParentRecords> {
  const values = await Promise.all(SERVICE_KEYS.map((key) => marketEnsReader(STOREFRONT, key)));
  return parseParentRecords(SERVICE_KEYS.map((key, index) => ({ key, value: values[index] ?? null })));
}

/** Effective price for one dataset on one seller: the dataset-subname
 *  override (`<id>.<seller>` svc.price) wins, else the seller's own record
 *  (mirrors the M4 quote resolution where the override is additive). */
async function entryPrice(seller: string, datasetId: string, base: string | null): Promise<string | null> {
  const override = await marketEnsReader(`${datasetId}.${seller}`, "svc.price").catch(() => null);
  return override ?? base;
}

/** The parent storefront's catalog: its live `svc.menu`; when that record is
 *  absent, the app's own served catalog (openbook.json): the same datasets
 *  the single-seller flow quotes, never synthesized market data. */
function parentMenu(menuRaw: string | null): MenuEntry[] {
  const parsed = parseMenu(menuRaw);
  return parsed !== null ? parsed : CONFIG.datasets.map((d) => ({ id: d.id, schema: d.schema }));
}

async function parentRow(records: ParentRecords, providers: readonly ProviderStats[]): Promise<MarketSellerRow> {
  const menu = parentMenu(records.menuRaw);
  const priceByDataset: Record<string, string | null> = {};
  for (const entry of menu) {
    priceByDataset[entry.id] = await entryPrice(STOREFRONT, entry.id, records.price);
  }
  let sla: SlaRecord | null = null;
  if (records.slaRaw !== null) {
    try {
      sla = parseSlaRecord(records.slaRaw);
    } catch {
      sla = null; // junk SLA record: surfaced as unset, never guessed
    }
  }
  return {
    name: STOREFRONT,
    menu,
    price: records.price,
    sla,
    payee: null, // the parent's payee is the venue treasury; the escrow read owns that row
    operator: records.operator,
    priceByDataset,
    stats: statsFor(records.operator, providers),
  };
}

async function subnameRow(ref: SellerRef, providers: readonly ProviderStats[]): Promise<MarketSellerRow> {
  const priceByDataset: Record<string, string | null> = {};
  for (const entry of ref.menu) {
    priceByDataset[entry.id] = await entryPrice(ref.name, entry.id, ref.price);
  }
  return {
    name: ref.name,
    menu: ref.menu,
    price: ref.price,
    sla: ref.sla,
    payee: ref.payee,
    operator: ref.operator,
    priceByDataset,
    stats: statsFor(ref.operator, providers),
  };
}

/** Every seller on the storefront: the parent's own catalog + every ENS
 *  subname seller, each with live records and subgraph stats. */
async function readSellers(): Promise<MarketView> {
  const [parent, subnames, providers] = await Promise.all([
    readParentRecords(),
    listSellers(STOREFRONT, { readEnsText: marketEnsReader, client: directoryClient }),
    fetchProviders(),
  ]);
  const rows: MarketSellerRow[] = [await parentRow(parent, providers)];
  for (const sub of subnames) rows.push(await subnameRow(sub, providers));
  return { sellers: rows };
}

async function fetchProviders(): Promise<ProviderStats[]> {
  const { data } = await hostedQuery({ url: CONFIG.pnl.endpoint, query: PROVIDERS_QUERY });
  return parseProviderRows(data);
}

// --- render -----------------------------------------------------------------

/** Live/stale/error status chip, the house idiom (live dot + mono label). */
function MarketStateChip({ state, reason }: { state: LiveState; reason?: string }): JSX.Element {
  const tone = state === "live" ? "" : state === "stale" ? "stale" : "off";
  return (
    <span className={`market__chip market__chip--${state}`} title={reason}>
      <span className={`ob-live ${tone}`} aria-hidden="true" />
      {state}
    </span>
  );
}

function SellerBlock({ row }: { row: MarketSellerRow }): JSX.Element {
  return (
    <article className="market__seller">
      <div className="market__seller-head">
        <span className="market__seller-name">{row.name}</span>
        {row.operator !== null && <span className="market__seller-op">{truncateHash(row.operator)}</span>}
      </div>

      <ul className="market__ds">
        {row.menu.map((entry) => (
          <li key={entry.id} className="market__ds-row">
            <span className="market__ds-id">{entry.id}</span>
            <span className="market__ds-price">{row.priceByDataset[entry.id] ?? "price not set"}</span>
          </li>
        ))}
      </ul>

      <dl className="market__kv">
        <div className="market__kvrow">
          <dt>freshness</dt>
          <dd>
            {row.sla !== null
              ? `within ${row.sla.maxBlockLag} blocks · latency ${row.sla.maxLatencyMs} ms`
              : "no SLA published"}
          </dd>
        </div>
        {row.stats !== null ? (
          <>
            <div className="market__kvrow">
              <dt>jobs</dt>
              <dd>
                {row.stats.jobs} · {row.stats.delivered} delivered
              </dd>
            </div>
            <div className="market__kvrow">
              <dt>settled</dt>
              <dd>{usdc6(row.stats.settled)} USDC</dd>
            </div>
            <div className="market__kvrow">
              <dt>refunded</dt>
              <dd>{usdc6(row.stats.refunded)} USDC</dd>
            </div>
            <div className="market__kvrow">
              <dt>avg lag</dt>
              <dd>{row.stats.avgLagBlocks.toFixed(1)} blocks</dd>
            </div>
          </>
        ) : (
          <div className="market__kvrow">
            <dt>stats</dt>
            <dd className="market__muted">no subgraph stats indexed yet</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

function VenueRow({ venue }: { venue: Live<{ feeBP: number; treasury: `0x${string}` }> }): JSX.Element {
  return (
    <footer className="market__venue">
      <span className="market__venue-key">venue fee · live from escrow</span>
      <span className="market__venue-fig">
        {venue.value === null
          ? "reading…"
          : `${venuePercent(venue.value.feeBP)} → ${venueTreasuryLabel(venue.value.treasury)}`}
      </span>
      <MarketStateChip state={venue.state} reason={venue.reason} />
      {venue.state === "error" && venue.value === null && venue.reason !== undefined && (
        <span className="market__venue-note">{venue.reason}</span>
      )}
    </footer>
  );
}

export function Market(): JSX.Element {
  const sellers = useLiveValue(readSellers, { pollMs: MARKET_POLL_MS, staleAfterMs: MARKET_STALE_MS });
  const venue = useLiveValue(() => platformFee(getPublicClient()), {
    pollMs: MARKET_POLL_MS,
    staleAfterMs: MARKET_STALE_MS,
  });

  return (
    <section className="market" aria-labelledby="market-title">
      <header className="market__head">
        <span className="market__title" id="market-title">
          the market
        </span>
        <span className="market__hint">anyone can list · agents compare · the escrow enforces</span>
        <MarketStateChip state={sellers.state} reason={sellers.reason} />
      </header>

      <div className="market__body" role="status" aria-live="polite">
        <p className="market__note">
          two reference sellers we operate · every figure reads live from ENS, the subgraph and the escrow
        </p>

        {sellers.state === "error" && sellers.value === null && (
          <p className="market__error" role="alert">
            ✗ {sellers.reason}
          </p>
        )}
        {sellers.state === "loading" && sellers.value === null && (
          <p className="market__muted">reading the storefront…</p>
        )}
        {sellers.state !== "live" && sellers.value !== null && sellers.reason !== undefined && (
          <p className="market__muted">
            {sellers.state} · {sellers.reason}
          </p>
        )}
        {sellers.value !== null && sellers.value.sellers.length === 0 && (
          <p className="market__muted">no sellers discovered on {STOREFRONT}</p>
        )}

        {sellers.value?.sellers.map((row) => (
          <SellerBlock key={row.name} row={row} />
        ))}

        <VenueRow venue={venue} />
      </div>
    </section>
  );
}
