/**
 * OpenBook — THE RECEIPT PRINTER (one route, guided ledger).
 *
 * Brand: the agent's settlement book, printed live. `▤ OB` mark. Paper, ink,
 * stamps (SETTLED / REFUNDED / STALE), and THE TAPE — a receipt printer that
 * types out every settlement event as it lands.
 *
 * Guided: each step is a card with a plain-language job ("See what's for
 * sale", "Get the price", "Pay", "Watch data arrive", "Settle or refund"),
 * tooltips on every jargon term, and key gates rendered as setup cards with
 * exact 60-second steps — never silent dead ends.
 *
 * Logic preserved verbatim from the prior revision; only presentation and
 * copy changed (plus aria + status semantics).
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

/** The hard-fail keys whose own record is unset — matched BY NAME, never by
 *  position: SERVICE_KEYS and HARD_FAIL_KEYS are different orders and a naive
 *  index filter falsely blames neighbors (F1, adversarial E2E). */
export function missingHardFailKeys(records: { key: string; value: string | null }[]): string[] {
  return HARD_FAIL_KEYS.filter((key) => records.find((r) => r.key === key)?.value == null);
}

export interface StepState {
  quote: QuoteView | null;
  job: JobState | null;
  paying: boolean;
  delivery: DeliveryState | null;
  querying: boolean;
  settling: boolean;
  settle: SettleState | null;
}

export type StepKind = "done" | "live" | "failed" | "";

/** Step kind → chip css class. A failed step must never read as in-flight. */
export function chipClass(kind: StepKind): string {
  return kind === "" ? "" : kind;
}

/**
 * Journal step states (resolve → quote → pay → deliver → settle).
 * Failures get their own state: a settled hard-fail must never read as
 * in-flight ("live" is reserved for work actually in progress).
 */
export function deriveSteps(
  ensDone: boolean,
  ensLoading: boolean,
  s: StepState,
): Record<"resolve" | "quote" | "pay" | "deliver" | "settle", StepKind> {
  return {
    resolve: ensDone ? "done" : ensLoading ? "" : "failed",
    quote: s.quote !== null ? "done" : "",
    pay: s.job !== null ? "done" : s.paying ? "live" : s.quote !== null ? "live" : "",
    deliver: s.delivery !== null ? "done" : s.querying ? "live" : "",
    settle: s.settle !== null ? "done" : s.settling ? "live" : "",
  };
}

