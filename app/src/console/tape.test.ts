/**
 * T16 receipt-tape pure-logic tests — fuzzy palette ranking, Tab-completion
 * suggestions, verdict stamps, and the copy-ack state machine. UI-shaped
 * logic only; DOM behavior is covered by the browser probe.
 */
import { describe, expect, it } from "bun:test";
import {
  completionCandidates,
  fuzzyMatch,
  paletteItems,
  rankPalette,
  runLineFor,
  type PaletteItem,
} from "./palette";
import { copyAckReducer, copyAckText, type CopyAck } from "./blocks/copyAck";
import { verdictFor } from "./blocks/verdict";
import { splitHex } from "./blocks/HashChip";
import type { CommandResult } from "./registry";

const CMD = [
  { name: "help", help: "list commands" },
  { name: "status", help: "one-shot health" },
  { name: "ens show", help: "storefront records" },
  { name: "datasets", help: "the storefront menu" },
  { name: "quote", help: "live quote for a dataset" },
  { name: "buy", help: "fund a job" },
  { name: "deliver", help: "submit the payload" },
  { name: "settle", help: "attest and settle" },
  { name: "sandbox stale", help: "built-to-fail job" },
  { name: "sandbox claim", help: "execute claimRefund" },
  { name: "policy try-overspend", help: "simulated overspend" },
];

const DS = [
  { id: "aave-v3-arbitrum-lending", description: "Aave V3 lending" },
  { id: "uniswap-v3-arbitrum-dex", description: "Uniswap V3 AMM" },
  { id: "opensea-nft-trades", description: "OpenSea trades" },
  { id: "ens-registrations", description: "ENS registrations" },
  { id: "overtime-sports-odds", description: "Sports odds" },
];

const rankingItems: PaletteItem[] = [
  { name: "settle", hint: "", kind: "command" },
  { name: "sandbox stale", hint: "", kind: "command" },
  { name: "datasets", hint: "", kind: "command" },
  { name: "opensea-nft-trades", hint: "", kind: "dataset" },
  { name: "ens-registrations", hint: "", kind: "dataset" },
  { name: "status", hint: "", kind: "command" },
];

describe("fuzzy palette ranking", () => {
  it("an empty query keeps every item in order", () => {
    expect(rankPalette("", rankingItems).map((i) => i.name)).toEqual([
      "settle",
      "sandbox stale",
      "datasets",
      "opensea-nft-trades",
      "ens-registrations",
      "status",
    ]);
  });

  it("drops items with no subsequence match", () => {
    expect(fuzzyMatch("status", "zz")).toBeNull();
    expect(rankPalette("zzzz", rankingItems)).toEqual([]);
  });

  it("prefix matches outrank every scattered subsequence", () => {
    const ranked = rankPalette("se", rankingItems).map((i) => i.name);
    expect(ranked[0]).toBe("settle");
    const ix = (name: string): number => ranked.indexOf(name);
    expect(ix("settle")).toBe(0);
    // word-boundary hit beats consecutive-but-late and scattered matches
    expect(ix("sandbox stale")).toBeLessThan(ix("datasets"));
    expect(ix("datasets")).toBeLessThanOrEqual(ix("opensea-nft-trades"));
    expect(ix("opensea-nft-trades")).toBeLessThan(ix("ens-registrations"));
  });

  it("an exact name ranks above everything", () => {
    const ranked = rankPalette("datasets", rankingItems);
    expect(ranked[0]?.name).toBe("datasets");
    expect(fuzzyMatch("datasets", "datasets")).not.toBeNull();
  });

  it("paletteItems groups commands first, then datasets, with kinds", () => {
    const items = paletteItems(CMD, DS);
    expect(items.length).toBe(CMD.length + DS.length);
    expect(items[0]).toEqual({ name: "help", hint: "list commands", kind: "command" });
    expect(items[CMD.length]).toMatchObject({ name: "aave-v3-arbitrum-lending", kind: "dataset" });
    expect(items[CMD.length]?.hint).toBe("Aave V3 lending");
  });
});

