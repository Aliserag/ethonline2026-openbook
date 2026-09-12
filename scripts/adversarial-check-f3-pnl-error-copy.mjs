/**
 * Adversarial E2E F3 — P&L error-state copy contract (browser check).
 *
 * When the P&L fetch fails, the books card shows an error notice but its
 * siblings lie about the state: the statline reads `live · … daily rows`
 * (a liveness claim plus a bare `…` placeholder) and the daily-rows panel
 * reads `loading the ledger…` forever (aria-busy is off — nothing is loading).
 * The error state must render as an error on both surfaces.
 *
 * Run with the P&L endpoint forced to fail. Exits nonzero on failure.
 *   npm i --no-save playwright-core
 *   node scripts/adversarial-check-f3-pnl-error-copy.mjs
 */
let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  // Dev fallback: bun workspace has no npm-installable node_modules; point
  // at a local playwright-core install (e.g. /tmp/t18/pw/node_modules).
  ({ chromium } = await import("file:///tmp/t18/pw/node_modules/playwright-core/index.mjs"));
}

const failures = [];
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

await page.route("**://api.studio.thegraph.com/**", (route) =>
  route.fulfill({ status: 500, contentType: "application/json", body: "{}" }).catch(() => {}),
);

await page.goto(process.env.TARGET ?? "http://localhost:5173", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const text = (sel) => document.querySelector(sel)?.textContent ?? "";
  const books = document.querySelector("#pnl-title")?.closest(".stepcard");
  return {
    booksError: (books?.textContent ?? "").includes("error") && !/loading|live/.test((books?.querySelector(".stepstate")?.textContent) ?? ""),
    statline: books?.querySelector(".statline")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    daily: document.querySelector("#ledger-title")?.closest(".stepcard")?.textContent ?? "",
    dailyBusy: books?.getAttribute("aria-busy") ?? null,
  };
});

const statlineOk = state.statline.includes("error") && !state.statline.includes("live") && !state.statline.includes("…");
check(state.booksError, "books-card-error", `stepstate text: ${state.booksError}`);
check(statlineOk, "statline-error-copy", `statline: "${state.statline}"`);
const dailyOk = !state.daily.includes("loading the ledger") && /error|could not be read/i.test(state.daily);
check(dailyOk, "daily-rows-error-copy", `daily rows: "${state.daily.slice(0, 120)}"`);
check(state.dailyBusy === "false", "not-busy-not-loading", `aria-busy=${state.dailyBusy}`);

await browser.close();
if (failures.length > 0) {
  console.error(`F3 CHECK FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("F3 CHECK PASSED");
