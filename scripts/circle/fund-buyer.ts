#!/usr/bin/env bun
/**
 * Top up the page's Circle buyer wallet on Arc from the treasury's USDC on another chain,
 * through Circle App Kit's Bridge (CCTP v2) with the Forwarding Service minting on Arc, so
 * no destination-chain gas is needed. Testnet USDC for the source chain comes from Circle's
 * faucet (faucet.circle.com or POST /v1/faucet/drips with the console API key).
 *
 *   bun scripts/circle/fund-buyer.ts 3.00               # from Arbitrum_Sepolia (default)
 *   bun scripts/circle/fund-buyer.ts 2.00 Base_Sepolia
 *
 * Needs SEPOLIA_PK (the treasury EOA) and CIRCLE_BUYER_WALLET_ADDRESS in the root .env, and
 * the App Kit packages: bun add @circle-fin/app-kit @circle-fin/adapter-viem-v2
 */
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const env = Object.fromEntries(
  readFileSync(resolve(import.meta.dir, "../../.env"), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_0-9]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/\s+#.*$/, "").trim()];
    }),
);
const amount = process.argv[2] ?? "3.00";
const fromChain = process.argv[3] ?? "Arbitrum_Sepolia";
const recipient = env.CIRCLE_BUYER_WALLET_ADDRESS;
if (!env.SEPOLIA_PK || !recipient) throw new Error("SEPOLIA_PK and CIRCLE_BUYER_WALLET_ADDRESS are required in .env");

const adapter = createViemAdapterFromPrivateKey({ privateKey: env.SEPOLIA_PK as `0x${string}` });
const kit = new AppKit();
const t0 = Date.now();
let result = await kit.bridge({
  from: { adapter, chain: fromChain as "Arbitrum_Sepolia" },
  to: { chain: "Arc_Testnet", recipientAddress: recipient, useForwarder: true },
  amount,
});
if (result.state === "error") result = await kit.retryBridge(result, { from: adapter });
const steps = (result as { steps?: { name: string; state: string; txHash?: string; error?: { message?: string } }[] }).steps ?? [];
for (const s of steps) console.log(`  ${s.name.padEnd(17)} ${s.state}${s.txHash ? ` ${s.txHash}` : ""}${s.error ? ` ${s.error.message ?? s.error}` : ""}`);
console.log(`${result.state}: ${amount} USDC ${fromChain} → Arc_Testnet for ${recipient} (${Math.round((Date.now() - t0) / 1000)}s)`);
process.exit(result.state === "error" ? 1 : 0);
