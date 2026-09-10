#!/usr/bin/env bash
':' //; exec node "$0" "$@"
// arc-usdc-transfer.mjs — OpenBook Task 0, Spike 1: Arc USDC transfer smoke.
// Run: bash scripts/spikes/arc-usdc-transfer.mjs  (re-execs via node; ./… or node … also work)
// Keyless mode: wallet unfunded -> prints funding steps and exits 3 (documented, not blocked).
// Funded mode: transfers 100000 (0.1 USDC, 6 decimals) from the .env wallet to the spare
// recipient and verifies receipt status 0x1. Requires cast (foundry) on PATH.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const RPC = "https://rpc.testnet.arc.io";
const CHAIN_ID = 5042002n; // Arc testnet (verified)
const USDC = "0x3600000000000000000000000000000000000000"; // native USDC ERC-20 view, 6 decimals
const AMOUNT = 100000n; // 0.1 USDC (100000 / 10^6)

function loadEnv() {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2] !== "") out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function cast(args) {
  return execFileSync("cast", args, { encoding: "utf8" }).trim();
}
function castOrNull(args) {
  try {
    return cast(args);
  } catch {
    return null;
  }
}
const firstNum = (s) => (s ? BigInt(s.split(" ")[0].replace(/"/g, "")) : null);
const usdc = (n) => (Number(n) / 1e6).toFixed(6) + " USDC";

function printFundingSteps() {
  console.log("");
  console.log("Funding steps (user action — keys needed):");
  console.log("  1) run    bash scripts/spikes/generate-key.sh   (already done if .env exists)");
  console.log("  2) fund   https://faucet.circle.com -> connect ARC_TESTNET_ADDR -> Arc Testnet -> USDC");
  console.log("     or Circle drips API (developer key): POST https://api.circle.com/v1/faucet/drips");
  console.log("     body: {\"address\":\"<ARC_TESTNET_ADDR>\",\"blockchain\":\"ARC-TESTNET\",\"native\":true,\"usdc\":true}");
  console.log("     (probed 2026-09-09: 401 without Bearer <TEST_API_KEY> — see docs/keys-needed.md)");
  console.log("  3) re-run this script — expected receipt status 0x1, tx on testnet.arcscan.app");
}

async function main() {
  console.log(`[arc-usdc-transfer] RPC=${RPC} chainId=${CHAIN_ID.toString()} amount=${AMOUNT.toString()} (=0.1 USDC, 6-dec)`);
  const onchain = castOrNull(["chain-id", "--rpc-url", RPC]);
  if (!onchain || firstNum(onchain) !== CHAIN_ID) {
    console.error("FATAL: cannot reach Arc testnet RPC (expected chain 5042002).");
    process.exit(1);
  }
  const env = loadEnv();
  const pk = env.ARC_TESTNET_PK;
  const recipient = env.ARC_RECIPIENT_ADDR;
  const LIVE_GAS = cast(["gas-price", "--rpc-url", RPC]).trim();
  if (!pk || !recipient) {
    console.log("SKIP: .env missing ARC_TESTNET_PK / ARC_RECIPIENT_ADDR — run scripts/spikes/generate-key.sh first.");
    printFundingSteps();
    process.exit(3);
  }
  const sender = cast(["wallet", "address", `--private-key=${pk}`]);
  const bal = firstNum(cast(["call", USDC, "balanceOf(address)(uint256)", sender, "--rpc-url", RPC]));
  if (bal === 0n) {
    console.log(`SKIP: wallet ${sender} holds 0 USDC on Arc testnet — fund it first (USDC is gas on Arc).`);
    printFundingSteps();
    process.exit(3);
  }
  if (bal < AMOUNT) {
    console.log(`SKIP: wallet ${sender} balance ${usdc(bal)} < required ${usdc(AMOUNT)} + gas.`);
    printFundingSteps();
    process.exit(3);
  }
  console.log(`sender   = ${sender}  balance=${usdc(bal)}`);
  console.log(`transfer = ${usdc(AMOUNT)} -> ${recipient}`);
  const out = cast([
    "send", USDC, "transfer(address,uint256)", recipient, AMOUNT.toString(),
    "--rpc-url", RPC, `--private-key=${pk}`, "--gas-price", LIVE_GAS, // live base fee (floats above the 20 Gwei floor)
  ]);
  const tx = (out.match(/0x[0-9a-fA-F]{64}/) || [])[0];
  if (!tx) {
    console.error("FAIL: no transaction hash in cast send output:\n" + out);
    process.exit(1);
  }
  console.log(`tx hash  = ${tx}`);
  console.log(`explorer = https://testnet.arcscan.app/tx/${tx}`);
  const rec = JSON.parse(cast(["receipt", tx, "--json", "--rpc-url", RPC]));
  console.log(`receipt: status=${rec.status} blockNumber=${rec.blockNumber} gasUsed=${rec.gasUsed}`);
  if (rec.status === "0x1") {
    console.log("PASS: USDC transfer confirmed on Arc testnet (receipt status 1).");
    process.exit(0);
  }
  console.error("FAIL: receipt status != 0x1");
  process.exit(1);
}

main().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exit(1);
});
