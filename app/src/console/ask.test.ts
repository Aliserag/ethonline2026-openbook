/**
 * Ask-mode contract tests (pure): proposal parsing/validation, the
 * confirmation gate, the no-key path, the arity/enumeration gates, the
 * static chip mappings, and stubbed-fetch LLM round trips (valid once,
 * hallucinated-dataset retry, malformed retry, empty-content refusal,
 * two-invalid refusal, model refusal without retry, fetch failure).
 * No DOM: Console.tsx's keyboard/browser wiring is covered by the browser
 * pass, not here.
 */
import { describe, expect, it } from "bun:test";
import {
  arityOf,
  ASK_TIMEOUT_MS,
  askLlm,
  buildSystemPrompt,
  datasetMenu,
  DATASET_IDS,
  missingKeyRefusal,
  offerAskFor,
  parseProposal,
  proposalLine,
  registrySchema,
  requiresRun,
  SUGGESTED_ASKS,
  validateProposal,
  type AskInput,
  type AskProposal,
} from "./ask";
import { CONFIG } from "../config";
import { commands, find, type Command } from "./registry";
// Side-effect registration of the real registry (same imports the Console does).
import "./commands/inspect";
import "./commands/sandbox";
import "./commands/act";

/** Live registry snapshot (the side-effect command imports run before this). */
const CMDS = (): readonly Command[] => commands();

function proposal(over: Partial<AskProposal> = {}): AskProposal {
  return { command: "quote", argv: ["overtime-sports-odds"], rationale: "price check", ...over };
}

function okJson(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Scripted fetch: serves `contents` in order (last content repeats). */
function stubFetch(contents: string[]): (typeof fetch) & { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const content = contents[Math.min(i, contents.length - 1)] ?? "";
    i += 1;
    return okJson(content);
  }) as (typeof fetch) & { calls: { url: string; body: Record<string, unknown> }[] };
  fn.calls = calls;
  return fn;
}

function input(over: Partial<AskInput> = {}): AskInput {
  return {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKey: "sk-test-key",
    model: "accounts/fireworks/models/deepseek-v4p1-flash",
    fetchImpl: stubFetch(['{"command":"quote","argv":["overtime-sports-odds"],"rationale":"price"}']),
    ...over,
  };
}

describe("parseProposal", () => {
  it("accepts a valid proposal object", () => {
    const parsed = parseProposal('{"command":"quote","argv":["aave-v3-arbitrum-lending"],"rationale":"check price"}');
    expect(parsed.kind).toBe("proposal");
    if (parsed.kind !== "proposal") return;
    expect(parsed.proposal).toEqual({
      command: "quote",
      argv: ["aave-v3-arbitrum-lending"],
      rationale: "check price",
    });
  });

  it("tolerates a ```json fence wrap", () => {
    const parsed = parseProposal('```json\n{"command":"lag","argv":[],"rationale":"freshness"}\n```');
    expect(parsed).toEqual({ kind: "proposal", proposal: { command: "lag", argv: [], rationale: "freshness" } });
  });

  it("returns a refusal for a refusal object", () => {
    const parsed = parseProposal('{"refusal":"no command maps to this"}');
    expect(parsed).toEqual({ kind: "refusal", refusal: "no command maps to this" });
  });

  it("rejects malformed JSON with the parse reason", () => {
    const parsed = parseProposal("buy quote please");
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") expect(parsed.reason).toContain("not JSON");
  });

  it("rejects empty and whitespace-only responses", () => {
    expect(parseProposal("").kind).toBe("invalid");
    expect(parseProposal("   \n\t ").kind).toBe("invalid");
  });

  it("rejects non-object JSON", () => {
    expect(parseProposal('["quote"]').kind).toBe("invalid");
    expect(parseProposal('"quote"').kind).toBe("invalid");
  });

  it("rejects missing command, non-string argv, and missing rationale", () => {
    expect(parseProposal('{"argv":[],"rationale":"x"}').kind).toBe("invalid");
    expect(parseProposal('{"command":"quote","argv":[42],"rationale":"x"}').kind).toBe("invalid");
    expect(parseProposal('{"command":"quote","argv":[]}').kind).toBe("invalid");
  });

  it("tolerates extra keys alongside the contract fields", () => {
    const parsed = parseProposal('{"command":"status","argv":[],"rationale":"health","confidence":0.9}');
    expect(parsed.kind).toBe("proposal");
  });
});

