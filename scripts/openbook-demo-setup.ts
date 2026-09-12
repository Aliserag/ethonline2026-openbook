/**
 * openbook-demo-setup.ts — T13 "one-world" setup (ops only).
 *
 * Idempotent. Generates-or-loads a demo-buyer Arc testnet key, funds it
 * ~2 USDC from the repo admin/buyer key (0xAC54…), flips the SlaHook
 * attester to the demo buyer (signed by the CURRENT attester, 0x64A7…,
 * i.e. OPERATOR_PRIVATE_KEY), then asserts the live market-instance state
 * the hooks world depends on.
 *
 * After this, the demo buyer key is the hook's attester, so the app signer
 * (VITE_DEMO_BUYER_KEY) can complete() while the CLI keeps working with
 * OPENBOOK_ATTESTER_PK = demo key.
 *
 * The private key is NEVER printed. It is persisted to `.env` (gitignored)
 * as DEMO_BUYER_PK / VITE_DEMO_BUYER_KEY / VITE_DEMO_BUYER_ADDRESS /
 * OPENBOOK_ATTESTER_PK, and the address to `app/.env.local` so a dev-server
 * restart picks up the demo signer.
 *
 * Run:  bun scripts/openbook-demo-setup.ts
 *
 * Env used (from `.env` or process env):
 *   OPERATOR_PRIVATE_KEY  — current hook attester (0x64A7…); signs setAttester
 *   ARC_TESTNET_PK        — admin/buyer key (0xAC54…); funds the demo buyer
 *   ARC_TESTNET_RPC       — optional Arc RPC override (default rpc.testnet.arc.io)
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Account,
  type Address,
  type PublicClient,
  type WalletClient,
} from "../agent/node_modules/viem/index.js";
import { arcTestnet } from "../agent/node_modules/viem/chains/index.js";
import { privateKeyToAccount, generatePrivateKey } from "../agent/node_modules/viem/accounts/index.js";
import { ERC8183_ABI, USDC_ABI, arcFees, ARC_RPC_URL } from "../agent/escrow.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const ENV_PATH = resolve(REPO_ROOT, ".env");
const APP_ENV_LOCAL = resolve(REPO_ROOT, "app", ".env.local");

// --- one-world addresses (verified live; see docs/funded-run-status.md) --------
const HOOK: Address = "0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846"; // EIP-55 checksum present
const ESCROW: Address = "0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5";
const POLICY_WALLET: Address = "0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E";
const USDC: Address = "0x3600000000000000000000000000000000000000";

const FUND_USDC = 2_000_000n; // ~2 USDC (6 decimals)
const MIN_USDC = 1_000_000n; // floor to assert the demo buyer holds
const RPC = process.env["ARC_TESTNET_RPC"] ?? ARC_RPC_URL;

/** The SlaHook surface this script touches (attester read + flip). */
const HOOK_ABI = [
  {
    type: "function",
    name: "attester",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "setAttester",
    stateMutability: "nonpayable",
    inputs: [{ type: "address", name: "next" }],
    outputs: [],
  },
] as const satisfies Abi;

interface Env { [key: string]: string }
function loadEnv(path: string): Env {
  const out: Env = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2] !== "") out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
/** Upsert keys into an env file, preserving comments/order of untouched lines. */
function upsertEnv(path: string, updates: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.length ? existing.split("\n") : [];
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = m ? m[1] : null;
    if (key !== null && key in updates && !done.has(key)) {
      out.push(`${key}=${updates[key]}`);
      done.add(key);
    } else {
      out.push(line);
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!done.has(key)) out.push(`${key}=${value}`);
  }
  writeFileSync(path, out.join("\n").replace(/\n+$/, "") + "\n");
}

const publicClient: PublicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });

