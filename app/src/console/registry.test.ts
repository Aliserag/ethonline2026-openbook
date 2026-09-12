import { describe, expect, it } from "bun:test";
import { commands, dispatch, find, parseArgv, register } from "./registry";
import type { Command, CommandContext } from "./registry";
// Side-effect: registers the 11 inspect + 4 sandbox commands (same imports the Console does).
import "./commands/inspect";
import "./commands/sandbox";

function ctx(): CommandContext {
  return {
    publicClient: {} as never,
    signer: { kind: "none", address: null },
    config: { name: "openbook", ens: "openbook.eth", datasets: [] } as never,
    navigate: () => undefined,
  };
}

/** Narrow to the text render kind; the discrimated union proves data is a string. */
function textOf(result: Awaited<ReturnType<typeof dispatch>>): string {
  if (result.render !== "text") throw new Error(`expected text render, got ${result.render}`);
  return result.data;
}

describe("registry", () => {
  it("help lists every registered command name", async () => {
    const text = textOf(await dispatch("help", ctx()));
    for (const command of commands()) {
      expect(text).toContain(command.name);
    }
  });

  it("help <cmd> prints the one-line help for that command", async () => {
    // Not just the name — the single-line description, which rules out the
    // "unknown command: lag" receipt (its data also contains "lag").
    expect(textOf(await dispatch("help lag", ctx()))).toBe(
      "lag · arc head vs subgraph indexed block (freshness ruler)",
    );
  });

  it("help <multi-word cmd> resolves by longest prefix, not the first token", async () => {
    // "sandbox" is not itself a command; only "sandbox stale" is. The old
    // first-token lookup answered "unknown command: sandbox".
    const text = textOf(await dispatch("help sandbox stale", ctx()));
    expect(text).toContain("sandbox stale");
    expect(text).not.toContain("unknown command");
  });

  it("ships the 11 named inspect/replay commands (T15 count baseline)", () => {
    const names = commands().map((c) => c.name);
    for (const name of [
      "help",
      "status",
      "ens show",
      "datasets",
      "quote",
      "books",
      "jobs",
      "job",
      "lag",
      "policy show",
      "replay",
    ]) {
      expect(names).toContain(name);
    }
    expect(commands().length).toBeGreaterThanOrEqual(11);
  });

  it("find resolves exact and multi-word names", () => {
    expect(find("status")?.name).toBe("status");
    expect(find("ens show")?.name).toBe("ens show");
    expect(find("policy show extra args")?.name).toBe("policy show");
    expect(find("nope")).toBeUndefined();
  });

  it("unknown command returns the exact text result", async () => {
    const result = await dispatch("blorp", ctx());
    expect(result.render).toBe("text");
    expect(result.data).toBe("unknown command: blorp · try help");
  });

  it("unknown multi-word command names the first token", async () => {
    const result = await dispatch("ens fetch", ctx());
    expect(result).toEqual({ render: "text", data: "unknown command: ens · try help" });
  });

  it("register adds a command that help and dispatch see", async () => {
    const original = commands().length;
    register({
      name: "ping",
      help: "pong",
      kind: "inspect",
      run: async () => ({ render: "text", data: "pong" }),
    } satisfies Command);
    expect(commands().length).toBe(original + 1);
    expect(textOf(await dispatch("ping", ctx()))).toBe("pong");
  });

  it("dispatch passes the full argv to run — multi-word commands keep their name", async () => {
    let seen: string[] | null = null;
    register({
      name: "grab snap",
      help: "echo args",
      kind: "inspect",
      run: async (_c, argv) => {
        seen = argv;
        return { render: "text", data: argv.join("|") };
      },
    } satisfies Command);
    expect(textOf(await dispatch("grab snap --big", ctx()))).toBe("grab|snap|--big");
    expect(seen).toEqual(["grab", "snap", "--big"]);
  });

  it("empty line returns an empty text result (no-op)", async () => {
    const result = await dispatch("   ", ctx());
    expect(result.render).toBe("text");
    expect(result.data).toBe("");
  });

  it("a throwing command renders its reason as text, never a raw exception", async () => {
    register({
      name: "boom",
      help: "throws",
      kind: "inspect",
      run: async () => {
        throw new Error("kaboom");
      },
    } satisfies Command);
    expect(textOf(await dispatch("boom", ctx()))).toBe("boom failed: kaboom");
  });
});

describe("parseArgv", () => {
  it("splits flags and values", () => {
    expect(parseArgv("buy x --amount 0.10")).toEqual(["buy", "x", "--amount", "0.10"]);
  });
  it("collapses whitespace and drops empty input", () => {
    expect(parseArgv("  status   \n ")).toEqual(["status"]);
    expect(parseArgv("")).toEqual([]);
    expect(parseArgv("   ")).toEqual([]);
  });
  it("keeps quoted phrases together", () => {
    expect(parseArgv('replay "42"')).toEqual(["replay", "42"]);
    expect(parseArgv("note 'hello world' now")).toEqual(["note", "hello world", "now"]);
  });
});
