/**
 * sell CLI tests (marketplace W1).
 *
 * Pure, keyless: init writes real SellerConfig files into temp dirs; the
 * config→dataset mapping is asserted field-for-field; register is exercised
 * against injected ens/cast/read seams (the default runners shell out to the
 * live ens CLI + cast and are never touched by tests).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import {
  MARKET_ESCROW,
  MARKET_HOOK,
  MARKET_OPERATOR,
  buildSellerConfig,
  buildSvcRecords,
  initSeller,
  loadSellerConfig,
  parsePriceToUsdc6dec,
  registerSeller,
  toOpenBookConfig,
  type RegisteredSeller,
  type RegisterDeps,
  type SellerConfig,
} from "../agent/sell-cli";

const ALPHA_PAYEE: Address = "0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21";
const ALPHA_OPERATOR: Address = "0x1111111111111111111111111111111111111111";

function alphaConfig(payee: Address = ALPHA_PAYEE): SellerConfig {
  return {
    name: "alpha",
    ens: "alpha.openbook.eth",
    escrow: MARKET_ESCROW,
    hook: MARKET_HOOK,
    payee,
    operatorKey: "SELLER_ALPHA_PK",
    gateway: { url: "https://gateway.thegraph.com", gatewayKeyEnv: "GRAPH_GATEWAY_KEY" },
    datasets: [
      {
        id: "aave-v3-arbitrum-lending",
        subgraphId: "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
        schema: "lending/3.1.0",
        description: "Aave V3 lending markets on Arbitrum (Messari lending schema)",
        freshness: { maxAge: 50 },
        priceUsdc: 120000,
        pinned: true,
        chain: "arbitrum",
      },
    ],
  };
}

describe("sell init", () => {
  it("writes sellers/<slug>.json matching SellerConfig for the alpha demo", () => {
    const dir = mkdtempSync(join(tmpdir(), "sell-init-"));
    try {
      const path = initSeller({
        name: "alpha",
        schema: "lending/3.1.0",
        price: "0.12",
        dir,
      });
      expect(path).toBe(join(dir, "alpha.json"));
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      expect(parsed).toEqual({
        name: "alpha",
        ens: "alpha.openbook.eth",
        escrow: MARKET_ESCROW,
        hook: MARKET_HOOK,
        payee: MARKET_OPERATOR,
        operatorKey: "SELLER_ALPHA_PK",
        gateway: { url: "https://gateway.thegraph.com", gatewayKeyEnv: "GRAPH_GATEWAY_KEY" },
        datasets: [
          {
            id: "aave-v3-arbitrum-lending",
            subgraphId: "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
            schema: "lending/3.1.0",
            description: "Aave V3 lending markets on Arbitrum (Messari lending schema)",
            freshness: { maxAge: 50 },
            priceUsdc: 120000,
            chain: "arbitrum",
          },
        ],
      });
      // the written file reloads through the validator into a valid SellerConfig
      expect(loadSellerConfig(path)).toEqual({
        ...alphaConfig(),
        payee: MARKET_OPERATOR,
        datasets: [expect.objectContaining({ pinned: true })],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a duplicate slug without --force and overwrites with --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "sell-dup-"));
    try {
      const first = initSeller({ name: "alpha", schema: "lending/3.1.0", price: "0.12", dir });
      expect(() => initSeller({ name: "alpha", schema: "lending/3.1.0", price: "0.12", dir })).toThrow(
        /already exists.*--force/,
      );
      expect(readFileSync(first, "utf8")).toBe(readFileSync(join(dir, "alpha.json"), "utf8"));
      const second = initSeller({
        name: "alpha",
        schema: "lending/3.1.0",
        price: "0.15",
        force: true,
        dir,
      });
      expect(second).toBe(first);
      const reloaded = loadSellerConfig(second);
      expect(reloaded.datasets[0].priceUsdc).toBe(150000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed price and an invalid slug before writing anything", () => {
    expect(() => parsePriceToUsdc6dec("not-a-price")).toThrow(/--price/);
    expect(() => buildSellerConfig({ name: "Alpha!", schema: "lending/3.1.0", price: "0.12" })).toThrow(
      /--name/,
    );
    expect(() => buildSellerConfig({ name: "beta", schema: "mystery/9.9.9", price: "0.12" })).toThrow(
      /--subgraph/,
    );
  });
});

describe("config→dataset mapping (toOpenBookConfig)", () => {
  it("maps the frozen SellerConfig onto the loop's OpenBookConfig", () => {
    const seller = alphaConfig();
    const mapped = toOpenBookConfig(seller);
    expect(mapped.name).toBe("alpha");
    expect(mapped.ens).toBe("alpha.openbook.eth");
    expect(mapped.escrow).toBe(MARKET_ESCROW);
    expect(mapped.payee).toBe(ALPHA_PAYEE);
    expect(mapped.operatorKey).toBe("SELLER_ALPHA_PK");
    expect(mapped.gateway).toEqual({
      keyEnv: "GRAPH_GATEWAY_KEY",
      baseUrl: "https://gateway.thegraph.com",
    });
    expect(mapped.pnl.endpoint).toContain("api.studio.thegraph.com");
    expect(mapped.datasets[0]).toEqual(
      expect.objectContaining({
        id: "aave-v3-arbitrum-lending",
        schema: "lending/3.1.0",
        priceUsdc: 120000,
        chain: "arbitrum",
        pinned: true,
      }),
    );
  });

  it("builds a custom (non-pinned) dataset from an explicit --subgraph", () => {
    const seller = buildSellerConfig({
      name: "beta",
      schema: "custom/1.0.0",
      price: "0.20",
      subgraph: "BJZUbWf1fYxdaY8N8Z8x8x8x8x8x8x8x8x8x8x8x8x8x8x8x8",
    });
    expect(seller.datasets[0]).toEqual(
      expect.objectContaining({
        id: "beta-custom-1.0.0",
        schema: "custom/1.0.0",
        priceUsdc: 200000,
        pinned: false,
        chain: "arbitrum",
      }),
    );
  });

  it("keeps the pinned identity when --subgraph matches the catalog pin", () => {
    const seller = buildSellerConfig({
      name: "beta",
      schema: "lending/3.1.0",
      price: "0.10",
      subgraph: "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
    });
    expect(toOpenBookConfig(seller).datasets[0].pinned).toBe(true);
    expect(seller.datasets[0].id).toBe("aave-v3-arbitrum-lending");
  });
});

describe("seller config validation", () => {
  it("rejects malformed configs (bad address, missing operator key, bad dataset)", () => {
    const base = alphaConfig();
    expect(() => loadSellerConfigFromObject({ ...base, escrow: "0x123" })).toThrow(/escrow/);
    const noKey = { ...base, operatorKey: "" };
    expect(() => loadSellerConfigFromObject(noKey)).toThrow(/operatorKey/);
    const badDataset = { ...base, datasets: [{ ...base.datasets[0], chain: "polygon" }] };
    expect(() => loadSellerConfigFromObject(badDataset)).toThrow(/chain/);
    const badPrice = { ...base, datasets: [{ ...base.datasets[0], priceUsdc: -1 }] };
    expect(() => loadSellerConfigFromObject(badPrice)).toThrow(/priceUsdc/);
  });

  it("rejects an empty dataset array", () => {
    expect(() => loadSellerConfigFromObject({ ...alphaConfig(), datasets: [] })).toThrow(/datasets/);
  });
});

describe("svc.* records built for register", () => {
  it("produces menu/price/sla/payee/operator for a single-dataset seller", () => {
    const ops = buildSvcRecords(alphaConfig(), ALPHA_OPERATOR);
    expect(ops).toEqual([
      {
        type: "text",
        key: "svc.menu",
        value: '[{"id":"aave-v3-arbitrum-lending","schema":"lending/3.1.0"}]',
      },
      { type: "text", key: "svc.price", value: "0.12 USDC/query" },
      { type: "text", key: "svc.sla", value: '{"maxBlockLag":50,"maxLatencyMs":2000}' },
      { type: "text", key: "svc.payee", value: ALPHA_PAYEE },
      { type: "text", key: "svc.operator", value: ALPHA_OPERATOR },
    ]);
  });

  it("refuses mixed prices (svc.price is name-level)", () => {
    const two = alphaConfig();
    two.datasets.push({ ...two.datasets[0], id: "other-lending", priceUsdc: 150000 });
    expect(() => buildSvcRecords(two, ALPHA_OPERATOR)).toThrow(/one price/);
  });

  it("carries the tightest freshness guarantee when datasets share a price", () => {
    const two = alphaConfig();
    two.datasets.push({
      ...two.datasets[0],
      id: "other-lending",
      schema: "lending/3.1.0",
      freshness: { maxAge: 20 },
    });
    const ops = buildSvcRecords(two, ALPHA_OPERATOR);
    expect(JSON.parse(ops[2].value)).toEqual({ maxBlockLag: 20, maxLatencyMs: 2000 });
  });
});

describe("register wiring (injected ens/cast/read seams)", () => {
  /** Foundry anvil fixture key — a test key, never a real secret. */
  const TEST_SELLER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const TEST_SELLER_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // derived from the key above
  const RECORDS: Record<string, string> = {
    "svc.menu": '[{"id":"aave-v3-arbitrum-lending","schema":"lending/3.1.0"}]',
    "svc.price": "0.12 USDC/query",
    "svc.sla": '{"maxBlockLag":50,"maxLatencyMs":2000}',
    "svc.payee": ALPHA_PAYEE,
    "svc.operator": TEST_SELLER_ADDR,
  };
  const readEnsText = async (name: string, key: string): Promise<string | null> =>
    RECORDS[key] ?? null;

  function stubDeps(logLines: string[]): RegisterDeps & {
    ensCalls: string[][];
    castCalls: string[][];
    castSend: (to: string, data: string) => string;
  } {
    const ensCalls: string[][] = [];
    const castCalls: string[][] = [];
    const castSend = (to: string, data: string): string => {
      castCalls.push([to, data]);
      return `0x${"c".repeat(64)}`;
    };
    return {
      env: {
        SEPOLIA_RPC: "https://rpc",
        SEPOLIA_PK: "0x1111111111111111111111111111111111111111111111111111111111111111",
        SELLER_ALPHA_PK: TEST_SELLER_KEY,
      },
      log: (line) => logLines.push(line),
      ensCli: (args) => {
        ensCalls.push(args);
        if (args[0] === "subname" && args[1] === "create") {
          return JSON.stringify({ to: "0x8eC443d5e7BCB2E9182c83CE96295dFc35085f29", data: "0xbeef", value: "0" });
        }
        if (args[0] === "set" && args[1] === "batch") {
          return JSON.stringify({ to: "0x59d9d95e8dEC7745a3A4243dB45458bfE513b0a3", data: "0xcafe", value: "0" });
        }
        throw new Error(`unexpected ens call: ${args.join(" ")}`);
      },
      castSend,
      readEnsText,
      ensCalls,
      castCalls,
    };
  }

  it("creates the subname owned by the payee, sets the records, and prints the read-back", async () => {
    const logLines: string[] = [];
    const deps = stubDeps(logLines);
    const result: RegisteredSeller = await registerSeller(alphaConfig(), deps);

    expect(deps.ensCalls[0]).toEqual(["subname", "create", "alpha.openbook.eth", "--owner", ALPHA_PAYEE]);
    const setCall = deps.ensCalls[1];
    expect(setCall[0]).toBe("set");
    expect(setCall[1]).toBe("batch");
    expect(setCall[2]).toBe("alpha.openbook.eth");
    expect(JSON.parse(setCall[4])).toEqual([
      { type: "text", key: "svc.menu", value: '[{"id":"aave-v3-arbitrum-lending","schema":"lending/3.1.0"}]' },
      { type: "text", key: "svc.price", value: "0.12 USDC/query" },
      { type: "text", key: "svc.sla", value: '{"maxBlockLag":50,"maxLatencyMs":2000}' },
      { type: "text", key: "svc.payee", value: ALPHA_PAYEE },
      { type: "text", key: "svc.operator", value: TEST_SELLER_ADDR },
    ]);
    expect(deps.castCalls).toHaveLength(2);
    expect(result.subnameTxs).toEqual([`0x${"c".repeat(64)}`]);
    expect(result.recordsTxs).toEqual([`0x${"c".repeat(64)}`]);
    expect(result.priceUsdc).toBe(120000);
    expect(result.sla).toEqual({ maxBlockLag: 50, maxLatencyMs: 2000 });
    expect(result.records.price).toBe("0.12 USDC/query");
    expect(result.records.operator).toBe(TEST_SELLER_ADDR);
    expect(logLines.some((line) => line.includes("read-back"))).toBe(true);
    expect(logLines.some((line) => line.includes("svc.price    = 0.12 USDC/query"))).toBe(true);
    expect(logLines.some((line) => line.includes(`operator identity = ${TEST_SELLER_ADDR}`))).toBe(true);
  });

  it("recovers an already-registered subname via the svc.price probe", async () => {
    const logLines: string[] = [];
    const deps = stubDeps(logLines);
    const failing = deps.ensCli as (args: string[]) => string;
    const original = failing;
    // subname create fails; the recovery probe reads svc.price and finds it set
    let createCalls = 0;
    deps.ensCli = (args) => {
      if (args[0] === "subname" && args[1] === "create") {
        createCalls++;
        throw new Error("broadcast failed: execution reverted");
      }
      if (args[0] === "get" && args[1] === "text") {
        return JSON.stringify({ name: "alpha.openbook.eth", key: "svc.price", value: "0.12 USDC/query" });
      }
      return original(args);
    };
    const result: RegisteredSeller = await registerSeller(alphaConfig(), deps);
    expect(createCalls).toBe(1);
    expect(result.subnameTxs).toEqual([]);
    expect(result.recordsTxs).toHaveLength(1);
    expect(logLines.some((line) => line.includes("already registered"))).toBe(true);
  });
});

// helper: validate an in-memory object through the same path as the file loader
function loadSellerConfigFromObject(value: unknown): SellerConfig {
  const path = join(mkdtempSync(join(tmpdir(), "sell-config-")), "cfg.json");
  try {
    writeFileSync(path, JSON.stringify(value));
    return loadSellerConfig(path);
  } finally {
    rmSync(join(path), { force: true });
  }
}