/** Signed write that waits for its receipt and throws on revert (mirrors escrow.ts). */
async function sendAndConfirm(
  w: WalletClient,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<{ hash: `0x${string}`; status: "success" | "reverted" }> {
  const account = w.account as Account;
  const fees = await arcFees(publicClient);
  const write = w.writeContract as unknown as (request: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
    account: Account;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }) => Promise<`0x${string}`>;
  const hash = await write({ address, abi, functionName, args, account, ...fees });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${functionName} reverted onchain (tx ${receipt.transactionHash})`);
  }
  return { hash, status: receipt.status };
}

const bal = async (who: string): Promise<bigint> => {
  const r = await publicClient.readContract({
    address: USDC,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [who as Address],
  });
  return r as bigint;
};
const usdc = (n: bigint): string => `${(Number(n) / 1e6).toFixed(6)} USDC`;
const keyOf = (pk: string): Address => privateKeyToAccount(pk as `0x${string}`).address;
const isKey = (v: string | undefined): v is string => /^0x[0-9a-fA-F]{64}$/.test(v ?? "");

async function hookAttester(): Promise<string> {
  const r = await publicClient.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "attester", args: [] });
  return r as string;
}

async function main(): Promise<void> {
  console.log(`[demo-setup] RPC=${RPC} escrow=${ESCROW} hook=${HOOK}`);
  const env = loadEnv(ENV_PATH);
  const pick = (k: string): string | undefined => (isKey(process.env[k]) ? process.env[k] : isKey(env[k]) ? env[k] : undefined);

  // --- 1. demo buyer key: generate-or-load --------------------------------------
  let demoPk = pick("DEMO_BUYER_PK");
  let demoAddr: Address;
  if (demoPk !== undefined) {
    demoAddr = keyOf(demoPk);
    console.log(`[demo-setup] using existing demo buyer: ${demoAddr}`);
  } else {
    demoPk = generatePrivateKey();
    demoAddr = keyOf(demoPk);
    console.log(`[demo-setup] generated fresh demo buyer: ${demoAddr} (key persisted to .env, NOT printed)`);
  }
  const envAddr = env["DEMO_BUYER_ADDRESS"] ?? process.env["DEMO_BUYER_ADDRESS"];
  if (envAddr && envAddr !== demoAddr) {
    console.warn(`[demo-setup] WARNING: DEMO_BUYER_ADDRESS mismatch — env has ${envAddr}, key derives ${demoAddr}; using derived address`);
  }

  // persist to .env (upsert) — covers DEMO_BUYER_PK / key / address / attester override
  const envUpdates: Record<string, string> = {
    DEMO_BUYER_PK: demoPk,
    VITE_DEMO_BUYER_KEY: demoPk,
    VITE_DEMO_BUYER_ADDRESS: demoAddr,
    OPENBOOK_ATTESTER_PK: demoPk, // CLI attests as the demo buyer (the point of T13)
  };
  upsertEnv(ENV_PATH, envUpdates);
  // app/.env.local — dev server picks up the demo signer on restart
  upsertEnv(APP_ENV_LOCAL, { VITE_DEMO_BUYER_KEY: demoPk, VITE_DEMO_BUYER_ADDRESS: demoAddr });
  console.log(`[demo-setup] persisted demo key to .env + app/.env.local (idempotent upsert)`);

  // --- 2. fund the demo buyer ~2 USDC from admin/buyer key 0xAC54… -------------
  const adminPk = pick("ARC_TESTNET_PK");
  if (adminPk === undefined) {
    console.warn(`[demo-setup] ARC_TESTNET_PK (admin/buyer 0xAC54…) not found — cannot fund; demo buyer starts at its current balance`);
  } else {
    const adminAddr = keyOf(adminPk);
    const before = await bal(demoAddr);
    console.log(`[demo-setup] admin=${adminAddr} demo-buyer balance before=${usdc(before)}`);
    if (before < FUND_USDC) {
      const need = FUND_USDC - before;
      const adminBefore = await bal(adminAddr);
      if (adminBefore < need) {
        throw new Error(`admin ${adminAddr} holds ${usdc(adminBefore)} < needed ${usdc(need)} to fund demo buyer to ~2 USDC`);
      }
      console.log(`[demo-setup] funding demo buyer +${usdc(need)} (to ~${usdc(FUND_USDC)})…`);
      const { hash } = await sendAndConfirm(wallet(adminPk), USDC, USDC_ABI, "transfer", [demoAddr, need]);
      console.log(`[demo-setup] fund tx=${hash}`);
    } else {
      console.log(`[demo-setup] demo buyer already >= ${usdc(FUND_USDC)} — skip funding (idempotent)`);
    }
    const after = await bal(demoAddr);
    console.log(`[demo-setup] demo-buyer balance after=${usdc(after)}`);
    if (after < MIN_USDC) {
      console.warn(`[demo-setup] demo buyer balance ${usdc(after)} < 1 USDC — funding did not land; manual top-up may be needed`);
    }
  }

  // --- 3. hook attester: flip to demo buyer if not already ----------------------
  const current = await hookAttester();
  console.log(`[demo-setup] hook attester()=${current} demo-buyer=${demoAddr}`);
  if (current.toLowerCase() !== demoAddr.toLowerCase()) {
    const opPk = pick("OPERATOR_PRIVATE_KEY");
    if (opPk === undefined) {
      throw new Error("attester flip needs OPERATOR_PRIVATE_KEY (the CURRENT attester, 0x64A7…) — missing");
    }
    const opAddr = keyOf(opPk);
    if (opAddr.toLowerCase() !== current.toLowerCase()) {
      throw new Error(`OPERATOR_PRIVATE_KEY derives ${opAddr} but the hook attester() is ${current} — only the current attester may flip it`);
    }
    console.log(`[demo-setup] setAttester(${demoAddr}) signed by current attester ${opAddr}…`);
    const { hash } = await sendAndConfirm(wallet(opPk), HOOK, HOOK_ABI, "setAttester", [demoAddr]);
    console.log(`[demo-setup] setAttester tx=${hash}`);
    const now = await hookAttester();
    if (now.toLowerCase() !== demoAddr.toLowerCase()) {
      throw new Error(`attester flip failed: still ${now}`);
    }
    console.log(`[demo-setup] attester flipped -> ${now}`);
    appendFileSync(resolve(REPO_ROOT, "scripts", ".demo-setter.lock"), `${hash} ${now}\n`);
  } else {
    console.log(`[demo-setup] attester already = demo buyer — nothing to flip (idempotent)`);
  }

  // --- 4. assert the live market-instance state --------------------------------
  const fee = (await publicClient.readContract({ address: ESCROW, abi: ERC8183_ABI, functionName: "platformFeeBP", args: [] })) as bigint;
  const treasury = (await publicClient.readContract({ address: ESCROW, abi: ERC8183_ABI, functionName: "platformTreasury", args: [] })) as string;
  const demoBal = await bal(demoAddr);
  console.log(`[demo-setup] platformFeeBP=${fee} platformTreasury=${treasury}`);
  if (fee !== 200n) throw new Error(`platformFeeBP expected 200, got ${fee}`);
  if (treasury.toLowerCase() !== POLICY_WALLET.toLowerCase()) {
    throw new Error(`platformTreasury expected ${POLICY_WALLET}, got ${treasury}`);
  }
  if (demoBal < MIN_USDC) throw new Error(`demo buyer ${demoAddr} holds ${usdc(demoBal)} < 1 USDC`);
  console.log(`[demo-setup] ASSERTS PASS: fee=200, treasury=${POLICY_WALLET}, demo buyer balance=${usdc(demoBal)}`);

  console.log("[demo-setup] done. Demo buyer is the hook attester; CLI attests as it via OPENBOOK_ATTESTER_PK.");
}

function wallet(pk: string): WalletClient {
  return createWalletClient({ chain: arcTestnet, transport: http(RPC), account: privateKeyToAccount(pk as `0x${string}`) });
}

main().catch((e) => {
  console.error(`[demo-setup] FAILED: ${(e && e.message) || e}`);
  process.exit(1);
});
