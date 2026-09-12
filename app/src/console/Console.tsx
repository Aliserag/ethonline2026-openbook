/**
 * Console — the docked command surface: a receipt PRINTER, not a dark
 * terminal (design ruling, spec §5.3c). Every command prints a perforated
 * receipt block (header row = serial + printed timestamp + kind chip; mono
 * body rows) with an inked rubber-stamp verdict for settle/refund/refusal
 * receipts (APPROVED / REFUNDED / REFUSED). The header strip carries the
 * always-live source chips OUTSIDE the tape (arc head, subgraph index, ENS
 * price — live/stale/error with reasons, never a stale value presented as
 * fresh; spec S9).
 *
 * Ask mode (chat-first, the LLM PROPOSES and the registry EXECUTES): the
 * mode chip above the input toggles command/ask (click or Tab when the
 * command lane resolves nothing, which also prints the "did you mean to
 * ask?" nudge). Ask submits an OpenAI-compatible chat request (env VITE_LLM_*,
 * see env.ts/.env.example) whose system prompt carries the registry schema,
 * the exact dataset ids, and a compact live context; the model returns only
 * `{"command", "argv", "rationale"}` or a refusal, validated against the
 * registry (exact name, arg arity, enumerated dataset ids) with one
 * temperature-0 retry. Proposals print as `proposed · <command argv>` tape
 * blocks; act/sandbox need the Run button or Enter (nothing auto-executes),
 * inspect/replay run on Enter like a typed line, and execution goes through
 * dispatch() unchanged so receipts are identical to typed usage. No key ->
 * the chip reads "ask: set VITE_LLM_API_KEY" and the chips (static mappings)
 * keep every command keyless. The asking state shows "asking <model>…" with
 * a cancel and a 45s budget; the dock never blocks on the model.
 *
 * Keyboard grammar (spec §5.3d): ⌘K opens the fuzzy palette over the
 * registry + dataset ids, ↑/↓ walk history, Tab completes (command mode) or
 * toggles the mode (ask mode / unresolvable input), Esc cancels the ask,
 * clears the pending proposal, then the popover, then the dock, ⌘L clears
 * the tape. Hashes/addresses copy on click with a printed ack; `sandbox
 * claim` prints a live countdown-bar block. Motion is ≤120ms on value change
 * only and zero under prefers-reduced-motion.
 *
 * The command files are imported for their registration side effects —
 * adding a command elsewhere requires no change here (registry contract).
 */
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CONFIG } from "../config";
import { env } from "../env";
import { demoAddress, getPublicClient, pickSigner } from "../data/chain";
import { fetchLagShared } from "../data/subgraph";
import { useLiveValue } from "../ui/useLiveValue";
import { createEnsTextReader } from "../../../mcp/src/ens";
import { commands, dispatch, find, type CommandContext, type CommandResult } from "./registry";
import {
  ASK_TIMEOUT_MS,
  askLlm,
  buildLiveAskContext,
  buildSystemPrompt,
  llmConfigured,
  missingKeyRefusal,
  offerAskFor,
  proposalLine,
  registrySchema,
  requiresRun,
  SUGGESTED_ASKS,
  type AskMode,
  type AskOutcome,
  type AskProposal,
} from "./ask";
import { hasLlmKey } from "../env";
import { renderResult } from "./renderers";
import { CountdownBlock } from "./blocks/CountdownBlock";
import { LogBlock } from "./blocks/LogBlock";
import { copyAckReducer, copyAckText, type CopyAck } from "./blocks/copyAck";
import { verdictFor, type Verdict } from "./blocks/verdict";
import { completionCandidates, Palette, paletteItems, type CompletionItem } from "./palette";
import { getSandboxState } from "./commands/sandbox"; // registers the sandbox commands (side effect)
import "./commands/inspect"; // registers the inspect commands (side effect)
import "./commands/act"; // registers buy/deliver/settle (side effect)
import "./tape.css";

