/**
 * Replay theater (T10) — the reader for the `#theater/<jobId>` route that T7's
 * `replay <jobId>` command opens. ALL I/O lives here (the frames themselves
 * stay pure in replay.ts):
 *
 *   - subgraph event view   — fetchJobEvents (Task 4), the primary trail
 *   - onchain job view      — readJob (Task 3), ground truth for state/amounts
 *   - chain-log fallback    — jobs whose event rows the subgraph has not
 *     indexed yet (rows before its start block; the per-job entity ids embed
 *     the terminal tx). The public Arc RPC caps eth_getLogs at a 10,000-block
 *     range, so the scan walks up to MAX_LOG_WINDOWS windows back from the
 *     head and decodes JobSubmitted (metaBlock/payloadHash) and
 *     PaymentReleased/Refunded (the terminal tx) from the logs themselves.
 *   - receipt-derived split — platformFee + getTransactionReceipt +
 *     feeSplitFromReceipt (Task 3) — the money frame's numbers are ALWAYS the
 *     receipt's, never config.
 *   - live heads + ENS storefront records for the quote/verdict frames.
 *
 * Every value degrades truthfully through useLiveValue: a dead source shows
 * its reason, never an invented figure (spec S9). Frame/tx discovery prefers
 * the subgraph (entity ids embed `txHash || logIndex`) and falls back to the
 * chain scan only when the subgraph lacks the row.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useModalFocus } from "../ui/useModalFocus";
import { parseAbi, type PublicClient } from "viem";
import { CONFIG } from "../config";
import { env } from "../env";
import { ADDR } from "../data/addresses";
import { getPublicClient } from "../data/chain";
import { feeSplitFromReceipt, platformFee, readJob } from "../data/escrow";
import { fetchJobEvents, fetchLagShared } from "../data/subgraph";
import { cachedAsOfLabel } from "../data/cache";
import type { FeeSplit, JobView } from "../data/types";
import { useLiveValue } from "../ui/useLiveValue";
import { resolveDatasetQuote } from "../console/commands/act";
import { createEnsTextReader, parseSlaRecord } from "../../../mcp/src/ens";
import { hostedQueryViaProxy } from "../data/endpoint";
import { explorerUrl, truncateHash } from "../format";
import { RulerBlock } from "../console/renderers";
import { buildFrames } from "./replay";

/** Event signatures verbatim from scripts/spikes/abi/erc8183.json (verified). */
const TERMINAL_ABI = parseAbi([
  "event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)",
  "event Refunded(uint256 indexed jobId, address indexed client, uint256 amount)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
]);
const PAYMENT_RELEASED = TERMINAL_ABI[0];
const REFUNDED = TERMINAL_ABI[1];
const JOB_SUBMITTED = TERMINAL_ABI[2];

/** Public Arc RPC eth_getLogs range cap (verified live: error -32614 beyond it). */
const LOG_WINDOW = 10_000n;
/** ~40k blocks of chain history (≈ 2 days at ~4s/block) for pre-index jobs. */
const MAX_LOG_WINDOWS = 4;
/** Subgraph event entity id: txHash (32B) || logIndex (4B) — the tx embeds the terminal hash. */
const EVENT_ID_RE = /^0x[0-9a-fA-F]{72}$/;

interface TheaterData {
  job: JobView;
  split: FeeSplit | null;
  splitError?: string;
  tx: `0x${string}` | null;
  heads: { arc: bigint; subgraph: bigint };
  ens: { name: string; price: string; maxBlockLag: number };
}

interface HeavyData {
  job: JobView;
  split: FeeSplit | null;
  splitError?: string;
  tx: `0x${string}` | null;
}

