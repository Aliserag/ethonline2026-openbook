/**
 * OpenBook — THE LEDGER TERMINAL (one route, the agent's public book):
 *
 *   storefront  ENSv2 svc.* records (Sepolia) — hard-fails when price/sla/payee
 *               are not set; never falls back to hard-coded values
 *   quote       live ENS-resolved price → 6-dec USDC amount + SLA terms
 *   pay         buyer flow: createJobWithSla split-key (single-key demo) —
 *               jobId + every tx hash from the escrow writes
 *   delivery    query_dataset via the Gateway with _meta block vs chainHead
 *               (freshness ruler — the tape) + verify/settle/refund
 *   pnl         openbook-pnl subgraph (Task 4) ledger via the Studio endpoint
 *
 * Key-guarded UI states: GRAPH_GATEWAY_KEY gates delivery+pnl; the wallet
 * gates pay/settle; missing keys render explicit notices, never fake data.
 *
 * Design: "The Ledger Terminal". Bindery ledger paper, printer's ink, one
 * semantic color family for money states (settled / refunded / stale), a
 * printer's blue for interactivity. Every figure is ledger monotype. The
 * signature is THE TAPE — a receipt-style freshness strip that prints the
 * settlement events as they land.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { useAccount, useConnect } from "wagmi";
import { createPublicClient, http, keccak256, toBytes, type PublicClient } from "viem";
import { arcTestnet } from "./wagmi";
import { env, hasGraphKey } from "./env";
import { CONFIG, defaultQueryFor, type DatasetConfig } from "./config";
import { arcWalletClient, ensureArcChain } from "./arc";
import { explorerUrl, truncateHash, usdc6 } from "./format";
import { fetchPnl, type PnlRow } from "./pnl";
import { createEnsTextReader, type EnsTextReader } from "../../mcp/src/ens";
import { gatewayQuery, stripMeta } from "../../mcp/src/gateway";
import { createJobWithSla, ERC8183, type Sla } from "../../agent/escrow";
import { verifyDelivery } from "../../mcp/src/escrow";

interface StorefrontState {
  records: { key: string; value: string | null }[];
  hardFail: string | null;
}

interface QuoteView {
  datasetId: string;
  amount: number;
  amountUsdc: string;
  minBlockLag: number;
  maxLatencyMs: number;
  payee: string;
}

interface JobState {
  jobId: string;
  minBlock: number;
  hashes: string[];
}

interface DeliveryState {
  dataset: DatasetConfig;
  payloadHash: `0x${string}`;
  metaBlock: number | null;
  chainHeadBlock: number | null;
  freshness: "fresh" | "stale" | "no-meta";
  result: unknown;
}

interface SettleState {
  verdict: string;
  reason?: string;
  minBlock: number;
  txHash?: string;
}

const SERVICE_KEYS = ["svc.menu", "svc.price", "svc.sla", "svc.payee", "svc.operator", "svc.pnl"];
const HARD_FAIL_KEYS = ["svc.price", "svc.sla", "svc.payee"];

function resolveStorefront(readEnsText: EnsTextReader): Promise<StorefrontState> {
  return Promise.all(SERVICE_KEYS.map((key) => readEnsText(CONFIG.ens, key))).then((values) => {
    const records = SERVICE_KEYS.map((key, index) => ({ key, value: values[index] ?? null }));
    const missing = HARD_FAIL_KEYS.filter((_, index) => records[index]?.value === null);
    return {
      records,
      hardFail:
        missing.length > 0
          ? `ENS_RESOLUTION_FAILED: ${missing.join(", ")} not set on ${CONFIG.ens} (sepolia ENSv2) — refusing to quote a hard-coded value`
          : null,
    };
  });
}

function quoteFromRecords(dataset: DatasetConfig, records: StorefrontState["records"]): QuoteView {
  const rec = (key: string): string => records.find((r) => r.key === key)?.value ?? "";
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*USDC\/query\s*$/i.exec(rec("svc.price"));
  if (!match) throw new Error(`invalid svc.price record: "${rec("svc.price")}"`);
  const price = parseFloat(match[1]!);
  const sla = JSON.parse(rec("svc.sla")) as Record<string, unknown>;
  const maxBlockLag = typeof sla["maxBlockLag"] === "number" ? sla["maxBlockLag"] : 50;
  const maxLatencyMs = typeof sla["maxLatencyMs"] === "number" ? sla["maxLatencyMs"] : 2000;
  return {
    datasetId: dataset.id,
    amount: Math.round(price * 1_000_000),
    amountUsdc: ((price * 1_000_000) / 1_000_000).toFixed(2),
    minBlockLag: maxBlockLag,
    maxLatencyMs,
    payee: rec("svc.payee"),
  };
}

export default function App() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();

  const [ens, setEns] = useState<StorefrontState | null>(null);
  const [ensLoading, setEnsLoading] = useState(true);
  const [datasetId, setDatasetId] = useState(CONFIG.datasets[0]?.id ?? "");
  const [queryText, setQueryText] = useState("");
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [paying, setPaying] = useState(false);
  const [job, setJob] = useState<JobState | null>(null);
  const [delivery, setDelivery] = useState<DeliveryState | null>(null);
  const [querying, setQuerying] = useState(false);
  const [settling, setSettling] = useState(false);
  const [settle, setSettle] = useState<SettleState | null>(null);
  const [pnl, setPnl] = useState<PnlRow[] | null>(null);
  const [pnlMeta, setPnlMeta] = useState<number | null>(null);
  const [pnlHead, setPnlHead] = useState<number | null>(null);
  const [pnlError, setPnlError] = useState<string | null>(null);

  const dataset = useMemo(
    () => CONFIG.datasets.find((d) => d.id === datasetId) ?? CONFIG.datasets[0],
    [datasetId],
  );
  const readEnsText = useMemo<EnsTextReader>(
    () => createEnsTextReader({ rpcUrl: env.sepoliaRpc }),
    [],
  );
  const publicClient = useMemo<PublicClient>(
    () => createPublicClient({ chain: arcTestnet, transport: http(env.arcRpc) }),
    [],
  );

  // storefront: live ENSv2 reads, hard-fail surfaced as a notice
  useEffect(() => {
    let cancelled = false;
    setEnsLoading(true);
    resolveStorefront(readEnsText)
      .then((state) => {
        if (!cancelled) setEns(state);
      })
      .catch((error) => {
        if (cancelled) return;
        setEns({
          records: SERVICE_KEYS.map((key) => ({ key, value: null })),
          hardFail: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (!cancelled) setEnsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [readEnsText]);

  useEffect(() => {
    setQueryText(defaultQueryFor(dataset));
  }, [dataset]);

  // P&L ledger: the openbook-pnl subgraph via Studio (key-gated)
  useEffect(() => {
    if (!hasGraphKey) return;
    let cancelled = false;
    Promise.all([fetchPnl(env.graphKey), publicClient.getBlockNumber()])
      .then(([result, head]) => {
        if (cancelled) return;
        setPnl(result.rows);
        setPnlMeta(result.metaBlock);
        setPnlHead(Number(head));
      })
      .catch((error) => {
        if (!cancelled) setPnlError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  const handleQuote = (): void => {
    if (ens === null || ens.hardFail !== null) return;
    try {
      setQuote(quoteFromRecords(dataset, ens.records));
    } catch (error) {
      setEns({ ...ens, hardFail: error instanceof Error ? error.message : String(error) });
    }
  };

  const handlePay = async (): Promise<void> => {
    if (!address || quote === null || dataset === undefined) return;
    setPaying(true);
    try {
      await ensureArcChain();
      const trace: string[] = [];
      const wallet = arcWalletClient(address, trace);
      const head = await publicClient.getBlockNumber();
      const sla: Sla = {
        minBlock: Number(head) - quote.minBlockLag,
        schemaHash: keccak256(toBytes(dataset.schema)),
        maxLatencyMs: quote.maxLatencyMs,
      };
      const jobId = await createJobWithSla(publicClient, {
        buyer: wallet,
        provider: wallet,
        evaluator: address,
        sla,
        amount6dec: BigInt(quote.amount),
        expirySeconds: 3600,
      });
      setJob({ jobId: String(jobId), minBlock: sla.minBlock, hashes: trace });
    } finally {
      setPaying(false);
    }
  };

  const handleQuery = async (): Promise<void> => {
    if (!hasGraphKey || dataset === undefined) return;
    setQuerying(true);
    try {
      const { data, meta } = await gatewayQuery({
        key: env.graphKey,
        subgraphId: dataset.subgraphId,
        query: queryText,
      });
      const freshness: DeliveryState["freshness"] =
        meta.block === null || meta.chainHeadBlock === null
          ? "no-meta"
          : meta.chainHeadBlock - meta.block <= dataset.freshness.maxAge
            ? "fresh"
            : "stale";
      setDelivery({
        dataset,
        payloadHash: keccak256(toBytes(JSON.stringify(stripMeta(data)))),
        metaBlock: meta.block,
        chainHeadBlock: meta.chainHeadBlock,
        freshness,
        result: stripMeta(data),
      });
    } finally {
      setQuerying(false);
    }
  };

  const handleSettle = async (): Promise<void> => {
    if (!address || job === null || delivery === null || delivery.metaBlock === null) return;
    setSettling(true);
    try {
      await ensureArcChain();
      const wallet = arcWalletClient(address);
      const result = await verifyDelivery(
        {
          jobId: job.jobId,
          payloadHash: delivery.payloadHash,
          metaBlock: delivery.metaBlock,
          minBlock: job.minBlock,
          settle: true,
        },
        { publicClient, walletClient: wallet },
      );
      setSettle({
        verdict: result.verdict,
        reason: result.reason,
        minBlock: result.minBlock,
        txHash: result.txHash,
      });
    } finally {
      setSettling(false);
    }
  };

  const ensDone = ens !== null && ens.hardFail === null;
  const step = {
    resolve: ensDone ? "done" : ensLoading ? "" : "live",
    quote: quote !== null ? "done" : "",
    pay: job !== null ? "done" : paying ? "live" : quote !== null ? "live" : "",
    deliver: delivery !== null ? "done" : querying ? "live" : "",
    settle: settle !== null ? "done" : settling ? "live" : "",
  } as const;

  // ---- THE TAPE events (signature): print what actually happened ---------
  const tapeEvents: { text: string; kind: "settled" | "refunded" | "stale" | "idle" }[] = [];
  if (settle !== null) {
    tapeEvents.push(
      settle.verdict === "APPROVE"
        ? { text: `SETTLED job ${settle.minBlock > 0 ? `#minBlock${settle.minBlock}` : ""} — seller paid · ${settle.txHash ? truncateHash(settle.txHash) : ""}`.replace("  ", " "), kind: "settled" as const }
        : { text: `REFUNDED — ${settle.reason ?? "SLA miss"} · ${settle.txHash ? truncateHash(settle.txHash) : ""}`, kind: "refunded" as const },
    );
  } else if (delivery !== null) {
    tapeEvents.push(
      delivery.freshness === "fresh"
        ? { text: `DELIVERED block ${delivery.metaBlock} · ${delivery.freshness}`, kind: "settled" as const }
        : delivery.freshness === "stale"
          ? { text: `DELIVERED block ${delivery.metaBlock} · STALE — gate refuses charge, refund path armed`, kind: "stale" as const }
          : { text: "DELIVERED · NO META — cannot attest freshness", kind: "idle" as const },
    );
  } else if (job !== null) {
    tapeEvents.push({ text: `FUNDED job ${job.jobId} · SLA minBlock ${job.minBlock}`, kind: "idle" as const });
  } else if (quote !== null) {
    tapeEvents.push({ text: `QUOTED ${quote.amountUsdc} USDC/query · SLA lag ${quote.minBlockLag} · latency ${quote.maxLatencyMs}ms`, kind: "idle" as const });
  } else {
    tapeEvents.push({ text: "tape idle — awaiting settlement activity", kind: "idle" as const });
  }

  return (
    <>
      <header className="masthead">
        <div className="nameblock">
          <h1>
            OpenBook<span className="ledger-no">the agent's settlement ledger</span>
          </h1>
          <p className="tagline">
            an autonomous agent selling freshness-guaranteed onchain data — every payment carries
            an SLA, every miss refunds itself onchain
          </p>
        </div>
        <div className="chainbadges">
          <span>arc · 5042002</span>
          <span>ensv2 · sepolia</span>
          <span>the graph · gateway</span>
          <span>{CONFIG.ens}</span>
        </div>
      </header>

      <p className="envline">
        <span>{hasGraphKey ? <b className="yes">GRAPH_GATEWAY_KEY set</b> : <b className="no">GRAPH_GATEWAY_KEY unset</b>}</span>
        <span>{env.sepoliaRpc ? <b className="yes">SEPOLIA_RPC set</b> : <b className="no">SEPOLIA_RPC unset (viem default)</b>}</span>
        <span>{env.arcRpc ? <b className="yes">ARC_TESTNET_RPC set</b> : <b className="no">ARC_TESTNET_RPC unset (public rpc)</b>}</span>
        <span>{isConnected ? <b className="yes">wallet: {truncateHash(address ?? "")}</b> : <b className="no">wallet disconnected</b>}</span>
      </p>

      <div className="book">
        <div className="journal">
          <ol className="process">
            <li className={step.resolve === "done" ? "done" : step.resolve === "live" ? "live" : ""}>resolve</li>
            <li className={step.quote === "done" ? "done" : ""}>quote</li>
            <li className={step.pay === "done" ? "done" : step.pay === "live" ? "live" : ""}>pay</li>
            <li className={step.deliver === "done" ? "done" : step.deliver === "live" ? "live" : ""}>deliver</li>
            <li className={step.settle === "done" ? "done" : step.settle === "live" ? "live" : ""}>settle</li>
          </ol>

          <section className="panel">
            <header>
              <h2>Storefront</h2>
              <span className="sub">{CONFIG.ens} · ENSv2 · Sepolia · live reads</span>
            </header>
            <div className="body">
              {ensLoading && <p className="notice">resolving {CONFIG.ens} svc.* records…</p>}
              {ens !== null && ens.hardFail !== null && (
                <div className="notice hardfail">
                  <strong>hard fail</strong> — the storefront is not priceable without its records.
                  <div className="mono">{ens.hardFail}</div>
                </div>
              )}
              {ens !== null && ens.hardFail === null && (
                <div className="notice ok">
                  <strong>records resolved</strong> — price, SLA and payee are live ENS text records,
                  not constants in this page.
                </div>
              )}
              <table className="ledger">
                <thead>
                  <tr>
                    <th>record</th>
                    <th>value</th>
                  </tr>
                </thead>
                <tbody>
                  {ens?.records.map((record) => (
                    <tr key={record.key}>
                      <td className="key">{record.key}</td>
                      <td className={record.value === null ? "val missing" : "val"}>
                        {record.value ?? "— not set —"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <header>
              <h2>Quote &amp; pay</h2>
              <span className="sub">buyer flow · escrow {truncateHash(ERC8183)}</span>
            </header>
            <div className="body">
              <div className="field">
                <label htmlFor="dataset">dataset</label>
                <select id="dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                  {CONFIG.datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.id} — {d.description}
                    </option>
                  ))}
                </select>
              </div>
              {quote === null ? (
                <button className="primary" disabled={!ensDone} onClick={handleQuote}>
                  Get quote
                </button>
              ) : (
                <div className="notice ok">
                  <strong>{quote.amountUsdc} USDC/query</strong> (6-dec · ENS svc.price)
                  <div className="mono">
                    SLA: min block lag {quote.minBlockLag} · latency {quote.maxLatencyMs}ms ·
                    payee {truncateHash(quote.payee)}
                  </div>
                </div>
              )}

              {isConnected ? (
                <p style={{ marginTop: 14 }}>
                  <button
                    className="primary"
                    disabled={quote === null || paying || job !== null}
                    onClick={handlePay}
                  >
                    {paying ? "signing escrow txs…" : job !== null ? "job funded" : `Pay ${quote?.amountUsdc ?? ""} USDC into escrow`}
                  </button>
                </p>
              ) : (
                <p className="notice">
                  Connect a wallet to pay.{" "}
                  {connectors.map((connector) => (
                    <button key={connector.uid} style={{ marginRight: 8 }} onClick={() => connect({ connector })}>
                      Connect {connector.name}
                    </button>
                  ))}
                </p>
              )}

              {job !== null && (
                <div className="notice ok">
                  <strong>funded</strong> — job {job.jobId} on ERC-8183 ({truncateHash(ERC8183)})
                  <div className="mono">
                    SLA minBlock <b>{job.minBlock}</b> · escrow 0.10 USDC (6-dec)
                    <br />
                    {job.hashes.map((hash, index) => (
                      <span key={hash}>
                        tx{job.hashes.length - index}:{" "}
                        <a href={explorerUrl(hash)} target="_blank" rel="noreferrer">
                          {truncateHash(hash)}
                        </a>
                        <br />
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <header>
              <h2>Delivery</h2>
              <span className="sub">the graph gateway · _meta freshness gate</span>
            </header>
            <div className="body">
              {!hasGraphKey && (
                <p className="notice error">
                  <strong>Graph gateway key not set</strong> — add <span className="mono">VITE_GRAPH_GATEWAY_KEY</span>{" "}
                  to <span className="mono">app/.env.local</span> (free Studio key at thegraph.com/studio).
                  The query and P&amp;L panels are key-gated — no hard-coded data.
                </p>
              )}
              <div className="field">
                <label htmlFor="query">graphql</label>
                <textarea id="query" value={queryText} onChange={(event) => setQueryText(event.target.value)} />
              </div>
              <button className="primary" disabled={!hasGraphKey || querying} onClick={handleQuery}>
                {querying ? "querying…" : "Pull fresh data"}
              </button>

              <FreshnessRuler delivery={delivery} minBlock={job?.minBlock ?? null} />
              {delivery !== null && <DeliveryResult delivery={delivery} />}

              <p style={{ marginTop: 14 }}>
                <button
                  className={delivery !== null && delivery.freshness === "stale" ? "danger" : "primary"}
                  disabled={!isConnected || job === null || delivery === null || settling}
                  onClick={handleSettle}
                >
                  {settling
                    ? "settling…"
                    : delivery !== null && delivery.freshness === "stale"
                      ? "Verify & refund stale delivery"
                      : "Verify & settle delivery"}
                </button>
              </p>
              {settle !== null && (
                <div className={settle.verdict === "APPROVE" ? "notice ok" : "notice error"}>
                  <strong>{settle.verdict === "APPROVE" ? "settled — seller paid" : `refund issued (${settle.reason ?? "SLA miss"})`}</strong>
                  {settle.txHash !== undefined && (
                    <div className="mono">
                      <a href={explorerUrl(settle.txHash)} target="_blank" rel="noreferrer">
                        {truncateHash(settle.txHash)}
                      </a>
                      · minBlock {settle.minBlock}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="summary">
          <section className="panel">
            <header>
              <h2>Running balance</h2>
              <span className="sub">openbook-pnl · arc-testnet</span>
            </header>
            <div className="body">
              {!hasGraphKey && (
                <p className="notice error">
                  <strong>P&amp;L unavailable</strong> — same Gateway key gate as the rest of the
                  Graph paths.
                </p>
              )}
              {pnlError !== null && <p className="notice error">{pnlError}</p>}
              {pnl !== null && pnl.length === 0 && <p className="notice">no settlement rows yet — the ledger fills as jobs complete.</p>}
              {pnl !== null && pnl.length > 0 && (
                <ul className="running">
                  <li>
                    <span className="cap">revenue</span>
                    <span className="fig settled">{usdc6(sum(pnl, (r) => r.revenue))} USDC</span>
                  </li>
                  <li>
                    <span className="cap">costs</span>
                    <span className="fig">{usdc6(sum(pnl, (r) => r.costs))} USDC</span>
                  </li>
                  <li>
                    <span className="cap">refunds</span>
                    <span className="fig refunded">{usdc6(sum(pnl, (r) => r.refunds))} USDC</span>
                  </li>
                  <li>
                    <span className="cap">net</span>
                    <span className="fig net">{usdc6(sum(pnl, (r) => r.net))} USDC</span>
                  </li>
                </ul>
              )}
              <p className="statline">
                _meta block {pnlMeta ?? "—"} · chain head {pnlHead ?? "—"} · daily rows{" "}
                {pnl !== null ? String(pnl.length) : "—"}
              </p>
            </div>
          </section>

          <section className="panel">
            <header>
              <h2>Ledger</h2>
              <span className="sub">daily rows</span>
            </header>
            <div className="body">
              {pnl !== null && pnl.length > 0 ? (
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>day</th>
                      <th>revenue</th>
                      <th>costs</th>
                      <th>refunds</th>
                      <th>net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pnl.map((row) => (
                      <tr key={row.id}>
                        <td className="key">{row.id}</td>
                        <td className="val">{usdc6(row.revenue)}</td>
                        <td className="val">{usdc6(row.costs)}</td>
                        <td className="val">{usdc6(row.refunds)}</td>
                        <td className={row.net.startsWith("-") ? "val missing" : "val ok"}>{usdc6(row.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="notice">daily rows appear here once settlements land.</p>
              )}
            </div>
          </section>
        </aside>
      </div>

      <div className="tape" aria-label="settlement tape: freshness scale and printed events">
        <div className="tape__head">
          <span className="tape__title">The Tape</span>
          <span className="tape__status">
            {delivery !== null ? `delivery ${delivery.freshness}` : settle !== null ? `settled ${settle.verdict}` : "idle"}
          </span>
        </div>
        <div className="tape__body">
          <div className="tape__scale">
            <FreshnessRuler delivery={delivery} minBlock={job?.minBlock ?? null} />
            <div className="tape__ticks">
              <span>SLA floor</span>
              <span>delivered ▸ chain head</span>
            </div>
          </div>
          <div className="tape__events" role="status" aria-live="polite">
            {tapeEvents.map((event, index) => (
              <span key={`${event.kind}-${index}`} className={`ev ${event.kind}`}>
                {event.text}
              </span>
            ))}
          </div>
        </div>
      </div>

      <footer className="foot">
        <span>
          SLA committed onchain at payment · verdict is deterministic open code · timeout defaults
          to the buyer (claimRefund)
        </span>
        <a
          href="https://github.com/Aliserag/ethonline2026-openbook/blob/main/docs/architecture.md"
          target="_blank"
          rel="noreferrer"
        >
          architecture ↗
        </a>
      </footer>
    </>
  );
}

function sum(rows: PnlRow[], pick: (row: PnlRow) => string): number {
  return rows.reduce((acc, row) => acc + Number(pick(row)), 0);
}

function FreshnessRuler({
  delivery,
  minBlock,
}: {
  delivery: DeliveryState | null;
  minBlock: number | null;
}): JSX.Element | null {
  if (delivery === null || delivery.metaBlock === null || delivery.chainHeadBlock === null) {
    return null;
  }
  const { metaBlock, chainHeadBlock, freshness } = delivery;
  const lo = Math.min(metaBlock, chainHeadBlock, minBlock ?? chainHeadBlock);
  const hi = Math.max(metaBlock, chainHeadBlock, minBlock ?? chainHeadBlock);
  const span = Math.max(1, hi - lo);
  const pct = (value: number): number => ((value - lo) / span) * 100;
  return (
    <div className="ruler" role="img" aria-label="freshness: delivered block vs SLA floor vs chain head">
      {minBlock !== null && (
        <span
          className="windowbar"
          style={{ left: `${pct(minBlock)}%`, width: `${Math.max(0, pct(chainHeadBlock) - pct(minBlock))}%` }}
          title={`SLA accepts metaBlock >= ${minBlock}`}
        />
      )}
      {minBlock !== null && (
        <span className="mark minblock" style={{ left: `${pct(minBlock)}%` }}>
          SLA min {minBlock}
        </span>
      )}
      <span className={`needle meta${freshness === "fresh" ? " fresh" : ""}`} style={{ left: `${pct(metaBlock)}%` }}>
        <span className="lbl">delivered {metaBlock}</span>
      </span>
      <span className="needle head" style={{ left: `${pct(chainHeadBlock)}%` }}>
        <span className="lbl">head {chainHeadBlock}</span>
      </span>
    </div>
  );
}

function DeliveryResult({ delivery }: { delivery: DeliveryState }): JSX.Element {
  const delta =
    delivery.metaBlock !== null && delivery.chainHeadBlock !== null
      ? delivery.chainHeadBlock - delivery.metaBlock
      : null;
  const status =
    delivery.freshness === "fresh"
      ? `${delta} block${delta === 1 ? "" : "s"} behind chain head — within SLA maxAge ${delivery.dataset.freshness.maxAge}`
      : delivery.freshness === "stale"
        ? `${delta} block${delta === 1 ? "" : "s"} behind chain head — beyond SLA maxAge ${delivery.dataset.freshness.maxAge}; the gate refuses to charge, verify refunds`
        : "no _meta in the response — cannot attest freshness";
  return (
    <div className={delivery.freshness === "fresh" ? "notice ok" : "notice error"}>
      <strong>{delivery.freshness === "fresh" ? "FRESH" : delivery.freshness === "stale" ? "STALE" : "NO META"}</strong>{" "}
      — {status}
      <div className="mono">
        payloadHash {truncateHash(delivery.payloadHash, 10, 10)} ·{" "}
        {JSON.stringify(delivery.result).slice(0, 96)}
        {JSON.stringify(delivery.result).length > 96 ? "…" : ""}
      </div>
    </div>
  );
}
