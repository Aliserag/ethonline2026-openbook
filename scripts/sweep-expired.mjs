#!/usr/bin/env node
/**
 * Refund every OpenBook escrow job that sits Funded/Submitted past its deadline.
 * ERC-8183 claimRefund(jobId) can be sent by anyone; the money always goes to the
 * job's client. Any funded Arc key works (SWEEP_PK, else OPENBOOK_ATTESTER_PK).
 *   node scripts/sweep-expired.mjs            # sweep
 *   node scripts/sweep-expired.mjs --dry-run  # list only
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
// viem is installed under app/; resolve it from there so the script runs from the repo root
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { createPublicClient, createWalletClient, http, parseAbi } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const RPC = "https://rpc.testnet.arc.io";
const ESCROW = "0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5";
const ABI = parseAbi([
  "function jobs(uint256) view returns (uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook)",
  "function claimRefund(uint256 jobId)",
]);
const chain = { id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const dry = process.argv.includes("--dry-run");
let pk = process.env.SWEEP_PK ?? process.env.OPENBOOK_ATTESTER_PK;
if (!pk) {
  try {
    const m = readFileSync(".env", "utf8").match(/^OPENBOOK_ATTESTER_PK=(0x[0-9a-fA-F]{64})/m);
    pk = m?.[1];
  } catch {}
}
const pub = createPublicClient({ chain, transport: http(RPC) });
const now = BigInt(Math.floor(Date.now() / 1000));
const expired = [];
for (let id = 1n; ; id++) {
  const job = await pub.readContract({ address: ESCROW, abi: ABI, functionName: "jobs", args: [id] });
  if (job[0] === 0n) break;
  const [, client, , , , budget, expiredAt, status] = job;
  if ((status === 1 || status === 2) && expiredAt < now) expired.push({ id, client, budget });
}
console.log(`${expired.length} expired open job(s)`);
for (const j of expired) console.log(`  job ${j.id} · ${Number(j.budget) / 1e6} USDC back to ${j.client}`);
if (dry || expired.length === 0) process.exit(0);
if (!pk) throw new Error("no key: set SWEEP_PK or OPENBOOK_ATTESTER_PK");
const wallet = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(pk) });
for (const j of expired) {
  const hash = await wallet.writeContract({ address: ESCROW, abi: ABI, functionName: "claimRefund", args: [j.id] });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  job ${j.id} claimRefund ${hash} ${r.status}`);
}
