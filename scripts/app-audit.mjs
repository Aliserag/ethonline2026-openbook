#!/usr/bin/env node
/**
 * OpenBook living-protocol e2e audit (plan Task 15) — the scripted half of the
 * release gate. Ports and extends the /tmp/obaudit throwaway harness:
 * puppeteer-core + the system Chrome at the standard macOS path.
 *
 *   node scripts/app-audit.mjs [--url http://localhost:5173]
 *
 * Surfaces asserted (6 groups):
 *   1. shell  — the spine tagline renders verbatim.
 *   2. map    — all 8 nodes (ens, agent, policy, mcp, gateway, subgraph,
 *               escrow, hook) render non-error values, or truthful degraded
 *               states whose reason text is present.
 *   3. console— ⌘K opens the dock; `help` lists the full 18-command set;
 *               `status` prints every live source; `quote
 *               aave-v3-arbitrum-lending` renders the ENS price (0.15 via the
 *               subname override) and an SLA floor.
 *   4. money  — `policy refusals` renders the real PolicyBlocked rows (or the
 *               truthful empty state); the replay theater for a known settled
 *               job renders all six frames with the money frame's split
 *               summing to the job amount.
 *   5. market — both sellers render from live ENS (openbook.eth +
 *               alpha.openbook.eth) and the venue row reads the escrow's
 *               platformFeeBP/Treasury as "2% → PolicyWallet" — or a reasoned
 *               degraded state.
 *   6. hygiene— zero console JS errors (excluding ambient 429s and
 *               chrome-extension origins); no horizontal overflow at 1440 and
 *               1280; no rendered text under 12px with the dock open.
 *
 * Ambient-429 honesty: a live widget that cannot load under the Studio-
 * gateway/Arc rate limit is retried once, then SKIPPED with the exact reason
 * printed — a SKIP only ever covers an ambient failure (matched by /429|rate
 * limit/i), never a product defect. Any other failure exits non-zero.
 *
 * Dependency: puppeteer-core (npm i --prefix scripts; the script also falls
 * back to the /tmp/obaudit harness install it was ported from).
 *
 * NOTE: every page.evaluate callback is fully self-contained — puppeteer
 * serializes function source into the page, closures over node-side helpers
 * do not exist there.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const AMBIENT_429 = /429|too many requests|rate[ _-]?limit(ed)?/i;
const EXTENSION_ORIGIN = /^chrome-extension:\/\//i;

// ---- assertion ledger -------------------------------------------------------

const results = [];
let fails = 0;
let skips = 0;
const failShots = [];

function done(name, verdict, detail) {
  results.push({ name, verdict, detail });
  console.log(`${verdict} ${name}${detail ? ` — ${detail}` : ""}`);
  if (verdict === "FAIL") fails += 1;
  if (verdict === "SKIP") skips += 1;
}

const pass = (name, detail) => done(name, "PASS", detail);
const fail = (name, detail) => done(name, "FAIL", detail);
const skip = (name, detail) => done(name, "SKIP", detail);

// ---- small node-side utils --------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Wait for a page-evaluate predicate (self-contained fn). Fails fast when the
 *  predicate itself throws deterministically (harness bug, not app state). */
async function waitFor(page, fn, { timeout = 60000, interval = 1500, label = "condition" } = {}, ...fnArgs) {
  const t0 = Date.now();
  let lastError;
  let sameErrorStreak = 0;
  for (;;) {
    let value;
    try {
      value = await page.evaluate(fn, ...fnArgs);
      lastError = null;
      sameErrorStreak = 0;
    } catch (error) {
      const msg = String(error && error.message ? error.message : error);
      if (lastError === msg) {
        sameErrorStreak += 1;
        if (sameErrorStreak >= 3) throw new Error(`predicate failing deterministically for ${label}: ${msg.slice(0, 140)}`);
      } else {
        sameErrorStreak = 1;
      }
      lastError = msg;
      value = null;
    }
    if (value) return value;
    if (Date.now() - t0 > timeout) {
      throw new Error(`timeout waiting for ${label}${lastError ? ` (${lastError.slice(0, 140)})` : ""}`);
    }
    await sleep(interval);
  }
}