describe("validateProposal", () => {
  it("accepts exact registry names with correct arity", () => {
    expect(validateProposal(proposal(), CMDS())).toBeNull();
    expect(validateProposal({ command: "ens show", argv: [], rationale: "storefront" }, CMDS())).toBeNull();
    expect(validateProposal({ command: "jobs", argv: ["--state", "refunded"], rationale: "last refund" }, CMDS())).toBeNull();
    expect(validateProposal({ command: "settle", argv: [], rationale: "close" }, CMDS())).toBeNull();
  });

  it("rejects a hallucinated command name and names the registry", () => {
    const veto = validateProposal({ command: "time-travel", argv: [], rationale: "x" }, CMDS());
    expect(veto).not.toBeNull();
    expect(veto).toContain('unknown command "time-travel"');
    expect(veto).toContain("quote");
  });

  it("rejects a hallucinated dataset id (measured case: buy ufc-predictions)", () => {
    const veto = validateProposal({ command: "buy", argv: ["ufc-predictions"], rationale: "sports odds" }, CMDS());
    expect(veto).not.toBeNull();
    expect(veto).toContain('"buy" dataset must be exactly one of');
    expect(veto).toContain("overtime-sports-odds");
  });

  it("rejects wrong arg arity: too few and too many", () => {
    const tooFew = validateProposal({ command: "quote", argv: [], rationale: "x" }, CMDS());
    expect(tooFew).toContain("quote");
    expect(tooFew).toContain("at least 1");
    const tooMany = validateProposal({ command: "settle", argv: ["y"], rationale: "x" }, CMDS());
    expect(tooMany).toContain("settle");
    expect(tooMany).toContain("at most 0");
  });

  it("rejects a non-command help target", () => {
    const veto = validateProposal({ command: "help", argv: ["nonsense"], rationale: "x" }, CMDS());
    expect(veto).toContain("target must be an exact command name");
  });
});

describe("offerAskFor (nudge ⇔ Tab agreement, round-1 review)", () => {
  it("strict command prefixes complete instead of offering ask; garbage offers ask", () => {
    const cmds = CMDS();
    const datasets = CONFIG.datasets;
    // strict prefixes have completion candidates -> Tab completes, no nudge
    expect(offerAskFor("qu", cmds, datasets)).toBe(false);
    expect(offerAskFor("bo", cmds, datasets)).toBe(false);
    expect(offerAskFor("sandbox cl", cmds, datasets)).toBe(false);
    expect(offerAskFor("policy s", cmds, datasets)).toBe(false);
    // resolvable input is never nudged even with zero dataset candidates
    expect(offerAskFor("quote", cmds, datasets)).toBe(false);
    // nothing resolves nor completes -> the nudge offers ask and Tab switches
    expect(offerAskFor("banana", cmds, datasets)).toBe(true);
    expect(offerAskFor("show me the money", cmds, datasets)).toBe(true);
    // empty / whitespace inputs are never nudged
    expect(offerAskFor("", cmds, datasets)).toBe(false);
    expect(offerAskFor("   ", cmds, datasets)).toBe(false);
  });
});

describe("arityOf", () => {
  it("derives min/max from the usage string", () => {
    expect(arityOf("buy <dataset> [--amount <usdc>]")).toEqual({ min: 1, max: 3 });
    expect(arityOf("quote <dataset>")).toEqual({ min: 1, max: 1 });
    expect(arityOf("jobs [--state settled|refunded|open]")).toEqual({ min: 0, max: 2 });
    expect(arityOf("help [cmd]")).toEqual({ min: 0, max: 1 });
    expect(arityOf("replay <jobId>")).toEqual({ min: 1, max: 1 });
    expect(arityOf(undefined)).toEqual({ min: 0, max: 0 });
  });
});