describe("tab completion suggestions", () => {
  it("an empty input offers every command, no datasets", () => {
    const items = completionCandidates("", CMD, DS);
    expect(items.length).toBe(CMD.length);
    expect(items.every((i) => i.kind === "command")).toBe(true);
    expect(items[0]?.value).toBe("help ");
  });

  it("completes a single-word command prefix", () => {
    expect(completionCandidates("st", CMD, DS).map((i) => i.label)).toEqual(["status"]);
  });

  it("completes a multi-word command from its second token", () => {
    const items = completionCandidates("ens s", CMD, DS);
    expect(items.map((i) => i.label)).toEqual(["ens show"]);
    expect(items[0]?.value).toBe("ens show ");
  });

  it("completes a dataset id mid-line for quote", () => {
    const items = completionCandidates("quote aav", CMD, DS);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ label: "aave-v3-arbitrum-lending", kind: "dataset" });
    expect(items[0]?.value).toBe("quote aave-v3-arbitrum-lending ");
  });

  it("a trailing space after quote offers command + every dataset", () => {
    const items = completionCandidates("quote ", CMD, DS);
    expect(items[0]?.label).toBe("quote"); // command first, then datasets
    expect(items.filter((i) => i.kind === "dataset").length).toBe(DS.length);
  });

  it("dataset completion stays off for non-dataset commands", () => {
    const items = completionCandidates("status ", CMD, DS);
    expect(items.every((i) => i.kind === "command")).toBe(true);
  });
});

describe("verdict stamps", () => {
  const tx = (kind?: "settled" | "refunded" | "stale" | "open"): CommandResult =>
    ({ render: "tx", data: { hash: `0x${"ab".repeat(32)}`, kind } }) as CommandResult;

  it("a settled tx receipt is APPROVED", () => {
    expect(verdictFor("settle aave-v3-arbitrum-lending", tx("settled"))).toBe("APPROVED");
  });

  it("a refunded tx receipt is REFUNDED", () => {
    expect(verdictFor("sandbox claim", tx("refunded"))).toBe("REFUNDED");
  });

  it("open/stale tx cards print un-stamped", () => {
    expect(verdictFor("settle", tx("open"))).toBeNull();
    expect(verdictFor("settle", tx(undefined))).toBeNull();
  });

  it("a refused policy simulation is REFUSED", () => {
    const kv = {
      render: "kv",
      data: {
        rows: [
          ["pure mirror", "✗ over per-tx cap"],
          ["live probe", "reverted: PolicyBlocked"],
        ],
      },
    } as CommandResult;
    expect(verdictFor("policy try-overspend 2", kv)).toBe("REFUSED");
  });

  it("an allowed policy simulation prints no stamp", () => {
    const kv = { render: "kv", data: { rows: [["pure mirror", "ok · within caps"]] } } as CommandResult;
    expect(verdictFor("policy try-overspend 2", kv)).toBeNull();
  });

  it("captured staleness evidence is REFUSED", () => {
    const kv = {
      render: "kv",
      data: { rows: [["simulate complete", "complete() would revert SlaNotMet · the protocol refuses the stale delivery"]] },
    } as CommandResult;
    expect(verdictFor("sandbox stale", kv)).toBe("REFUSED");
  });

  it("an unattested sandbox prints no stamp", () => {
    const kv = {
      render: "kv",
      data: { rows: [["evidenced refusal", "awaiting the attester key"]] },
    } as CommandResult;
    expect(verdictFor("sandbox stale", kv)).toBeNull();
  });

  it("guarded buy/deliver refusals stamp REFUSED", () => {
    const buy = { render: "kv", data: { rows: [["chain head", "✗ unreachable · buy refused"]] } } as CommandResult;
    const deliver = { render: "kv", data: { rows: [["gateway", "✗ delivery refused · key missing"]] } } as CommandResult;
    expect(verdictFor("buy aave-v3-arbitrum-lending", buy)).toBe("REFUSED");
    expect(verdictFor("deliver", deliver)).toBe("REFUSED");
  });

  it("a settle verdict of APPROVE stamps APPROVED", () => {
    const kv = {
      render: "kv",
      data: {
        rows: [
          ["job", "7"],
          ["verdict", "APPROVE"],
          ["tx", "0x3b2d816d…aa8bb50f"],
          ["split", "seller 0.15 · treasury 0.00"],
        ],
        note: "verdict is APPROVE: SLA met — the hook allowed complete()",
      },
    } as CommandResult;
    expect(verdictFor("settle aave-v3-arbitrum-lending", kv)).toBe("APPROVED");
  });

  it("a settle that refunds instead stamps REFUNDED", () => {
    const kv = {
      render: "kv",
      data: {
        rows: [["verdict", "STALE"], ["refund", "client refunded — full amount, no fee row"]],
        note: "verdict is STALE: stale or invalid — refunded instead",
      },
    } as CommandResult;
    expect(verdictFor("settle", kv)).toBe("REFUNDED");
  });

  it("ordinary kv receipts never stamp", () => {
    const kv = { render: "kv", data: { rows: [["arc head", "42 (live)"]] } } as CommandResult;
    expect(verdictFor("status", kv)).toBeNull();
    expect(verdictFor("sandbox claim", { render: "kv", data: { rows: [["countdown", "not eligible yet"]] } } as CommandResult)).toBeNull();
    expect(verdictFor("help", null)).toBeNull();
  });
});

