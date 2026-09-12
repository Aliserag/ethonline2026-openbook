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
 * Keyboard grammar (spec §5.3d): ⌘K opens the fuzzy palette over the
 * registry + dataset ids, ↑/↓ walk history, Tab cycles the completion
 * popover (commands then dataset ids), Esc closes (popover first, then the
 * dock), ⌘L clears the tape. Hashes/addresses copy on click with a printed
 * ack; `sandbox claim` prints a live countdown-bar block. Motion is ≤120ms
 * on value change only and zero under prefers-reduced-motion.
 *
 * The command files are imported for their registration side effects —
 * adding a command elsewhere requires no change here (registry contract).
 */
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CONFIG } from "../config";
import { env } from "../env";
import { demoAddress, getPublicClient, pickSigner } from "../data/chain";
import { fetchLag } from "../data/subgraph";
import { useLiveValue } from "../ui/useLiveValue";
import { createEnsTextReader } from "../../../mcp/src/ens";
import { commands, dispatch, type CommandContext, type CommandResult } from "./registry";
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
}

interface TabPopover {
  candidates: CompletionItem[];
  index: number;
}

const SUGGESTIONS = [
  "status",
  "help",
  "lag",
  "books",
  "jobs",
  "ens show",
  "quote aave-v3-arbitrum-lending",
  "policy show",
];

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

export function Console(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [popover, setPopover] = useState<TabPopover | null>(null);
  const [copyAck, setCopyAck] = useState<CopyAck | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);

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

  const paletteItemsMemo = useMemo(() => paletteItems(commands(), CONFIG.datasets), []);

  // ⌘K (or Ctrl+K) opens the fuzzy palette; ⌘L clears the tape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (paletteOpen) {
          setPaletteOpen(false);
        } else {
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
    const candidates = completionCandidates(input, commands(), CONFIG.datasets);
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
      void runLine(input.trim());
      return;
    }
    if (event.key === "Escape") {
      if (popover !== null) {
        setPopover(null);
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
          <LiveChip label="subgraph" read={() => fetchLag().then((l) => `idx ${l.indexed.toLocaleString("en-US")} · ${l.rows} rows`)} />
          <LiveChip label="ens" read={() => readEnsText(CONFIG.ens, "svc.price").then((p) => (p === null ? "no price" : p))} />
        </span>
        <span className="console__hints">⌘K palette · ↑↓ history · Tab complete · Esc close</span>
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
                the receipt printer · every command prints a block. try:
              </p>
              <div className="console__suggest">
                {SUGGESTIONS.map((s) => (
                  <button type="button" key={s} className="console__suggest-chip" onClick={() => void runLine(s)}>
                    {s}
                  </button>
                ))}
              </div>
              <p className="tape__hints">
                <kbd>⌘K</kbd> palette · <kbd>Tab</kbd> complete · <kbd>↑↓</kbd> history ·{" "}
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

      <div className="console__inputrow">
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
          placeholder="type a command · help"
          aria-label="console command input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <span className="tape__rowhint">
          <kbd>⌘L</kbd> clears
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
