// Live check (W2 evidence): run the buyer CLI's marketplace mode against live
// Sepolia ENSv2 — `--compare` lists every seller offering a schema with its
// ENS price/SLA, then (unless --compare) buys from the pickSeller choice.
//
// Env is stripped in this harness (bun sees 0 process.env keys), so the RPC
// travels as argv[2] — the same trick M2's directory-live.ts uses. The CLI's
// loadDotEnv then fills the remaining keys from .env; SEPOLIA_RPC is already
// set here so the file never overrides it. Read-only runs need no keys.
//
// Usage: bun scripts/spikes/router-live.ts [sepolia-rpc-url] -- <cli-args...>
import { main } from "../../agent/buyer-cli";

const RPC = process.argv[2] ?? "https://ethereum-sepolia.publicnode.com";
process.env.SEPOLIA_RPC = RPC;
try {
  await main(process.argv.slice(3));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[buyer] ${message}`);
  process.exit(1);
}