interface Entry {
  id: number;
  line: string;
  at: number;
  results: CommandResult[] | null; // null while the command is running
  error?: string;
  /** unix seconds when a live claim countdown should render under the block */
  countdownUntil?: number;
  /** ask-mode receipt: the model's proposal or refusal (never auto-executed) */
  ask?: AskOutcome;
  /** ask-mode in-flight: the model being asked (renders "asking <model>…") */
  asking?: string;
}

interface TabPopover {
  candidates: CompletionItem[];
  index: number;
}

function LiveChip({
  label,
  read,
}: {
  label: string;
  read: () => Promise<string>;
}): JSX.Element {
  const live = useLiveValue(read, { pollMs: 15_000, staleAfterMs: 45_000 });
  const text =
    live.state === "live"
      ? `${label} ${live.value}`
      : live.state === "loading"
        ? `${label} …`
        : live.state === "stale"
          ? `${label} ${live.value ?? "n/a"} · stale`
          : `${label} · error`;
  const dot =
    live.state === "live" ? "ob-live" : live.state === "stale" ? "ob-live stale" : "ob-live off";
  const title =
    live.state === "live"
      ? `live · as of ${new Date(live.at).toLocaleTimeString()}`
      : (live.reason ?? live.state);
  return (
    <span className={`console__chip console__chip--${live.state}`} title={title}>
      <span className={dot} aria-hidden="true" />
      {text}
    </span>
  );
}

/** Receipt header kind chip label + state class for an entry. */
function entryBadge(entry: Entry): { label: string; stateClass: string } {
  if (entry.error !== undefined) return { label: "ERROR", stateClass: " tape__kind--error" };
  if (entry.countdownUntil !== undefined) return { label: "COUNTDOWN", stateClass: " tape__kind--countdown" };
  if (entry.ask !== undefined || entry.asking !== undefined) return { label: "ASK", stateClass: "" };
  if (entry.results === null) return { label: "FEED", stateClass: "" };
  const labels: Record<string, string> = {
    text: "LOG",
    kv: "KV",
    table: "TABLE",
    ruler: "RULER",
    tx: "TX",
    frames: "FRAMES",
  };
  const render = entry.results[0]?.render ?? "text";
  return {
    label: labels[render] ?? render.toUpperCase(),
    stateClass: render === "tx" ? " tape__kind--tx" : "",
  };
}

function verdictStampClass(verdict: Verdict): string {
  return verdict === "APPROVED" ? "ok" : verdict === "REFUNDED" ? "refund" : "refuse";
}

