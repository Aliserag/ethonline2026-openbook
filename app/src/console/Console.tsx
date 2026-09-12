/**
 * Console — the docked command surface (⌘K). A receipt printer, not a dark
 * terminal (design ruling): every command prints a typed block (text / kv /
 * table / ruler / tx / frames). The header strip carries three always-live
 * source chips polled through useLiveValue — arc head, subgraph index, ENS
 * price — so the always-visible panel shows live/stale/error states with
 * reasons, never a stale value presented as fresh (spec S9).
 *
 * Keyboard: ⌘K (or Ctrl+K) toggles, ↑/↓ walk history, Tab autocompletes
 * command names (cycles through matches), Esc closes. Enter prints.
 *
 * The inspect command file is imported for its registration side effect —
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
import "./commands/inspect"; // registers the 11 inspect commands (side effect)

interface Entry {
  id: number;
  line: string;
  results: CommandResult[] | null; // null while the command is running
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
          ? `${label} ${live.value ?? "—"} · stale`
          : `${label} · error`;
  const dot =
    live.state === "live" ? "ob-live" : live.state === "stale" ? "ob-live stale" : "ob-live off";
  const title =
    live.state === "live"
      ? `live — as of ${new Date(live.at).toLocaleTimeString()}`
      : (live.reason ?? live.state);
  return (
    <span className={`console__chip console__chip--${live.state}`} title={title}>
      <span className={dot} aria-hidden="true" />
      {text}
    </span>
  );
}

export function Console(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tabCycle, setTabCycle] = useState(0);
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

  // ⌘K (or Ctrl+K) toggles the dock from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // keep the newest print in view
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const runLine = async (line: string): Promise<void> => {
    if (line.length === 0) return;
    setHistory((h) => [...h, line]);
    setHistoryIndex(-1);
    setTabCycle(0);
    setInput("");
    const id = seqRef.current++;
    setEntries((es) => [...es, { id, line, results: null }]);
    try {
      const result = await dispatch(line, ctx);
      setEntries((es) =>
        es.map((en) => (en.id === id ? { ...en, results: [result] } : en)),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEntries((es) =>
        es.map((en) =>
          en.id === id
            ? { ...en, results: [{ render: "text", data: `${line} failed: ${message}` }] }
            : en,
        ),
      );
    }
  };

  const navHistory = (delta: number): void => {
    if (history.length === 0) return;
    const next = Math.min(history.length - 1, Math.max(-1, historyIndex + delta));
    setHistoryIndex(next);
    setInput(next === -1 ? "" : history[history.length - 1 - next]);
  };

  const complete = (): void => {
    const first = input.split(/\s+/)[0] ?? "";
    const matches = commands().filter((c) => c.name.startsWith(first));
    if (matches.length === 0) return;
    const pick = matches[tabCycle % matches.length];
    setTabCycle((c) => c + 1);
    const rest = input.slice(first.length);
    setInput(`${pick.name}${rest.length > 0 ? rest : " "}`);
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
    <section className="console" aria-label="openbook console">
      <header className="console__head">
        <span className="console__title">console</span>
        <span className="console__chips">
          <LiveChip label="arc" read={() => getPublicClient().getBlockNumber().then((n) => n.toLocaleString("en-US"))} />
          <LiveChip label="subgraph" read={() => fetchLag().then((l) => `idx ${l.indexed.toLocaleString("en-US")} · ${l.rows} rows`)} />
          <LiveChip label="ens" read={() => readEnsText(CONFIG.ens, "svc.price").then((p) => (p === null ? "no price" : p))} />
        </span>
        <span className="console__hints">⌘K toggle · ↑↓ history · Tab complete · Esc close</span>
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
                the receipt printer — every command prints a block. try:
              </p>
              <div className="console__suggest">
                {SUGGESTIONS.map((s) => (
                  <button type="button" key={s} className="console__suggest-chip" onClick={() => void runLine(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            entries.map((entry) => (
              <article className="console__entry" key={entry.id}>
                <div className="console__line">
                  <span className="console__prompt" aria-hidden="true">
                    ›
                  </span>{" "}
                  {entry.line}
                </div>
                <div className="console__result">
                  {entry.results === null ? (
                    <span className="console__running">printing…</span>
                  ) : (
                    entry.results.map((result, i) => (
                      <div key={i} className={`console__block console__block--${result.render}`}>
                        {renderResult(result)}
                      </div>
                    ))
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      </div>

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
            setTabCycle(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="type a command — help"
          aria-label="console command input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>
    </section>
  );
}