/**
 * The heavy path — onchain job read, subgraph event trail, chain-log terminal
 * discovery and the receipt-derived split — replays HISTORY, so it is computed
 * once per jobId and cached: the 30s poll only re-reads the live parts (heads
 * + ENS records). This also keeps the public Arc RPC from being hit with a
 * multi-window log scan on every poll.
 *
 * Only TERMINAL results are cached (see isTerminalHeavy): an open job or a
 * transient split failure is evicted on resolution so the next poll re-reads.
 */
const heavyCache = new Map<string, Promise<HeavyData>>();

/**
 * A heavy result is cacheable only when history really ended: the job is
 * settled or refunded AND the receipt split did not fail. An open job must
 * re-read (it may settle between polls) and a transient splitError must be
 * retried (the receipt read or fee decode may recover).
 */
export function isTerminalHeavy(data: HeavyData): boolean {
  return (data.job.state === "settled" || data.job.state === "refunded") && data.splitError === undefined;
}

function heavyData(jobId: bigint): Promise<HeavyData> {
  const key = jobId.toString();
  const existing = heavyCache.get(key);
  if (existing !== undefined) return existing;
  const loading = loadHeavy(jobId)
    .then((data) => {
      if (!isTerminalHeavy(data)) heavyCache.delete(key);
      return data;
    })
    .catch((error) => {
      // a transient failure may succeed on retry — evict so the next poll retries
      heavyCache.delete(key);
      throw error;
    });
  heavyCache.set(key, loading);
  return loading;
}

async function loadHeavy(jobId: bigint): Promise<HeavyData> {
  const publicClient = getPublicClient();
  const events = await fetchJobEvents(jobId);
  const onchain = await readJob(publicClient, jobId);
  const hasChain = onchain !== null && onchain.jobId !== 0n; // shared escrow rows we don't own decode as zero
  const paid = events.paid;
  if (!hasChain && paid === undefined) {
    throw new Error(`job ${jobId} is unknown onchain and unindexed · the replay has nothing to read`);
  }

  const state: JobView["state"] = events.refunded
    ? "refunded"
    : events.settled
      ? "settled"
      : hasChain
        ? onchain.state
        : "open";

  // After the guard, `paid` exists or `onchain` is a real row — the `!` is the
  // throw above, not a fabricated fallback.
  const job: JobView = {
    jobId,
    buyer: paid?.buyer ?? onchain!.buyer,
    seller: paid?.seller ?? onchain!.seller,
    amount: paid?.amount ?? onchain!.amount,
    minBlock: hasChain && onchain!.minBlock > 0n ? onchain!.minBlock : (paid?.minBlock ?? 0n),
    deadline: paid?.deadline ?? onchain!.deadline,
    blockNumber: paid?.blockNumber ?? onchain!.blockNumber,
    timestamp: paid?.timestamp ?? onchain!.timestamp,
    state,
    payloadHash: events.fulfilled?.payloadHash,
    metaBlock: events.fulfilled?.metaBlock,
    refundReason: events.refunded?.reason,
  };

  // Terminal tx: subgraph entity id first (indexed jobs, e.g. 185853 and job
  // 4), chain scan as the fallback for jobs whose rows the subgraph has not
  // indexed yet. The scan also replays fulfillment for those same jobs.
  const needFulfillment = job.metaBlock === undefined || job.payloadHash === undefined;
  const terminalEntity: "settleds" | "refundIssueds" = state === "refunded" ? "refundIssueds" : "settleds";
  const subgraphTx = await subgraphTerminalTx(jobId, terminalEntity);
  let tx = subgraphTx;
  const chain = needFulfillment || subgraphTx === null ? await chainScan(publicClient, jobId) : null;
  if (tx === null && chain !== null) tx = chain.payment?.tx ?? chain.refund?.tx ?? null;
  if (job.metaBlock === undefined && chain?.submitted) {
    job.metaBlock = Number(chain.submitted.block);
    job.payloadHash = chain.submitted.deliverable;
  }

  let split: FeeSplit | null = null;
  let splitError: string | undefined;
  if (state === "settled" && tx !== null) {
    try {
      const fee = await platformFee(publicClient);
      const receipt = await publicClient.getTransactionReceipt({ hash: tx });
      split = feeSplitFromReceipt(receipt, fee.feeBP, job.seller);
    } catch (error) {
      splitError = error instanceof Error ? error.message : String(error);
    }
  }

  return { job, split, splitError, tx };
}

