/**
 * Scoped subgraph reader for the open-book Studio P&L subgraph (the same
 * hosted endpoint backend (mcp get_pnl) and the P&L panel use — public, no
 * key). Every query is scoped to OUR_ADDRESSES: queryPaids filter on
 * `seller_in OR buyer_in`, and integers arrive as GraphQL decimal strings /
 * Bytes as lowercase hex.
 *
 * Cost convention: a job where an OUR_ADDRESS is the BUYER and the job
 * SETTLED is the agent's own data spend (a cost), not external revenue — the
 * subgraph books all Settled as revenue, and scopedTotals follows that
 * semantics; consumers tracking the cost line derive it separately as
 * `jobs.filter(j => oursBuyer(j) && j.state === "settled")`.
 */
import { hostedQuery, type FetchLike } from "../../../mcp/src/gateway";
import { CONFIG } from "../config";
import { OUR_ADDRESSES } from "./addresses";
import type { JobView } from "./types";

const OURS = new Set(OUR_ADDRESSES.map((a) => a.toLowerCase()));
export function isOurs(address: `0x${string}`): boolean {
  return OURS.has(address.toLowerCase());
}

interface QueryPaidRaw {
  id?: unknown;
  jobId?: unknown;
  buyer?: unknown;
  seller?: unknown;
  amount?: unknown;
  minBlock?: unknown;
  deadline?: unknown;
  blockNumber?: unknown;
  timestamp?: unknown;
}
interface FulfilledRaw { id?: unknown; jobId?: unknown; payloadHash?: unknown; metaBlock?: unknown }
interface SettledRaw { id?: unknown; jobId?: unknown; seller?: unknown; amount?: unknown }
interface RefundRaw { id?: unknown; jobId?: unknown; reason?: unknown }
interface PolicyBlockedRaw { id?: unknown; reason?: unknown }

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}
function big(v: unknown): bigint {
  return BigInt(str(v));
}
function addr(v: unknown): `0x${string}` {
  return str(v).toLowerCase() as `0x${string}`;
}

