/**
 * seller.ts tests (Task 7).
 *
 * Pure, keyless: the seller's chain I/O rides injected public/wallet clients
 * (the real clients are created only when none are supplied) and the gateway
 * rides the fetch seam. These tests pin the no-misdelivery contract — a job
 * whose committed schemaHash matches no configured dataset is SKIPped, never
 * served with an unrelated payload — plus the deterministic dataset match.
 */
import { describe, expect, it } from "bun:test";
import { keccak256, toBytes, type Address, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as path from "node:path";
import { loadConfigFile, type OpenBookConfig } from "../mcp/src/datasets";
import { ERC8183, packSla, setEscrowAddress } from "./escrow";
import { findDatasetForSla, serveFundedJobs, type SellerStats } from "./seller";
import { defaultQueryFor } from "./src/queries";

const CONFIG: OpenBookConfig = loadConfigFile(
  path.join(import.meta.dir, "..", "mcp", "config", "openbook.json"),
);

/** Foundry anvil fixture key — a test key, never a real secret. */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR1: Address = "0x0000000000000000000000000000000000000001";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const NOOP = (): void => {};

describe("findDatasetForSla", () => {
  it("matches a configured dataset by keccak(schema) — the buyer-side packing", () => {
    expect(findDatasetForSla(CONFIG, keccak256(toBytes("lending/3.1.0")))).toEqual(CONFIG.datasets[0]);
    expect(findDatasetForSla(CONFIG, keccak256(toBytes("dex-amm/4.0.1")))).toEqual(CONFIG.datasets[1]);
  });

  it("returns undefined for an unknown schemaHash — the seller never falls back", () => {
    expect(findDatasetForSla(CONFIG, keccak256(toBytes("someone-elses/schema")))).toBeUndefined();
  });
});

describe("defaultQueryFor", () => {
  it("serves per-schema demo query shapes from the pinned Messari schemas", () => {
    expect(defaultQueryFor(CONFIG.datasets[0])).toBe("{ markets(first: 3) { id } }"); // lending
    expect(defaultQueryFor(CONFIG.datasets[1])).toBe("{ pools(first: 3) { id } }"); // dex-amm
  });
});

describe("serveFundedJobs — schema-mismatch skip (no misdelivery)", () => {
  /** JobView array shape returned by getJob (matches escrow.getJob normalization). */
  function jobView(description: string, status = 1): unknown[] {
    return [
      42n, // id
      ADDR1, // client
      "0x0000000000000000000000000000000000000002", // provider
      ADDR1, // evaluator
      description,
      100000n, // budget
      BigInt(Math.floor(Date.now() / 1000)) + 3600n, // expiredAt
      BigInt(status), // status
      ZERO, // hook
    ];
  }

  it("SKIPs a funded job whose committed schemaHash matches no dataset (errors+log, no submit)", async () => {
    const publicClient = {
      getBlockNumber: async (): Promise<bigint> => 1000n,
      getLogs: async (params: { event: { name: string } }): Promise<unknown[]> => {
        if (params.event.name === "JobFunded") {
          return [{ args: { jobId: 42n }, transactionHash: `0x${"1".repeat(64)}` }];
        }
        return [];
      },
      readContract: async (params: { functionName: string }): Promise<unknown> => {
        if (params.functionName === "getJob") {
          return jobView(
            packSla({
              minBlock: 10,
              schemaHash: keccak256(toBytes("someone-elses/schema")), // not in CONFIG.datasets
              maxLatencyMs: 500,
            }),
          );
        }
        throw new Error(`unexpected readContract: ${params.functionName}`);
      },
    } as unknown as PublicClient;
    const walletClient = {
      writeContract: async (): Promise<never> => {
        throw new Error("unexpected wallet write — the mismatch path must not submit");
      },
    } as unknown as WalletClient;
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("unexpected gateway fetch — the mismatch path must not query");
    };
    const logLines: string[] = [];
    const stats = await serveFundedJobs(
      {
        config: CONFIG,
        env: { ARC_TESTNET_PK: TEST_KEY, GRAPH_GATEWAY_KEY: "test-key" },
        publicClient,
        walletClient,
        fetchImpl,
        chainHead: async () => 1000,
        log: (line) => logLines.push(line),
      },
      { lookback: 100n },
    );
    expect(stats.scannedJobs).toBe(1);
    expect(stats.served).toBe(0);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain("schemaHash");
    expect(logLines.some((line) => line.includes("SKIP job=42") && line.includes("no configured dataset"))).toBe(true);
  });

  it("serves a job whose schemaHash DOES match (happy-path wiring)", async () => {
    const description = packSla({
      minBlock: 950,
      schemaHash: keccak256(toBytes("lending/3.1.0")), // matches CONFIG.datasets[0]
      maxLatencyMs: 500,
    });
    const publicClient = {
      getBlockNumber: async (): Promise<bigint> => 1000n,
      getLogs: async (params: { event: { name: string } }): Promise<unknown[]> => {
        if (params.event.name === "JobFunded") {
          return [{ args: { jobId: 7n }, transactionHash: `0x${"2".repeat(64)}` }];
        }
        return [];
      },
      readContract: async (params: { functionName: string }): Promise<unknown> => {
        if (params.functionName === "getJob") return jobView(description);
        throw new Error(`unexpected readContract: ${params.functionName}`);
      },
    } as unknown as PublicClient;
    // gateway returns a fresh result (block 990, chainHead 1000, within maxAge 50
    // and >= minBlock 950) so the job proceeds past the dataset match
    const fetchImpl = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          data: {
            markets: [{ id: "0x1" }],
            _meta: { block: { number: 990, hash: "0xbeef", timestamp: 1789000000 }, hasIndexingErrors: false },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    let submitted: bigint | undefined;
    const walletClient = {
      account: { address: "0x0000000000000000000000000000000000000002" },
      writeContract: async (params: { functionName: string; args: unknown[] }): Promise<string> => {
        if (params.functionName === "submit") {
          submitted = (params.args as unknown[])[0] as bigint;
          return `0x${"3".repeat(64)}`;
        }
        throw new Error(`unexpected wallet write: ${params.functionName}`);
      },
    } as unknown as WalletClient;
    // the escrow submit helpers wait for a receipt — stub waitForTransactionReceipt
    (publicClient as unknown as Record<string, unknown>)["waitForTransactionReceipt"] = async () => ({
      transactionHash: `0x${"4".repeat(64)}`,
      status: "success" as const,
    });
    // write() reads live fees via arcFees before the stubbed send
    (publicClient as unknown as Record<string, unknown>)["estimateFeesPerGas"] = async () => ({
      maxFeePerGas: 26_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });

    const logLines: string[] = [];
    const stats = await serveFundedJobs(
      {
        config: CONFIG,
        env: { ARC_TESTNET_PK: TEST_KEY, GRAPH_GATEWAY_KEY: "test-key" },
        publicClient,
        walletClient,
        fetchImpl,
        chainHead: async () => 1000,
        log: (line) => logLines.push(line),
      },
      { lookback: 100n },
    );
    expect(submitted).toBe(7n);
    expect(stats.served).toBe(1);
    expect(stats.errors).toHaveLength(0);
  });

  it("SKIPs a job whose deliverable is stale (metaBlock below the freshness window)", async () => {
    const description = packSla({
      minBlock: 500,
      schemaHash: keccak256(toBytes("lending/3.1.0")),
      maxLatencyMs: 500,
    });
    const publicClient = {
      getBlockNumber: async (): Promise<bigint> => 1000n,
      getLogs: async (params: { event: { name: string } }): Promise<unknown[]> => {
        if (params.event.name === "JobFunded") {
          return [{ args: { jobId: 8n }, transactionHash: `0x${"5".repeat(64)}` }];
        }
        return [];
      },
      readContract: async (params: { functionName: string }): Promise<unknown> => {
        if (params.functionName === "getJob") return jobView(description);
        throw new Error(`unexpected readContract: ${params.functionName}`);
      },
    } as unknown as PublicClient;
    const walletClient = {
      writeContract: async (): Promise<never> => {
        throw new Error("unexpected wallet write — stale path must not submit");
      },
    } as unknown as WalletClient;
    // gateway returns a STALE result: block 90 vs chainHead 1000 (> maxAge 50)
    const fetchImpl = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          data: {
            markets: [{ id: "0x1" }],
            _meta: { block: { number: 90, hash: "0xold", timestamp: 1789000000 }, hasIndexingErrors: false },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const logLines: string[] = [];
    const stats = await serveFundedJobs(
      {
        config: CONFIG,
        env: { ARC_TESTNET_PK: TEST_KEY, GRAPH_GATEWAY_KEY: "test-key" },
        publicClient,
        walletClient,
        fetchImpl,
        chainHead: async () => 1000,
        log: (line) => logLines.push(line),
      },
      { lookback: 100n },
    );
    expect(stats.served).toBe(0);
    expect(stats.staleSkipped).toBe(1);
    expect(logLines.some((line) => line.includes("SKIP job=8") && line.includes("stale"))).toBe(true);
  });
});

describe("serveFundedJobs — provider-scoped tally on the SHARED reference contract", () => {
  /** Seller address derived from the TEST_KEY fixture (same derivation as seller.ts). */
  const SELLER = privateKeyToAccount(TEST_KEY).address.toLowerCase();
  const FOREIGN = "0x64a78b6d5e99274d01d1d0a70b180a73aaeb8d21";

  /** JobView array with a caller-chosen provider. */
  function jobViewFor(provider: string, status = 3): unknown[] {
    return [
      42n, // id
      ADDR1, // client
      provider,
      ADDR1, // evaluator
      packSla({ minBlock: 10, schemaHash: keccak256(toBytes("lending/3.1.0")), maxLatencyMs: 500 }),
      100000n, // budget
      BigInt(Math.floor(Date.now() / 1000)) + 3600n, // expiredAt
      BigInt(status), // status
      ZERO, // hook
    ];
  }

  it("counts revenue ONLY from own-provider PaymentReleased; refunds from own jobs only", async () => {
    const publicClient = {
      getBlockNumber: async (): Promise<bigint> => 1000n,
      getLogs: async (params: {
        event: { name: string };
        args?: { provider?: string };
      }): Promise<unknown[]> => {
        if (params.event.name === "JobFunded") return [];
        if (params.event.name === "PaymentReleased") {
          // node-side semantics: the indexed provider topic filter applies,
          // so the mock only hands back what the filter would return
          const own = { args: { jobId: 1n, provider: SELLER, amount: 1000000n }, transactionHash: `0x${"a".repeat(64)}` };
          const foreign = {
            args: { jobId: 99n, provider: FOREIGN, amount: 5000000n },
            transactionHash: `0x${"b".repeat(64)}`,
          };
          return params.args?.provider === SELLER ? [own] : [foreign];
        }
        if (params.event.name === "Refunded") {
          return [
            { args: { jobId: 2n, amount: 250000n }, transactionHash: `0x${"c".repeat(64)}` }, // own job (getJob: provider = SELLER)
            { args: { jobId: 200n, amount: 900000n }, transactionHash: `0x${"d".repeat(64)}` }, // foreign job
          ];
        }
        return [];
      },
      readContract: async (params: { functionName: string; args?: unknown[] }): Promise<unknown> => {
        if (params.functionName === "getJob") {
          const jobId = (params.args as unknown[])[0] as bigint;
          // job 2 is the seller's; job 200 belongs to a foreign provider
          return jobId === 2n ? jobViewFor(SELLER) : jobViewFor(FOREIGN);
        }
        throw new Error(`unexpected readContract: ${params.functionName}`);
      },
    } as unknown as PublicClient;
    const walletClient = {} as unknown as WalletClient;
    const logLines: string[] = [];
    const stats = await serveFundedJobs(
      {
        config: CONFIG,
        env: { ARC_TESTNET_PK: TEST_KEY, GRAPH_GATEWAY_KEY: "test-key" },
        publicClient,
        walletClient,
        fetchImpl: async (): Promise<Response> => {
          throw new Error("unexpected gateway fetch — no funded jobs to serve");
        },
        log: (line) => logLines.push(line),
      },
      { lookback: 100n },
    );
    // foreign PaymentReleased (5,000,000) is not in the tally; own is counted once
    expect(stats.revenue6dec).toBe(1000000n);
    expect(stats.completedCount).toBe(1);
    // own refund counted; foreign refund (no matching provider) skipped
    expect(stats.refunded6dec).toBe(250000n);
    expect(stats.refundCount).toBe(1);
    expect(logLines).toContain("SKIP refund job=200: provider is not " + SELLER + " — foreign job on the shared contract");
  });
});

describe("serveFundedJobs — event scans follow the configured escrow", () => {
  it("targets the market escrow override for all three scans, never the shared reference", async () => {
    const MARKET_ESCROW: Address = "0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5";
    expect(MARKET_ESCROW.toLowerCase()).not.toBe(ERC8183.toLowerCase()); // meaningful override
    const scanned: Address[] = [];
    const publicClient = {
      getBlockNumber: async (): Promise<bigint> => 1000n,
      getLogs: async (params: { address: Address }): Promise<unknown[]> => {
        scanned.push(params.address);
        return [];
      },
      readContract: async (): Promise<unknown> => {
        throw new Error("unexpected readContract — no funded jobs to resolve");
      },
      read: async (): Promise<unknown> => {
        throw new Error("unexpected eth_call — no tallies to attribute");
      },
    } as unknown as PublicClient;
    const walletClient = {} as WalletClient;
    setEscrowAddress(MARKET_ESCROW);
    try {
      await serveFundedJobs(
        {
          config: CONFIG,
          env: { ARC_TESTNET_PK: TEST_KEY, GRAPH_GATEWAY_KEY: "test-key" },
          publicClient,
          walletClient,
        },
        { lookback: 100n },
      );
      expect(scanned).toHaveLength(3); // JobFunded + PaymentReleased + Refunded
      for (const addr of scanned) {
        expect(addr.toLowerCase()).toBe(MARKET_ESCROW.toLowerCase());
      }
    } finally {
      setEscrowAddress(null); // never leak the override into other tests
    }
  });
});