describe("palette run mapping", () => {
  it("a dataset pick maps to its read-only quote line, never a bare id", () => {
    expect(runLineFor({ name: "aave-v3-arbitrum-lending", hint: "", kind: "dataset" })).toBe(
      "quote aave-v3-arbitrum-lending",
    );
  });

  it("command picks run unchanged, multi-word names included", () => {
    expect(runLineFor({ name: "status", hint: "", kind: "command" })).toBe("status");
    expect(runLineFor({ name: "ens show", hint: "", kind: "command" })).toBe("ens show");
  });
});

describe("copy-ack state", () => {
  const hash = `0x${"cd".repeat(32)}`;

  it("a copy prints the ack for its receipt", () => {
    expect(copyAckReducer(null, { type: "copied", entryId: 3, hash })).toEqual({ entryId: 3, hash });
  });

  it("a failed write prints the failure ack (never the ✓)", () => {
    expect(copyAckReducer(null, { type: "failed", entryId: 3, hash })).toEqual({
      entryId: 3,
      hash,
      failed: true,
    });
  });

  it("the next copy replaces the previous ack", () => {
    const prev: CopyAck = { entryId: 1, hash: `0x${"aa".repeat(32)}` };
    expect(copyAckReducer(prev, { type: "copied", entryId: 4, hash })).toEqual({ entryId: 4, hash });
  });

  it("clear removes the ack (and clearing nothing is a no-op)", () => {
    expect(copyAckReducer({ entryId: 1, hash }, { type: "clear" })).toBeNull();
    expect(copyAckReducer(null, { type: "clear" })).toBeNull();
  });

  it("the printed text is the honest success/failure decision", () => {
    expect(copyAckText({ entryId: 1, hash })).toContain("✓ copied");
    const failed = copyAckText({ entryId: 1, hash, failed: true });
    expect(failed).toContain("copy failed");
    expect(failed).not.toContain("✓");
  });
});

describe("hex splitting for copy chips", () => {
  it("wraps full hex tokens and keeps surrounding text", () => {
    const parts = splitHex("payee 0x1234567890abcdef1234567890abcdef12345678 has the funds");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("payee ");
    expect(parts[1]).toEqual({ hash: "0x1234567890abcdef1234567890abcdef12345678" });
  });

  it("ignores truncated ellipsis display values", () => {
    const parts = splitHex("0x1234…abcd");
    expect(parts).toEqual(["0x1234…abcd"]);
  });
});