export function fetchJobs(
  key?: string,
  fetchImpl?: FetchLike,
): Promise<JobView[]> {
  const endpoint = CONFIG.pnl.endpoint.replace("{GRAPH_GATEWAY_KEY}", key ?? "");
  const ours = OUR_ADDRESSES.length > 0 ? OURS : new Set(["0x0"]);
  const oursList = [...ours].map((a) => JSON.stringify(a)).join(", ");
  // Round 1: the scoped paid rows (the marquee heap — no global windows).
  const paidQuery = `{
  queryPaids(first: 200, orderBy: timestamp, orderDirection: desc,
    where: { or: [{ seller_in: [${oursList}] }, { buyer_in: [${oursList}] }] }) {
    id jobId buyer seller amount minBlock deadline blockNumber timestamp
  }
  _meta { block { number } }
}`;
  return hostedQuery({ url: endpoint, query: paidQuery, fetchImpl }).then(
    ({ data: paidData }) => {
      const paidRoot = (typeof paidData === "object" && paidData !== null ? paidData : {}) as Record<string, unknown>;
      const paidRows = (Array.isArray(paidRoot["queryPaids"]) ? paidRoot["queryPaids"] : []) as QueryPaidRaw[];
      if (paidRows.length === 0) return [];
      const jobIds = paidRows.map((row) => big(row["jobId"]).toString());
      // Round 2: per-job event windows bound to the RETURNED jobIds — a refund
      // for any of our jobs can never be evicted by a global first-N window.
      // first: 1000 (graph-node max) on each collection: round 1 can return up
      // to 200 paid rows, so 200 > the default 100-row page would otherwise
      // silently re-create window eviction past the 100th job of any type.
      const eventsQuery = `{
  fulfilleds(first: 1000, where: { jobId_in: [${jobIds.join(", ")}] }) { id jobId payloadHash metaBlock }
  settleds(first: 1000, where: { jobId_in: [${jobIds.join(", ")}] }) { id jobId seller amount }
  refundIssueds(first: 1000, where: { jobId_in: [${jobIds.join(", ")}] }) { id jobId reason }
}`;
      return hostedQuery({ url: endpoint, query: eventsQuery, fetchImpl }).then(
        ({ data: eventsData }) => {
          const eventsRoot = (typeof eventsData === "object" && eventsData !== null ? eventsData : {}) as Record<string, unknown>;
          const fulfilledRows = (Array.isArray(eventsRoot["fulfilleds"]) ? eventsRoot["fulfilleds"] : []) as FulfilledRaw[];
          const settledRows = (Array.isArray(eventsRoot["settleds"]) ? eventsRoot["settleds"] : []) as SettledRaw[];
          const refundRows = (Array.isArray(eventsRoot["refundIssueds"]) ? eventsRoot["refundIssueds"] : []) as RefundRaw[];

          const fulfilledByJob = new Map<string, { payloadHash: `0x${string}`; metaBlock: number }>();
          for (const f of fulfilledRows) {
            fulfilledByJob.set(big(f["jobId"]).toString(), {
              payloadHash: str(f["payloadHash"]).toLowerCase() as `0x${string}`,
              metaBlock: Number(big(f["metaBlock"])),
            });
          }
          const settled = new Set(settledRows.map((s) => big(s["jobId"]).toString()));
          const refundReason = new Map<string, string>();
          for (const r of refundRows) refundReason.set(big(r["jobId"]).toString(), str(r["reason"]));

          const jobs: JobView[] = [];
          for (const row of paidRows) {
            const jobId = big(row["jobId"]);
            const key = jobId.toString();
            const buyer = addr(row["buyer"]);
            const seller = addr(row["seller"]);
            if (!isOurs(buyer) && !isOurs(seller)) continue; // belt-and-suspenders scope
            const fulfilled = fulfilledByJob.get(key);
            const state: JobView["state"] = refundReason.has(key)
              ? "refunded"
              : settled.has(key)
                ? "settled"
                : "open";
            jobs.push({
              jobId,
              buyer,
              seller,
              amount: big(row["amount"]),
              minBlock: big(row["minBlock"]),
              deadline: big(row["deadline"]),
              blockNumber: big(row["blockNumber"]),
              timestamp: Number(big(row["timestamp"])),
              state,
              payloadHash: fulfilled?.payloadHash,
              metaBlock: fulfilled?.metaBlock,
              refundReason: refundReason.get(key),
            });
          }
          return jobs;
        },
      );
    },
  );
}

export interface JobEventView {
  paid?: {
    buyer: `0x${string}`;
    seller: `0x${string}`;
    amount: bigint;
    minBlock: bigint;
    deadline: bigint;
    blockNumber: bigint;
    timestamp: number;
  };
  fulfilled?: { payloadHash: `0x${string}`; metaBlock: number };
  settled?: { seller: `0x${string}`; amount: bigint };
  refunded?: { reason: string };
}

/** Per-job event views (unscoped — a caller already holding the jobId asks). */
export async function fetchJobEvents(
  jobId: bigint,
  key?: string,
  fetchImpl?: FetchLike,
): Promise<JobEventView> {
  const endpoint = CONFIG.pnl.endpoint.replace("{GRAPH_GATEWAY_KEY}", key ?? "");
  const id = jobId.toString();
  const query = `{
  queryPaids(first: 1, where: { jobId: ${id} }) { jobId buyer seller amount minBlock deadline blockNumber timestamp }
  fulfilleds(first: 1, where: { jobId: ${id} }) { jobId payloadHash metaBlock }
  settleds(first: 1, where: { jobId: ${id} }) { jobId seller amount }
  refundIssueds(first: 1, where: { jobId: ${id} }) { jobId reason }
}`;
  const { data } = await hostedQuery({ url: endpoint, query, fetchImpl });
  const root = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const first = <T>(rows: unknown): T | undefined => {
    const arr = Array.isArray(rows) ? rows : [];
    return (arr[0] as T) ?? undefined;
  };
  const paid = first<QueryPaidRaw>(root["queryPaids"]);
  const fulfilled = first<FulfilledRaw>(root["fulfilleds"]);
  const settled = first<SettledRaw>(root["settleds"]);
  const refunded = first<RefundRaw>(root["refundIssueds"]);
  return {
    paid: paid ? {
      buyer: addr(paid["buyer"]), seller: addr(paid["seller"]), amount: big(paid["amount"]),
      minBlock: big(paid["minBlock"]), deadline: big(paid["deadline"]),
      blockNumber: big(paid["blockNumber"]), timestamp: Number(big(paid["timestamp"])),
    } : undefined,
    fulfilled: fulfilled ? { payloadHash: str(fulfilled["payloadHash"]).toLowerCase() as `0x${string}`, metaBlock: Number(big(fulfilled["metaBlock"])) } : undefined,
    settled: settled ? { seller: addr(settled["seller"]), amount: big(settled["amount"]) } : undefined,
    refunded: refunded ? { reason: str(refunded["reason"]) } : undefined,
  };
}

