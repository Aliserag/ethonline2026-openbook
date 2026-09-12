/**
 * Console ask mode — the LLM contract behind the dock's second input mode.
 * One hard rule: the LLM PROPOSES, the registry EXECUTES. The model returns
 * ONLY a command name + argv picked from the fixed registry (exact names,
 * arity checked), never a number the app would display as data: a question
 * about a value must resolve to the command that reads it (quote/datasets/
 * books/jobs/status/lag), and every receipt stays a live read. Proposals for
 * `act`/`sandbox` commands need an explicit Run (Enter or click); inspect/
 * replay run on Enter like a typed line. No key -> ask returns a refusal
 * that says how to enable it and every command keeps working.
 *
 * The pure functions in this module (parseProposal, validateProposal, arity,
 * requiresRun, registrySchema, buildSystemPrompt, SUGGESTED_ASKS) are the
 * tested contract; askLlm does the OpenAI-compatible fetch, retrying once at
 * temperature 0 when the response does not validate, then refusing.
 */
import { CONFIG } from "../config";
import { env } from "../env";
import { ADDR } from "../data/addresses";
import { getPublicClient } from "../data/chain";
import { platformFee } from "../data/escrow";
import { truncateHash } from "../format";
import { createEnsTextReader } from "../../../mcp/src/ens";
import { find, type Command, type CommandKind } from "./registry";
import { completionCandidates } from "./palette";

export type AskMode = "command" | "ask";

export interface AskableDataset {
  id: string;
  description?: string;
}

/**
 * The single predicate behind BOTH the "did you mean to ask?" nudge and the
 * Tab mode-switch, so the two can never disagree (round-1 review): a
 * command-mode input offers the ask lane when it is non-empty, resolves to
 * no registry command (`find`), AND Tab-completion has nothing to offer
 * (`completionCandidates`). A strict command prefix (`qu`, `bo`, `sandbox
 * cl`, `policy s`) has completion candidates, so it completes on Tab and the
 * nudge stays quiet; garbage (`banana`) nudges and Tab switches to ask.
 */
export function offerAskFor(
  input: string,
  cmds: readonly Command[],
  datasets: readonly AskableDataset[],
): boolean {
  const text = input.trim();
  if (text.length === 0) return false;
  if (find(text) !== undefined) return false;
  return completionCandidates(text, [...cmds], [...datasets]).length === 0;
}

/** A validated registry pick: exact command name + argument tokens only. */
export interface AskProposal {
  command: string;
  argv: string[];
  /** one short line explaining the pick to the buyer */
  rationale: string;
}

/** Ask lane outcome — the only two shapes the contract allows. */
export type AskOutcome =
  | { status: "proposal"; proposal: AskProposal; model: string }
  | { status: "refusal"; refusal: string; model: string };

/** Injection point for the fetch round trip (stubbable in tests). */
export interface AskInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  /** abort the in-flight completion (the dock's cancel affordance) */
  signal?: AbortSignal;
}

/** The closed set of buyer-visible dataset ids — arg validation and prompt enumeration. */
export const DATASET_IDS: readonly string[] = CONFIG.datasets.map((d) => d.id);

/** Parse of one raw model response. */
export type ParsedAsk =
  | { kind: "proposal"; proposal: AskProposal }
  | { kind: "refusal"; refusal: string }
  | { kind: "invalid"; reason: string };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate one model response into a proposal/refusal, or report why it does
 * not satisfy the contract (retry material). Tolerates a ```json fence wrap
 * (models do that); a "refusal" key short-circuits; anything else must be an
 * object with command/argv/rationale.
 */
export function parseProposal(raw: string): ParsedAsk {
  const text = raw.trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text);
  const body = fence === null ? text : fence[1].trim();
  if (body.length === 0) return { kind: "invalid", reason: "empty response" };
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (error) {
    return { kind: "invalid", reason: `not JSON: ${reason(error)}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { kind: "invalid", reason: "response is not a JSON object" };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.refusal === "string" && obj.refusal.length > 0) {
    return { kind: "refusal", refusal: obj.refusal };
  }
  if (typeof obj.command !== "string" || obj.command.length === 0) {
    return { kind: "invalid", reason: "missing a command string" };
  }
  if (!Array.isArray(obj.argv) || obj.argv.some((arg) => typeof arg !== "string")) {
    return { kind: "invalid", reason: "argv must be an array of strings" };
  }
  if (typeof obj.rationale !== "string" || obj.rationale.length === 0) {
    return { kind: "invalid", reason: "missing a rationale string" };
  }
  return {
    kind: "proposal",
    proposal: { command: obj.command as string, argv: obj.argv as string[], rationale: obj.rationale },
  };
}

