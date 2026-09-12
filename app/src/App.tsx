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
import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { useAccount, useConnect } from "wagmi";
import { createPublicClient, http, keccak256, toBytes, type PublicClient } from "viem";
import { arcChain } from "./wagmi";
import { env, hasAlchemyKey, hasGraphKey } from "./env";
import { CONFIG, defaultQueryFor, type DatasetConfig } from "./config";
import { arcWalletClient, ensureArcChain } from "./arc";
import { explorerUrl, truncateHash, usdc6 } from "./format";
import { fetchPnl, type PnlRow, type RefundEvent } from "./pnl";
import { createEnsTextReader, type EnsTextReader } from "../../mcp/src/ens";
import { gatewayQuery, stripMeta } from "../../mcp/src/gateway";
import { defaultChainHeadResolver } from "../../mcp/src/chainhead";
import { createJobWithSla, ERC8183, setUsdcAddress, usdcAddress, USDC_ABI, type Sla } from "../../agent/escrow";
import { verifyDelivery } from "../../mcp/src/escrow";

// Chain-specific USDC (VITE_USDC_ADDRESS) — mainnet override for the escrow module.
if (env.usdcAddress !== undefined && /^0x[0-9a-fA-F]{40}$/.test(env.usdcAddress)) {
  setUsdcAddress(env.usdcAddress as `0x${string}`);
}

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
          ? `ENS_RESOLUTION_FAILED: ${missing.join(", ")} not set on ${CONFIG.ens} (sepolia ENSv2); refusing to quote a hard-coded value`
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

/**
 * ENSv2 hierarchical namespace: a dataset may publish its own records at
 * `<dataset>.openbook.eth`, served by the parent's subregistry. The most
 * specific records win (per-dataset pricing/SLA); the parent storefront is
 * the fallback. Mirrors the MCP's getQuote resolution.
 */
async function quoteWithNamespace(
  dataset: DatasetConfig,
  records: StorefrontState["records"],
  readEnsText: EnsTextReader,
): Promise<QuoteView> {
  const subname = `${dataset.id}.${CONFIG.ens}`;
  const [subPrice, subSla] = await Promise.all([
    readEnsText(subname, "svc.price").catch(() => null),
    readEnsText(subname, "svc.sla").catch(() => null),
  ]);
  const merged = records.map((record) => {
    if (record.key === "svc.price" && subPrice !== null) return { ...record, value: subPrice };
    if (record.key === "svc.sla" && subSla !== null) return { ...record, value: subSla };
    return record;
  });
  return quoteFromRecords(dataset, merged);
}

/** Tooltip — the page's vocabulary for judges with zero context. */
/**
 * Tooltip — wrap the KEYWORD (`<Tip text="…">SLA</Tip>`): it renders with a
 * dashed underline and reveals the note on hover/focus. No "?" badges.
 */
function Tip({ text, children }: { text: string; children?: ReactNode }): JSX.Element {
  return (
    <span className="tip" data-tip={text} role="note" aria-label={text} tabIndex={0}>
      {children ?? "?"}
    </span>
  );
}

type StepStateAttr = "active" | "done" | "failed" | "blocked" | "idle";