function formatPrintedAt(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** sandbox claim prints a live countdown bar while the deadline is ahead. */
function countdownUntilFor(line: string, result: CommandResult): number | undefined {
  if (line !== "sandbox claim" || result.render !== "kv") return undefined;
  const countdownRow = result.data.rows.find(([key]) => key === "countdown");
  if (countdownRow === undefined || countdownRow[1].startsWith("✗")) return undefined;
  const state = getSandboxState();
  if (state === null || state.job.deadline === 0n) return undefined;
  const until = Number(state.job.deadline);
  return until > Math.floor(Date.now() / 1000) ? until : undefined;
}

/**
 * Proposal receipt block in the tape: `proposed · <command argv>` with the
 * rationale and the proposing model, plus the confirmation gate — act and
 * sandbox proposals show a Run button (nothing auto-executes); inspect and
 * replay note they run on Enter like a typed line. Refusals print as an
 * error-styled log line (model refusal, no key, or invalid twice).
 */
function AskReceiptBlock({
  outcome,
  onRun,
}: {
  outcome: AskOutcome;
  onRun: (proposal: AskProposal) => void;
}): JSX.Element {
  if (outcome.status === "refusal") {
    return (
      <div className="console__block tape__block tape__block--ask tape__block--refusal">
        <LogBlock text={`refused · ${outcome.refusal} (by ${outcome.model})`} error />
      </div>
    );
  }
  const { proposal, model } = outcome;
  const gated = requiresRun(find(proposal.command)?.kind ?? "inspect");
  return (
    <div className="console__block tape__block tape__block--ask">
      <div className="console__ask-line">
        <span className="console__ask-tag">proposed</span>
        <code>{proposalLine(proposal)}</code>
      </div>
      <p className="console__ask-why">
        {proposal.rationale} · by {model}
      </p>
      {gated ? (
        <button type="button" className="console__ask-run" onClick={() => onRun(proposal)}>
          Run ↵ <span className="console__ask-run-note">nothing auto-executes</span>
        </button>
      ) : (
        <p className="console__ask-note">read-only · Enter runs it like a typed command</p>
      )}
    </div>
  );
}

export function Console(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AskMode>("command");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpenedDrawerRef = useRef(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [popover, setPopover] = useState<TabPopover | null>(null);
  const [copyAck, setCopyAck] = useState<CopyAck | null>(null);
  const [pendingAsk, setPendingAsk] = useState<{ proposal: AskProposal } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);
  const askAbortRef = useRef<AbortController | null>(null);

  const readEnsText = useMemo(() => createEnsTextReader({ rpcUrl: env.sepoliaRpc }), []);

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

  /** Registry snapshot (side-effect imports in commands/* populate it once). */
  const allCommands = useMemo(() => commands(), []);
  const paletteItemsMemo = useMemo(() => paletteItems(allCommands, CONFIG.datasets), [allCommands]);

  // release the in-flight ask when the dock unmounts
  useEffect(() => () => askAbortRef.current?.abort(), []);

  // ⌘K (or Ctrl+K) opens the fuzzy palette; ⌘L clears the tape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (paletteOpen && event.key === "Escape") {
        // wherever focus is, Escape closes the palette (it made the page inert);
        // when ⌘K opened the drawer for the palette, it closes the drawer too so
        // focus returns to where the judge was
        event.preventDefault();
        setPaletteOpen(false);
        if (paletteOpenedDrawerRef.current) {
          paletteOpenedDrawerRef.current = false;
          setOpen(false);
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (paletteOpen) {
          setPaletteOpen(false);
        } else {
          paletteOpenedDrawerRef.current = !open;
          setOpen(true);
          setPaletteOpen(true);
        }
        return;
      }
      if (open && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setEntries([]);
        setPopover(null);
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, paletteOpen]);

  useEffect(() => {
    if (open && !paletteOpen) inputRef.current?.focus();
  }, [open, paletteOpen]);

  // keep the newest print in view
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  // the printed copy-ack auto-fades after a beat (value change only)
  useEffect(() => {
    if (copyAck === null) return;
    const timer = window.setTimeout(
      () => setCopyAck((prev) => copyAckReducer(prev, { type: "clear" })),
      2000,
    );
    return () => window.clearTimeout(timer);
  }, [copyAck]);

  const handleCopy = (entryId: number, hash: string): void => {
    setCopyAck((prev) => copyAckReducer(prev, { type: "copied", entryId, hash }));
  };

  const handleCopyFailed = (entryId: number, hash: string): void => {
    setCopyAck((prev) => copyAckReducer(prev, { type: "failed", entryId, hash }));
  };

  const runLine = async (line: string): Promise<void> => {
    if (line.length === 0) return;
    // a typed line supersedes any pending proposal (the explicit keyboard way)
    setPendingAsk(null);
    setHistory((h) => [...h, line]);
    setHistoryIndex(-1);
    setPopover(null);
    setInput("");
    const id = seqRef.current++;
    setEntries((es) => [...es, { id, line, at: Date.now(), results: null }]);
    try {
      const result = await dispatch(line, ctx);
      setEntries((es) =>
        es.map((en) =>
          en.id === id
            ? { ...en, results: [result], countdownUntil: countdownUntilFor(line, result) }
            : en,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEntries((es) => es.map((en) => (en.id === id ? { ...en, error: message } : en)));
    }
  };

  /** Execute a confirmed proposal through the SAME dispatch path as a typed
   * line — receipts are identical to typed usage (the LLM never executed). */
  const runProposal = (proposal: AskProposal): void => {
    setPendingAsk(null);
    void runLine(proposalLine(proposal));
  };

  /** Ask lane: build the live-context system prompt, call the LLM (propose
   * only), print a proposal or refusal receipt. Never blocks the dock: the
   * in-flight entry shows "asking <model>…" with a cancel. With no key the
   * refusal receipt is immediate: no asking state, no live-context reads, no
   * fetch (round-1 review — the tape must not pretend a model call happens). */
  const runAsk = async (question: string): Promise<void> => {
    const text = question.trim();
    if (text.length === 0) return;
    setPendingAsk(null);
    setPopover(null);
    setInput("");
    const id = seqRef.current++;
    if (!llmConfigured(env.llmApiKey)) {
      setEntries((es) => [...es, { id, line: `ask · ${text}`, at: Date.now(), results: null, ask: missingKeyRefusal() }]);
      return;
    }
    const controller = new AbortController();
    askAbortRef.current?.abort();
    askAbortRef.current = controller;
    setEntries((es) => [...es, { id, line: `ask · ${text}`, at: Date.now(), results: null, asking: env.llmModel }]);
    try {
      const systemPrompt = buildSystemPrompt(registrySchema(allCommands), await buildLiveAskContext());
      const outcome = await askLlm(
        text,
        { baseUrl: env.llmBaseUrl, apiKey: env.llmApiKey, model: env.llmModel, signal: controller.signal },
        systemPrompt,
        allCommands,
      );
      setEntries((es) => es.map((en) => (en.id === id ? { ...en, asking: undefined, ask: outcome } : en)));
      if (outcome.status === "proposal") setPendingAsk({ proposal: outcome.proposal });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const message = err.name === "AbortError" ? "ask cancelled" : err.message;
      setEntries((es) => es.map((en) => (en.id === id ? { ...en, asking: undefined, error: message } : en)));
    } finally {
      if (askAbortRef.current === controller) askAbortRef.current = null;
    }
  };

  const cancelAsk = (): void => {
    askAbortRef.current?.abort();
  };

  const navHistory = (delta: number): void => {
    if (history.length === 0) return;
    const next = Math.min(history.length - 1, Math.max(-1, historyIndex + delta));
    setHistoryIndex(next);
    setInput(next === -1 ? "" : history[history.length - 1 - next]);
  };

  /** Tab: cycles the popover's current match set, or builds it from the input. */
  const complete = (): void => {
    if (popover !== null) {
      const next = (popover.index + 1) % popover.candidates.length;
      setInput(popover.candidates[next].value);
      setPopover({ ...popover, index: next });
      return;
    }
    const candidates = completionCandidates(input, allCommands, CONFIG.datasets);
    if (candidates.length === 0) return;
    setInput(candidates[0].value);
    setPopover({ candidates, index: 0 });
  };

  const applyCompletion = (candidate: CompletionItem): void => {
    setInput(candidate.value);
    setPopover(null);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Tab") {
      event.preventDefault();
      // ask mode: Tab returns to the command lane (the nudge's invitation)
      if (mode === "ask") {
        setMode("command");
        return;
      }
      // command mode: the SAME predicate as the nudge decides the switch —
      // Tab switches to ask exactly when the nudge offers it, and completes
      // otherwise (strict prefixes like `qu` complete to `quote`, never
      // fight the nudge, round-1 review).
      if (offerAskFor(input, allCommands, CONFIG.datasets)) {
        setMode("ask");
        return;
      }
      complete();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      navHistory(1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      navHistory(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const text = input.trim();
      if (mode === "ask" && text.length > 0) {
        void runAsk(text);
        return;
      }
      // an empty input with a pending proposal runs it (explicit second Enter)
      if (pendingAsk !== null && text.length === 0) {
        runProposal(pendingAsk.proposal);
        return;
      }
      void runLine(text);
      return;
    }
    if (event.key === "Escape") {
      if (askAbortRef.current !== null) {
        cancelAsk();
        return;
      }
      if (popover !== null) {
        setPopover(null);
        return;
      }
      if (pendingAsk !== null) {
        setPendingAsk(null);
        return;
      }
      setOpen(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="console__launcher"
        onClick={() => setOpen(true)}
        aria-label="open the console (⌘K)"
      >
        console <kbd>⌘K</kbd>
      </button>
    );
  }

  return (
    <section className="console" aria-label="openbook console · the receipt printer">
      <header className="console__head">
        <span className="console__title">console</span>
        <span className="console__chips">
          <LiveChip label="arc" read={() => getPublicClient().getBlockNumber().then((n) => n.toLocaleString("en-US"))} />
          <LiveChip label="subgraph" read={() => fetchLagShared().then((l) => `idx ${l.indexed.toLocaleString("en-US")} · ${l.rows} rows`)} />
          <LiveChip label="ens" read={() => readEnsText(CONFIG.ens, "svc.price").then((p) => (p === null ? "no price" : p))} />
        </span>
        <span className="console__hints">⌘K palette · Tab complete · mode chip · ↵ runs · Esc close</span>
        <button
          type="button"
          className="console__close"
          onClick={() => setOpen(false)}
          aria-label="close console (⌘K)"
        >
          ×
        </button>
      </header>

      <div className="console__body">
        <div className="console__entries" ref={bodyRef} aria-live="polite" role="log">
          {entries.length === 0 ? (
            <div className="console__empty">
              <p className="console__empty-line">
                the receipt printer · every command prints a block · ask below, or run one of the
                mapped chips
              </p>
              <p className="tape__hints">
                <kbd>⌘K</kbd> palette · <kbd>Tab</kbd> complete or ask · <kbd>↑↓</kbd> history ·{" "}
                <kbd>⌘L</kbd> clears · <kbd>Esc</kbd> close
              </p>
            </div>
          ) : (
            entries.map((entry) => {
              const badge = entryBadge(entry);
              const verdict = verdictFor(entry.line, entry.results?.[0] ?? null);
              return (
                <article className="console__entry tape__receipt" key={entry.id}>
                  <header className="tape__rec-head">
                    <span className="tape__serial">#{String(entry.id + 1).padStart(4, "0")}</span>
                    <time className="tape__at" dateTime={new Date(entry.at).toISOString()}>
                      {formatPrintedAt(entry.at)}
                    </time>
                    <span className={`tape__kind${badge.stateClass}`}>{badge.label}</span>
                  </header>
                  <div className="console__line">
                    <span className="console__prompt" aria-hidden="true">
                      ›
                    </span>{" "}
                    {entry.line}
                  </div>
                  <div className="console__result">
                    {entry.error !== undefined ? (
                      <div className="console__block tape__block tape__block--error">
                        <LogBlock text={`${entry.line} failed: ${entry.error}`} error />
                      </div>
                    ) : entry.asking !== undefined ? (
                      <div className="console__block tape__block tape__block--ask">
                        <LogBlock text={`asking ${entry.asking}… (budget ${ASK_TIMEOUT_MS / 1000}s)`} />
                        <button type="button" className="console__ask-cancel" onClick={cancelAsk}>
                          cancel
                        </button>
                      </div>
                    ) : entry.ask !== undefined ? (
                      <AskReceiptBlock outcome={entry.ask} onRun={runProposal} />
                    ) : entry.results === null ? (
                      <div className="console__block tape__block tape__block--log">
                        <LogBlock text="printing…" />
                      </div>
                    ) : (
                      entry.results.map((result, i) => (
                        <div key={i} className={`console__block console__block--${result.render} tape__block tape__block--${result.render}`}>
                          {renderResult(
                            result,
                            (jobId) => ctx.navigate(`#theater/${jobId}`),
                            (hash) => handleCopy(entry.id, hash),
                            (hash) => handleCopyFailed(entry.id, hash),
                          )}
                        </div>
                      ))
                    )}
                    {entry.countdownUntil !== undefined && (
                      <div className="console__block tape__block tape__block--countdown">
                        <CountdownBlock until={entry.countdownUntil} />
                      </div>
                    )}
                  </div>
                  {verdict !== null && (
                    <span
                      className={`tape__stamp tape__stamp--${verdictStampClass(verdict)}`}
                      aria-label={`verdict: ${verdict}`}
                    >
                      {verdict}
                    </span>
                  )}
                  {copyAck !== null && copyAck.entryId === entry.id && (
                    <div className={`tape__ack${copyAck.failed === true ? " tape__ack--failed" : ""}`}>
                      {copyAckText(copyAck)}
                    </div>
                  )}
                  <div className="tape__perf" aria-hidden="true" />
                </article>
              );
            })
          )}
        </div>
      </div>

      {popover !== null && (
        <div className="tape__pop" role="listbox" aria-label="tab completion · commands and datasets">
          <div className="tape__pop-head">
            {popover.candidates.length} match{popover.candidates.length === 1 ? "" : "es"} · tab cycles · click picks
          </div>
          {popover.candidates.map((candidate) => (
            <div
              key={`${candidate.kind}-${candidate.label}`}
              role="option"
              aria-selected={candidate.value === popover.candidates[popover.index]?.value}
              className={`tape__pop-item tape__pop-item--${candidate.kind}${
                candidate.value === popover.candidates[popover.index]?.value ? " tape__pop-item--sel" : ""
              }`}
              onClick={() => applyCompletion(candidate)}
            >
              <span className="tape__pop-name">{candidate.label}</span>
              <span className="tape__pop-hint">{candidate.hint}</span>
              <span className="tape__pop-kind">{candidate.kind === "command" ? "CMD" : "DATA"}</span>
            </div>
          ))}
        </div>
      )}

      <div className="console__asks">
        <span className="console__asks-cap">try asking</span>
        {SUGGESTED_ASKS.map((ask) => (
          <button
            type="button"
            key={ask.line}
            className="console__ask-chip"
            title={`runs: ${ask.line} (static mapping, no key needed)`}
            onClick={() => void runLine(ask.line)}
          >
            {ask.label}
          </button>
        ))}
      </div>

      {mode === "command" && offerAskFor(input, allCommands, CONFIG.datasets) && (
        <div className="console__nudge">
          <span>
            did you mean to ask? press <kbd>Tab</kbd> to switch to ask mode
          </span>
          <button type="button" className="console__nudge-ask" onClick={() => setMode("ask")}>
            ask
          </button>
        </div>
      )}

      <div className="console__inputrow">
        <button
          type="button"
          className={`console__mode console__mode--${mode}`}
          onClick={() => setMode((m) => (m === "command" ? "ask" : "command"))}
          title="click or Tab to toggle mode"
          aria-label={`input mode: ${mode}`}
          aria-pressed={mode === "ask"}
        >
          {mode === "command" ? "command ▸ ask" : hasLlmKey ? "ask ◂ command" : "ask: set VITE_LLM_API_KEY"}
        </button>
        <span className="console__prompt" aria-hidden="true">
          ›
        </span>
        <input
          ref={inputRef}
          className="console__input"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setPopover(null);
          }}
          onKeyDown={onKeyDown}
          placeholder={mode === "command" ? "type a command · help" : "ask a question · the LLM proposes, the registry executes"}
          aria-label={`console ${mode} input`}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <span className="tape__rowhint">
          {pendingAsk !== null ? (
            <kbd>↵</kbd>
          ) : (
            <kbd>⌘L</kbd>
          )}
          {pendingAsk !== null ? " runs proposal" : " clears"}
        </span>
      </div>

      <Palette
        open={paletteOpen}
        items={paletteItemsMemo}
        onRun={(line) => {
          setPaletteOpen(false);
          void runLine(line);
        }}
        onClose={() => {
          setPaletteOpen(false);
          inputRef.current?.focus();
        }}
      />
    </section>
  );
}
