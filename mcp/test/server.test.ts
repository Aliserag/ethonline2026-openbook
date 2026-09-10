/**
 * sla-subgraph-mcp test suite (Task 5, TDD).
 *
 * Non-live tests are fully mocked: gateway HTTP responses are injected through
 * the `fetchImpl` seams of createApp (never mocked inside production code).
 * Live Gateway tests are key-guarded — they only run when GRAPH_GATEWAY_KEY is
 * present and hit the real Gateway (thegraph.com) exactly like the server does.
 */
import { describe, expect, it, beforeAll } from "bun:test";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp, createMcpServer } from "../src/server";
import {
  loadConfigFile,
  type OpenBookConfig,
} from "../src/datasets";
import type {
  OpenBookApp,
  ListDatasetsResult,
  QueryDatasetResult,
  VerifyDeliveryResult,
  GetQuoteResult,
  GetPnlResult,
} from "../src/server";
import * as path from "node:path";

// --- fixtures ----------------------------------------------------------------

/**
 * Foundry's well-known anvil test key — a TEST fixture, never a real secret.
 * The operator key is read from env in production; here it only drives the
 * deterministic-attestation assertions.
 */
const OPERATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OPERATOR_ACCOUNT = privateKeyToAccount(OPERATOR_KEY);

/** The freshness fragment the server appends to every Gateway query. */
const META_FRAGMENT_RE = /_meta\s*\{\s*block\s*\{\s*number\s*hash\s*timestamp\s*\}\s*hasIndexingErrors\s*\}/;

function configPath(name: string): string {
  return path.join(import.meta.dir, "..", "config", name);
}

interface CapturedRequest {
  url: string;
  body: string;
}

/** Fake gateway payload carrying the `_meta` freshness fields. */
function gatewayBody(data: Record<string, unknown>, block: number, hash: string): unknown {
  return {
    // the Gateway's _Meta_ has no chainHeadBlock (live probe 2026-09-09);
    // the freshness head is the app's chainHead seam (Alchemy eth_blockNumber)
    data: { ...data, _meta: { block: { number: block, hash, timestamp: 1789000000 }, hasIndexingErrors: false } },
  };
}

function mockFetch(respond: (url: string, body: string) => unknown): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, body });
    const payload = respond(url, body);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}

const ensFixtures = {
  menu: '[{"id":"aave-v3-arbitrum-lending","schema":"lending/3.1.0"},{"id":"uniswap-v3-arbitrum-dex","schema":"dex-amm/4.0.1"}]',
  price: "0.10 USDC/query",
  sla: '{"maxBlockLag":50,"maxLatencyMs":2000}',
  payee: "0x3600000000000000000000000000000000000000",
};

/** ENS text reader that returns the given records (null = record not set). */
function stubEns(records: Partial<typeof ensFixtures> | null) {
  return async (name: string, key: string): Promise<string | null> => {
    expect(name).toBe("openbook.eth");
    if (!records) return null;
    const bareKey = key.replace(/^svc\./, "");
    return records[bareKey as keyof typeof ensFixtures] ?? null;
  };
}

/** Narrow an unknown JSON value to a record (tests parse tool JSON output). */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function configOf(name: string): OpenBookConfig {
  return loadConfigFile(configPath(name));
}

// --- verify_delivery (deterministic gate) ----------------------------------------

