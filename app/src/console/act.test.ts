/**
 * T8 act command tests: argv parsing (ENS-price default), the buy guard's
 * exact copy, the subname-first price-resolution helper, classifyRevert over
 * synthetic revert data, and registry registration of buy/deliver/settle.
 */
import { describe, expect, it } from "bun:test";
import { keccak256, toBytes } from "viem";
import { commands, dispatch } from "./registry";
import type { EnsTextReader } from "../../../mcp/src/ens";
import {
  canBuy,
  classifyRevert,
  parseBuyArgs,
  resolveDatasetRecord,
} from "./commands/act";
// Side-effect: registers buy/deliver/settle (same import the app will make).
import "./commands/act";

/** A fake ENS reader that answers only the records the fake storefront sets. */
function reader(records: Record<string, string | null>): EnsTextReader {
  return async (name, key) => records[`${name}|${key}`] ?? null;
}

describe("parseBuyArgs", () => {
  it("defaults the amount to the ENS price (subname record wins)", async () => {
    const records = {
      "aave-v3-arbitrum-lending.openbook.eth|svc.price": "0.10 USDC/query",
      "openbook.eth|svc.sla": '{"maxBlockLag": 50, "maxLatencyMs": 2000}',
    };
    const args = await parseBuyArgs(["buy", "aave-v3-arbitrum-lending"], reader(records));
    expect(args).toEqual({ datasetId: "aave-v3-arbitrum-lending", amountUsdc: 100000 });
  });

  it("falls back to the parent storefront price when the subname is unset", async () => {
    const records = {
      "openbook.eth|svc.price": "0.25 USDC/query",
      "openbook.eth|svc.sla": '{"maxBlockLag": 50, "maxLatencyMs": 2000}',
    };
    const args = await parseBuyArgs(["buy", "uniswap-v3-arbitrum-dex"], reader(records));
    expect(args).toEqual({ datasetId: "uniswap-v3-arbitrum-dex", amountUsdc: 250000 });
  });

  it("requires the svc.sla record too (no freshness window, no buy)", async () => {
    const records = { "openbook.eth|svc.price": "0.10 USDC/query" };
    await expect(parseBuyArgs(["buy", "aave-v3-arbitrum-lending"], reader(records))).rejects.toThrow(
      "svc.sla is not set",
    );
  });

  it("--amount overrides the ENS price", async () => {
    const records = {
      "openbook.eth|svc.price": "0.10 USDC/query",
      "openbook.eth|svc.sla": '{"maxBlockLag": 50, "maxLatencyMs": 2000}',
    };
    const args = await parseBuyArgs(
      ["buy", "aave-v3-arbitrum-lending", "--amount", "0.75"],
      reader(records),
    );
    expect(args.amountUsdc).toBe(750000);
  });

  it("rejects invalid --amount", async () => {
    const records = {
      "openbook.eth|svc.price": "0.10 USDC/query",
      "openbook.eth|svc.sla": '{"maxBlockLag": 50, "maxLatencyMs": 2000}',
    };
    await expect(
      parseBuyArgs(["buy", "aave-v3-arbitrum-lending", "--amount", "junk"], reader(records)),
    ).rejects.toThrow("invalid --amount");
  });

  it("rejects unknown datasets and missing dataset args", async () => {
    await expect(parseBuyArgs(["buy", "nope"], reader({}))).rejects.toThrow("unknown dataset: nope");
    await expect(parseBuyArgs(["buy"], reader({}))).rejects.toThrow("usage: buy");
  });
});

