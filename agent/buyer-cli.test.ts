/**
 * buyer-cli quote-flow tests (Task 7).
 *
 * Fully keyless: the ENS reads and gateway/proxy fetches ride the injectable
 * `readEnsText` / `fetchImpl` seams (never mocked inside production code), so
 * these tests touch no network and no wallet. They pin the quote contract
 * (ENS-gated, hard-fail, 6-dec parsing) and the delivery contract (gateway
 * URL shape, _meta fragment, deterministic payload hash, --stale routing).
 */
import { describe, expect, it } from "bun:test";
import { keccak256, toBytes } from "viem";
import { loadConfigFile, type OpenBookConfig } from "../mcp/src/datasets";
import { deliverQuery, defaultQueryFor, runBuyerFlow } from "./buyer-cli";
import * as path from "node:path";

const CONFIG: OpenBookConfig = loadConfigFile(
  path.join(import.meta.dir, "..", "mcp", "config", "openbook.json"),
);

const ensFixtures = {
  menu: '[{"id":"aave-v3-arbitrum-lending","schema":"lending/3.1.0"},{"id":"uniswap-v3-arbitrum-dex","schema":"dex-amm/4.0.1"}]',
  price: "0.10 USDC/query",
  sla: '{"maxBlockLag":50,"maxLatencyMs":2000}',
  payee: "0x3600000000000000000000000000000000000000",
};

/** ENS text reader stub (null = record not set — same shape the MCP tests use). */
function stubEns(records: Partial<typeof ensFixtures> | null) {
  return async (name: string, key: string): Promise<string | null> => {
    expect(name).toBe("openbook.eth");
    if (!records) return null;
    const bareKey = key.replace(/^svc\./, "");
    return records[bareKey as keyof typeof ensFixtures] ?? null;
  };
}

/** Gateway fetch stub: returns a payload with _meta and records the request. */
function mockFetch(respond: (url: string, body: string) => unknown) {
  const requests: { url: string; body: string }[] = [];
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

function gatewayData(block: number, chainHeadBlock: number, hash = "0xdeadbeef"): unknown {
  return {
    markets: [{ id: "0x1" }],
    _meta: { block: { number: block, hash }, chainHeadBlock: { number: chainHeadBlock } },
  };
}

const GATEWAY_PATH =
  "/api/test-key/subgraphs/id/4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf";
const META_FRAGMENT_RE = /_meta\s*\{\s*block\s*\{\s*number\s*hash\s*\}\s*chainHeadBlock\s*\{\s*number\s*\}\s*\}/;

// --- quote flow (keyless, ENS-gated) -----------------------------------------

describe("buyer-cli quote flow", () => {
  it("resolves price/SLA/payee from mocked ENS records into a 6-dec quote", async () => {
    const result = await runBuyerFlow(
      CONFIG,
      { datasetId: "aave-v3-arbitrum-lending", onlyQuote: true },
      { env: {}, readEnsText: stubEns(ensFixtures) },
    );
    expect(result.quote).toMatchObject({
      datasetId: "aave-v3-arbitrum-lending",
      amount: 100000, // 0.10 USDC in 6-dec units
      amountUsdc: "0.10",
      minBlockLag: 50,
      maxLatencyMs: 2000,
      payee: ensFixtures.payee,
      priceRecord: "0.10 USDC/query",
    });
    expect(result.jobId).toBeUndefined(); // onlyQuote never touches the chain
  });

  it("hard-fails (ENS_RESOLUTION_FAILED) when svc.price is missing — never quotes a default", async () => {
    await expect(
      runBuyerFlow(
        CONFIG,
        { datasetId: "aave-v3-arbitrum-lending", onlyQuote: true },
        { env: {}, readEnsText: stubEns({ ...ensFixtures, price: null }) },
      ),
    ).rejects.toThrow(/ENS_RESOLUTION_FAILED/);
  });

  it("hard-fails when svc.sla is missing", async () => {
    await expect(
      runBuyerFlow(
        CONFIG,
        { datasetId: "aave-v3-arbitrum-lending", onlyQuote: true },
        { env: {}, readEnsText: stubEns({ ...ensFixtures, sla: null }) },
      ),
    ).rejects.toThrow(/ENS_RESOLUTION_FAILED/);
  });

  it("rejects unknown datasets", async () => {
    await expect(
      runBuyerFlow(CONFIG, { datasetId: "nope", onlyQuote: true }, { env: {}, readEnsText: stubEns(ensFixtures) }),
    ).rejects.toThrow(/unknown dataset/);
  });
});

// --- delivery (mocked gateway, keyless) ----------------------------------------

describe("buyer-cli delivery (mocked gateway)", () => {
  it("default query matches the dataset schema (lending -> markets)", () => {
    expect(defaultQueryFor(CONFIG.datasets[0])).toBe("{ markets(first: 3) { id } }");
  });

  it("queries the live Gateway URL with the freshness fragment and a deterministic payload hash", async () => {
    const { fetchImpl, requests } = mockFetch(() => ({ data: gatewayData(995, 1000) }));
    const delivery = await deliverQuery(
      CONFIG,
      { datasetId: "aave-v3-arbitrum-lending" },
      { env: { GRAPH_GATEWAY_KEY: "test-key" }, fetchImpl },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`https://gateway.thegraph.com${GATEWAY_PATH}`);
    const body = JSON.parse(requests[0].body) as { query: string };
    expect(body.query).toMatch(META_FRAGMENT_RE);
    // freshness: head - block = 1000 - 995 = 5 <= maxAge 50
    expect(delivery).toMatchObject({
      via: "gateway",
      freshness: "fresh",
      metaBlock: 995,
      chainHeadBlock: 1000,
    });
    expect(delivery.payloadHash).toBe(
      keccak256(toBytes(JSON.stringify({ markets: [{ id: "0x1" }] }))),
    );
  });

  it("classifies an old _meta as STALE without any live-network dependence", async () => {
    const { fetchImpl, requests } = mockFetch(() => ({ data: gatewayData(90, 1000) }));
    const delivery = await deliverQuery(
      CONFIG,
      { datasetId: "aave-v3-arbitrum-lending" },
      { env: { GRAPH_GATEWAY_KEY: "test-key" }, fetchImpl },
    );
    expect(delivery.freshness).toBe("stale"); // 1000 - 90 = 910 > maxAge 50
    expect(requests).toHaveLength(1);
  });

  it("--stale routes the query through the stale proxy (money-shot path)", async () => {
    const { fetchImpl, requests } = mockFetch(() => ({
      data: gatewayData(90, 141, "0xoldblock"),
    }));
    const delivery = await deliverQuery(
      CONFIG,
      { datasetId: "aave-v3-arbitrum-lending", stale: true, staleProxyUrl: "http://127.0.0.1:8787" },
      { env: { GRAPH_GATEWAY_KEY: "test-key" }, fetchImpl },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`http://127.0.0.1:8787${GATEWAY_PATH}`);
    expect(delivery).toMatchObject({
      via: "stale-proxy",
      freshness: "stale",
      metaBlock: 90,
      chainHeadBlock: 141,
    });
    // the replayed block is verifiably below any SLA minBlock derived at pay time
    expect(delivery.metaBlock).toBeLessThan(90 + 50);
  });

  it("hard-fails without GRAPH_GATEWAY_KEY (keyless discipline, no silent skip)", async () => {
    await expect(
      deliverQuery(CONFIG, { datasetId: "aave-v3-arbitrum-lending" }, { env: {} }),
    ).rejects.toThrow(/GRAPH_GATEWAY_KEY/);
  });
});