/**
 * Arity of a command's `args` usage string: min = required <placeholders>
 * outside brackets, max = that plus every token inside [brackets] (flag +
 * value counted separately). `undefined` args (zero-arg commands) is 0..0.
 * 'buy <dataset> [--amount <usdc>]' -> { min: 1, max: 3 }.
 */
export function arityOf(args: string | undefined): { min: number; max: number } {
  if (args === undefined) return { min: 0, max: 0 };
  const outside = args.replace(/\[[^\]]*\]/g, " ");
  const min = (outside.match(/<[^>]+>/g) ?? []).length;
  const bracketTokens = (args.match(/\[[^\]]*\]/g) ?? []).reduce(
    (total, block) => total + block.replace(/^\[|\]$/g, "").split(/\s+/).filter(Boolean).length,
    0,
  );
  return { min, max: min + bracketTokens };
}

/**
 * Registry gate over a proposal: exact command name + argv arity, plus the
 * closed enumerations the usage string names (dataset ids, help targets).
 * Returns the reason when the proposal must be refused, null when it may
 * execute. This is what stops a hallucinated command (e.g. `buy
 * ufc-predictions`), a wrong argument count, or an invented dataset id from
 * running — the refusal feeds the single temperature-0 retry.
 */
export function validateProposal(proposal: AskProposal, cmds: readonly Command[]): string | null {
  const command = cmds.find((c) => c.name === proposal.command);
  if (command === undefined) {
    const names = cmds.map((c) => c.name).join(" · ");
    return `unknown command "${proposal.command}" · the registry has: ${names}`;
  }
  const { min, max } = arityOf(command.args);
  if (proposal.argv.length < min) {
    return `"${proposal.command}" needs at least ${min} arg${min === 1 ? "" : "s"} · got ${proposal.argv.length}`;
  }
  if (proposal.argv.length > max) {
    return `"${proposal.command}" takes at most ${max} arg${max === 1 ? "" : "s"} · got ${proposal.argv.length}`;
  }
  const usage = command.args ?? "";
  const first = proposal.argv[0];
  if (first !== undefined && !first.startsWith("--") && /\bdataset\b/.test(usage) && !DATASET_IDS.includes(first)) {
    return `"${proposal.command}" dataset must be exactly one of: ${DATASET_IDS.join(", ")} · got "${first}"`;
  }
  if (first !== undefined && !first.startsWith("--") && /\bcmd\b/.test(usage) && !cmds.some((c) => c.name === first)) {
    return `"${proposal.command}" target must be an exact command name · got "${first}"`;
  }
  return null;
}

/** The dataset menu block for the prompt: exact ids + one-line descriptions. */
export function datasetMenu(): string {
  return CONFIG.datasets
    .map((d) => `- ${d.id} · ${d.description}`)
    .join("\n");
}

/**
 * Confirmation gate: `act` (buy/deliver/settle) and `sandbox` proposals need
 * an explicit Run; inspect/replay are read-only and may run on Enter.
 */
export function requiresRun(kind: CommandKind): boolean {
  return kind === "act" || kind === "sandbox";
}

/** The dispatchable line for a proposal: command name + argv, whitespace-joined. */
export function proposalLine(proposal: AskProposal): string {
  return proposal.argv.length > 0 ? `${proposal.command} ${proposal.argv.join(" ")}` : proposal.command;
}