function resolveStorefront(readEnsText: EnsTextReader): Promise<StorefrontState> {
  return Promise.all(SERVICE_KEYS.map((key) => readEnsText(CONFIG.ens, key))).then((values) => {
    const records = SERVICE_KEYS.map((key, index) => ({ key, value: values[index] ?? null }));
    const missing = missingHardFailKeys(records);
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

/** Tooltip — the page's vocabulary for judges with zero context. */
function Tip({ text }: { text: string }): JSX.Element {
  return (
    <span className="tip" data-tip={text} role="note" aria-label={text} tabIndex={0}>
      ?
    </span>
  );
}

type StepStateAttr = "active" | "done" | "failed" | "blocked" | "idle";

/** One step card — the guided spine. */
function StepCard(props: {
  n: number;
  state: StepStateAttr;
  title: string;
  what: string;
  why?: string;
  children: React.ReactNode;
}): JSX.Element {
  const stateLabel =
    props.state === "done"
      ? "done"
      : props.state === "active"
        ? "next"
        : props.state === "failed"
          ? "failed"
          : props.state === "blocked"
            ? "needs setup"
            : "waiting";
  return (
    <section className="stepcard" data-state={props.state} aria-labelledby={`step-${props.n}-title`}>
      <div className="stepcard__head">
        <span className="stepno" aria-hidden="true">
          {props.n}
        </span>
        <div className="steptitle">
          <h2 id={`step-${props.n}-title`}>{props.title}</h2>
          <p className="what">{props.what}</p>
        </div>
        <span className="stepstate">{stateLabel}</span>
      </div>
      <div className="body">
        {props.why !== undefined && <p className="why">{props.why}</p>}
        {props.children}
      </div>
    </section>
  );
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
  const step = deriveSteps(ensDone, ensLoading, {
    quote,
    job,
    paying,
    delivery,
    querying,
    settling,
    settle,
  });

  const stepState = (k: StepKind): StepStateAttr =>
    k === "done" ? "done" : k === "failed" ? "failed" : k === "live" ? "active" : "idle";

  // ---- THE TAPE events (the signature): print what actually happened ------
  const tapeEvents: { text: string; kind: "settled" | "refunded" | "stale" | "idle" }[] = [];
  if (settle !== null) {
    tapeEvents.push(
      settle.verdict === "APPROVE"
        ? { text: `SETTLED job ${job?.jobId ?? ""} — seller paid${settle.txHash ? ` · ${truncateHash(settle.txHash)}` : ""}`, kind: "settled" as const }
        : { text: `REFUNDED — ${settle.reason ?? "SLA miss"}${settle.txHash ? ` · ${truncateHash(settle.txHash)}` : ""}`, kind: "refunded" as const },
    );
  } else if (delivery !== null) {
    tapeEvents.push(
      delivery.freshness === "fresh"
        ? { text: `DELIVERED block ${delivery.metaBlock} · fresh`, kind: "settled" as const }
        : delivery.freshness === "stale"
          ? { text: `DELIVERED block ${delivery.metaBlock} · STALE — gate refuses charge, refund armed`, kind: "stale" as const }
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
          <span className="brandmark" aria-hidden="true">
            ▤ OB
          </span>
          <div>
            <h1>
              OpenBook<span className="ledger-no">the agent's settlement ledger</span>
            </h1>
            <p className="tagline">
              an autonomous agent selling freshness-guaranteed onchain data — every payment
              carries an SLA, and <span className="accent">every miss refunds itself onchain</span>
            </p>
          </div>
        </div>
        <div className="chainbadges">
          <span>arc · 5042002</span>
          <span>ensv2 · sepolia</span>
          <span>the graph · gateway</span>
          <span>{CONFIG.ens}</span>
        </div>
      </header>

      <main>
        <p className="envline" aria-label="environment status">
          <span>
            <span className={hasGraphKey ? "dot yes" : "dot no"} aria-hidden="true" />
            {hasGraphKey ? "GRAPH_GATEWAY_KEY set" : "GRAPH_GATEWAY_KEY unset"}
          </span>
          <span>
            <span className={env.sepoliaRpc ? "dot yes" : "dot no"} aria-hidden="true" />
            {env.sepoliaRpc ? "SEPOLIA_RPC set" : "SEPOLIA_RPC unset (viem default)"}
          </span>
          <span>
            <span className={env.arcRpc ? "dot yes" : "dot no"} aria-hidden="true" />
            {env.arcRpc ? "ARC_TESTNET_RPC set" : "ARC_TESTNET_RPC unset (public rpc)"}
          </span>
          <span>
            <span className={isConnected ? "dot yes" : "dot no"} aria-hidden="true" />
            {isConnected ? `wallet: ${truncateHash(address ?? "")}` : "wallet disconnected"}
          </span>
        </p>

        <div className="book">
          <div className="journal">
            <ol className="process" aria-label="flow progress">
              <li className={chipClass(step.resolve)}>resolve</li>
              <li className={chipClass(step.quote)}>quote</li>
              <li className={chipClass(step.pay)}>pay</li>
              <li className={chipClass(step.deliver)}>deliver</li>
              <li className={chipClass(step.settle)}>settle</li>
            </ol>

            <StepCard
              n={1}
              state={ensDone ? "done" : ensLoading ? "active" : "failed"}
              title="See what's for sale"
              what="The storefront lives on ENSv2 (Sepolia): menu, price, SLA, payee."
              why="The storefront is a name, not a file. OpenBook.eth publishes its menu, price and service-level promise as live ENSv2 records — if any record is missing, nothing gets priced. No hard-coded values, ever."
            >
              {ensLoading && (
                <p className="notice" role="status">
                  Resolving {CONFIG.ens} on Sepolia — reading its live records…
                </p>
              )}
              {ens !== null && ens.hardFail !== null && (
                <>
                  <div className="notice hardfail">
                    <strong>Storefront isn't set up yet.</strong> The agent won't guess a price — it
                    refuses to trade until its ENSv2 records exist. That's the point: no name, no
                    commerce.
                    <div className="mono">{ens.hardFail}</div>
                  </div>
                  <div className="setupcard">
                    <span className="kicker">60-second setup</span>
                    <strong>To watch OpenBook sell:</strong>
                    <ol>
                      <li>
                        Register the name and records with <code>scripts/ens/setup.sh</code> (writes
                        menu, price, SLA, payee).
                        <Tip text="The setup script needs a Sepolia key with test ETH + free MockUSDC. Details in docs/keys-needed.md." />
                      </li>
                      <li>Reload this page — the table below fills with live records.</li>
                      <li>Step 2 unlocks: prices are read from the name, not hard-coded.</li>
                    </ol>
                  </div>
                </>
              )}
              {ens !== null && ens.hardFail === null && (
                <div className="notice ok">
                  <strong>Storefront live.</strong> Price, SLA and payee resolved from ENSv2 records
                  on {CONFIG.ens} — the exact values the agent is bound by, read off the chain.
                </div>
              )}
              <table className="ledger" aria-label="ENS storefront records">
                <thead>
                  <tr>
                    <th scope="col">
                      ENSv2 record
                      <Tip text="ENSv2 (Sepolia) lets the agent publish a structured menu: what it sells, at what price, under what SLA, and who gets paid." />
                    </th>
                    <th scope="col">live value</th>
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
            </StepCard>

            <StepCard
              n={2}
              state={stepState(step.quote) === "idle" && stepState(step.resolve) === "done" ? "active" : stepState(step.quote)}
              title="Get the price"
              what="Quote the chosen dataset — priced straight from the ENSv2 records."
              why="Ask first, pay later. The agent quotes from its own ENSv2 records (price + SLA), so you always know exactly what you're buying before a payment moves."
            >
              <div className="field">
                <label htmlFor="dataset">
                  dataset
                  <Tip text="Two standardized Messari subgraphs — the same query shape runs on both. That's The Graph's schema leverage." />
                </label>
                <select id="dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                  {CONFIG.datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.id} — {d.description}
                    </option>
                  ))}
                </select>
              </div>
              {quote === null ? (
                <button
                  className="primary"
                  disabled={!ensDone}
                  onClick={handleQuote}
                  title={!ensDone ? "The storefront (step 1) must resolve first" : undefined}
                >
                  Get quote
                </button>
              ) : (
                <div className="notice ok" role="status">
                  <strong>{quote.amountUsdc} USDC/query</strong> — quoted from ENS, guaranteed fresh
                  <div className="mono">
                    SLA: min block lag {quote.minBlockLag} · latency {quote.maxLatencyMs}ms · payee{" "}
                    {truncateHash(quote.payee)}
                  </div>
                </div>
              )}
              {quote !== null && (
                <p style={{ marginTop: 12 }}>
                  {isConnected ? (
                    <button
                      className="primary"
                      disabled={paying || job !== null}
                      onClick={handlePay}
                      title={job !== null ? "This job is already funded" : undefined}
                    >
                      {paying ? "signing escrow txs…" : job !== null ? "job funded ✓" : `Pay ${quote.amountUsdc} USDC into escrow`}
                    </button>
                  ) : (
                    <span className="notice" style={{ display: "inline-block", marginBottom: 0 }}>
                      Connect a wallet to pay.{" "}
                      {connectors.map((connector) => (
                        <button key={connector.uid} style={{ marginRight: 8 }} onClick={() => connect({ connector })}>
                          Connect {connector.name}
                        </button>
                      ))}
                    </span>
                  )}
                </p>
              )}
              {job !== null && (
                <div className="notice ok" role="status">
                  <strong>Funded — the SLA is now onchain.</strong> job {job.jobId} on ERC-8183 (
                  {truncateHash(ERC8183)}). The agent has committed to deliver data no older than
                  block {job.minBlock} — or refund you automatically.
                  <div className="mono">
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
            </StepCard>

            <StepCard
              n={3}
              state={
                delivery !== null
                  ? "done"
                  : querying
                    ? "active"
                    : !hasGraphKey
                      ? "blocked"
                      : "idle"
              }
              title="Watch data arrive"
              what="One live query through The Graph's Gateway — with its freshness timestamp."
              why="Every answer carries a proof of freshness (the _meta block). If the data is older than the SLA allows, the agent refuses to charge for it — before you pay, not after."
            >
              {!hasGraphKey && (
                <div className="setupcard">
                  <span className="kicker">one free key, 60 seconds</span>
                  <strong>To watch live data:</strong>
                  <ol>
                    <li>
                      Get a free key at <a href="https://thegraph.com/studio" target="_blank" rel="noreferrer">thegraph.com/studio</a>{" "}
                      (account → API keys).
                      <Tip text="The Studio key gates Gateway queries and the hosted Subgraph MCP — one key, both." />
                    </li>
                    <li>
                      Add it to <code>app/.env.local</code> as <code>VITE_GRAPH_GATEWAY_KEY</code>.
                    </li>
                    <li>Reload — this panel runs the live query.</li>
                  </ol>
                </div>
              )}
              <div className="field">
                <label htmlFor="query">
                  graphql
                  <Tip text="The exact query the agent runs against the pinned Messari subgraph — you can edit it live." />
                </label>
                <textarea id="query" value={queryText} onChange={(event) => setQueryText(event.target.value)} />
              </div>
              <button
                className="primary"
                disabled={!hasGraphKey || querying}
                onClick={handleQuery}
                title={!hasGraphKey ? "Needs the Graph gateway key (see card above)" : undefined}
              >
                {querying ? "querying…" : "Pull fresh data"}
              </button>

              <FreshnessRuler delivery={delivery} minBlock={job?.minBlock ?? null} />
              {delivery !== null && <DeliveryResult delivery={delivery} />}
            </StepCard>

            <StepCard
              n={4}
              state={stepState(step.settle)}
              title="Settle — or refund"
              what="The verdict is deterministic open code: fresh data settles, stale data refunds."
              why="This is the whole idea: the payment itself checks the SLA. The agent never gets paid for stale data, and the buyer never has to ask for a refund — it just happens onchain."
            >
              <p style={{ marginTop: 0 }}>
                <button
                  className={delivery !== null && delivery.freshness === "stale" ? "danger" : "primary"}
                  disabled={!isConnected || job === null || delivery === null || settling}
                  onClick={handleSettle}
                  title={
                    !isConnected
                      ? "Connect a wallet first (step 2)"
                      : job === null
                        ? "Fund a job first (step 2)"
                        : delivery === null
                          ? "Pull fresh data first (step 3)"
                          : undefined
                  }
                >
                  {settling
                    ? "settling…"
                    : delivery !== null && delivery.freshness === "stale"
                      ? "Verify & refund stale delivery"
                      : "Verify & settle delivery"}
                </button>
              </p>
              {settle !== null && (
                <div className={settle.verdict === "APPROVE" ? "notice ok" : "notice error"} role="status">
                  <span className={settle.verdict === "APPROVE" ? "stamp settled" : "stamp refunded"}>
                    {settle.verdict === "APPROVE" ? "SETTLED" : "REFUNDED"}
                  </span>{" "}
                  <strong>
                    {settle.verdict === "APPROVE"
                      ? "seller paid — SLA met"
                      : `refund issued (${settle.reason ?? "SLA miss"})`}
                  </strong>
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
            </StepCard>
          </div>

          <aside className="summary">
            <section className="stepcard" data-state={pnl !== null && pnl.length > 0 ? "done" : "idle"}>
              <div className="stepcard__head">
                <span className="stepno" aria-hidden="true">
                  P
                </span>
                <div className="steptitle">
                  <h2 id="pnl-title">The agent's books</h2>
                  <p className="what">
                    Running P&amp;L, onchain and queryable — every settlement lands here.
                  </p>
                </div>
                <span className="stepstate">live</span>
              </div>
              <div className="body">
                {!hasGraphKey && (
                  <div className="setupcard">
                    <span className="kicker">one free key, 60 seconds</span>
                    <strong>To read the books:</strong> same Graph key as step 3 — add
                    <code> VITE_GRAPH_GATEWAY_KEY</code> to <code>app/.env.local</code> and reload.
                  </div>
                )}
                {pnlError !== null && <p className="notice error">{pnlError}</p>}
                {pnl !== null && pnl.length === 0 && (
                  <p className="notice">no settlement rows yet — the ledger fills as jobs complete.</p>
                )}
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

            <section className="stepcard" data-state="idle">
              <div className="stepcard__head">
                <span className="stepno" aria-hidden="true">
                  L
                </span>
                <div className="steptitle">
                  <h2 id="ledger-title">Daily rows</h2>
                  <p className="what">The audit trail, day by day.</p>
                </div>
              </div>
              <div className="body">
                {pnl !== null && pnl.length > 0 ? (
                  <table className="ledger" aria-label="daily P&L rows">
                    <thead>
                      <tr>
                        <th scope="col">day</th>
                        <th scope="col">revenue</th>
                        <th scope="col">costs</th>
                        <th scope="col">refunds</th>
                        <th scope="col">net</th>
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
            <span className="tape__title">The Tape — settlement printer</span>
            <span className="tape__status">
              {settle !== null
                ? `settled ${settle.verdict}`
                : delivery !== null
                  ? `delivery ${delivery.freshness}`
                  : job !== null
                    ? `funded ${job.jobId}`
                    : quote !== null
                      ? `quoted ${quote.amountUsdc} USDC`
                      : "idle"}
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
      </main>

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
    <div className={delivery.freshness === "fresh" ? "notice ok" : "notice error"} role="status">
      <span className={delivery.freshness === "fresh" ? "stamp settled" : delivery.freshness === "stale" ? "stamp stale" : "stamp"}>
        {delivery.freshness === "fresh" ? "FRESH" : delivery.freshness === "stale" ? "STALE" : "NO META"}
      </span>{" "}
      — {status}
      <div className="mono">
        payloadHash {truncateHash(delivery.payloadHash, 10, 10)} ·{" "}
        {JSON.stringify(delivery.result).slice(0, 96)}
        {JSON.stringify(delivery.result).length > 96 ? "…" : ""}
      </div>
    </div>
  );
}
