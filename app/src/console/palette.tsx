/**
 * Palette — the ⌘K fuzzy command palette over the registry + dataset ids
 * (Warp-style, spec §5.3d). Fuzzy matching, ranking, and the Tab-completion
 * candidate logic are pure and exported for the unit tests; the component
 * is the overlay shell: ↑/↓ choose, Enter runs, Esc closes.
 */
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";

export interface PaletteItem {
  name: string;
  hint: string;
  kind: "command" | "dataset";
}

export interface CompletionItem {
  /** the full replacement input when chosen */
  value: string;
  label: string;
  hint: string;
  kind: "command" | "dataset";
}

/**
 * Fuzzy subsequence score. Higher is better; null = no match.
 * Prefix matches outrank every subsequence; word-boundary hits (after "-",
 * " " or "/") and consecutive runs score more; gaps cost a little.
 */
export function fuzzyMatch(name: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const n = name.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 900 + q.length * 2;

  let score = 0;
  let qi = 0;
  let streak = 0;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) {
      const boundary = i === 0 || n[i - 1] === "-" || n[i - 1] === " " || n[i - 1] === "/";
      if (boundary) score += 40;
      streak += 1;
      score += 20 + (streak >= 2 ? 10 : 0) + (n[i] === "-" || n[i] === " " ? 0 : 2);
      qi += 1;
    } else {
      streak = 0;
      score -= 1;
    }
  }
  if (qi < q.length) return null;
  return score;
}

/** Rank a query over items: filter by fuzzy match, sort by score (stable). */
export function rankPalette(query: string, items: PaletteItem[]): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return items;
  const scored: { item: PaletteItem; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const score = fuzzyMatch(item.name, q);
    if (score !== null) scored.push({ item, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.item);
}

/** Group palette items: commands first (registry order), then datasets. */
export function paletteItems(
  commands: { name: string; help: string }[],
  datasets: { id: string; description?: string }[],
): PaletteItem[] {
  return [
    ...commands.map((command) => ({ name: command.name, hint: command.help, kind: "command" as const })),
    ...datasets.map((dataset) => ({
      name: dataset.id,
      hint: dataset.description ?? "dataset",
      kind: "dataset" as const,
    })),
  ];
}

/**
 * Tab-completion candidates for the dock: command names by prefix (single
 * or multi-word), and — for the dataset-taking commands (quote, buy) —
 * dataset ids by the partial id token. The value is the complete replacement
 * input, so picking one lands a runnable line.
 */
export function completionCandidates(
  input: string,
  commands: { name: string; help: string }[],
  datasets: { id: string; description?: string }[],
): CompletionItem[] {
  const trimmed = input.trimEnd();
  const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const partial = tokens[tokens.length - 1] ?? "";
  const trailing = input !== trimmed;
  const command = tokens[0] ?? "";
  const takesDataset = command === "quote" || command === "buy";
  const before = trailing ? input : input.slice(0, input.length - partial.length);

  const items: CompletionItem[] = [];
  for (const c of commands) {
    const inSingle = tokens.length < 2 && c.name.startsWith(partial);
    const inMulti = tokens.length > 1 && c.name.startsWith(`${tokens.slice(0, -1).join(" ")} ${partial}`);
    if (inSingle || inMulti) {
      items.push({ value: `${c.name} `, label: c.name, hint: c.help, kind: "command" });
    }
  }
  if (takesDataset) {
    for (const dataset of datasets) {
      if (trailing || dataset.id.startsWith(partial)) {
        items.push({
          value: `${before}${dataset.id} `,
          label: dataset.id,
          hint: dataset.description ?? "dataset",
          kind: "dataset",
        });
      }
    }
  }
  return items;
}

export function Palette({
  open,
  items,
  onRun,
  onClose,
}: {
  open: boolean;
  items: PaletteItem[];
  onRun: (line: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const ranked = useMemo(() => rankPalette(query, items), [query, items]);
  const visible = ranked.slice(0, 12);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSel((s) => Math.min(visible.length - 1, s + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSel((s) => Math.max(0, s - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const pick = visible[Math.min(sel, visible.length - 1)];
      if (pick !== undefined) onRun(pick.name);
      else if (query.trim().length > 0) onRun(query.trim());
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  if (!open) return null;
  return (
    <div
      className="palette"
      role="dialog"
      aria-label="command palette (fuzzy over commands and datasets)"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette__panel">
        <div className="palette__inputrow">
          <span className="palette__kbd" aria-hidden="true">
            ⌘K
          </span>
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="run a command — fuzzy over the registry + datasets"
            aria-label="palette query"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
        {visible.length === 0 ? (
          <div className="palette__none">no match — enter still runs the line</div>
        ) : (
          <ul className="palette__list" role="listbox" aria-activedescendant={`palette-opt-${sel}`}>
            {visible.map((item, i) => (
              <li
                key={item.name}
                id={`palette-opt-${i}`}
                role="option"
                aria-selected={i === sel}
                className={`palette__opt${i === sel ? " palette__opt--sel" : ""}${item.kind === "dataset" ? " palette__opt--dataset" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => onRun(item.name)}
              >
                <span className="palette__opt-name">{item.name}</span>
                <span className="palette__opt-hint">{item.hint}</span>
                <span className="palette__opt-kind">{item.kind === "command" ? "CMD" : "DATA"}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="palette__foot">↑↓ choose · enter run · esc close</div>
      </div>
    </div>
  );
}