/** The registry schema block: every command as one line (name, args, kind, help). */
export function registrySchema(cmds: readonly Command[]): string {
  return cmds
    .map((c) => `- ${c.name}${c.args !== undefined ? ` ${c.args}` : ""} · kind: ${c.kind} · ${c.help}`)
    .join("\n");
}

/**
 * System prompt: the registry schema (the ONLY names the model may propose)
 * plus a compact live context block, and the strict output contract.
 */
export function buildSystemPrompt(schema: string, liveContext: string): string {
  return [
    "You route a buyer's question to an OpenBook console command. You NEVER answer with data:",
    "a question about a price, a balance, a job, a verdict or a freshness figure must pick the",
    "command that reads it. The registry executes every command; you only propose.",
    "",
    `REGISTRY (the ONLY commands you may propose, exact names only):`,
    schema,
    "",
    `DATASETS (exact ids only: buy/quote/deliver take ONE of these, never a paraphrase):`,
    datasetMenu(),
    "",
    `LIVE CONTEXT (read at ask time):`,
    liveContext,
    "",
    "RULES:",
    '- reply with ONLY a JSON object, no prose, no code fences: {"command": "<exact name>", "argv": ["<arg>", ...], "rationale": "<one short line>"}',
    "- argv holds the arguments only, never the command name; zero-arg commands take an empty argv",
    "- if the request cannot map to a registry command, reply {\"refusal\": \"<why>\"}",
    "- never invent a command name, an argument, or a value: pick from the registry, fill argv from the context or the question",
  ].join("\n");
}

/** The no-key refusal — the ask lane's only answer until VITE_LLM_API_KEY is set. */
export function missingKeyRefusal(): AskOutcome {
  return {
    status: "refusal",
    refusal:
      "ask needs an LLM key · set VITE_LLM_API_KEY in app/.env.local (see .env.example) · every command still works in command mode",
    model: "none",
  };
}

/**
 * The shared key predicate: the dock's runAsk short-circuits on this BEFORE
 * creating an asking state or reading the live context, and askLlm refuses on
 * it before any fetch — one predicate, so the no-key path cannot lie.
 */
export function llmConfigured(apiKey: string): boolean {
  return apiKey.trim().length > 0;
}

/**
 * Best-effort live context block for the system prompt: escrow, venue fee +
 * treasury, the seller list with live ENS prices, and the dataset ids. Any
 * source that fails renders its reason inline, never a hard-coded figure.
 */
export async function buildLiveAskContext(): Promise<string> {
  const readEns = createEnsTextReader({ rpcUrl: env.sepoliaRpc });
  const lines: string[] = [];

  let feeLine = "venue fee: ✗ unreachable";
  try {
    const { feeBP, treasury } = await platformFee(getPublicClient());
    feeLine = `venue fee: ${feeBP} bp (${(feeBP / 100).toFixed(0)}%) · treasury ${truncateHash(treasury)}`;
  } catch {
    // keep the ✗ reason line
  }

  const sellerPrice = async (id: string): Promise<string> => {
    const sub = `${id}.${CONFIG.ens}`;
    let value: string | null = null;
    let failed = false;
    for (const name of [sub, CONFIG.ens]) {
      try {
        value = await readEns(name, "svc.price");
        if (value !== null && value.length > 0) break;
      } catch {
        failed = true;
      }
    }
    return failed && value === null ? "✗ ens unreachable" : (value ?? "✗ no svc.price");
  };

  const priced = await Promise.all(
    CONFIG.datasets.map(async (d) => `${d.id} = ${await sellerPrice(d.id)}`),
  );

  lines.push(`- escrow: ${truncateHash(ADDR.escrow)} on Arc testnet (buyer funds jobs here)`);
  lines.push(`- ${feeLine}`);
  lines.push(`- sellers (live ENS prices, ${CONFIG.ens}): ${priced.join(" · ")}`);
  lines.push(`- dataset ids: ${CONFIG.datasets.map((d) => d.id).join(", ")}`);
  return lines.join("\n");
}

