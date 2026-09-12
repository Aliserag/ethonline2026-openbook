// Live check (W2 evidence): run the buyer CLI's marketplace mode against live
// Sepolia ENSv2 — `--compare` lists every seller offering a schema with its
// ENS price/SLA, then (unless --compare) buys from the pickSeller choice: the
// job is funded FOR the chosen seller (provider = their svc.operator) and the
// CLI polls their loop for the submission before verifying/settling.
//
// Env is stripped in this harness (bun sees 0 process.env keys), so the
// Sepolia RPC travels as argv[2] and all remaining keys are loaded from .env
// (the CLI's own loadDotEnv does the same). `--escrow <addr>` is consumed
// here as OPENBOOK_ESCROW so the market instance (0x967e…) can be targeted.
//
// Usage: bun scripts/spikes/router-live.ts [sepolia-rpc-url] -- <cli-args...>
//        with optional `--escrow <addr>` inside <cli-args>.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { main } from "../../agent/buyer-cli";

// Mirror the CLI's minimal .env loader (loads only unset keys).
try {
  const text = readFileSync(resolve(".env"), "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
  }
} catch {
  // no .env — env must come from the shell
}

const RPC = process.argv[2] ?? "https://ethereum-sepolia.publicnode.com";
process.env.SEPOLIA_RPC = RPC;

const rest = process.argv.slice(3);
const escrowIndex = rest.indexOf("--escrow");
if (escrowIndex >= 0 && escrowIndex + 1 < rest.length) {
  process.env.OPENBOOK_ESCROW = rest[escrowIndex + 1];
  rest.splice(escrowIndex, 2);
}
try {
  await main(rest);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[buyer] ${message}`);
  process.exit(1);
}