async function loadHeads(publicClient: PublicClient): Promise<{ arc: bigint; subgraph: bigint }> {
  const [arc, subgraph] = await Promise.all([publicClient.getBlockNumber(), fetchLagShared()]);
  return { arc, subgraph: BigInt(subgraph.indexed) };
}

/** Compose the theater's live inputs: cached history + freshly polled heads/ENS. */
async function loadTheater(jobId: bigint): Promise<TheaterData> {
  const publicClient = getPublicClient();
  const [heavy, heads] = await Promise.all([heavyData(jobId), loadHeads(publicClient)]);
  const ens = await loadEns(heavy.job);
  return { ...heavy, heads, ens };
}

/** Decode the terminal tx hash from a subgraph event entity id (settled/refundIssued). */
async function subgraphTerminalTx(
  jobId: bigint,
  entity: "settleds" | "refundIssueds",
): Promise<`0x${string}` | null> {
  const query = `{ ${entity}(first: 1, where: { jobId: ${jobId.toString()} }) { id } }`;
  const { data } = await hostedQueryViaProxy(query);
  const root = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const rows = Array.isArray(root[entity]) ? root[entity] : [];
  const id = rows[0] as { id?: unknown } | undefined;
  const raw = typeof id?.id === "string" ? id.id : "";
  if (!EVENT_ID_RE.test(raw)) return null;
  return raw.slice(0, 66).toLowerCase() as `0x${string}`;
}

interface ChainScan {
  submitted?: { tx: `0x${string}`; block: bigint; deliverable: `0x${string}` };
  payment?: { tx: `0x${string}`; block: bigint };
  refund?: { tx: `0x${string}`; block: bigint };
}

/**
 * Walk 10k-block windows back from the chain head and decode the job's
 * fulfillment + terminal event from raw logs. Returns null when nothing is
 * found (the public RPC cannot reach the job's lifetime) — the theater then
 * degrades honestly instead of inventing a tx.
 */
async function chainScan(publicClient: PublicClient, jobId: bigint): Promise<ChainScan | null> {
  try {
    const head = await publicClient.getBlockNumber();
    let to = head;
    let from = head > LOG_WINDOW ? head - LOG_WINDOW : 0n;
    for (let i = 0; i < MAX_LOG_WINDOWS; i++) {
      const [submitted, payment, refund] = await Promise.all([
        publicClient.getLogs({ address: ADDR.escrow, event: JOB_SUBMITTED, args: { jobId }, fromBlock: from, toBlock: to, strict: true }),
        publicClient.getLogs({ address: ADDR.escrow, event: PAYMENT_RELEASED, args: { jobId }, fromBlock: from, toBlock: to, strict: true }),
        publicClient.getLogs({ address: ADDR.escrow, event: REFUNDED, args: { jobId }, fromBlock: from, toBlock: to, strict: true }),
      ]);
      const scan: ChainScan = {};
      if (submitted.length > 0) {
        const log = submitted[submitted.length - 1];
        scan.submitted = { tx: log.transactionHash, block: log.blockNumber, deliverable: log.args.deliverable };
      }
      if (payment.length > 0) {
        const log = payment[payment.length - 1];
        scan.payment = { tx: log.transactionHash, block: log.blockNumber };
      }
      if (refund.length > 0) {
        const log = refund[refund.length - 1];
        scan.refund = { tx: log.transactionHash, block: log.blockNumber };
      }
      if (scan.submitted || scan.payment || scan.refund) return scan;
      if (from === 0n) return null;
      to = from - 1n;
      from = from > LOG_WINDOW ? from - LOG_WINDOW : 0n;
    }
    return null;
  } catch {
    return null; // log probes degrade to the readable subgraph trail, never a hard error
  }
}

