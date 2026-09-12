#!/usr/bin/env bun
/**
 * Move the Circle seller wallet's USDC earnings back to the Circle buyer wallet so the
 * keyless demo keeps running (both wallets are ours; the escrow settled the seller for real).
 *   bun scripts/circle/recycle.ts            # transfer everything the seller holds
 *   bun scripts/circle/recycle.ts --dry-run
 */
import { createPublicClient, http, parseAbi } from "viem";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { circleEnvFrom, entitySecretCiphertext } from "../../app/worker/circle";
import { ARC_RPC, USDC, arcTestnet } from "../../app/worker/shared";

const env = Object.fromEntries(
  readFileSync(resolve(import.meta.dir, "../../.env"), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_0-9]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/\s+#.*$/, "").trim()];
    }),
);
const cenv = circleEnvFrom((k) => (k === "CIRCLE_API_KEY" ? (env.CIRCLE_API_KEY ?? env.ARC_TEST_API_KEY) : env[k]));
if (!cenv) throw new Error("Circle env incomplete in .env (run scripts/circle/provision.ts)");
const pub = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });
const bal = await pub.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [cenv.sellerAddress] });
console.log(`seller holds ${Number(bal) / 1e6} USDC`);
if (bal === 0n || process.argv.includes("--dry-run")) process.exit(0);
const res = await fetch("https://api.circle.com/v1/w3s/developer/transactions/transfer", {
  method: "POST",
  headers: { authorization: `Bearer ${cenv.apiKey}`, "content-type": "application/json" },
  body: JSON.stringify({
    idempotencyKey: crypto.randomUUID(),
    walletId: cenv.sellerWalletId,
    destinationAddress: cenv.buyerAddress,
    tokenAddress: USDC,
    blockchain: "ARC-TESTNET",
    amount: [(Number(bal) / 1e6).toFixed(6)],
    feeLevel: "MEDIUM",
    entitySecretCiphertext: await entitySecretCiphertext(cenv),
  }),
});
const body = (await res.json()) as { data?: { id?: string; state?: string }; message?: string };
if (!res.ok || !body.data?.id) throw new Error(`transfer failed ${res.status}: ${body.message ?? ""}`);
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const t = ((await (await fetch(`https://api.circle.com/v1/w3s/transactions/${body.data.id}`, { headers: { authorization: `Bearer ${cenv.apiKey}` } })).json()) as { data?: { transaction?: { state?: string; txHash?: string; errorReason?: string } } }).data?.transaction;
  if (t?.state === "COMPLETE") {
    console.log(`recycled ${Number(bal) / 1e6} USDC seller → buyer · tx ${t.txHash}`);
    process.exit(0);
  }
  if (t?.state && ["FAILED", "DENIED", "CANCELLED"].includes(t.state)) throw new Error(`transfer ${t.state}: ${t.errorReason ?? ""}`);
}
throw new Error("transfer did not complete in time");