describe("verify_delivery (deterministic gate)", () => {
  const app: OpenBookApp = createApp(configOf("openbook.json"), {
    env: { GRAPH_GATEWAY_KEY: "test-key", OPERATOR_PRIVATE_KEY: OPERATOR_KEY },
    readEnsText: stubEns(ensFixtures),
  });

  it("REJECTS stale deliverables first (metaBlock < minBlock -> STALE_DATA, never charges)", async () => {
    const out: VerifyDeliveryResult = await app.verifyDelivery({ metaBlock: 50, minBlock: 60 });
    expect(out.verdict).toBe("REJECT");
    if (out.verdict === "REJECT") expect(out.reason).toBe("STALE_DATA");
    expect(out.txHash).toBeUndefined();
  });

  it("REJECTS the boundary case (metaBlock === minBlock - 1 is still before the SLA block)", async () => {
    const out = await app.verifyDelivery({ metaBlock: 59, minBlock: 60 });
    expect(out.verdict).toBe("REJECT");
    if (out.verdict === "REJECT") expect(out.reason).toBe("STALE_DATA");
  });

  it("APPROVES when metaBlock >= minBlock with a well-formed payload hash", async () => {
    const out = await app.verifyDelivery({
      metaBlock: 60,
      minBlock: 60,
      payloadHash: `0x${"11".repeat(32)}`,
    });
    expect(out.verdict).toBe("APPROVE");
  });

  it("REJECTS a malformed payload hash (INVALID_HASH) regardless of freshness", async () => {
    const out = await app.verifyDelivery({ metaBlock: 100_000, minBlock: 60, payloadHash: "not-a-hash" });
    expect(out.verdict).toBe("REJECT");
    if (out.verdict === "REJECT") expect(out.reason).toBe("INVALID_HASH");
  });

  it("refuses to decide when minBlock is unavailable (no job, no explicit minBlock)", async () => {
    await expect(
      app.verifyDelivery({ metaBlock: 99, payloadHash: `0x${"22".repeat(32)}` }),
    ).rejects.toThrow(/minBlock/);
  });

  it("echoes the jobId and resolved minBlock with the verdict", async () => {
    const out = await app.verifyDelivery({
      jobId: "42",
      payloadHash: `0x${"11".repeat(32)}`,
      metaBlock: 60,
      minBlock: 60,
    });
    expect(out).toMatchObject({ verdict: "APPROVE", jobId: "42", minBlock: 60 });
    expect(out.txHash).toBeUndefined();
  });

  it("settle:true without an operator key fails cleanly (no silent skip of the refund)", async () => {
    const keyless = createApp(configOf("openbook.json"), {
      env: {},
      readEnsText: stubEns(ensFixtures),
    });
    await expect(
      keyless.verifyDelivery({ jobId: "7", payloadHash: `0x${"11".repeat(32)}`, metaBlock: 50, minBlock: 60, settle: true }),
    ).rejects.toThrow(/OPERATOR_PRIVATE_KEY/);
  });
});

// --- get_quote (ENS-gated pricing) ------------------------------------------------

describe("get_quote (ENS-gated pricing)", () => {
  it("hard-fails (ENS_RESOLUTION_FAILED) when svc.price is not set — never silently defaults", async () => {
    const app = createApp(configOf("openbook.json"), {
      env: {},
      readEnsText: stubEns({ ...ensFixtures, price: null }),
    });
    await expect(app.getQuote("aave-v3-arbitrum-lending")).rejects.toThrow(/ENS_RESOLUTION_FAILED/);
  });

  it("hard-fails when svc.sla is not set", async () => {
    const app = createApp(configOf("openbook.json"), {
      env: {},
      readEnsText: stubEns({ ...ensFixtures, sla: null }),
    });
    await expect(app.getQuote("aave-v3-arbitrum-lending")).rejects.toThrow(/ENS_RESOLUTION_FAILED/);
  });

  it("resolves amount/minBlockLag/deadlineBlocks/payee from live ENS records", async () => {
    const app = createApp(configOf("openbook.json"), {
      env: {},
      readEnsText: stubEns(ensFixtures),
    });
    const quote: GetQuoteResult = await app.getQuote("aave-v3-arbitrum-lending");
    expect(quote).toMatchObject({
      datasetId: "aave-v3-arbitrum-lending",
      amount: 100000, // 0.10 USDC in 6-dec units
      minBlockLag: 50,
      deadlineBlocks: 1, // ceil(2000ms / 4000ms per Arc block)
      payee: ensFixtures.payee,
    });
    expect(quote.amountUsdc).toBe("0.10");
  });

  it("rejects unknown datasets", async () => {
    const app = createApp(configOf("openbook.json"), {
      env: {},
      readEnsText: stubEns(ensFixtures),
    });
    await expect(app.getQuote("nope")).rejects.toThrow(/unknown dataset/);
  });
});

