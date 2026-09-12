/**
 * Tour mode (T12) — the `#tour` hash route: the app's existing 5-step
 * narrative (resolve → quote → pay → deliver → settle) as a scripted walk over
 * the new shell. Every step card carries the console command that reproduces
 * it; each CTA dispatches through the console registry (`ens show` /
 * `quote <id>` / `buy <id>` / `deliver` / `settle`) and prints the console's
 * OWN output through the same `renderResult` pipeline the dock uses — the
 * command code and the renderers are shared, never re-implemented here.
 *
 * Derivation: a thin view over the same `deriveSteps` state machine the main
 * journal uses. The tour owns a `StepState` of its own, fed by (1) the live
 * storefront read (`resolveStorefront`) and subname-first quote
 * (`quoteWithNamespace` — both existing App derivations), and (2) the act
 * commands' module-level job state (`getActJob`), which is the single shared
 * lifecycle the console's buy/deliver/settle also mutate. No chain call
 * exists in this file.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { CONFIG, type DatasetConfig } from "../config";
import { env, hasGraphKey } from "../env";
import { demoAddress, getPublicClient, pickSigner } from "../data/chain";
import { truncateHash } from "../format";
import { createEnsTextReader } from "../../../mcp/src/ens";
import {
  StepCard,
  chipClass,
  deriveSteps,
  quoteFromRecords,
  quoteWithNamespace,
  resolveStorefront,
  type DeliveryState,
  type QuoteView,
  type SettleState,
  type StepKind,
  type StepState,
  type StepStateAttr,
  type StorefrontState,
} from "../App";
import { dispatch, type CommandContext, type CommandResult } from "../console/registry";
import { renderResult } from "../console/renderers";
import { getActJob } from "../console/commands/act";

type StepId = "resolve" | "quote" | "pay" | "deliver" | "settle";

interface TourRun {
  cmd: string;
  running: boolean;
  result: CommandResult | null;
}

const EMPTY_RUNS: Record<StepId, TourRun | null> = {
  resolve: null,
  quote: null,
  pay: null,
  deliver: null,
  settle: null,
};

/** The console command that reproduces a step — the CTA's only predicate. */
function ctaFor(step: StepId, dataset: DatasetConfig): string {
  if (step === "resolve") return "ens show";
  if (step === "quote") return `quote ${dataset.id}`;
  if (step === "pay") return `buy ${dataset.id}`;
  if (step === "deliver") return "deliver";
  return "settle";
}

/**
 * The settle command prints its verdict as kv rows. A step counts as done only
 * when a `verdict` row is present AND no ✗ row sits on the signing/attest/
 * settle legs (until T13 the SlaHook reverts NotAttester — that kv has no
 * verdict row, so the chip stays actionable and the receipt names the revert).
 */
function settledFromResult(result: CommandResult): SettleState | null {
  if (result.render !== "kv") return null;
  const rows = result.data.rows;
  const errored = rows.some(
    ([key, value]) => (key === "signer" || key === "attest" || key === "settle") && value.startsWith("✗"),
  );
  const verdict = rows.find(([key]) => key === "verdict")?.[1];
  if (verdict === undefined || errored) return null;
  return {
    verdict,
    reason: rows.find(([key]) => key === "reason")?.[1],
    minBlock: 0,
  };
}

/**
 * The act commands' shared lifecycle as a StepState patch — read fresh from the
 * module state every call, never cached. `delivery` comes ONLY from the
 * current job (a re-buy has no payload yet — an old payload must never show as
 * delivered), `settle` clears when the job id changes (an old verdict must
 * never stamp a new lifecycle), and a TERMINAL record (settled/refunded, kept
 * on record by the settle command) derives BOTH step 4 and step 5 as done —
 * stable across reloads, no flicker when the walk completes.
 */
export function actJobView(prev: StepState): StepState {
  const job = getActJob();
  if (job === null) return { ...prev, job: null, delivery: null };
  const jobDataset = CONFIG.datasets.find((d) => d.id === job.datasetId) ?? null;
  const delivery: DeliveryState | null =
    job.payloadHash !== undefined && job.metaBlock !== undefined && jobDataset !== null
      ? {
          dataset: jobDataset,
          payloadHash: job.payloadHash,
          metaBlock: job.metaBlock,
          chainHeadBlock: null,
          freshness: "no-meta",
          result: null,
        }
      : null;
  const terminal = job.outcome !== undefined;
  const freshLifecycle = job.jobId !== prev.job?.jobId;
  return {
    ...prev,
    job: { jobId: job.jobId, minBlock: job.minBlock, hashes: [] },
    delivery,
    settle: terminal
      ? { verdict: job.outcome === "settled" ? "APPROVE" : "REJECT", minBlock: 0 }
      : freshLifecycle
        ? null
        : prev.settle,
  };
}