async function loadEns(job: JobView): Promise<{ name: string; price: string; maxBlockLag: number }> {
  const readEnsText = createEnsTextReader({ rpcUrl: env.sepoliaRpc });
  // the dataset a job bought is not onchain: match its amount against each seller's live record
  const quotes = await Promise.all(
    CONFIG.datasets.map(async (d) => {
      try {
        return await resolveDatasetQuote(d, readEnsText);
      } catch {
        return null;
      }
    }),
  );
  const matched = quotes.filter((q): q is NonNullable<typeof q> => q !== null && BigInt(q.amountUsdc) === job.amount);
  if (matched.length === 1) return { name: matched[0]!.priceName, price: matched[0]!.price, maxBlockLag: matched[0]!.maxBlockLag };
  const [price, sla] = await Promise.all([
    readEnsText(CONFIG.ens, "svc.price").catch(() => null),
    readEnsText(CONFIG.ens, "svc.sla").catch(() => null),
  ]);
  let maxBlockLag = 0;
  if (sla !== null) {
    try {
      maxBlockLag = parseSlaRecord(sla).maxBlockLag;
    } catch {
      // unreadable record — the quote frame renders "· unreadable", never a fake figure
    }
  }
  return { name: CONFIG.ens, price: price ?? "✗ svc.price unreadable (ENS)", maxBlockLag };
}

/**
 * Compose the theater's live inputs for one job. The job view merges the
 * subgraph's paid row (blockNumber/timestamp) over the onchain read (whose
 * parseSla minBlock is the TRUE SLA floor the verdict was judged against).
 */
const THEATER_POLL_MS = 30_000;
const THEATER_STALE_MS = 90_000;

/** `#theater/<digits>` → the numeric jobId string; anything else → null. */
export function parseTheaterHash(hash: string): string | null {
  const match = /^#theater\/([0-9]+)$/.exec(hash.trim());
  return match ? match[1] : null;
}