// --- query_dataset (freshness gate) ------------------------------------------------

describe("query_dataset (freshness gate)", () => {
  const config = configOf("openbook.json");
  const freshMeta: unknown = gatewayBody({ markets: [{ id: "0x1" }] }, 995, "0xdeadbeef");

  const appFor = (respond: (url: string, body: string) => unknown) => {
    const { fetchImpl, requests } = mockFetch(respond);
    const app = createApp(config, {
      env: { GRAPH_GATEWAY_KEY: "test-key", OPERATOR_PRIVATE_KEY: OPERATOR_KEY },
      fetchImpl,
      readEnsText: stubEns(ensFixtures),
      chainHead: async () => 1000,
    });
    return { app, requests };
  };

  it("marks the query unavailable (STALE) when chain head - _meta.block > maxAge — no attestation, never charge", async () => {
    const { app, requests } = appFor(() => gatewayBody({ markets: [{ id: "0x1" }] }, 100, "0xaa"));
    const out: QueryDatasetResult = await app.queryDataset("aave-v3-arbitrum-lending", "{ markets { id } }");
    expect(out.unavailable).toBe(true);
    if (out.unavailable) expect(out.reason).toBe("STALE");
    expect(requests).toHaveLength(1);
  });

  it("returns result + meta + a deterministic attestation when fresh", async () => {
    const { app, requests } = appFor(() => freshMeta);
    const out: QueryDatasetResult = await app.queryDataset("aave-v3-arbitrum-lending", "{ markets { id } }");
    expect(out.unavailable).toBe(false);
    if (out.unavailable) return;
    expect(out.result).toEqual({ markets: [{ id: "0x1" }] });
    expect(out.meta).toEqual({ block: 995, hash: "0xdeadbeef" });
    const expectedPayloadHash = keccak256(toBytes(JSON.stringify({ markets: [{ id: "0x1" }] })));
    expect(out.attestation.payloadHash).toBe(expectedPayloadHash);
    expect(out.attestation.message).toBe(`aave-v3-arbitrum-lending@995|${expectedPayloadHash}|995`);
    // deterministic: an independent sign of the same message reproduces the signature
    const independent = await OPERATOR_ACCOUNT.signMessage({ message: out.attestation.message });
    expect(out.attestation.signature).toBe(independent);
    expect(out.attestation.signer).toBe(OPERATOR_ACCOUNT.address);
    expect(requests).toHaveLength(1);
  });

  it("appends the freshness fragment to every query sent to the Gateway", async () => {
    const { app, requests } = appFor(() => freshMeta);
    await app.queryDataset("uniswap-v3-arbitrum-dex", "{ pools(first: 5) { id } }");
    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0].body) as { query: string };
    expect(body.query).toMatch(META_FRAGMENT_RE);
    expect(requests[0].url).toBe(
      "https://gateway.thegraph.com/api/test-key/subgraphs/id/FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX",
    );
  });

  it("does not double-append the fragment when the caller already selects _meta", async () => {
    const { app, requests } = appFor(() => freshMeta);
    await app.queryDataset("aave-v3-arbitrum-lending", "{ markets { id } _meta { block { number } } }");
    const body = JSON.parse(requests[0].body) as { query: string };
    expect(body.query.match(/_meta/g)).toHaveLength(1);
  });

  it("hard-fails cleanly without GRAPH_GATEWAY_KEY", async () => {
    const app = createApp(config, { env: {}, readEnsText: stubEns(ensFixtures) });
    await expect(app.queryDataset("aave-v3-arbitrum-lending", "{ markets { id } }")).rejects.toThrow(
      /GRAPH_GATEWAY_KEY/,
    );
  });

  it("surfaces gateway errors instead of charging or stalling", async () => {
    const { app } = appFor(() => ({ errors: [{ message: "query parse error" }] }));
    await expect(app.queryDataset("aave-v3-arbitrum-lending", "{ broken(")).rejects.toThrow(/parse error/);
  });
});