/** Map one raw response to a proposal/refusal outcome, vetoing via the registry. */
function settle(raw: string, cmds: readonly Command[], model: string): AskOutcome | null {
  const parsed = parseProposal(raw);
  if (parsed.kind === "refusal") return { status: "refusal", refusal: parsed.refusal, model };
  if (parsed.kind === "invalid") return null;
  if (validateProposal(parsed.proposal, cmds) !== null) return null;
  return { status: "proposal", proposal: parsed.proposal, model };
}

/** Why a raw response cannot settle as an outcome (retry hint material), or null. */
function vetoReason(raw: string, cmds: readonly Command[]): string | null {
  const parsed = parseProposal(raw);
  if (parsed.kind === "refusal") return null;
  if (parsed.kind === "invalid") return parsed.reason;
  return validateProposal(parsed.proposal, cmds);
}

/** The dock's in-flight ask budget: reasoning models are slow, so the asking
 * state shows "asking <model>…" for up to this long, with a cancel. */
export const ASK_TIMEOUT_MS = 45_000;

/**
 * One ask round trip: POST /chat/completions (temperature 0, json_object),
 * validate the response against the registry, retry once at temperature 0
 * with the validation error appended, then fall back to a refusal receipt.
 * A refused proposal (model refusal, invalid twice, empty content) never
 * executes; a fetch failure (network, timeout, abort) throws for the caller
 * to render as an error receipt.
 */
export async function askLlm(
  question: string,
  input: AskInput,
  systemPrompt: string,
  cmds: readonly Command[],
): Promise<AskOutcome> {
  if (!llmConfigured(input.apiKey)) return missingKeyRefusal();

  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/+$/, "");

  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`ask timed out after ${ASK_TIMEOUT_MS / 1000}s`)), ASK_TIMEOUT_MS);
  try {
    const complete = async (extra?: string): Promise<string> => {
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: extra === undefined ? question : `${question}\n\n${extra}` },
      ];
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
          messages,
          temperature: 0,
          // reasoning models count reasoning_tokens against this budget: a
          // 120-token call spends it ALL on reasoning and returns "" — 800
          // keeps ~700 for an actual answer.
          max_tokens: 800,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`llm ${response.status}${body.length > 0 ? `: ${body.slice(0, 200)}` : ""}`);
      }
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      // Empty/whitespace content is NOT a crash: it validates as "empty
      // response", retries once, and then refuses (parent-measured: a
      // reasoning-only response returns "").
      return (data.choices?.[0]?.message?.content ?? "").trim();
    };

    const firstRaw = await complete();
    const firstVeto = vetoReason(firstRaw, cmds);
    if (firstVeto === null) return settle(firstRaw, cmds, input.model) as AskOutcome;

    const retry = settle(
      await complete(`Your previous response was invalid: ${firstVeto}. Respond with ONLY the JSON object from the contract.`),
      cmds,
      input.model,
    );
    if (retry !== null) return retry;

    return {
      status: "refusal",
      refusal: `the ask did not resolve to a registry command · ${firstVeto}`,
      model: input.model,
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** Static suggested-command chips: ask-lines mapped to real registry lines. */
export interface SuggestedAsk {
  /** the natural-language ask-line shown on the chip */
  label: string;
  /** the registry line it maps to (statically, so chips work keyless) */
  line: string;
}

export const SUGGESTED_ASKS: SuggestedAsk[] = [
  { label: "Buy the next UFC card's odds, freshness matters", line: "buy overtime-sports-odds" },
  { label: "What has the venue earned?", line: "books" },
  { label: "Show the last refund", line: "jobs --state refunded" },
  { label: "How fresh is the sports data?", line: "quote overtime-sports-odds" },
  { label: "Who's selling and at what price?", line: "datasets" },
  { label: "Refuse a stale delivery (demo)", line: "sandbox stale" },
];
