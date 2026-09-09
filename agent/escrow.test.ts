/**
 * ERC-8183 settlement spine tests (Task 3).
 *
 * Two tiers:
 *  - packSla/parseSla: pure, deterministic, always runs (keyless).
 *  - funded lifecycle: createJob → setBudget → approve → fund → submit → complete.
 *    Skipped unless ARC_TESTNET_PK is present AND the wallet holds >= MIN_BALANCE
 *    USDC on Arc testnet (the key in .env is the Task 0 throwaway that is only
 *    funded after a faucet drip — docs/keys-needed.md §2). The suite must pass
 *    keyless/fundless.
 */
import { describe, expect, it } from "bun:test";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  keccak256,
  toBytes,
  type Address,
} from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  ERC8183,
  USDC,
  USDC_ABI,
  packSla,
  parseSla,
  createJobWithSla,
  submitDeliverable,
  complete,
  getJob,
  ARC_RPC_URL,
  type Sla,
} from "./escrow";
import erc8183Abi from "./abi/erc8183.json";

// --- explicit .env loader (bun auto-loads .env, tsx/node do not; keeping the
// --- guard deterministic regardless of runner) ----------------------------------
import { readFileSync } from "node:fs";
import { join } from "node:path";
function loadDotEnv(): void {
  try {
    const text = readFileSync(join(process.cwd(), ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [key, raw] = [m[1]!, m[2]!.replace(/^["']|["']$/g, "")];
      if (process.env[key] === undefined) process.env[key] = raw;
    }
  } catch {
    /* no .env — env must come from the shell */
  }
}
loadDotEnv();

const RPC_URL = process.env.ARC_TESTNET_RPC ?? ARC_RPC_URL;
const AMOUNT = 10000n; // 0.01 USDC in 6-dec units — matches the Task 0 spike
const MIN_BALANCE = 100000n; // 0.1 USDC: escrow amount + gas buffer (~6 writes)
const EXPIRY_SECONDS = 3600;

const pk = process.env.ARC_TESTNET_PK as `0x${string}` | undefined;

describe("packSla", () => {
  it("packs SLA terms deterministically (exact JSON, full hash preserved)", () => {
    const sla: Sla = {
      minBlock: 100,
      schemaHash: `0x${"ab".repeat(32)}`,
      maxLatencyMs: 500,
    };
    const packed = packSla(sla);
    // built independently of packSla: pins key order, number formatting, and
    // the full 32-byte hash (the plan's Step-1 expectation rendered it as
    // "0xabab…" display shorthand). Same input => byte-identical output.
    const expected = `{"minBlock":100,"schemaHash":"0x${"ab".repeat(32)}","maxLatencyMs":500}`;
    expect(packed).toBe(expected);
    expect(packSla({ ...sla })).toBe(packed);
  });

  it("round-trips through parseSla", () => {
    const sla: Sla = {
      minBlock: 1_234,
      schemaHash: `0x${"cd".repeat(32)}`,
      maxLatencyMs: 750,
    };
    expect(parseSla(packSla(sla))).toEqual(sla);
  });

  it("rejects malformed SLA descriptions", () => {
    expect(() => parseSla("not-json")).toThrow();
    expect(() => parseSla('{"minBlock":"100"}')).toThrow(); // wrong types
    expect(() => parseSla("{}")).toThrow();
  });
});

// --- funded-lifecycle readiness probe --------------------------------------------
// ARC_TESTNET_PK exists in .env from Task 0 but the wallet may be unfunded; the
// lifecycle needs real USDC (escrow + gas), so gate on balance, not key presence.
let lifecycleReady = false;
let probedAddress: Address | undefined;
if (pk) {
  try {
    const account = privateKeyToAccount(pk);
    probedAddress = account.address;
    const publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(RPC_URL),
    });
    const balance = (await publicClient.readContract({
      address: USDC,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    lifecycleReady = balance >= MIN_BALANCE;
    if (!lifecycleReady) {
      console.warn(
        `SKIP lifecycle test: wallet ${account.address} holds ${balance} (6-dec) USDC — need >= ${MIN_BALANCE}. Fund via faucet.circle.com (docs/keys-needed.md §2) then re-run.`,
      );
    }
  } catch (err) {
    console.warn(`SKIP lifecycle test: RPC probe failed (${(err as Error).message})`);
  }
} else {
  console.warn("SKIP lifecycle test: ARC_TESTNET_PK not set (docs/keys-needed.md §3).");
}

it.skipIf(!lifecycleReady)(
  "funded lifecycle: createJob → setBudget → approve → fund → submit → complete",
  async () => {
    if (!pk) throw new Error("unreachable: test skipped without a funded key");
    const account = privateKeyToAccount(pk);
    const publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(RPC_URL),
    });
    const walletClient = createWalletClient({
      account,
      chain: arcTestnet,
      transport: http(RPC_URL),
    });

    // single funded key plays client = provider = evaluator (legal per the
    // verified spec; the Task 0 smoke used the same roles)
    const provider = account.address;
    const sla: Sla = {
      minBlock: Number(await publicClient.getBlockNumber()),
      schemaHash: keccak256(toBytes("openbook-test-schema-v1")),
      maxLatencyMs: 500,
    };

    const jobId = await createJobWithSla(publicClient, walletClient, {
      provider,
      evaluator: provider,
      expirySeconds: EXPIRY_SECONDS,
      sla,
      amount6dec: AMOUNT,
    });
    expect(typeof jobId).toBe("bigint");
    expect(jobId).toBeGreaterThan(0n);

    // job is Funded (1) with the packed SLA onchain
    const job = await getJob(publicClient, jobId);
    expect(job.id).toBe(jobId);
    expect(job.status).toBe(1); // Funded
    expect(job.budget).toBe(AMOUNT);
    expect(job.description).toBe(packSla(sla));

    // provider submits the deliverable → Submitted (2)
    const deliverableHash = keccak256(toBytes(`openbook-deliverable-${jobId}`));
    await submitDeliverable(publicClient, walletClient, jobId, deliverableHash);
    expect((await getJob(publicClient, jobId)).status).toBe(2); // Submitted

    // evaluator completes → Completed (3) + PaymentReleased(amount) onchain
    const receipt = await complete(publicClient, walletClient, jobId, deliverableHash);
    expect((await getJob(publicClient, jobId)).status).toBe(3); // Completed

    const escrowLogs = receipt.logs.filter(
      (l) => l.address.toLowerCase() === ERC8183.toLowerCase(),
    );
    const released = escrowLogs
      .map((l) => {
        try {
          return decodeEventLog({
            abi: erc8183Abi,
            data: l.data,
            topics: l.topics,
          });
        } catch {
          return null;
        }
      })
      .find((d) => d?.eventName === "PaymentReleased");
    expect(released).toBeDefined();
    const args = released?.args as unknown as { amount?: bigint; provider?: Address };
    expect(args.amount).toBe(AMOUNT);
    expect(args.provider).toBe(provider);
  },
  300_000,
);