// --- get_pnl ---------------------------------------------------------------------

describe("get_pnl", () => {
  const pnlBody: unknown = {
    data: {
      dailyPnLs: [
        { id: "day-1234", revenue: "1000000", costs: "200000", refunds: "0", net: "800000" },
        { id: "day-1233", revenue: "0", costs: "0", refunds: "50000", net: "-50000" },
      ],
      _meta: { block: { number: 61700000 } },
    },
  };

  it("returns the DailyPnL rows and the subgraph meta block", async () => {
    const { fetchImpl, requests } = mockFetch(() => pnlBody);
    const app = createApp(configOf("openbook.json"), {
      env: { GRAPH_GATEWAY_KEY: "test-key" },
      fetchImpl,
      readEnsText: stubEns(ensFixtures),
    });
    const out: GetPnlResult = await app.getPnl();
    expect(out.metaBlock).toBe(61700000);
    expect(out.dailyPnLs).toHaveLength(2);
    expect(out.dailyPnLs[0]).toEqual({
      id: "day-1234",
      revenue: "1000000",
      costs: "200000",
      refunds: "0",
      net: "800000",
    });
    // get_pnl queries the open-book subgraph endpoint (Studio), not the pinned Gateway id
    expect(requests[0].url).toContain("/open-book/");
  });

  it("works without GRAPH_GATEWAY_KEY — the Studio query endpoint is public", async () => {
    const { fetchImpl, requests } = mockFetch(() => pnlBody);
    const app = createApp(configOf("openbook.json"), { env: {}, fetchImpl, readEnsText: stubEns(ensFixtures) });
    const out: GetPnlResult = await app.getPnl();
    expect(out.metaBlock).toBe(61700000);
    expect(out.dailyPnLs).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });
});

// --- list_datasets ------------------------------------------------------------------

describe("list_datasets", () => {
  it("returns both pinned datasets with schema/price/description; merges the ENS svc.menu tag", async () => {
    const app = createApp(configOf("openbook.json"), {
      env: {},
      readEnsText: stubEns(ensFixtures),
    });
    const out: ListDatasetsResult = await app.listDatasets();
    const ids = out.datasets.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(["aave-v3-arbitrum-lending", "uniswap-v3-arbitrum-dex"]));
    const aave = out.datasets.find((d) => d.id === "aave-v3-arbitrum-lending");
    expect(aave).toBeDefined();
    expect(aave).toMatchObject({
      schema: "lending/3.1.0",
      priceUsdc: 100000,
      pinned: true,
      onEnsMenu: true,
    });
    expect(aave?.description.length).toBeGreaterThan(0);
    expect(aave?.price).toBe("0.10 USDC/query");
    expect(aave?.freshnessMaxAge).toBe(50);
  });

  it("stays usable when ENS is unreachable (catalog never hard-fails)", async () => {
    const app = createApp(configOf("openbook.json"), {
      env: {},
      readEnsText: async () => {
        throw new Error("rpc down");
      },
    });
    const out = await app.listDatasets();
    expect(out.datasets.length).toBeGreaterThanOrEqual(2);
    expect(out.datasets.every((d) => !d.onEnsMenu)).toBe(true);
  });
});

// --- config files ---------------------------------------------------------------------