describe("requiresRun (confirmation gate)", () => {
  it("gates act and sandbox; inspect and replay run on Enter", () => {
    expect(requiresRun("act")).toBe(true);
    expect(requiresRun("sandbox")).toBe(true);
    expect(requiresRun("inspect")).toBe(false);
    expect(requiresRun("replay")).toBe(false);
  });
});

describe("registrySchema / datasetMenu / buildSystemPrompt", () => {
  it("enumerates every command with args, kind and help", () => {
    const schema = registrySchema(CMDS());
    for (const name of ["buy", "deliver", "settle", "quote", "jobs", "lag", "sandbox stale", "replay"]) {
      expect(schema).toContain(name);
    }
    expect(schema).toContain("kind: act");
    expect(schema).toContain("kind: inspect");
  });

  it("enumerates the exact dataset ids in the menu and the prompt", () => {
    const menu = datasetMenu();
    expect(DATASET_IDS).toContain("overtime-sports-odds");
    for (const id of DATASET_IDS) expect(menu).toContain(id);
    const prompt = buildSystemPrompt(registrySchema(CMDS()), "live context");
    expect(prompt).toContain("REGISTRY");
    expect(prompt).toContain("DATASETS");
    expect(prompt).toContain('"command"');
    expect(prompt).toContain("refusal");
  });
});

describe("proposalLine", () => {
  it("joins command and argv into the dispatchable line", () => {
    expect(proposalLine({ command: "buy", argv: ["overtime-sports-odds", "--amount", "0.10"], rationale: "x" }))
      .toBe("buy overtime-sports-odds --amount 0.10");
    expect(proposalLine({ command: "lag", argv: [], rationale: "x" })).toBe("lag");
  });
});

describe("missingKeyRefusal (no-key path)", () => {
  it("is a refusal that names the env var and keeps everything else intact", () => {
    const outcome = missingKeyRefusal();
    expect(outcome.status).toBe("refusal");
    expect(outcome.refusal).toContain("VITE_LLM_API_KEY");
  });

  it("askLlm with an empty or whitespace key refuses without calling fetch", async () => {
    for (const key of ["", "   "]) {
      const fetchImpl = stubFetch([]);
      const outcome = await askLlm("hello", input({ apiKey: key, fetchImpl }), "system", CMDS());
      expect(outcome.status).toBe("refusal");
      if (outcome.status === "refusal") expect(outcome.refusal).toContain("VITE_LLM_API_KEY");
      expect(fetchImpl.calls.length).toBe(0);
    }
  });
});

