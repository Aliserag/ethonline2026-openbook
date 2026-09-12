/**
 * Adversarial E2E F2 — treasury hash case contract (browser check).
 *
 * The books' treasury row renders the policy-wallet address through the
 * `running .cap` label style, whose `text-transform: uppercase` mangles the
 * value: `0x4e83…894E` displays as `0X4E83…894E` (0x prefix included) and
 * destroys EIP-55 case. Every other hash in the app renders lower/mixed-case
 * mono. A hash is DATA, not a label — it must not inherit the label's case
 * transform (nor the label's sans face).
 *
 * Run against the dev server (:5173) with the P&L endpoint forced to fail so
 * the surface is deterministic. Exits nonzero on failure.
 *
 *   npm i --no-save playwright-core   # or NODE_PATH to an install
 *   node scripts/adversarial-check-f2-treasury-case.mjs
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

// Force the P&L (Studio) endpoint to fail — the books card must still render
// the treasury row (its read is onchain, not subgraph), which is the surface
// under test.
await page.route("**://api.studio.thegraph.com/**", (route) =>
  route.fulfill({ status: 500, contentType: "application/json", body: "{}" }).catch(() => {}),
);

await page.goto(process.env.TARGET ?? "http://localhost:5173", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(4000);

const anchor = await page.$('.refunds-live .cap a[href*="arcscan"]');
if (!anchor) {
  check(false, "treasury-row-present", "no treasury anchor in the books card");
} else {
  const style = await anchor.evaluate((el) => ({
    textTransform: getComputedStyle(el).textTransform,
    fontFamily: getComputedStyle(el).fontFamily,
  }));
  check(
    style.textTransform === "none",
    "treasury-hash-not-uppercased",
    `computed text-transform: ${style.textTransform}`,
  );
  check(
    style.fontFamily.includes("Mono") || style.fontFamily.includes("mono"),
    "treasury-hash-mono",
    `computed font-family: ${style.fontFamily.split(",")[0]}`,
  );
}
await browser.close();
if (failures.length > 0) {
  console.error(`F2 CHECK FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("F2 CHECK PASSED");