describe("config files", () => {
  it("openbook.json pins the two Messari subgraph ids verbatim", () => {
    const cfg = configOf("openbook.json");
    expect(cfg.ens).toBe("openbook.eth");
    expect(cfg.escrow).toBe("0x0747EEf0706327138c69792bF28Cd525089e4583");
    const byId = Object.fromEntries(cfg.datasets.map((d) => [d.id, d]));
    expect(byId["aave-v3-arbitrum-lending"].subgraphId).toBe(
      "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
    );
    expect(byId["uniswap-v3-arbitrum-dex"].subgraphId).toBe(
      "FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX",
    );
  });

  it("demo2.json reuses the server against the Compound V3 Ethereum subgraph (reusability receipt)", () => {
    const cfg = configOf("demo2.json");
    const compound = cfg.datasets.find((d) => d.subgraphId === "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9");
    expect(compound).toBeDefined();
    expect(compound?.schema).toBe("lending/3.1.0");
    expect(compound?.freshness.maxAge).toBeGreaterThan(0);
  });
});

// --- MCP protocol layer -----------------------------------------------------------------

describe("MCP server (protocol-level)", () => {
  let app: OpenBookApp;
  beforeAll(() => {
    app = createApp(configOf("openbook.json"), {
      env: { GRAPH_GATEWAY_KEY: "test-key", OPERATOR_PRIVATE_KEY: OPERATOR_KEY },
      readEnsText: stubEns(ensFixtures),
      fetchImpl: mockFetch(() => gatewayBody({ markets: [{ id: "0x1" }] }, 995, "0xdeadbeef")).fetchImpl,
      chainHead: async () => 1000,
    });
  });

  it("advertises exactly the 5 tools", async () => {
    const mcp = createMcpServer(app);
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const reply = await rpc(client, "tools/list", {});
    const result = asRecord(reply.result);
    const tools = result["tools"];
    expect(Array.isArray(tools)).toBe(true);
    const names = (tools as unknown[])
      .map((t) => String(asRecord(t)["name"]))
      .sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(
      ["get_pnl", "get_quote", "list_datasets", "query_dataset", "verify_delivery"].sort(),
    );
  });

  it("returns an ENS_RESOLUTION_FAILED error from get_quote when records are missing", async () => {
    const hardFail = createApp(configOf("openbook.json"), {
      env: {},
      readEnsText: stubEns({ ...ensFixtures, sla: null }),
    });
    const mcp = createMcpServer(hardFail);
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const reply = await rpc(client, "tools/call", {
      name: "get_quote",
      arguments: { datasetId: "aave-v3-arbitrum-lending" },
    });
    const result = asRecord(reply.result);
    expect(result["isError"]).toBe(true);
    const text = toolText(result);
    expect(text).toContain("ENS_RESOLUTION_FAILED");
  });

  it("serves a fresh query_dataset round-trip through the protocol", async () => {
    const mcp = createMcpServer(app);
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const reply = await rpc(client, "tools/call", {
      name: "query_dataset",
      arguments: { datasetId: "uniswap-v3-arbitrum-dex", graphql: "{ pools(first: 3) { id } }" },
    });
    const result = asRecord(reply.result);
    expect(result["isError"]).toBeFalsy();
    const out = asRecord(JSON.parse(toolText(result)));
    expect(out["unavailable"]).toBe(false);
    const meta = asRecord(out["meta"]);
    expect(meta["block"]).toBe(995);
    const att = asRecord(out["attestation"]);
    expect(att["signer"]).toBe(OPERATOR_ACCOUNT.address);
  });

  it("marks a stale query_dataset unavailable through the protocol", async () => {
    const staleApp = createApp(configOf("openbook.json"), {
      env: { GRAPH_GATEWAY_KEY: "test-key", OPERATOR_PRIVATE_KEY: OPERATOR_KEY },
      readEnsText: stubEns(ensFixtures),
      fetchImpl: mockFetch(() => gatewayBody({ markets: [] }, 10, "0xaa")).fetchImpl,
      chainHead: async () => 1000,
    });
    const mcp = createMcpServer(staleApp);
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const reply = await rpc(client, "tools/call", {
      name: "query_dataset",
      arguments: { datasetId: "aave-v3-arbitrum-lending", graphql: "{ markets { id } }" },
    });
    const result = asRecord(reply.result);
    expect(result["isError"]).toBeFalsy();
    const out = asRecord(JSON.parse(toolText(result)));
    expect(out["unavailable"]).toBe(true);
    expect(out["reason"]).toBe("STALE");
  });

  it("serves verify_delivery REJECT/STALE_DATA deterministically through the protocol", async () => {
    const mcp = createMcpServer(app);
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const reply = await rpc(client, "tools/call", {
      name: "verify_delivery",
      arguments: { jobId: "42", payloadHash: `0x${"33".repeat(32)}`, metaBlock: 50, minBlock: 60 },
    });
    const result = asRecord(reply.result);
    expect(result["isError"]).toBeFalsy();
    const out = asRecord(JSON.parse(toolText(result)));
    expect(out["verdict"]).toBe("REJECT");
    expect(out["reason"]).toBe("STALE_DATA");
    expect(out["jobId"]).toBe("42");
    expect(out["minBlock"]).toBe(60);
  });
});