/** Mount anywhere in App: watches location.hash and renders the theater overlay while on the route. */
export function TheaterRoute(): JSX.Element | null {
  const [jobId, setJobId] = useState<string | null>(() => parseTheaterHash(window.location.hash));
  useEffect(() => {
    const onHash = (): void => setJobId(parseTheaterHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (jobId === null) return null;
  return (
    <Theater
      key={jobId}
      jobId={jobId}
      onClose={() => {
        window.location.hash = "#";
      }}
    />
  );
}

export function Theater({ jobId, onClose }: { jobId: string; onClose: () => void }): JSX.Element {
  const [index, setIndex] = useState(0);
  const id = useMemo(() => BigInt(jobId), [jobId]);
  const live = useLiveValue(() => loadTheater(id), {
    pollMs: THEATER_POLL_MS,
    staleAfterMs: THEATER_STALE_MS,
    cacheKey: `theater.${jobId}`,
  });

  const frames = useMemo(() => {
    const data = live.value;
    if (!data) return [];
    const built = buildFrames(data.job, data.split, data.heads, data.ens);
    const money = built.find((f) => f.id === "money");
    if (money && data.tx) money.tx = data.tx;
    return built;
  }, [live.value]);

  // Keep the scrubber clamped when a reload shrinks the frame list.
  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, frames.length - 1)));
  }, [frames.length]);

  // ←/→ scrub frames, Esc closes. Inputs keep their own keys (console dock).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.key === "ArrowLeft") setIndex((current) => Math.max(0, current - 1));
      else if (event.key === "ArrowRight") {
        setIndex((current) => Math.min(Math.max(0, frames.length - 1), current + 1));
      } else if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frames.length, onClose]);

  const data = live.value;
  const frame = frames[Math.min(index, Math.max(0, frames.length - 1))];
  const stateStamp = data?.job.state ?? "open";
  const rootRef = useRef<HTMLElement | null>(null);
  useModalFocus(true, {
    inertSelectors: ["main", ".console", ".console__launcher"],
    focus: () => rootRef.current?.querySelector<HTMLElement>("button, a[href]") ?? rootRef.current,
    container: () => rootRef.current,
  });
  // keyboard scrubbing moves focus with the selection (tablist contract)
  useEffect(() => {
    const active = document.activeElement;
    if (active && active.closest(".theater__scrub")) {
      rootRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    }
  }, [index]);

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      className="theater"
      role="dialog"
      aria-modal="true"
      aria-label={`replay theater · job ${jobId}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="theater__card">
        <header className="theater__head">
          <span className="theater__title">replay theater</span>
          <span className={`stamp ${stateStamp}`}>{stateStamp}</span>
          <span className="theater__job">job {jobId}</span>
          {live.source === "cache" && <span className="theater__cached">{cachedAsOfLabel(live.at)}</span>}
          <button type="button" className="theater__close" onClick={onClose} aria-label="close theater (esc)">
            ×
          </button>
        </header>

        {data === null ? (
          live.state === "error" ? (
            <div className="theater__status theater__status--error" role="alert">
              <p>the replay could not be built · {live.reason}</p>
              <button type="button" onClick={live.refresh}>
                retry
              </button>
            </div>
          ) : (
            <div className="theater__status">loading the replay…</div>
          )
        ) : (
          <>
            <div className="theater__scrub" role="tablist" aria-label="frames">
              <button
                type="button"
                className="theater__scrub-btn"
                onClick={() => setIndex((current) => Math.max(0, current - 1))}
                disabled={index === 0}
                aria-label="previous frame"
              >
                ←
              </button>
              {frames.map((f, i) => (
                <button
                  type="button"
                  key={f.id}
                  className={`theater__frame-btn${i === index ? " active" : ""}`}
                  role="tab"
                  aria-selected={i === index}
                  onClick={() => setIndex(i)}
                >
                  {f.title}
                </button>
              ))}
              <button
                type="button"
                className="theater__scrub-btn"
                onClick={() => setIndex((current) => Math.min(Math.max(0, frames.length - 1), current + 1))}
                disabled={index >= frames.length - 1}
                aria-label="next frame"
              >
                →
              </button>
            </div>

            {frame !== undefined && (
              <div className="theater__frame" key={frame.id}>
                <h3 className="theater__frame-title">{frame.title}</h3>
                <div className="theater__rows">
                  {frame.rows.map(([key, value]) => (
                    <div className="theater__row" key={key}>
                      <span className="theater__k">{key}</span>
                      <span className="theater__v">{value}</span>
                    </div>
                  ))}
                </div>
                {frame.id === "verdict" && (
                  <div className="theater__ruler">
                    <RulerBlock
                      data={{
                        delivered: data.job.metaBlock,
                        head: Number(data.heads.arc),
                        floor: Number(data.job.minBlock),
                        label: "deliverable vs SLA floor vs arc head",
                      }}
                    />
                  </div>
                )}
                {frame.tx !== undefined && (
                  <div className="theater__tx">
                    <a href={explorerUrl(frame.tx)} target="_blank" rel="noreferrer">
                      {frame.title === "money" ? "receipt tx" : "tx"} {truncateHash(frame.tx, 10, 8)} ↗
                    </a>
                  </div>
                )}
                {data.splitError !== undefined && frame.id === "money" && (
                  <div className="theater__note theater__note--error">split unavailable: {data.splitError}</div>
                )}
                {frame.note !== undefined && <div className="theater__note">{frame.note}</div>}
              </div>
            )}
          </>
        )}

        <footer className="theater__foot">← → scrub · esc closes · every frame is derived from live reads</footer>
      </div>
    </section>
  );
}