/**
 * Indexing lag view: `indexed` = the subgraph's chain barrier (_meta.block),
 * `rows` = queryPaids returned by the head probe (capped at 200) — a proxy
 * for "is anything indexed", not an exact total.
 */
export async function fetchLag(
  key?: string,
  fetchImpl?: FetchLike,
): Promise<{ indexed: number; rows: number }> {
  const endpoint = CONFIG.pnl.endpoint.replace("{GRAPH_GATEWAY_KEY}", key ?? "");
  const query = `{
  queryPaids(first: 200, orderBy: timestamp, orderDirection: desc) { jobId }
  _meta { block { number } }
}`;
  const { data, meta } = await hostedQuery({ url: endpoint, query, fetchImpl });
  const root = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const rows = Array.isArray(root["queryPaids"]) ? root["queryPaids"].length : 0;
  return { indexed: meta.block ?? 0, rows };
}

export interface PolicyRefusalView {
  /** PolicyBlocked reason string, e.g. PER_TX_CAP / DAILY_CAP / NOT_ALLOWLISTED */
  reason: string;
  /**
   * Entity id = txHash||logIndex (the subgraph's logIndexId) — the refusal
   * tx hash is its first 66 chars (0x + 64 hex).
   */
  id: string;
}

/**
 * PolicyBlocked rows — the policy wallet's refusal evidence (PolicyWallet.sol
 * emits PolicyBlocked instead of reverting on cap/allowlist violations, so
 * these rows are the truth for `policy refusals`; the subgraph's PolicyConfig
 * entity is empty on our instance and is never read). Unscoped: the policy
 * wallet is global to the book.
 */
export async function fetchPolicyRefusals(
  key?: string,
  fetchImpl?: FetchLike,
): Promise<PolicyRefusalView[]> {
  const endpoint = CONFIG.pnl.endpoint.replace("{GRAPH_GATEWAY_KEY}", key ?? "");
  const query = `{
  policyBlockeds(first: 100, orderBy: id, orderDirection: desc) { id reason }
}`;
  const { data } = await hostedQuery({ url: endpoint, query, fetchImpl });
  const root = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const rows = (Array.isArray(root["policyBlockeds"]) ? root["policyBlockeds"] : []) as PolicyBlockedRaw[];
  return rows.map((row) => ({ id: str(row["id"]), reason: str(row["reason"]) }));
}

/**
 * Books totals over an already-fetched job list, scoped to OUR_ADDRESSES
 * (revenue/refunds exclude foreign jobs). refunds are full job amounts —
 * RefundIssued events carry no amount of their own. See the module header for
 * the buyer-ours-settled (agent's own spend) convention.
 */
export function scopedTotals(jobs: JobView[]): { revenue: bigint; refunds: bigint; net: bigint } {
  let revenue = 0n;
  let refunds = 0n;
  for (const job of jobs) {
    if (!isOurs(job.buyer) && !isOurs(job.seller)) continue;
    if (job.state === "settled") revenue += job.amount;
    else if (job.state === "refunded") refunds += job.amount;
  }
  return { revenue, refunds, net: revenue - refunds };
}