/**
 * Poor-man's JSON-RPC over the SDK's linked in-memory transports. Resolves when
 * the server answers the matching id (the bun test runner's own timeout guards
 * against a never-arriving response, so no wall-clock timer is needed here).
 */
function rpc(
  client: { send: (msg: unknown) => void; onmessage: ((msg: unknown) => void) | null },
  method: string,
  params: unknown,
): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const id = Math.trunc(Math.random() * 1e9);
  client.onmessage = (msg: unknown) => {
    const record = asRecord(msg);
    if (record["id"] !== id) return;
    resolve(msg);
  };
  client.send({ jsonrpc: "2.0", id, method, params });
  return promise;
}

/** Extract the first text content item of an MCP tool result. */
function toolText(result: Record<string, unknown>): string {
  const content = result["content"];
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("tool result has no content");
  }
  const first = asRecord(content[0]);
  if (typeof first["text"] !== "string") throw new Error("tool result content is not text");
  return first["text"];
}

// --- live Gateway tests (key-guarded) -------------------------------------------------

// Live tests are opt-in (RUN_LIVE=1) — bun auto-loads .env into process.env,
// so a placeholder/stale GRAPH_GATEWAY_KEY must never flip the suite to live.

const hasKey =
  process.env.RUN_LIVE === "1" &&
  process.env.GRAPH_GATEWAY_KEY !== undefined &&
  process.env.GRAPH_GATEWAY_KEY.length > 0;

describe.skipIf(!hasKey)("live Gateway (opt-in: RUN_LIVE=1 + GRAPH_GATEWAY_KEY)", () => {
  const liveApp: OpenBookApp = createApp(configOf("openbook.json"), {
    env: {
      GRAPH_GATEWAY_KEY: process.env.GRAPH_GATEWAY_KEY ?? "",
      OPERATOR_PRIVATE_KEY: OPERATOR_KEY,
    },
  });

  it(
    "query_dataset returns a real _meta.block from the pinned Aave V3 Arbitrum subgraph",
    async () => {
      const out: QueryDatasetResult = await liveApp.queryDataset(
        "aave-v3-arbitrum-lending",
        "{ markets(first: 1) { id } }",
      );
      expect(out.unavailable).toBe(false);
      if (out.unavailable) return;
      expect(out.meta.block).toBeGreaterThan(0);
      expect(out.meta.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(out.attestation.signer).toBe(OPERATOR_ACCOUNT.address);
    },
    60_000,
  );

  it(
    "get_pnl returns the openbook-pnl shape from Studio (requires the funded-run deploy)",
    async () => {
      if (process.env.RUN_PNL_LIVE !== "1") {
        console.warn(
          "SKIP: openbook-pnl is deployed during the funded run — re-run with RUN_LIVE=1 RUN_PNL_LIVE=1 after `bash scripts/deploy-subgraph.sh`.",
        );
        return;
      }
      const out: GetPnlResult = await liveApp.getPnl();
      expect(Array.isArray(out.dailyPnLs)).toBe(true);
      expect(out.metaBlock).toBeGreaterThan(0);
    },
    60_000,
  );
});
