/**
 * Console command registry — the fixed contract every wave-B/C surface
 * registers into (T8/T9/T10/T11 add their commands via `register`; help and
 * autocomplete derive from the registry, so adding a command requires no UI
 * change). One command = one file entry in commands/.
 *
 * CommandResult is the typed render contract — renderers.tsx consumes exactly
 * these kinds. Live reads never invent a value: a failed source renders its
 * reason inline (see commands/inspect.ts), and dispatch wraps any throwing
 * command into a text result with the exact error message.
 */
import type { PublicClient } from "viem";
import type { AppConfig } from "../config";
import type { SignerKind } from "../data/types";

export type CommandKind = "inspect" | "act" | "sandbox" | "replay";

export type KvRow = [key: string, value: string];

export interface KvData {
  rows: KvRow[];
  /** optional line rendered under the kv rows */
  note?: string;
}

export interface TableData {
  columns: string[];
  rows: Record<string, string>[];
  /** optional line rendered above the table (e.g. totals) */
  summary?: string;
}

export interface RulerData {
  /** delivered block (subgraph indexed block) */
  delivered?: number;
  /** chain head block */
  head?: number;
  /** SLA floor (minimum accepted block), optional */
  floor?: number;
  label: string;
  note?: string;
}

export interface TxData {
  hash: `0x${string}`;
  title?: string;
  kind?: "settled" | "refunded" | "stale" | "open";
  rows?: KvRow[];
  note?: string;
}

export interface FramesData {
  jobId: string;
}

export type CommandResult =
  | { render: "kv"; data: KvData }
  | { render: "table"; data: TableData }
  | { render: "ruler"; data: RulerData }
  | { render: "tx"; data: TxData }
  | { render: "text"; data: string }
  | { render: "frames"; data: FramesData };

export interface SignerView {
  kind: SignerKind;
  /** demo buyer's address when VITE_DEMO_BUYER_KEY is set and valid */
  address: `0x${string}` | null;
}

export interface CommandContext {
  publicClient: PublicClient;
  signer: SignerView;
  config: AppConfig;
  navigate: (route: string) => void;
  toast?: (message: string) => void;
}

export interface Command {
  name: string;
  args?: string;
  help: string;
  kind: CommandKind;
  run: (ctx: CommandContext, argv: string[]) => Promise<CommandResult>;
}

const REGISTRY = new Map<string, Command>();

/** Register a command. The last registration for a name wins. */
export function register(command: Command): void {
  REGISTRY.set(command.name, command);
}

export function commands(): Command[] {
  return [...REGISTRY.values()];
}

/**
 * Resolve a name to a command. Multi-word names are matched by longest prefix
 * ("ens show" beats "ens"), so dispatch of `ens show` is unambiguous.
 */
export function find(name: string): Command | undefined {
  const words = parseArgv(name);
  for (let i = words.length; i >= 1; i--) {
    const command = REGISTRY.get(words.slice(0, i).join(" "));
    if (command) return command;
  }
  return undefined;
}

/**
 * Shell-ish argv split honoring single/double quotes (no escapes — no command
 * needs them). 'buy x --amount 0.10' → ["buy","x","--amount","0.10"].
 */
export function parseArgv(line: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (const ch of line.trim()) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) argv.push(current);
  return argv;
}

/**
 * Run a line through the registry. Unknown names and throwing commands both
 * return text results with the reason — dispatch never raises to the UI.
 */
export async function dispatch(line: string, ctx: CommandContext): Promise<CommandResult> {
  const argv = parseArgv(line);
  if (argv.length === 0) return { render: "text", data: "" };
  const command = find(line);
  if (!command) return { render: "text", data: `unknown command: ${argv[0]} — try help` };
  try {
    return await command.run(ctx, argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { render: "text", data: `${command.name} failed: ${reason}` };
  }
}