/** `#tour` (exactly) → on-route; anything else → null (mirrors parseTheaterHash). */
export function parseTourHash(hash: string): boolean {
  return /^#tour$/.test(hash.trim());
}

/** Mount anywhere in App: watches location.hash and renders the tour while on the route. */
export function TourRoute(): JSX.Element | null {
  const [on, setOn] = useState<boolean>(() => parseTourHash(window.location.hash));
  useEffect(() => {
    const onHash = (): void => setOn(parseTourHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (!on) return null;
  return (
    <Tour
      onClose={() => {
        window.location.hash = "#";
      }}
    />
  );
}

export function Tour({ onClose }: { onClose: () => void }): JSX.Element {
  const [ens, setEns] = useState<StorefrontState | null>(null);
  const [ensLoading, setEnsLoading] = useState(true);
  const [datasetId, setDatasetId] = useState(CONFIG.datasets[0]?.id ?? "");
  const [state, setState] = useState<StepState>({
    quote: null,
    job: null,
    paying: false,
    delivery: null,
    querying: false,
    settling: false,
    settle: null,
  });
  const [runs, setRuns] = useState<Record<StepId, TourRun | null>>(EMPTY_RUNS);

  const dataset = useMemo(
    () => CONFIG.datasets.find((d) => d.id === datasetId) ?? CONFIG.datasets[0],
    [datasetId],
  );
  const readEnsText = useMemo(
    () => createEnsTextReader({ rpcUrl: env.sepoliaRpc }),
    [],
  );

  // The console's command context — same shape the dock itself builds.
  const ctx = useMemo<CommandContext>(
    () => ({
      publicClient: getPublicClient(),
      signer: {
        kind: pickSigner({ demoKey: import.meta.env.VITE_DEMO_BUYER_KEY as string | undefined }),
        address: demoAddress(),
      },
      config: CONFIG,
      navigate: (route: string) => {
        window.location.hash = route;
      },
    }),
    [],
  );

  // Step 1: the live storefront — the existing deriveSteps inputs, read once.
  useEffect(() => {
    let cancelled = false;
    setEnsLoading(true);
    resolveStorefront(readEnsText)
      .then((next) => {
        if (!cancelled) setEns(next);
      })
      .catch((error) => {
        if (cancelled) return;
        setEns({
          records: [],
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

  // Step 2: the live quote, derived from the same records the main page prices
  // against (subname-first, per the price-coherence ruling). If the extra
  // subname ENS reads fail on a flaky public RPC, fall back to the parent
  // records already resolved so the walk stays live — the CTA's console
  // receipt is the authoritative re-run.
  useEffect(() => {
    if (ens === null || ens.hardFail !== null) return;
    let cancelled = false;
    const fallback = async (): Promise<QuoteView | null> => {
      try {
        return quoteFromRecords(dataset, ens.records);
      } catch {
        return null;
      }
    };
    quoteWithNamespace(dataset, ens.records, readEnsText)
      .catch(fallback)
      .then((quote) => {
        if (!cancelled && quote !== null) setState((prev) => ({ ...prev, quote }));
      });
    return () => {
      cancelled = true;
    };
  }, [dataset, ens, readEnsText]);

  // The act commands' shared lifecycle, derived FRESH at render time (never a
  // mount snapshot): the console dock's buy/deliver/settle mutate the same
  // module state while the tour is open, so pay/deliver chips always read the
  // current job. A (re-)buy starts a new lifecycle: an old job's delivery and
  // verdict must never carry over, so delivery is derived solely from the
  // current job and settle clears when the job id changes.
  const live = actJobView(state);

  // While the tour is open, hash/focus/visibility changes can mean the console
  // acted elsewhere; force a re-render so `live` re-derives the chips.
  useEffect(() => {
    const pulse = (): void => setState((prev) => ({ ...prev }));
    window.addEventListener("hashchange", pulse);
    window.addEventListener("focus", pulse);
    document.addEventListener("visibilitychange", pulse);
    return () => {
      window.removeEventListener("hashchange", pulse);
      window.removeEventListener("focus", pulse);
      document.removeEventListener("visibilitychange", pulse);
    };
  }, []);

  // CTA: run the step's console command and print the console's own result.
  const runCta = async (step: StepId): Promise<void> => {
    const cmd = ctaFor(step, dataset);
    setRuns((r) => ({ ...r, [step]: { cmd, running: true, result: null } }));
    try {
      const result = await dispatch(cmd, ctx);
      setRuns((r) => ({ ...r, [step]: { cmd, running: false, result } }));
      if (step === "pay") {
        // A (re-)buy opens a fresh lifecycle: any prior verdict belongs to
        // the old job.
        setState((prev) => ({ ...prev, settle: null }));
      }
      if (step === "settle") {
        const settled = settledFromResult(result);
        setState((prev) => (settled === null ? prev : { ...prev, settle: settled }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuns((r) => ({
        ...r,
        [step]: { cmd, running: false, result: { render: "text", data: `${cmd} failed: ${message}` } },
      }));
    }
  };

  // Focus the dialog when it opens and return focus to the entry trigger
  // (the `data-tour-entry` button) when it closes — the same bar the
  // Console/Palette set (focus moves with the surface, never through the
  // background page).
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    // Hand focus back to the entry trigger after the dialog unmounts. The
    // timeout is deliberately NOT cleared: it must run post-removal, once
    // the browser has blurred the detached subtree onto <body>.
    return () => {
      setTimeout(() => {
        const trigger = document.querySelector<HTMLElement>("[data-tour-entry]");
        if (document.activeElement === document.body) trigger?.focus();
      }, 0);
    };
  }, []);

  // Esc closes the tour from anywhere (inputs keep their own keys).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ensDone = ens !== null && ens.hardFail === null;
  const step = deriveSteps(ensDone, ensLoading, live);
  const stepState = (k: StepKind): StepStateAttr =>
    k === "done" ? "done" : k === "failed" ? "failed" : k === "live" ? "active" : "idle";

  const ctaBlock = (id: StepId, label: string): JSX.Element => {
    const run = runs[id];
    const cmd = ctaFor(id, dataset);
    return (
      <div className="tour__cta">
        <span className="tour__cmd">console: <code>{cmd}</code></span>
        {run !== null && run.running ? (
          <span className="tour__running">printing…</span>
        ) : (
          <button type="button" className="primary" onClick={() => void runCta(id)} aria-label={label}>
            run it
          </button>
        )}
        {run !== null && run.result !== null && (
          <div className="tour__receipt" aria-live="polite">
            {renderResult(run.result, (jobId) => {
              window.location.hash = `#theater/${jobId}`;
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <section
      className="tour"
      role="dialog"
      aria-modal="true"
      aria-label="the 5-step walk as console commands"
      tabIndex={-1}
      ref={dialogRef}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="tour__card">
        <header className="tour__head">
          <span className="tour__title">tour · the 5-step walk</span>
          <span className="tour__hint">every button runs the console's own command and prints its receipt · esc closes</span>
          <button type="button" className="tour__close" onClick={onClose} aria-label="close tour (esc)">
            ×
          </button>
        </header>

        <ol className="process tour__process" aria-label="tour progress">
          <li className={chipClass(step.resolve)}>resolve</li>
          <li className={chipClass(step.quote)}>quote</li>
          <li className={chipClass(step.pay)}>pay</li>
          <li className={chipClass(step.deliver)}>deliver</li>
          <li className={chipClass(step.settle)}>settle</li>
        </ol>

        <div className="tour__steps">
          <StepCard
            n={1}
            state={ensDone ? "done" : ensLoading ? "active" : "failed"}
            stateLabel={ensLoading ? "resolving…" : undefined}
            title="The storefront: what's for sale"
            what="This table is the storefront: the datasets on offer, their prices and their SLA, read live from openbook.eth."
            why="The storefront is a name, not a file. openbook.eth publishes its menu, price and service-level promise as live ENSv2 records. If a record is missing, nothing gets priced: the agent will not quote a hard-coded value."
          >
            {ensLoading && (
              <p className="notice" role="status">
                Reading the live records of {CONFIG.ens} on Sepolia…
              </p>
            )}
            {ens !== null && ens.hardFail !== null && (
              <div className="notice hardfail">
                <strong>Storefront isn't set up yet.</strong> The agent won't guess a price. It
                refuses to trade until its ENSv2 records exist.
                <div className="mono">{ens.hardFail}</div>
              </div>
            )}
            {ensDone && (
              <div className="notice ok">
                <strong>Storefront live.</strong> Price, SLA and payee resolved from the ENSv2
                records on {CONFIG.ens}.
              </div>
            )}
            {ens !== null && (
              <table className="ledger" aria-label="ENS storefront records">
                <thead>
                  <tr>
                    <th scope="col">ENSv2 record</th>
                    <th scope="col">live value</th>
                  </tr>
                </thead>
                <tbody>
                  {ens.records.map((record) => (
                    <tr key={record.key}>
                      <td className="key">{record.key}</td>
                      <td className={record.value === null ? "val missing" : "val"}>
                        {record.value ?? "not set"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {ctaBlock(
              "resolve",
              "print the live storefront records through the console (ens show)",
            )}
          </StepCard>

          <StepCard
            n={2}
            state={
              stepState(step.quote) === "idle" && stepState(step.resolve) === "done"
                ? "active"
                : stepState(step.quote)
            }
            title="Get the price"
            what="Quote the chosen dataset. The price comes straight from the ENSv2 records."
            why="Ask first, pay later. The agent quotes from its own ENSv2 records (price and SLA), so you know what you're buying before a payment moves."
          >
            <div className="field">
              <label htmlFor="tour-dataset">dataset</label>
              <select
                id="tour-dataset"
                value={datasetId}
                onChange={(event) => {
                  // The new dataset's quote has not resolved yet: step 2 must
                  // never keep the previous dataset's price/SLA/payee.
                  setState((prev) => ({ ...prev, quote: null }));
                  setDatasetId(event.target.value);
                }}
              >
                {CONFIG.datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id} · {d.description}
                  </option>
                ))}
              </select>
            </div>
            {state.quote !== null ? (
              <div className="notice ok" role="status">
                <strong>{state.quote.amountUsdc} USDC/query</strong>, quoted live from the ENS records
                <div className="mono">
                  SLA: min block lag {state.quote.minBlockLag} · latency {state.quote.maxLatencyMs}ms ·
                  payee {truncateHash(state.quote.payee)}
                </div>
              </div>
            ) : (
              <p className="notice">
                {ensDone ? "pricing from the live records…" : "needs the storefront (step 1)."}
              </p>
            )}
            {ctaBlock("quote", `print the live quote through the console (quote ${dataset.id})`)}
          </StepCard>

          <StepCard
            n={3}
            state={stepState(step.pay)}
            title="Pay into escrow"
            what="Fund an ERC-8183 job at the live ENS price. USDC sits in escrow until the freshness check passes."
            why="The payment sits in escrow until the freshness proof clears. Miss the freshness window and it refunds itself onchain, with nobody asked to approve it. The console's buy prints the whole receipt: dataset, ENS price, signer, balance, SLA floor, job."
          >
            <p className="caption">
              The buy command needs a signer: the demo key (<code>VITE_DEMO_BUYER_KEY</code>, provisioned
              by setup) or a connected wallet. Until the demo key is set, the receipt below prints the
              console's refusal and the recovery path.
            </p>
            {ctaBlock("pay", `fund an escrow job through the console (buy ${dataset.id})`)}
          </StepCard>

          <StepCard
            n={4}
            state={
              live.delivery !== null ? "done" : !hasGraphKey ? "blocked" : stepState(step.deliver)
            }
            stateLabel={!hasGraphKey ? "needs a Graph key" : undefined}
            title="Watch data arrive"
            what="One live query through The Graph gateway, with its freshness timestamp."
            why="Every answer carries a proof of freshness, the _meta block. If the data is older than the SLA allows, the agent refuses to charge for it. In production the buyer is an MCP agent: this is the same query it runs through the server."
          >
            {!hasGraphKey && (
              <p className="caption">
                The Graph gateway needs a free key: <code>VITE_GRAPH_GATEWAY_KEY</code> in{" "}
                <code>app/.env.local</code> (thegraph.com/studio). The deliver command prints its own
                refusal until then: try it.
              </p>
            )}
            {ctaBlock("deliver", "capture and submit the delivery through the console (deliver)")}
          </StepCard>

          <StepCard
            n={5}
            state={stepState(step.settle)}
            title="Settle or refund"
            what="The verdict is deterministic open code: fresh data settles, stale data refunds."
            why="The payment itself checks the SLA: our SlaHook contract reverts a stale completion onchain. The agent is never paid for stale data, the buyer never asks for a refund, and 2% of every settlement routes to the protocol treasury."
          >
            {ctaBlock("settle", "attest and settle through the console (settle)")}
          </StepCard>
        </div>

        <footer className="tour__foot">esc closes · every receipt is the console's own command output</footer>
      </div>
    </section>
  );
}
