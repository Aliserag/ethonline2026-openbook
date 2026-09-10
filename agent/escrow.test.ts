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
  arcFees,
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
const PROVIDER_SEED = 50000n; // 0.05 USDC sent buyer→provider for their gas (setBudget + submit)
// buyer needs: escrow amount + provider seed + gas for ~6 writes (~0.1 USDC)
const MIN_BALANCE = 150000n; // 0.15 USDC
const EXPIRY_SECONDS = 3600;

const buyerPk = process.env.ARC_TESTNET_PK as `0x${string}` | undefined;
const providerPk = process.env.ARC_RECIPIENT_PK as `0x${string}` | undefined;

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
    expect(() =>
      parseSla(
        '{"minBlock":1,"schemaHash":"0x1234","maxLatencyMs":500}',
      ),
    ).toThrow(); // schemaHash must be 0x + 64 hex
    expect(() =>
      parseSla(
        `{"minBlock":1,"schemaHash":"0x${"ab".repeat(32).replace("b", "g")}","maxLatencyMs":500}`,
      ),
    ).toThrow(); // non-hex chars rejected
  });
});

// --- funded-lifecycle readiness probe --------------------------------------------
// The lifecycle runs with two distinct funded-capable keys: ARC_TESTNET_PK is
// the buyer (faucet target 0xAC54…54De) and ARC_RECIPIENT_PK is the provider
// (0x64A7…). Both keys already exist in .env from Task 0; only the BUYER needs
// a faucet drip (the test seeds the provider's gas from the buyer). Skip until
// both keys exist AND the buyer holds >= MIN_BALANCE.
let lifecycleReady = false;
let probedAddress: Address | undefined;
if (buyerPk && providerPk) {
  try {
    const account = privateKeyToAccount(buyerPk);
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
        `SKIP lifecycle test: buyer ${account.address} holds ${balance} (6-dec) USDC — need >= ${MIN_BALANCE}. Fund via faucet.circle.com (docs/keys-needed.md §2) then re-run.`,
      );
    }
  } catch (err) {
    console.warn(`SKIP lifecycle test: RPC probe failed (${(err as Error).message})`);
  }
} else {
  console.warn(
    "SKIP lifecycle test: ARC_TESTNET_PK and/or ARC_RECIPIENT_PK not set (docs/keys-needed.md §3).",
  );
}

it.skipIf(!lifecycleReady)(
  "funded lifecycle (split-key buyer≠provider): createJob → setBudget → approve → fund → submit → complete",
  async () => {
    if (!buyerPk || !providerPk) throw new Error("unreachable: test skipped without funded keys");
    const buyerAccount = privateKeyToAccount(buyerPk);
    const providerAccount = privateKeyToAccount(providerPk);
    expect(buyerAccount.address).not.toBe(providerAccount.address); // genuinely two wallets
    const publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(RPC_URL),
    });
    const buyerWallet = createWalletClient({
      account: buyerAccount,
      chain: arcTestnet,
      transport: http(RPC_URL),
    });
    const providerWallet = createWalletClient({
      account: providerAccount,
      chain: arcTestnet,
      transport: http(RPC_URL),
    });

    // seed the provider's gas (tutorial pattern: client funds the provider) and
    // baseline their balance AFTER the seed confirms — a fire-and-forget send
    // races this read on a sub-second chain (the balance lands pre-seed).
    const seedHash = await buyerWallet.writeContract({
      address: USDC,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [providerAccount.address, PROVIDER_SEED],
      account: buyerAccount,
      ...(await arcFees(publicClient)),
    });
    await publicClient.waitForTransactionReceipt({ hash: seedHash });

    const sla: Sla = {
      minBlock: Number(await publicClient.getBlockNumber()),
      schemaHash: keccak256(toBytes("openbook-test-schema-v1")),
      maxLatencyMs: 500,
    };

    // buyer signs createJob/approve/fund; provider signs setBudget (provider-only)
    const jobId = await createJobWithSla(publicClient, {
      buyer: buyerWallet,
      provider: providerWallet,
      evaluator: buyerAccount.address,
      expirySeconds: EXPIRY_SECONDS,
      sla,
      amount6dec: AMOUNT,
    });
    expect(typeof jobId).toBe("bigint");
    expect(jobId).toBeGreaterThan(0n);

    // job is Funded (1) with the packed SLA onchain, quote = AMOUNT
    const job = await getJob(publicClient, jobId);
    expect(job.id).toBe(jobId);
    expect(job.status).toBe(1); // Funded
    expect(job.budget).toBe(AMOUNT);
    expect(job.description).toBe(packSla(sla));
    expect(job.client).toBe(buyerAccount.address);
    expect(job.provider).toBe(providerAccount.address);
    expect(job.evaluator).toBe(buyerAccount.address);

    // PROVIDER signs the submission → Submitted (2)
    const deliverableHash = keccak256(toBytes(`openbook-deliverable-${jobId}`));
    await submitDeliverable(publicClient, providerWallet, jobId, deliverableHash);
    expect((await getJob(publicClient, jobId)).status).toBe(2); // Submitted

    // EVALUATOR (the buyer) settles → Completed (3) + PaymentReleased to provider
    const receipt = await complete(publicClient, buyerWallet, jobId, deliverableHash);
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
    // The PaymentReleased event in THIS job's receipt is the settlement truth
    // (amount + provider). A wallet balance-delta assertion is non-deterministic
    // on a shared wallet — the provider receives unrelated inflows (policy
    // withdrawals, other jobs) between the two reads; that flaked under
    // parallel runs (review round 2, both scorers).
    const args = released?.args as unknown as { amount?: bigint; provider?: Address };
    expect(args.amount).toBe(AMOUNT);
    expect(args.provider).toBe(providerAccount.address);
  },
  300_000,
);