/** Is this an ambient gateway/Arc failure the app truthfully degraded from? */
const isAmbient = (text) => AMBIENT_429.test(String(text ?? ""));

// ---- puppeteer --------------------------------------------------------------

function loadPuppeteer() {
  for (const candidate of ["puppeteer-core", "/tmp/obaudit/node_modules/puppeteer-core"]) {
    try {
      const mod = require(candidate);
      if (mod && typeof mod.launch === "function") return mod;
    } catch {
      // keep looking
    }
  }
  throw new Error(
    "puppeteer-core not found — run `npm install --prefix scripts` (or keep the /tmp/obaudit harness install the script was ported from)",
  );
}

// ---- surface constants ------------------------------------------------------

const SPINE_LINE =
  "The data marketplace for agents, with automatic refunds for every stale delivery.";

/** The full registered command set: 11 inspect + 3 act + 4 sandbox. */
const COMMAND_NAMES = [
  "help",
  "status",
  "ens show",
  "datasets",
  "quote",
  "books",
  "jobs",
  "job",
  "lag",
  "policy show",
  "replay",
  "buy",
  "deliver",
  "settle",
  "policy refusals",
  "policy try-overspend",
  "sandbox stale",
  "sandbox claim",
];

const NODE_TITLES = {
  ens: "ENS storefront",
  agent: "agent · ERC-8004",
  policy: "policy wallet",
  mcp: "sla-subgraph-mcp",
  gateway: "graph gateway",
  subgraph: "open-book subgraph",
  escrow: "escrow · ERC-8183",
  hook: "sla hook",
};

const THEATER_FRAMES = ["quote", "pay", "deliver", "verdict", "money", "books"];
const KNOWN_SETTLED_JOB = "4";

// ---- console driving --------------------------------------------------------

async function openDock(page) {
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })),
  );
  await page.waitForSelector(".console", { timeout: 8000 });
  // ⌘K also opened the palette; Escape closes just the palette, dock stays.
  await page.keyboard.press("Escape");
  await sleep(400);
}

/** Type a line into the dock and return the normalized last-entry text. */
async function runCmd(page, cmd, { timeout = 45000 } = {}) {
  const input = await page.$(".console__input");
  if (!input) throw new Error("console input not found — dock closed?");
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await input.type(cmd, { delay: 3 });
  await page.keyboard.press("Enter");
  const needle = norm(cmd);
  return waitFor(
    page,
    (needle) => {
      const normPage = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
      const entries = [...document.querySelectorAll(".console__entry")];
      const last = entries[entries.length - 1];
      if (!last) return null;
      const line = normPage(last.querySelector(".console__line")?.textContent ?? "");
      if (!line.includes(needle)) return null; // not our entry yet
      const text = normPage(last.textContent);
      if (text.includes("printing…")) return null; // still rendering
      return text;
    },
    { timeout, label: `console result for "${cmd}"` },
    needle,
  );
}

/** Re-run a command after a settle pause; returns {text, retried}. */
async function runCmdWithRetry(page, cmd, { pauseMs = 6000, timeout = 45000 } = {}) {
  let text = await runCmd(page, cmd, { timeout });
  if (!/[✗]|failed|unavailable/i.test(text)) return { text, retried: false };
  await sleep(pauseMs);
  text = await runCmd(page, cmd, { timeout });
  return { text, retried: true };
}

/** Run a command and read the last entry's kv rows (key/value pairs). */
async function runKvCmd(page, cmd, { timeout = 45000, pauseMs = 0 } = {}) {
  let text = await runCmd(page, cmd, { timeout });
  if (pauseMs > 0) await sleep(pauseMs);
  const rows = await page.evaluate(() => {
    const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    const entry = [...document.querySelectorAll(".console__entry")].pop();
    if (!entry) return [];
    return [...entry.querySelectorAll(".tape__kvrow")].map((r) => [
      normP(r.querySelector(".tape__k")?.textContent ?? ""),
      normP(r.querySelector(".tape__v")?.textContent ?? ""),
    ]);
  });
  return { text, rows };
}