/** One step card — the guided spine. */
function StepCard(props: {
  n: number;
  state: StepStateAttr;
  stateLabel?: string;
  title: string;
  what: string;
  why?: string;
  children: React.ReactNode;
}): JSX.Element {
  const stateLabel =
    props.stateLabel ??
    (props.state === "done"
      ? "done"
      : props.state === "active"
        ? "next"
        : props.state === "failed"
          ? "failed"
          : props.state === "blocked"
            ? "needs setup"
            : "waiting");
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
  const [refundEvents, setRefundEvents] = useState<RefundEvent[]>([]);
  const [pnlMeta, setPnlMeta] = useState<number | null>(null);
  const [pnlHead, setPnlHead] = useState<number | null>(null);
  const [pnlError, setPnlError] = useState<string | null>(null);
  const [pnlUpdatedAt, setPnlUpdatedAt] = useState<Date | null>(null);
  const [pnlNonce, setPnlNonce] = useState(0);
  const [payError, setPayError] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [settleError, setSettleError] = useState<string | null>(null);

  const dataset = useMemo(
    () => CONFIG.datasets.find((d) => d.id === datasetId) ?? CONFIG.datasets[0],
    [datasetId],
  );
  const readEnsText = useMemo<EnsTextReader>(
    () => createEnsTextReader({ rpcUrl: env.sepoliaRpc }),
    [],
  );
  const publicClient = useMemo<PublicClient>(
    () => createPublicClient({ chain: arcChain, transport: http(env.arcRpc) }),
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

  // P&L ledger: the open-book subgraph via Studio — public endpoint, no key.
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPnl(env.graphKey), publicClient.getBlockNumber()])
      .then(([result, head]) => {
        if (cancelled) return;
        setPnl(result.rows);
        setRefundEvents(result.refundEvents);
        setPnlMeta(result.metaBlock);
        setPnlHead(Number(head));
        setPnlError(null);
        setPnlUpdatedAt(new Date());
      })
      .catch((error) => {
        if (!cancelled) setPnlError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient, pnlNonce]);

  // The brand is a printer, not a screenshot: the ledger refreshes itself every
  // 15s (and immediately when the tab comes back), so rows, block deltas and the
  // "updated" stamp move without a click. Every 2026 winner's live surface does
  // this — Atlas polls 41 requests, AgentGate shows "updated HH:MM:SS" + ↺.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setPnlNonce((n) => n + 1);
    }, 15_000);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") setPnlNonce((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const flowBusy = paying || querying || settling;

  // Switching datasets invalidates the previous quote/delivery/verdict — the pay
  // button must never fund the previous dataset's price. Refused while a flow is in
  // flight (paying/querying/settling): a funded job or a half-signed tx must never be
  // orphaned by a stray click.
  const handleDatasetChange = (nextId: string): void => {
    if (flowBusy) return;
    setDatasetId(nextId);
    setQuote(null);
    setDelivery(null);
    setSettle(null);
    setSettleError(null);
    setQueryError(null);
    setPayError(null);
  };

  const handleQuote = (): void => {
    if (ens === null || ens.hardFail !== null) return;
    quoteWithNamespace(dataset, ens.records, readEnsText)
      .then((next) => setQuote(next))
      .catch((error) => {
        setEns({ ...ens, hardFail: error instanceof Error ? error.message : String(error) });
      });
  };

  // A tester's first real blocker is funding: read the wallet's Arc USDC up
  // front so the faucet guidance appears BEFORE a failed payment, not after.
  useEffect(() => {
    if (!address) {
      setUsdcBalance(null);
      setBalanceError(null);
      return;
    }
    let cancelled = false;
    publicClient
      .readContract({
        address: usdcAddress(),
        abi: USDC_ABI,
        functionName: "balanceOf",
        args: [address],
      })
      .then((balance) => {
        if (cancelled) return;
        setUsdcBalance(balance as bigint);
        setBalanceError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        // Never hide a failed read: a caller who cannot see their balance must be
        // told why, or the faucet guidance silently disappears on an RPC hiccup.
        setUsdcBalance(null);
        setBalanceError(error instanceof Error ? error.message.slice(0, 60) : String(error).slice(0, 60));
      });
    return () => {
      cancelled = true;
    };
  }, [address, publicClient, job]);

  const handlePay = async (): Promise<void> => {
    if (!address || quote === null || dataset === undefined) return;
    setPaying(true);
    setPayError(null);
    try {
      await ensureArcChain();
      const trace: string[] = [];
      const wallet = arcWalletClient(address, trace);
      // The SLA floor is a block on the DATASET's chain (the data lives on
      // Arbitrum/Ethereum), never on Arc — the delivery's metaBlock and this
      // floor must share a chain or the freshness gate is vacuous.
      let head = 0;
      if (hasAlchemyKey) {
        try {
          head = await defaultChainHeadResolver(env.alchemyKey)(dataset.chain);
        } catch {
          head = 0;
        }
      }
      const sla: Sla = {
        minBlock: head - quote.minBlockLag,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPayError(
        /reject|denied/i.test(message)
          ? "Signature rejected. Approve the transactions in your wallet to fund the job, or try again."
          : /insufficient|gas|fund/i.test(message)
            ? "Your wallet needs testnet USDC. USDC pays gas on Arc. Free at faucet.circle.com (pick Arc Testnet, paste your address)."
            : `Payment failed: ${message.slice(0, 140)}`,
      );
    } finally {
      setPaying(false);
    }
  };

  const handleQuery = async (): Promise<void> => {
    if (!hasGraphKey || dataset === undefined) return;
    setQuerying(true);
    setQueryError(null);
    try {
      const { data, meta } = await gatewayQuery({
        key: env.graphKey,
        subgraphId: dataset.subgraphId,
        query: queryText,
      });
      // Freshness reference: the dataset's own chain head (Alchemy). The
      // Gateway's _meta has no chainHeadBlock field (live probe 2026-09-09).
      let head: number | null = null;
      if (hasAlchemyKey) {
        try {
          head = await defaultChainHeadResolver(env.alchemyKey)(dataset.chain);
        } catch {
          head = null;
        }
      }
      const freshness: DeliveryState["freshness"] =
        meta.block === null || head === null
          ? "no-meta"
          : head - meta.block <= dataset.freshness.maxAge
            ? "fresh"
            : "stale";
      setDelivery({
        dataset,
        payloadHash: keccak256(toBytes(JSON.stringify(stripMeta(data)))),
        metaBlock: meta.block,
        chainHeadBlock: head,
        freshness,
        result: stripMeta(data),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setQueryError(
        /auth|key|401|403|not found/i.test(message)
          ? "The Graph gateway rejected the key. Check VITE_GRAPH_GATEWAY_KEY (a fresh Studio key, setup notes §4)."
          : `Query failed: ${message.slice(0, 140)}`,
      );
    } finally {
      setQuerying(false);
    }
  };

  const handleSettle = async (): Promise<void> => {
    if (!address || job === null || delivery === null || delivery.metaBlock === null) return;
    setSettleError(null);
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettleError(
        /reject|denied/i.test(message)
          ? "Signature rejected. Approve in your wallet to settle, or retry."
          : `Settlement failed: ${message.slice(0, 140)}`,
      );
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
        ? { text: `SETTLED job ${job?.jobId ?? ""} · seller paid${settle.txHash ? ` · ${truncateHash(settle.txHash)}` : ""}`, kind: "settled" as const }
        : { text: `REFUNDED · ${settle.reason ?? "SLA miss"}${settle.txHash ? ` · ${truncateHash(settle.txHash)}` : ""}`, kind: "refunded" as const },
    );
  } else if (delivery !== null) {
    tapeEvents.push(
      delivery.freshness === "fresh"
        ? { text: `DELIVERED block ${delivery.metaBlock} · fresh`, kind: "settled" as const }
        : delivery.freshness === "stale"
          ? { text: `DELIVERED block ${delivery.metaBlock} · STALE · gate refuses to charge, refund armed`, kind: "stale" as const }
          : { text: "DELIVERED · NO META · freshness cannot be attested", kind: "idle" as const },
    );
  } else if (job !== null) {
    tapeEvents.push({ text: `FUNDED job ${job.jobId} · SLA minBlock ${job.minBlock}`, kind: "idle" as const });
  } else if (quote !== null) {
    tapeEvents.push({ text: `QUOTED ${quote.amountUsdc} USDC/query · SLA lag ${quote.minBlockLag} · latency ${quote.maxLatencyMs}ms`, kind: "idle" as const });
  } else {
    tapeEvents.push({ text: "tape idle · awaiting settlement activity", kind: "idle" as const });
  }

  // chain-derived lines: refunds the subgraph indexed, so the tape prints events
  // that happened outside this tab too — and moves on its own once polled.
  for (const ev of refundEvents.slice(0, 3)) {
    tapeEvents.push({
      text: `REFUNDED job ${ev.jobId} · ${ev.reason} · indexed onchain`,
      kind: "refunded" as const,
    });
  }

  return (
    <>
      <header className="masthead">
        <div className="walletblock" aria-label="wallet">
          {isConnected ? (
            <span className="addr" title="connected wallet">{truncateHash(address ?? "")}</span>
          ) : (
            connectors.map((connector) => (
              <button key={connector.uid} className="ghost" onClick={() => connect({ connector })}>
                Connect wallet
              </button>
            ))
          )}
        </div>
        <div className="nameblock">
          <span className="brandmark" aria-hidden="true">
            ▤ OB
          </span>
          <div>
            <h1>
              OpenBook<span className="ledger-no">the agent's settlement ledger</span>
            </h1>
            <p className="tagline">
              an autonomous agent selling freshness-guaranteed onchain data. Every payment
              carries an{" "}
              <Tip text="Service-level agreement: a freshness promise attached to the payment itself. Miss the freshness window and the payment refunds itself onchain, with nobody asked to approve it.">SLA</Tip>
              , and <span className="accent">every miss refunds itself onchain</span>
            </p>
          </div>
        </div>
        <div className="chainbadges">
          <span>arc · {arcChain.id}</span>
          <span>ensv2 · sepolia</span>
          <span>the graph · gateway</span>
          <span>{CONFIG.ens}</span>
        </div>
      </header>

      <main>
        <p className="intro">
          <strong>First time here? Start with steps 1 and 2.</strong> The menu, the live quote and
          the agent's books all read from ENS and the public subgraph with <em>no wallet and no
          keys</em>. Step 3 (paying) needs an EVM wallet and free testnet USDC from{" "}
          <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
            faucet.circle.com
          </a>{" "}
          (pick Arc Testnet). Step 4 lets you watch the SLA verdict settle onchain.
        </p>
        <p className="envline" aria-label="environment status">
          <span>
            <span className={hasGraphKey ? "dot yes" : "dot no"} aria-hidden="true" />
            <Tip text="query_dataset runs through The Graph Gateway, which needs a free API key. The quote and the books work without it. Devs: set VITE_GRAPH_GATEWAY_KEY.">
              {hasGraphKey ? "live delivery: on" : "live delivery: needs a key"}
            </Tip>
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
              stateLabel={ensLoading ? "resolving…" : undefined}
              title="See what's for sale"
              what="The storefront lives on ENSv2 (Sepolia): menu, price, SLA, payee."
              why="The storefront is a name, not a file. openbook.eth publishes its menu, price and service-level promise as live ENSv2 records. If a record is missing, nothing gets priced: the agent will not quote a hard-coded value."
            >
              {ensLoading && (
                <p className="notice" role="status">
                  Reading the live records of {CONFIG.ens} on Sepolia…
                </p>
              )}
              {ens !== null && ens.hardFail !== null && (
                <>
                  <div className="notice hardfail">
                    <strong>Storefront isn't set up yet.</strong> The agent won't guess a price. It
                    refuses to trade until its ENSv2 records exist. No name, no commerce.
                    <div className="mono">{ens.hardFail}</div>
                  </div>
                  <div className="setupcard">
                    <span className="kicker">60-second setup</span>
                    <strong>To watch OpenBook sell:</strong>
                    <ol>
                      <li>
                        Register the name and records with{" "}
                        <Tip text="The setup script needs a Sepolia key with test ETH + free MockUSDC. Details in the setup notes."><code>scripts/ens/setup.sh</code></Tip>{" "}
                        (writes menu, price, SLA, payee).
                      </li>
                      <li>Reload this page and the table below fills with live records.</li>
                      <li>Step 2 unlocks: prices come from the name, not from this app.</li>
                    </ol>
                  </div>
                </>
              )}
              {ens !== null && ens.hardFail === null && (
                <div className="notice ok">
                  <strong>Storefront live.</strong> Price, SLA and payee resolved from the ENSv2
                  records on {CONFIG.ens}. These are the values the agent is bound by, read off the
                  chain.
                </div>
              )}
              <table className="ledger" aria-label="ENS storefront records">
                <thead>
                  <tr>
                    <th scope="col">
                      <Tip text="ENSv2 (Sepolia) lets the agent publish a structured menu: what it sells, at what price, under what SLA, and who gets paid.">ENSv2 record</Tip>
                    </th>
                    <th scope="col">live value</th>
                  </tr>
                </thead>
                <tbody>
                  {ens?.records.map((record) => (
                    <tr key={record.key}>
                      <td className="key">{record.key}</td>
                      <td className={record.value === null ? "val missing" : "val"}>
                        {record.value ?? "not set"}
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
              what="Quote the chosen dataset. The price comes straight from the ENSv2 records."
              why="Ask first, pay later. The agent quotes from its own ENSv2 records (price and SLA), so you know what you're buying before a payment moves."
            >
              <div className="field">
                <label htmlFor="dataset">
                  <Tip text="Two standardized Messari subgraphs. The same query shape runs on both, which is the point of the standard.">dataset</Tip>
                </label>
                <select
                  id="dataset"
                  value={datasetId}
                  disabled={flowBusy}
                  aria-describedby="dataset-lock"
                  onChange={(event) => handleDatasetChange(event.target.value)}
                >
                  {CONFIG.datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.id} · {d.description}
                    </option>
                  ))}
                </select>
                {flowBusy && (
                  <p className="caption" id="dataset-lock">
                    locked while a payment is in flight, so the funded job stays in view
                  </p>
                )}
              </div>
              {quote === null ? (
                <>
                  <button
                    className="primary"
                    disabled={!ensDone}
                    onClick={handleQuote}
                    aria-describedby="quote-caption"
                  >
                    Get quote
                  </button>
                  {!ensDone && (
                    <p className="caption" id="quote-caption">
                      Needs the storefront (step 1). See the card above.
                    </p>
                  )}
                </>
              ) : (
                <div className="notice ok" role="status">
                  <strong>{quote.amountUsdc} USDC/query</strong>, quoted live from the ENS records
                  <button
                    type="button"
                    className="ob-refresh"
                    onClick={handleQuote}
                    aria-label="re-read the quote from the ENS records"
                  >
                    ↺ re-quote
                  </button>
                  <div className="mono">
                    SLA: min block lag {quote.minBlockLag} · latency {quote.maxLatencyMs}ms · payee{" "}
                    {truncateHash(quote.payee)}
                  </div>
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                {isConnected ? (
                  <button
                    className="primary"
                    disabled={quote === null || paying || job !== null}
                    onClick={handlePay}
                    aria-describedby="pay-caption"
                  >
                    {paying ? "signing escrow txs…" : job !== null ? "job funded ✓" : `Pay ${quote?.amountUsdc ?? "0.10"} USDC into escrow`}
                  </button>
                ) : (
                  <p className="caption">
                    Paying needs a wallet.{" "}
                    {connectors.map((connector) => (
                      <button key={connector.uid} className="ghost" onClick={() => connect({ connector })}>
                        Connect {connector.name}
                      </button>
                    ))}{" "}
                    (or use the Connect wallet button up top). Nothing leaves the escrow until the SLA is checked.
                  </p>
                )}
                {quote === null && isConnected && (
                  <p className="caption" id="pay-caption">
                    Quote first. The price comes from the agent's ENS records.
                  </p>
                )}
                {isConnected && quote !== null && usdcBalance !== null && usdcBalance < BigInt(quote.amount) && (
                  <div className="notice" role="status" style={{ marginTop: 10 }}>
                    <strong>Your wallet needs testnet USDC to pay.</strong> USDC is also the gas token on Arc.
                    Free faucet:{" "}
                    <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                      faucet.circle.com ↗
                    </a>{" "}
                    (pick <em>Arc Testnet</em>, paste your address). The quote and the books above
                    work without it.
                  </div>
                )}
                {isConnected && balanceError !== null && (
                  <p className="caption" role="status" style={{ marginTop: 8 }}>
                    could not read your Arc USDC balance ({balanceError}). The pay button still works; if
                    payment fails on funds, use{" "}
                    <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                      faucet.circle.com ↗
                    </a>
                  </p>
                )}
                {payError !== null && (
                  <div className="notice error" role="alert">
                    <strong>Payment didn't go through.</strong> {payError}
                  </div>
                )}
              </div>
              {job !== null && (
                <div className="notice ok" role="status">
                  <strong>Funded. The SLA is now onchain.</strong> job {job.jobId} on{" "}
                  <Tip text="Escrow (ERC-8183): USDC sits in a neutral contract, released to the agent only when the delivery passes the SLA check, or refunded to you automatically if it fails or the deadline lapses.">ERC-8183</Tip>{" "}
                  ({truncateHash(ERC8183)}). The agent has committed to deliver data no older than
                  block {job.minBlock}, or refund you automatically.
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
              what="One live query through The Graph gateway, with its freshness timestamp."
              why="Every answer carries a proof of freshness, the _meta block. If the data is older than the SLA allows, the agent refuses to charge for it."
            >
              {!hasGraphKey && (
                <div className="setupcard">
                  <span className="kicker">one free key, 60 seconds</span>
                  <strong>To watch live data:</strong>
                  <ol>
                    <li>
                      Get a free key at{" "}
                      <Tip text="The Studio key gates Gateway queries and the hosted Subgraph MCP. One key covers both."><a href="https://thegraph.com/studio" target="_blank" rel="noreferrer">thegraph.com/studio</a></Tip>{" "}
                      (account → API keys).
                    </li>
                    <li>
                      Add it to <code>app/.env.local</code> as <code>VITE_GRAPH_GATEWAY_KEY</code>.
                    </li>
                    <li>Reload and this panel runs the live query.</li>
                  </ol>
                </div>
              )}
              <div className="field">
                <label htmlFor="query">
                  <Tip text="The exact query the agent runs against the pinned Messari subgraph. You can edit it live.">graphql</Tip>
                </label>
                <textarea id="query" value={queryText} onChange={(event) => setQueryText(event.target.value)} />
              </div>
              <button
                className="primary"
                disabled={!hasGraphKey || querying}
                onClick={handleQuery}
                aria-describedby={!hasGraphKey ? "query-caption" : undefined}
              >
                {querying ? "querying…" : "Pull fresh data"}
              </button>
              {!hasGraphKey && (
                <p className="caption" id="query-caption">
                  Needs a Graph key. See the setup card above.
                </p>
              )}
              {queryError !== null && (
                <div className="notice error" role="alert">
                  <strong>Query failed.</strong> {queryError}
                </div>
              )}

              <FreshnessRuler delivery={delivery} minBlock={job?.minBlock ?? null} />
              {delivery !== null && <DeliveryResult delivery={delivery} />}
            </StepCard>

            <StepCard
              n={4}
              state={stepState(step.settle)}
              title="Settle or refund"
              what="The verdict is deterministic open code: fresh data settles, stale data refunds."
              why="The payment itself checks the SLA. The agent is never paid for stale data, and the buyer never has to ask for a refund: it happens onchain."
            >
              <p style={{ marginTop: 0 }}>
                <button
                  className={delivery !== null && delivery.freshness === "stale" ? "danger" : "primary"}
                  disabled={!isConnected || job === null || delivery === null || settling}
                  onClick={handleSettle}
                  aria-describedby={
                    !isConnected || job === null || delivery === null ? "settle-caption" : undefined
                  }
                >
                  {settling
                    ? "settling…"
                    : delivery !== null && delivery.freshness === "stale"
                      ? "Verify & refund stale delivery"
                      : "Verify & settle delivery"}
                </button>
              </p>
              {(!isConnected || job === null || delivery === null) && (
                <p className="caption" id="settle-caption">
                  Needs:{" "}
                  {[
                    !isConnected && "a connected wallet",
                    job === null && "a funded job (step 2)",
                    delivery === null && "fresh data pulled (step 3)",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {settleError !== null && (
                <div className="notice error" role="alert">
                  <strong>Settlement didn't complete.</strong> {settleError}
                </div>
              )}
              {settle !== null && (
                <div className={settle.verdict === "APPROVE" ? "notice ok" : "notice error"} role="status">
                  <span className={settle.verdict === "APPROVE" ? "stamp settled" : "stamp refunded"}>
                    {settle.verdict === "APPROVE" ? "SETTLED" : "REFUNDED"}
                  </span>{" "}
                  <strong>
                    {settle.verdict === "APPROVE"
                      ? "seller paid, SLA met"
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
            <section
              className="stepcard"
              aria-busy={pnl === null && pnlError === null}
              data-state={pnlError !== null ? "failed" : pnl !== null && pnl.length > 0 ? "done" : "idle"}
            >
              <div className="stepcard__head">
                <span className="stepno" aria-hidden="true">
                  P
                </span>
                <div className="steptitle">
                  <h2 id="pnl-title">The agent's books</h2>
                  <p className="what">
                    Running P&amp;L, onchain and queryable. Every settlement lands here.
                  </p>
                </div>
                <span className="stepstate">
                  {pnlError !== null ? "error" : pnl === null ? "loading…" : pnl.length > 0 ? "live" : "waiting"}
                </span>
              </div>
              <div className="body">
                {pnlError !== null && <p className="notice error">{pnlError}</p>}
                {pnl !== null && pnl.length === 0 && (
                  <p className="notice">no settlement rows yet. The ledger fills as jobs complete.</p>
                )}
                {pnl !== null && pnl.length > 0 && (
                  <ul className="running">
                    <li>
                      <span className="cap">revenue</span>
                      <span className="fig settled hero">{usdc6(sum(pnl, (r) => r.revenue))} USDC</span>
                    </li>
                    <li>
                      <span className="cap">costs</span>
                      <span className="fig">{usdc6(sum(pnl, (r) => r.costs))} USDC</span>
                    </li>
                    <li>
                      <span className="cap">refunds</span>
                      <span className="fig refunded hero">{usdc6(sum(pnl, (r) => r.refunds))} USDC</span>
                    </li>
                    <li>
                      <span className="cap">net</span>
                      <span className="fig net hero">{usdc6(sum(pnl, (r) => r.net))} USDC</span>
                    </li>
                  </ul>
                )}
                {refundEvents.length > 0 && (
                  <div className="refunds-live">
                    <p className="cap">money moved backwards. Watch one (no wallet needed).</p>
                    <ul className="running">
                      {refundEvents.map((ev) => (
                        <li key={ev.id}>
                          <span className="cap">job {ev.jobId} · {ev.reason}</span>
                          <a
                            className="fig refunded"
                            href={explorerUrl(ev.id.slice(0, 66))}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Refunded ↗
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="statline">
                  <span className={pnlError !== null ? "ob-live off" : "ob-live"} aria-hidden="true" />
                  live · _meta block {pnlMeta ?? "…"} · chain head {pnlHead ?? "…"}
                  {pnlMeta !== null && pnlHead !== null
                    ? ` (Δ ${Math.max(0, pnlHead - pnlMeta)} blocks behind head)`
                    : ""}{" "}
                  · daily rows {pnl !== null ? String(pnl.length) : "…"}
                  {pnlUpdatedAt !== null && (
                    <>
                      {" · "}
                      <span className="live-stamp">updated {pnlUpdatedAt.toLocaleTimeString()}</span>
                      <button
                        type="button"
                        className="ob-refresh"
                        onClick={() => setPnlNonce((n) => n + 1)}
                        aria-label="refresh the agent's books"
                      >
                        ↺ refresh
                      </button>
                    </>
                  )}
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
                  <p className="notice">
                    {pnl === null
                      ? "loading the ledger…"
                      : "daily rows appear here once settlements land."}
                  </p>
                )}
              </div>
            </section>
          </aside>
        </div>

        <div className="tape" aria-label="settlement tape: freshness scale and printed events">
          <div className="tape__head">
            <span className="tape__title">The tape: settlement printer</span>
            <span className="tape__status">
              <span
                className={
                  settle !== null
                    ? "ob-live"
                    : delivery !== null && delivery.freshness === "stale"
                      ? "ob-live stale"
                      : "ob-live off"
                }
                aria-hidden="true"
              />
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
            {delivery !== null && (
              <div className="tape__scale">
                <FreshnessRuler delivery={delivery} minBlock={job?.minBlock ?? null} />
                <div className="tape__ticks">
                  <span>SLA floor</span>
                  <span>delivered ▸ chain head</span>
                </div>
              </div>
            )}
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
          to the buyer (
          <Tip text="claimRefund: if the agent's deadline lapses with no delivery, anyone can trigger the refund, so the buyer never has to chase the agent.">claimRefund</Tip>
          )
        </span>
        <a
          href="https://github.com/Aliserag/OpenBook/blob/main/docs/architecture.md"
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
      ? `${delta} block${delta === 1 ? "" : "s"} behind chain head, within SLA maxAge ${delivery.dataset.freshness.maxAge}`
      : delivery.freshness === "stale"
        ? `${delta} block${delta === 1 ? "" : "s"} behind chain head, beyond SLA maxAge ${delivery.dataset.freshness.maxAge}. The gate refuses to charge; verify refunds`
        : "no _meta in the response, so freshness cannot be attested";
  return (
    <div className={delivery.freshness === "fresh" ? "notice ok" : "notice error"} role="status">
      <span className={delivery.freshness === "fresh" ? "stamp settled" : delivery.freshness === "stale" ? "stamp stale" : "stamp"}>
        {delivery.freshness === "fresh" ? "FRESH" : delivery.freshness === "stale" ? "STALE" : "NO META"}
      </span>{" "}
      {status}
      <div className="mono">
        payloadHash {truncateHash(delivery.payloadHash, 10, 10)} ·{" "}
        {JSON.stringify(delivery.result).slice(0, 96)}
        {JSON.stringify(delivery.result).length > 96 ? "…" : ""}
      </div>
    </div>
  );
}