describe("askLlm round trips (stubbed fetch)", () => {
  it("POSTs the OpenAI-compatible contract and returns a valid proposal", async () => {
    const fetchImpl = stubFetch(['{"command":"buy","argv":["overtime-sports-odds"],"rationale":"fresh sports odds"}']);
    const outcome = await askLlm(
      "buy fresh sports odds, accurate to the last minute",
      input({ fetchImpl }),
      buildSystemPrompt(registrySchema(CMDS()), "live"),
      CMDS(),
    );
    expect(outcome.status).toBe("proposal");
    if (outcome.status !== "proposal") return;
    expect(outcome.proposal).toEqual({ command: "buy", argv: ["overtime-sports-odds"], rationale: "fresh sports odds" });
    expect(outcome.model).toBe("accounts/fireworks/models/deepseek-v4p1-flash");

    const call = fetchImpl.calls[0];
    expect(call.url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect(call.body.model).toBe("accounts/fireworks/models/deepseek-v4p1-flash");
    expect(call.body.temperature).toBe(0);
    expect(call.body.max_tokens).toBe(800);
    expect(call.body.response_format).toEqual({ type: "json_object" });
    const messages = call.body.messages as { role: string; content: string }[];
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "buy fresh sports odds, accurate to the last minute" });
  });

  it("retries once when the first response hallucinates a dataset id, appending the veto", async () => {
    const fetchImpl = stubFetch([
      '{"command":"buy","argv":["ufc-predictions"],"rationale":"sports odds"}',
      '{"command":"buy","argv":["overtime-sports-odds"],"rationale":"sports odds"}',
    ]);
    const outcome = await askLlm("buy fresh sports odds", input({ fetchImpl }), "system", CMDS());
    expect(fetchImpl.calls.length).toBe(2);
    expect(outcome.status).toBe("proposal");
    if (outcome.status !== "proposal") return;
    expect(outcome.proposal.command).toBe("buy");
    expect(outcome.proposal.argv).toEqual(["overtime-sports-odds"]);
    const retryMessages = fetchImpl.calls[1].body.messages as { role: string; content: string }[];
    expect(retryMessages[1].content).toContain("ufc-predictions");
    expect(retryMessages[1].content).toContain("invalid");
  });

  it("retries once on malformed JSON and accepts the second response", async () => {
    const fetchImpl = stubFetch(["definitely not json", '{"command":"lag","argv":[],"rationale":"head"}']);
    const outcome = await askLlm("how fresh", input({ fetchImpl }), "system", CMDS());
    expect(fetchImpl.calls.length).toBe(2);
    expect(outcome).toEqual({
      status: "proposal",
      proposal: { command: "lag", argv: [], rationale: "head" },
      model: "accounts/fireworks/models/deepseek-v4p1-flash",
    });
  });

  it("treats empty content as a refusal-class failure after the retry, never a crash", async () => {
    const fetchImpl = stubFetch(["", "  "]);
    const outcome = await askLlm("anything", input({ fetchImpl }), "system", CMDS());
    expect(fetchImpl.calls.length).toBe(2);
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") expect(outcome.refusal).toContain("did not resolve");
  });

  it("refuses after two invalid responses, without throwing", async () => {
    const fetchImpl = stubFetch(['{"command":"buy","argv":["nope"],"rationale":"x"}', "garbage"]);
    const outcome = await askLlm("buy stuff", input({ fetchImpl }), "system", CMDS());
    expect(fetchImpl.calls.length).toBe(2);
    expect(outcome.status).toBe("refusal");
    if (outcome.status === "refusal") {
      expect(outcome.refusal).toContain("did not resolve");
      expect(outcome.refusal).toContain("nope");
    }
  });

  it("returns a model refusal as-is WITHOUT a retry", async () => {
    const fetchImpl = stubFetch(['{"refusal":"no registry command shows weather"}']);
    const outcome = await askLlm("what is the weather", input({ fetchImpl }), "system", CMDS());
    expect(fetchImpl.calls.length).toBe(1);
    expect(outcome).toEqual({ status: "refusal", refusal: "no registry command shows weather", model: "accounts/fireworks/models/deepseek-v4p1-flash" });
  });

  it("surfaces a fetch failure as a thrown error (network/HTTP, not refusal)", async () => {
    const fn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const outcome = askLlm("help", input({ fetchImpl: fn }), "system", CMDS());
    await expect(outcome).rejects.toThrow(/llm 500/);
  });

  it("exposes the in-flight budget the asking state shows", () => {
    expect(ASK_TIMEOUT_MS).toBe(45_000);
  });
});

describe("SUGGESTED_ASKS", () => {
  it("is static, exactly six chips, and every mapping resolves in the registry (keyless)", () => {
    expect(SUGGESTED_ASKS).toHaveLength(6);
    for (const ask of SUGGESTED_ASKS) {
      expect(find(ask.line), `chip line "${ask.line}" must resolve`).toBeDefined();
    }
    expect(SUGGESTED_ASKS.some((a) => a.line === "buy overtime-sports-odds")).toBe(true);
    expect(SUGGESTED_ASKS.some((a) => a.line === "datasets")).toBe(true);
  });
});