// ---- the audit --------------------------------------------------------------

async function audit(url) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("requestfailed", (r) =>
    failedRequests.push(`${r.url()} :: ${(r.failure() || {}).errorText || ""}`),
  );

  try {
    console.log(`\n=== OpenBook app audit · ${url} ===\n`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(6000);

    /* 1 · shell — the spine line verbatim ---------------------------------- */
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (bodyText.includes(SPINE_LINE)) {
      pass("1.shell spine line renders verbatim", SPINE_LINE.slice(0, 60) + "…");
    } else {
      fail("1.shell spine line renders verbatim", "tagline not found in rendered text");
    }

    /* 6a · hygiene — horizontal overflow, 1440, dock closed ----------------- */
    const over1440closed = await page.evaluate(() => {
      const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      const vw = window.innerWidth;
      const offenders = [...document.querySelectorAll("body *")]
        .map((e) => ({ el: e, r: e.getBoundingClientRect() }))
        .filter((x) => x.r.width > 0 && (x.r.right > document.documentElement.clientWidth + 2 || x.r.left < -2))
        .slice(0, 8)
        .map((x) => `${x.el.tagName}.${String(x.el.className || "").split(" ")[0]} right=${Math.round(x.r.right)}`);
      return { sw, vw, offenders };
    });
    if (over1440closed.sw <= over1440closed.vw + 2) {
      pass("6.hygiene no horizontal overflow @1440 (dock closed)", `scrollW=${over1440closed.sw} vw=${over1440closed.vw}`);
    } else {
      fail("6.hygiene no horizontal overflow @1440 (dock closed)", `scrollW=${over1440closed.sw} vw=${over1440closed.vw} :: ${over1440closed.offenders.join(", ")}`);
    }

    /* 2 · map — 8 nodes, non-error or reasoned degraded --------------------- */
    let mapNodes = null;
    try {
      mapNodes = await waitFor(
        page,
        () => {
          const nodes = [...document.querySelectorAll(".map__node")];
          if (nodes.length < 8) return null;
          const parsed = nodes.map((g) => {
            const cls = (g.getAttribute("class") || "").split(/\s+/);
            const state = cls.find((c) => c === "live" || c === "stale" || c === "error" || c === "loading") || "unknown";
            return {
              name: String(g.querySelector(".map__node-name")?.textContent ?? "").replace(/\s+/g, " ").trim(),
              state,
              chip: String(g.querySelector(".map__node-chip")?.textContent ?? "").replace(/\s+/g, " ").trim(),
              reason: String(g.querySelector("title")?.textContent ?? "").replace(/\s+/g, " ").trim(),
            };
          });
          if (parsed.some((n) => n.state === "loading")) return null;
          return parsed;
        },
        { timeout: 90000, label: "all 8 map nodes to leave loading" },
      );
    } catch (error) {
      fail("2.map all 8 nodes render", error.message.slice(0, 160));
    }
    if (mapNodes) {
      const byName = new Map(mapNodes.map((n) => [n.name, n]));
      const missing = Object.values(NODE_TITLES).filter((t) => !byName.has(t));
      if (missing.length > 0) {
        fail("2.map all 8 nodes render", `missing nodes: ${missing.join(", ")}`);
      } else {
        const notes = [];
        const skipIds = [];
        const hard = [];
        for (const [id, title] of Object.entries(NODE_TITLES)) {
          const node = byName.get(title);
          if (node.state === "error" || node.state === "unknown") {
            // The SVG <title> renders reason ?? node.title, so "present" is
            // vacuous — a stranded node falls back to its own title. The
            // degrade is only reasoned when the reason is ambient (429/rate
            // limit); anything else is a real surfaced failure.
            const hasReason = node.reason.length > 0 && node.reason !== node.name;
            if (!hasReason) {
              hard.push(`${id}[${node.state} with NO reason text]`);
            } else if (isAmbient(node.reason)) {
              skipIds.push(id);
              notes.push(`${id}[${node.state}: ${node.reason.slice(0, 60)}]`);
            } else {
              hard.push(`${id}[${node.state}: ${node.reason.slice(0, 60)} — not ambient]`);
            }
          } else if (node.state === "live") {
            notes.push(`${id}[live: ${node.chip.slice(0, 40)}]`);
          } else {
            notes.push(`${id}[${node.state}: ${node.reason.slice(0, 50) || node.chip.slice(0, 40)}]`);
          }
        }
        if (hard.length > 0) {
          fail("2.map all 8 nodes render", hard.join(" · "));
        } else if (skipIds.length > 0) {
          skip("2.map all 8 nodes render", `${skipIds.length} node(s) degraded with ambient reason (${skipIds.join(",")}); ${notes.join(" · ")}`);
        } else {
          pass("2.map all 8 nodes render", notes.join(" · "));
        }
      }
    }

    /* 5 · market — two live-ENS sellers + venue fee row --------------------- */
    const marketPredicate = () => {
      const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
      const sellers = [...document.querySelectorAll(".market__seller-name")].map((e) => normP(e.textContent));
      const error = normP(document.querySelector(".market__error")?.textContent ?? "");
      const chip = normP(document.querySelector(".market__head .market__chip")?.textContent ?? "");
      if (sellers.length >= 2 || error) return { sellers, error, chip };
      return null;
    };
    const probeMarket = () =>
      waitFor(page, marketPredicate, { timeout: 90000, label: "market sellers or truthful error" });

    let market;
    try {
      let raw = await probeMarket();
      // Re-probe once after a settle pause before granting an ambient SKIP:
      // the 30s storefront poll may recover mid-check.
      if (raw.error) {
        await sleep(10000);
        raw = await probeMarket();
      }
      const venue = await waitFor(
        page,
        () => {
          const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
          const fig = normP(document.querySelector(".market__venue-fig")?.textContent ?? "");
          const chip = normP(document.querySelector(".market__venue .market__chip")?.textContent ?? "");
          const note = normP(document.querySelector(".market__venue-note")?.textContent ?? "");
          if (fig && fig !== "reading…") return { fig, chip, note };
          return null;
        },
        { timeout: 120000, label: "market venue figure" },
      );
      market = { sellers: raw.sellers, error: raw.error, chip: raw.chip, venue };
    } catch (error) {
      const stateDump = await page.evaluate(() => {
        const sec = document.querySelector(".market");
        if (!sec) return "(market section not mounted)";
        return String(sec.textContent).replace(/\s+/g, " ").slice(0, 300);
      }).catch(() => "(dump failed)");
      market = { error: error.message, dump: stateDump };
    }

    if (market.error) {
      if (isAmbient(market.error)) {
        skip("5.market two sellers render from live ENS", `reasoned degraded after re-probe: ${market.error.slice(0, 120)}`);
      } else {
        fail("5.market two sellers render from live ENS", `market error: ${market.error.slice(0, 160)}${market.dump ? ` :: ${market.dump}` : ""}`);
      }
    } else {
      const sellers = market.sellers ?? [];
      const parent = sellers.find((s) => s === "openbook.eth");
      const subnames = sellers.filter((s) => s !== "openbook.eth" && /\.openbook\.eth$/.test(s));
      if (parent && subnames.length >= 1) {
        pass("5.market two sellers render from live ENS", `sellers=${sellers.join(", ")}`);
      } else {
        fail("5.market two sellers render from live ENS", `sellers=(${sellers.join(", ") || "none"}) — need openbook.eth + ≥1 subname`);
      }
      const { fig, chip, note } = market.venue;
      if (!fig) {
        fail("5.market venue row (platformFee → 2 percent feed)", `venue never rendered: ${note || "no figure and no note"}`);
      } else if (fig.includes("2%") && fig.includes("PolicyWallet")) {
        pass("5.market venue row (platformFee → 2 percent feed)", `${fig} · ${chip}`);
      } else if (chip === "error" && note) {
        if (isAmbient(note)) {
          // An unexercised fee read is a SKIP, never a PASS: the assertion is
          // about the rendered 2-percent feed, not about a truthful error.
          skip("5.market venue row (platformFee → 2 percent feed)", `reasoned degraded: ${note.slice(0, 120)}`);
        } else {
          fail("5.market venue row (platformFee → 2 percent feed)", `${fig} · ${chip} · ${note}`);
        }
      } else {
        fail("5.market venue row (platformFee → 2 percent feed)", `got "${fig}" (${chip}) — expected 2% → PolicyWallet`);
      }
    }

    /* 3 · console — dock, help, status, quote -------------------------------- */
    try {
      await openDock(page);
      pass("3.console ⌘K opens the dock", ".console present after ⌘K (palette closed via Esc)");

      const helpText = await runCmd(page, "help", { timeout: 30000 });
      const missingCmds = COMMAND_NAMES.filter((c) => !helpText.includes(c));
      if (missingCmds.length === 0) {
        pass("3.console help lists the full command set", `${COMMAND_NAMES.length} commands (11 inspect + 3 act + 4 sandbox)`);
      } else {
        fail("3.console help lists the full command set", `missing: ${missingCmds.join(", ")}`);
      }

      const status = await runKvCmd(page, "status", { timeout: 45000 });
      const statusKeys = ["arc head", "subgraph", "ens", "gateway key", "demo wallet"];
      const present = new Map(status.rows);
      const missingKeys = statusKeys.filter((k) => !present.has(k));
      if (missingKeys.length > 0) {
        fail("3.console status prints all live sources", `missing rows: ${missingKeys.join(", ")}`);
      } else {
        const degraded = statusKeys.filter((k) => present.get(k)?.startsWith("✗"));
        const hard = degraded.filter((k) => !isAmbient(present.get(k)));
        if (hard.length > 0) {
          fail("3.console status prints all live sources", `non-ambient value failures: ${hard.map((k) => `${k}: ${present.get(k)}`).join(" | ")}`);
        } else if (degraded.length > 0) {
          pass("3.console status prints all live sources", `all 5 rows present · truthful degrade on: ${degraded.join(", ")}`);
        } else {
          pass("3.console status prints all live sources", "all 5 rows present and live");
        }
      }

      let quote = await runKvCmd(page, "quote aave-v3-arbitrum-lending", { timeout: 45000 });
      if (quote.rows.some(([k, v]) => k === "ens price" && v.includes("✗"))) {
        await sleep(6000);
        quote = await runKvCmd(page, "quote aave-v3-arbitrum-lending", { timeout: 45000 });
      }
      const qRows = new Map(quote.rows);
      const qPrice = qRows.get("ens price") ?? "";
      const qFloor = qRows.get("sla floor") ?? "";
      if (qPrice.includes("0.15") && /^[0-9,]+$/.test(qFloor.replace(/[^0-9,]/g, "")) && qFloor.length > 0) {
        pass("3.console quote renders ENS price + SLA floor", `ens price ${qPrice} · floor ${qFloor}`);
      } else if (qPrice.includes("✗")) {
        if (isAmbient(qPrice + " " + quote.text.slice(0, 200))) {
          skip("3.console quote renders ENS price + SLA floor", `reasoned degraded after retry: ${qPrice}`);
        } else {
          fail("3.console quote renders ENS price + SLA floor", `ens price row: ${qPrice}`);
        }
      } else {
        fail("3.console quote renders ENS price + SLA floor", `price "${qPrice}" · floor "${qFloor}" — expected 0.15 + numeric floor`);
      }
    } catch (error) {
      fail("3.console dock/help/status/quote", error.message.slice(0, 160));
    }

    /* 4a · money — policy refusals ------------------------------------------ */
    try {
      const refusals = await runCmdWithRetry(page, "policy refusals");
      const rowCount = await page.evaluate(() => {
        const entry = [...document.querySelectorAll(".console__entry")].pop();
        if (!entry) return 0;
        // table rows (some clickable rows carry .tape__row--job; plain rows are
        // bare <tr>) — count the rendered body rows either way.
        return entry.querySelectorAll(".tape__table tbody tr").length;
      });
      // Real rows REQUIRE a contract reason code — the summary line's own
      // "N policy refusals onchain" wording must not self-satisfy the check.
      const hasReasonCodes = /PER_TX_CAP|DAILY_CAP|NOT_ALLOWLISTED/.test(refusals.text);
      const truthfulEmpty = refusals.text.includes("no PolicyBlocked events indexed") && rowCount === 0;
      if (hasReasonCodes && rowCount >= 1) {
        pass("4.money policy refusals renders real PolicyBlocked rows", `${rowCount} rendered row(s) onchain: ${refusals.text.slice(0, 120)}`);
      } else if (truthfulEmpty) {
        pass("4.money policy refusals renders real PolicyBlocked rows", "truthful empty state: no PolicyBlocked events indexed (blank, not zeroed)");
      } else if (refusals.text.includes("failed")) {
        if (isAmbient(refusals.text)) {
          skip("4.money policy refusals renders real PolicyBlocked rows", `reasoned degraded after retry: ${refusals.text.slice(0, 130)}`);
        } else {
          fail("4.money policy refusals renders real PolicyBlocked rows", refusals.text.slice(0, 160));
        }
      } else {
        fail("4.money policy refusals renders real PolicyBlocked rows", `no real reason codes (${rowCount} rows): ${refusals.text.slice(0, 160)}`);
      }
    } catch (error) {
      fail("4.money policy refusals renders real PolicyBlocked rows", error.message.slice(0, 160));
    }

    /* 4b · money — replay theater: six frames + money sum -------------------- */
    // Blur the console input first: Escape is how the theater closes, and the
    // dock input swallows Escape while focused.
    await page.evaluate(() => {
      if (document.activeElement) document.activeElement.blur();
    });
    await page.evaluate((job) => {
      window.location.hash = `#theater/${job}`;
    }, KNOWN_SETTLED_JOB);
    const theaterProbe = () => {
      const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
      const err = document.querySelector(".theater__status--error");
      if (err) return { error: normP(err.textContent) };
      const btns = [...document.querySelectorAll(".theater__frame-btn")];
      if (btns.length !== 6) return null;
      const titles = btns.map((b) => normP(b.textContent));
      const moneyBtn = btns.find((b) => normP(b.textContent) === "money");
      if (moneyBtn) moneyBtn.click();
      return { frames: titles, pendingMoney: !!moneyBtn };
    };

    let theaterFrames = null;
    let theaterError = null;
    try {
      const first = await waitFor(page, theaterProbe, { timeout: 60000, label: "theater six frames or truthful error" });
      if (first.error) {
        theaterError = first.error;
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll(".theater__status--error button")].find(
            (b) => String(b.textContent ?? "").replace(/\s+/g, " ").trim() === "retry",
          );
          if (btn) btn.click();
        });
        await sleep(1500);
        const retried = await waitFor(page, theaterProbe, { timeout: 60000, label: "theater six frames after retry" });
        if (retried.error) theaterError = retried.error;
        else theaterFrames = retried.frames;
      } else {
        theaterFrames = first.frames;
      }
    } catch (error) {
      fail("4.money replay theater six frames", error.message.slice(0, 160));
    }

    if (theaterError !== null && theaterFrames === null) {
      if (isAmbient(theaterError)) {
        skip("4.money replay theater six frames", `reasoned degraded after retry: ${theaterError.slice(0, 130)}`);
      } else {
        fail("4.money replay theater six frames", theaterError.slice(0, 160));
      }
    } else if (theaterFrames === null) {
      // already failed above (waitFor threw); nothing more to record
    } else {
      const orderOk = THEATER_FRAMES.every((f, i) => theaterFrames[i] === f);
      if (orderOk) {
        pass("4.money replay theater six frames", `frames=${theaterFrames.join(",")}`);
      } else {
        fail("4.money replay theater six frames", `titles=${theaterFrames.join(",")} — expected ${THEATER_FRAMES.join(",")}`);
      }
      // money frame active: read its rows (in-page wait for the re-render).
      const moneyRows = await page.evaluate(async () => {
        const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
        const t0 = Date.now();
        while (Date.now() - t0 < 3000) {
          const title = normP(document.querySelector(".theater__frame-title")?.textContent ?? "");
          if (title === "money") break;
          await new Promise((r) => setTimeout(r, 120));
        }
        return [...document.querySelectorAll(".theater__frame .theater__row")].map((r) => [
          normP(r.querySelector(".theater__k")?.textContent ?? ""),
          normP(r.querySelector(".theater__v")?.textContent ?? ""),
        ]);
      });
      const rowMap = new Map(moneyRows);
      const treasury = rowMap.get("treasury (platform cut)");
      const seller = rowMap.get("seller (provider)");
      const total = rowMap.get("total");
      const rawOf = (v) => (v ? /^(\d+) \(/.exec(v)?.[1] : undefined);
      const [t, s, tot] = [rawOf(treasury), rawOf(seller), rawOf(total)];
      if (t !== undefined && s !== undefined && tot !== undefined) {
        if (Number(t) + Number(s) === Number(tot)) {
          pass("4.money money frame sums to the job amount", `treasury ${t} + seller ${s} = total ${tot} (raw)`);
        } else {
          fail("4.money money frame sums to the job amount", `treasury ${t} + seller ${s} != total ${tot}`);
        }
      } else if (rowMap.has("state") && /split unavailable/.test(rowMap.get("state") ?? "")) {
        // The money frame truthfully degrades to "settled · split unavailable
        // (see note)" — SKIP only when the underlying splitError is ambient
        // (rate limit / gateway); any other split error is a real failure.
        const splitNote = await page.evaluate(() => {
          const note = document.querySelector(".theater__note--error");
          return note ? String(note.textContent).replace(/\s+/g, " ").trim() : "";
        });
        if (splitNote && isAmbient(splitNote)) {
          skip("4.money money frame sums to the job amount", `truthful degraded: ${splitNote.slice(0, 130)}`);
        } else {
          fail("4.money money frame sums to the job amount", `split unavailable, non-ambient: ${splitNote || "(no split error text)"}`);
        }
      } else {
        fail("4.money money frame sums to the job amount", `rows=${JSON.stringify(moneyRows)}`);
      }
    }

    // close the theater (Esc) — the dock stays open for the hygiene sweep
    await page.evaluate(() => {
      if (document.activeElement) document.activeElement.blur();
    });
    await page.keyboard.press("Escape");
    await sleep(800);

    /* 6 · hygiene — dock open: overflow 1440+1280, no sub-12px text --------- */
    const over1440open = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      vw: window.innerWidth,
    }));
    if (over1440open.sw <= over1440open.vw + 2) {
      pass("6.hygiene no horizontal overflow @1440 (dock open)", `scrollW=${over1440open.sw} vw=${over1440open.vw}`);
    } else {
      fail("6.hygiene no horizontal overflow @1440 (dock open)", `scrollW=${over1440open.sw} vw=${over1440open.vw}`);
    }

    await page.setViewport({ width: 1280, height: 900 });
    await sleep(1200);
    const over1280open = await page.evaluate(() => ({
      sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      vw: window.innerWidth,
    }));
    if (over1280open.sw <= over1280open.vw + 2) {
      pass("6.hygiene no horizontal overflow @1280 (dock open)", `scrollW=${over1280open.sw} vw=${over1280open.vw}`);
    } else {
      fail("6.hygiene no horizontal overflow @1280 (dock open)", `scrollW=${over1280open.sw} vw=${over1280open.vw}`);
    }

    for (const [label, width] of [["1440", 1440], ["1280", 1280]]) {
      await page.setViewport({ width, height: 1000 });
      await sleep(900);
      const offenders = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll("body *")) {
          if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
          const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!txt) continue;
          if (el.getClientRects().length === 0) continue;
          const size = parseFloat(getComputedStyle(el).fontSize);
          if (!Number.isFinite(size) || size >= 12) continue;
          bad.push({ tag: el.tagName, cls: String(el.className || "").split(" ").slice(0, 2).join("."), size, text: txt.slice(0, 40) });
          if (bad.length >= 20) break;
        }
        return bad;
      });
      if (offenders.length === 0) {
        pass(`6.hygiene no rendered text under 12px @${label} (dock open)`, "computed sweep empty");
      } else {
        fail(`6.hygiene no rendered text under 12px @${label} (dock open)`, offenders.map((o) => `${o.tag}.${o.cls} ${o.size}px "${o.text}"`).join(" | "));
      }
    }

    /* 6 · hygiene — zero console JS errors (ambient 429s + extensions out) -- */
    const ignore = (m) => isAmbient(m) || EXTENSION_ORIGIN.test(m);
    const realErrors = consoleErrors.filter((m) => !ignore(m));
    const realPage = pageErrors.filter((m) => !ignore(m));
    const realReq = failedRequests.filter((m) => !ignore(m));
    const detail = [];
    if (consoleErrors.length || pageErrors.length || failedRequests.length) {
      const ambientCount =
        consoleErrors.filter(ignore).length +
        pageErrors.filter(ignore).length +
        failedRequests.filter(ignore).length;
      if (ambientCount > 0) detail.push(`${ambientCount} ambient (429/extension) suppressed`);
    }
    if (realErrors.length === 0 && realPage.length === 0 && realReq.length === 0) {
      pass("6.hygiene zero console JS errors", detail.join(" · ") || "clean");
    } else {
      fail("6.hygiene zero console JS errors", [
        ...realErrors.slice(0, 5).map((e) => `console: ${e.slice(0, 140)}`),
        ...realPage.slice(0, 5).map((e) => `pageerror: ${e.slice(0, 140)}`),
        ...realReq.slice(0, 5).map((e) => `reqfail: ${e.slice(0, 140)}`),
      ].join(" | "));
    }

    /* ---- evidence on failure --------------------------------------------- */
    if (fails > 0) {
      const shot = path.join("/tmp/obaudit", `app-audit-${Date.now()}.png`);
      try {
        await page.screenshot({ path: shot, fullPage: false });
        failShots.push(shot);
      } catch {
        // screenshots are best-effort evidence
      }
    }
  } finally {
    await browser.close();
  }
}

// ---- main -------------------------------------------------------------------

const argv = process.argv.slice(2);
const urlIdx = argv.indexOf("--url");
const url =
  (urlIdx >= 0 && argv[urlIdx + 1]) ||
  argv.find((a) => a.startsWith("--url="))?.slice(6) ||
  "http://localhost:5173";

let puppeteer;
try {
  puppeteer = loadPuppeteer();
} catch (error) {
  console.error(`FAIL harness bootstrap — ${error.message}`);
  process.exit(1);
}

(async () => {
  try {
    await audit(url);
  } catch (error) {
    console.error(`FAIL harness — ${error.message}`);
    fails += 1;
  }
  console.log(
    `\n=== summary: ${results.length - fails - skips} PASS · ${skips} SKIP (reasoned) · ${fails} FAIL · ${results.length} assertions ===`,
  );
  if (failShots.length > 0) console.log(`failure screenshots: ${failShots.join(", ")}`);
  if (fails > 0) {
    console.log(`\nAUDIT FAILED against ${url}`);
    process.exit(1);
  }
  console.log(`\nAUDIT PASSED against ${url}`);
  process.exit(0);
})();
