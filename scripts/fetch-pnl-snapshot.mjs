#!/usr/bin/env node
/**
 * fetch-pnl-snapshot.mjs — build-time snapshot fallback (demo resilience).
 *
 * Fetches the open-book Studio P&L endpoint ONCE and writes
 * app/public/pnl-snapshot.json (dailyPnLs + refundIssueds + providers + a
 * takenAt ISO stamp). The app serves it only when BOTH the live read and the
 * last-good cache are unavailable, always labeled `snapshot taken <time>` —
 * so a fresh visitor with no cache still sees real (labeled) numbers during
 * an upstream wall.
 *
 * Wired as a pre-build step in scripts/deploy-app.sh. Fails SOFT: when the
 * Studio endpoint is walled at build time, the previous snapshot (if any) is
 * kept and the build proceeds — the app then degrades to live+cache only.
 *
 *   node scripts/fetch-pnl-snapshot.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "mcp/config/openbook.json");
const OUT_PATH = resolve(ROOT, "app/public/pnl-snapshot.json");

/** Same selections the app reads: pnl.query's fields + the market's providers. */
const QUERY = `{ dailyPnLs { id startedAt revenue costs refunds net } refundIssueds(first: 3, orderBy: id, orderDirection: desc) { id jobId reason } providers(orderBy: lastJobAt, orderDirection: desc) { id jobs settled refunded delivered avgLagBlocks lastJobAt } }`;

function failSoft(message) {
  console.warn(`   WARN: ${message}`);
  console.warn("   keeping any existing snapshot; the app falls back to live + cache only");
  process.exit(0);
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (error) {
  failSoft(`cannot read ${CONFIG_PATH}: ${error.message}`);
}
const endpoint = config?.pnl?.endpoint;
if (typeof endpoint !== "string" || endpoint.length === 0) {
  failSoft("no pnl.endpoint in config");
}

console.log(`   fetching pnl snapshot from ${endpoint}`);

let response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY }),
  });
} catch (error) {
  failSoft(`upstream fetch failed: ${error.message}`);
}
if (!response.ok) {
  failSoft(`upstream HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

let payload;
try {
  payload = await response.json();
} catch (error) {
  failSoft(`upstream returned non-JSON: ${error.message}`);
}
const data = payload?.data;
if (typeof data !== "object" || data === null) {
  failSoft("upstream returned no data payload");
}
const dailyPnLs = Array.isArray(data.dailyPnLs) ? data.dailyPnLs : [];
const refundIssueds = Array.isArray(data.refundIssueds) ? data.refundIssueds : [];
const providers = Array.isArray(data.providers) ? data.providers : [];

const snapshot = {
  takenAt: new Date().toISOString(),
  dailyPnLs,
  refundIssueds,
  providers,
};

try {
  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
} catch (error) {
  console.error(`   FAIL: cannot write ${OUT_PATH}: ${error.message}`);
  process.exit(1);
}
console.log(
  `   wrote ${OUT_PATH}: ${dailyPnLs.length} daily rows, ${refundIssueds.length} refund events, ${providers.length} providers @ ${snapshot.takenAt}`,
);
