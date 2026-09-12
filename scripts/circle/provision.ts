#!/usr/bin/env bun
/**
 * One-time provisioning of the page's Circle wallets (Arc testnet):
 *   1. generate + register the entity secret (recovery file OUTSIDE the repo)
 *   2. create a wallet set and two SCA wallets: buyer and seller
 *   3. append the ids/addresses to the root .env (never printed)
 * Needs CIRCLE_API_KEY (or ARC_TEST_API_KEY) in .env. Re-runs are idempotent.
 *   bun add -g @circle-fin/developer-controlled-wallets   # or run from a dir that has it
 *   bun scripts/circle/provision.ts
 */
import { initiateDeveloperControlledWalletsClient, registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const ENV = resolve(import.meta.dir, "../../.env");
const RECOVERY_DIR = process.env.CIRCLE_RECOVERY_DIR ?? resolve(homedir(), "Documents/OpenBook-secrets");
const env = Object.fromEntries(
  readFileSync(ENV, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_0-9]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/\s+#.*$/, "").trim()];
    }),
);
const raw = env.CIRCLE_API_KEY ?? env.ARC_TEST_API_KEY;
if (!raw) throw new Error("CIRCLE_API_KEY (or ARC_TEST_API_KEY) missing from .env");
const apiKey = raw.split(":").length === 3 ? raw : `TEST_API_KEY:${raw}`;

let entitySecret = env.CIRCLE_ENTITY_SECRET;
if (!entitySecret) {
  mkdirSync(RECOVERY_DIR, { recursive: true });
  entitySecret = randomBytes(32).toString("hex");
  await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: RECOVERY_DIR });
  appendFileSync(ENV, `\n# Circle developer-controlled wallets (registered ${new Date().toISOString()}; recovery file in ${RECOVERY_DIR})\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);
  console.log(`entity secret registered; recovery file saved under ${RECOVERY_DIR} (keep it)`);
} else console.log("entity secret already in .env");

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
let walletSetId = env.CIRCLE_WALLET_SET_ID;
if (!walletSetId) {
  walletSetId = (await client.createWalletSet({ name: "openbook" })).data?.walletSet?.id;
  if (!walletSetId) throw new Error("no wallet set id");
  appendFileSync(ENV, `CIRCLE_WALLET_SET_ID=${walletSetId}\n`);
}
if (!env.CIRCLE_BUYER_WALLET_ID) {
  const w = await client.createWallets({
    walletSetId,
    blockchains: ["ARC-TESTNET"],
    count: 2,
    accountType: "SCA",
    metadata: [{ name: "openbook buyer", refId: "buyer" }, { name: "openbook seller", refId: "seller" }],
  });
  const wallets = w.data?.wallets ?? [];
  const buyer = wallets.find((x) => x.refId === "buyer") ?? wallets[0];
  const seller = wallets.find((x) => x.refId === "seller") ?? wallets[1];
  if (!buyer || !seller) throw new Error("wallet creation returned fewer than two wallets");
  appendFileSync(ENV, `CIRCLE_BUYER_WALLET_ID=${buyer.id}\nCIRCLE_BUYER_WALLET_ADDRESS=${buyer.address}\nCIRCLE_SELLER_WALLET_ID=${seller.id}\nCIRCLE_SELLER_WALLET_ADDRESS=${seller.address}\n`);
  console.log("buyer", buyer.address, "· seller", seller.address, "· SCA on ARC-TESTNET, gas by Gas Station");
} else console.log("wallets already provisioned:", env.CIRCLE_BUYER_WALLET_ADDRESS, env.CIRCLE_SELLER_WALLET_ADDRESS);
console.log("next: fund the buyer with testnet USDC (faucet.circle.com, Arc Testnet) and set the CIRCLE_* values as server secrets on both hosts");