describe("canBuy", () => {
  it("no signer → the exact instructive copy (demo key or wallet-connect)", () => {
    expect(canBuy({ signer: "none", balance: 1_000_000n, amount: 100_000n })).toEqual({
      ok: false,
      reason: "no signer — connect a wallet or set VITE_DEMO_BUYER_KEY",
    });
  });

  it("balance < amount → the faucet recovery message", () => {
    const result = canBuy({ signer: "demo", balance: 50_000n, amount: 100_000n });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("faucet.circle.com");
      expect(result.reason).toContain("low USDC balance");
    }
  });

  it("sufficient balance + signer → ok", () => {
    expect(canBuy({ signer: "demo", balance: 100_000n, amount: 100_000n })).toEqual({ ok: true });
  });

  it("injected signer is a signer", () => {
    expect(canBuy({ signer: "injected", balance: 200_000n, amount: 100_000n })).toEqual({ ok: true });
  });
});

describe("resolveDatasetRecord (price resolution: subname first)", () => {
  it("a set subname record wins", () => {
    expect(resolveDatasetRecord("0.50 USDC/query", "0.10 USDC/query")).toBe("0.50 USDC/query");
  });

  it("falls back to the parent when the subname is unset", () => {
    expect(resolveDatasetRecord(null, "0.10 USDC/query")).toBe("0.10 USDC/query");
  });

  it("both unset → null", () => {
    expect(resolveDatasetRecord(null, null)).toBeNull();
  });
});

describe("classifyRevert", () => {
  const selector = (sig: string): `0x${string}` =>
    keccak256(toBytes(sig)).slice(0, 10) as `0x${string}`;
  const data = (sel: string, tail = ""): `0x${string}` => `${sel}${tail}` as `0x${string}`;

  const errorString = (message: string): `0x${string}` => {
    const hex = Buffer.from(message, "utf8").toString("hex");
    const offset = "0".repeat(62) + "20";
    const len = message.length.toString(16).padStart(64, "0");
    const body = (hex + "0".repeat(64)).slice(0, 64);
    return data("0x08c379a0", `${offset}${len}${body}`);
  };

  it("names the SlaHook SlaNotMet revert (full signature selector)", () => {
    expect(classifyRevert(data(selector("SlaNotMet(uint256,uint256)"), "00".repeat(64)))).toBe("SlaNotMet");
  });

  it("names NotAttester and MissingAttestation", () => {
    expect(classifyRevert(data(selector("NotAttester()")))).toBe("NotAttester");
    expect(classifyRevert(data(selector("MissingAttestation()")))).toBe("MissingAttestation");
  });

  it("names the PolicyWallet cap errors", () => {
    expect(classifyRevert(data(selector("PerTxCapExceeded()")))).toBe("PerTxCapExceeded");
    expect(classifyRevert(data(selector("DailyCapExceeded()")))).toBe("DailyCapExceeded");
    expect(classifyRevert(data(selector("NotAllowlisted()")))).toBe("NotAllowlisted");
  });

  it("decodes Error(string) — the onlyAgentOrOwner require(from ..., \"not agent\")", () => {
    expect(classifyRevert(errorString("not agent"))).toBe("onlyAgentOrOwner");
    expect(classifyRevert(errorString("not owner"))).toBe("Error(string): not owner");
  });

  it("renders unknown selectors as their hex prefix, never a fabricated name", () => {
    expect(classifyRevert(data(selector("SomethingElse()")))).toBe(`unknown selector ${selector("SomethingElse()")}`);
  });
});

describe("registry registration (carry-in names)", () => {
  it("buy / deliver / settle are registered", () => {
    const names = commands().map((c) => c.name);
    for (const name of ["buy", "deliver", "settle"]) expect(names).toContain(name);
  });

  it("dispatch reaches the registered act commands without a signer (guard row)", async () => {
    const ctx = {
      publicClient: {} as never,
      signer: { kind: "none", address: null },
      config: { ens: "openbook.eth", datasets: [] } as never,
      navigate: () => undefined,
    };
    // No incoming message, no ENS records → buy refuses BEFORE any live read:
    // the unknown-dataset path is pure argv handling.
    const result = await dispatch("buy nope", ctx);
    expect(result.render).toBe("text");
    if (result.render === "text") expect(result.data).toContain("unknown dataset: nope");
  });
});
