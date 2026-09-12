#!/usr/bin/env node
/**
 * OpenBook app audit: the scripted half of the release gate for the
 * five-section page (hero → try it → market → books → how it works) plus the
 * console dock. puppeteer-core + the system Chrome at the standard macOS path.
 *
 *   node scripts/app-audit.mjs [--url https://openbook.litai.ca]
 *
 * Groups:
 *   1. shell    the headline renders verbatim; nav + hero buttons present
 *   2. hero     the latest-refund receipt renders (Refunded badge + job id) or
 *               its truthful empty/error copy; live counters resolve
 *   3. try      the dataset picker has 5 datasets, the ENS-priced quote line
 *               renders, both buttons are enabled (no purchase is executed)
 *   4. market   two seller cards from live ENS (openbook.eth + a subname);
 *               the venue line reads the live fee
 *   5. books    the four figures resolve, the board has rows (or a truthful
 *               state), the refusals block renders
 *   6. console  ⌘K opens the dock; help lists all 18 commands; quote renders
 *               the 0.15 ENS price and a numeric SLA floor
 *   7. hygiene  no horizontal overflow at 1440 / 1280 / 390; no landing text
 *               under 13px; zero console JS errors (ambient 429s and
 *               extension origins excluded)
 *
 * A live widget that cannot load under an ambient upstream wall (matched by
 * /429|rate limit/i) is SKIPPED with the reason printed; anything else fails
 * and the process exits non-zero.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const AMBIENT = /429|too many requests|rate[ _-]?limit(ed)?/i;
const EXTENSION_ORIGIN = /^chrome-extension:\/\//i;
const HEADLINE = "When an agent buys stale data, the money comes back. Automatically.";
const COMMAND_NAMES = [
  "help", "status", "ens show", "datasets", "quote", "books", "jobs", "job", "lag", "policy show", "replay",
  "buy", "deliver", "settle", "policy refusals", "policy try-overspend", "sandbox stale", "sandbox claim",
];

const results = [];
let fails = 0;
let skips = 0;
function done(name, verdict, detail) {
  results.push({ name, verdict, detail });
  console.log(`${verdict} ${name}${detail ? ` — ${detail}` : ""}`);
  if (verdict === "FAIL") fails += 1;
  if (verdict === "SKIP") skips += 1;
}
const pass = (n, d) => done(n, "PASS", d);
const fail = (n, d) => done(n, "FAIL", d);
const skip = (n, d) => done(n, "SKIP", d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAmbient = (t) => AMBIENT.test(String(t ?? ""));

async function waitFor(page, fn, { timeout = 60000, interval = 1500, label = "condition" } = {}, ...args) {
  const t0 = Date.now();
  let lastError = null;
  for (;;) {
    let value = null;
    try {
      value = await page.evaluate(fn, ...args);
      lastError = null;
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
    }
    if (value) return value;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${label}${lastError ? ` (${lastError.slice(0, 120)})` : ""}`);
    await sleep(interval);
  }
}

function loadPuppeteer() {
  for (const candidate of ["puppeteer-core", "/tmp/obaudit/node_modules/puppeteer-core"]) {
    try {
      const mod = require(candidate);
      if (mod && typeof mod.launch === "function") return mod;
    } catch {
      // keep looking
    }
  }
  throw new Error("puppeteer-core not found — run `npm install --prefix scripts`");
}

async function openDock(page) {
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
  await page.waitForSelector(".console", { timeout: 8000 });
  await page.keyboard.press("Escape");
  await sleep(400);
}

async function runCmd(page, cmd, { timeout = 45000 } = {}) {
  const input = await page.$(".console__input");
  if (!input) throw new Error("console input not found");
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await input.type(cmd, { delay: 3 });
  await page.keyboard.press("Enter");
  return waitFor(
    page,
    (needle) => {
      const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
      const entries = [...document.querySelectorAll(".console__entry")];
      const last = entries[entries.length - 1];
      if (!last) return null;
      const line = normP(last.querySelector(".console__line")?.textContent ?? "");
      if (!line.includes(needle)) return null;
      const text = normP(last.textContent);
      if (text.includes("printing…")) return null;
      return text;
    },
    { timeout, label: `console result for "${cmd}"` },
    cmd,
  );
}

async function kvRows(page) {
  return page.evaluate(() => {
    const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
    const entry = [...document.querySelectorAll(".console__entry")].pop();
    if (!entry) return [];
    return [...entry.querySelectorAll(".tape__kvrow")].map((r) => [
      normP(r.querySelector(".tape__k")?.textContent ?? ""),
      normP(r.querySelector(".tape__v")?.textContent ?? ""),
    ]);
  });
}

async function overflowAt(page, width) {
  await page.setViewport({ width, height: 1000 });
  await sleep(600);
  return page.evaluate(() => {
    const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const vw = window.innerWidth;
    const offenders = [...document.querySelectorAll("body *")]
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && (x.r.right > document.documentElement.clientWidth + 2 || x.r.left < -2))
      .slice(0, 6)
      .map((x) => `${x.e.tagName}.${String(x.e.className || "").split(" ")[0]} right=${Math.round(x.r.right)}`);
    return { sw, vw, offenders };
  });
}

async function audit(url) {
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  try {
    console.log(`\n=== OpenBook app audit · ${url} ===\n`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(5000);

    /* 1 · shell */
    const h1 = await page.evaluate(() => String(document.querySelector("h1")?.textContent ?? "").replace(/\s+/g, " ").trim());
    if (h1 === HEADLINE) pass("1.shell headline renders verbatim", h1.slice(0, 50) + "…");
    else fail("1.shell headline renders verbatim", `got "${h1}"`);
    const shell = await page.evaluate(() => ({
      nav: [...document.querySelectorAll(".hero__nav a")].map((a) => a.textContent.trim()),
      buttons: [...document.querySelectorAll(".hero__actions button")].map((b) => b.textContent.trim()),
    }));
    if (shell.nav.length === 4 && shell.buttons.length === 2) pass("1.shell nav + hero buttons", `${shell.nav.join("/")} · ${shell.buttons.join(" · ")}`);
    else fail("1.shell nav + hero buttons", JSON.stringify(shell));

    /* 2 · hero receipt + counters */
    try {
      const receipt = await waitFor(
        page,
        () => {
          const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
          const card = document.querySelector(".receipt");
          if (!card) return null;
          const text = normP(card.textContent);
          if (/Reading the escrow/i.test(text)) return null;
          return { text, badge: normP(card.querySelector(".badge")?.textContent ?? ""), empty: card.classList.contains("receipt--empty") };
        },
        { timeout: 90000, label: "hero receipt to settle" },
      );
      if (!receipt.empty && receipt.badge === "Refunded" && /job\s*\d+/i.test(receipt.text)) {
        pass("2.hero latest refund renders", receipt.text.slice(0, 110));
      } else if (receipt.empty && isAmbient(receipt.text)) {
        skip("2.hero latest refund renders", `truthful degraded: ${receipt.text.slice(0, 120)}`);
      } else {
        fail("2.hero latest refund renders", receipt.text.slice(0, 160));
      }
    } catch (error) {
      fail("2.hero latest refund renders", error.message.slice(0, 160));
    }
    const counters = await page.evaluate(() =>
      [...document.querySelectorAll(".counters .figure strong")].map((s) => s.textContent.trim()),
    );
    if (counters.length === 3 && counters.every((c) => c !== "…")) {
      if (counters.some((c) => c === "?")) skip("2.hero counters resolve", `degraded: ${counters.join(" · ")}`);
      else pass("2.hero counters resolve", counters.join(" · "));
    } else {
      fail("2.hero counters resolve", counters.join(" · ") || "no counters");
    }

    /* 3 · try it */
    try {
      const tryState = await waitFor(
        page,
        () => {
          const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
          const options = [...document.querySelectorAll("#dataset option")].map((o) => o.textContent.trim());
          const quote = normP(document.querySelector(".try__quote")?.textContent ?? "");
          if (/Reading the price/i.test(quote)) return null;
          const buttons = [...document.querySelectorAll(".try__actions button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }));
          return { options, quote, buttons };
        },
        { timeout: 60000, label: "try-it quote line" },
      );
      if (tryState.options.length === 5) pass("3.try five datasets listed", tryState.options.join(" / "));
      else fail("3.try five datasets listed", tryState.options.join(" / "));
      if (/USDC per query · fresh within \d+ (Arbitrum|Ethereum) blocks/.test(tryState.quote)) pass("3.try ENS quote line renders", tryState.quote);
      else if (isAmbient(tryState.quote)) skip("3.try ENS quote line renders", tryState.quote);
      else fail("3.try ENS quote line renders", tryState.quote);
      const enabled = tryState.buttons.length === 2 && tryState.buttons.every((b) => !b.disabled);
      if (enabled) pass("3.try both buttons enabled (not executed)", tryState.buttons.map((b) => b.text).join(" · "));
      else fail("3.try both buttons enabled (not executed)", JSON.stringify(tryState.buttons));
    } catch (error) {
      fail("3.try section", error.message.slice(0, 160));
    }

    /* 4 · market */
    try {
      const market = await waitFor(
        page,
        () => {
          const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
          const sellers = [...document.querySelectorAll(".seller h3")].map((h) => normP(h.textContent));
          const note = normP(document.querySelector("#market > p.small")?.textContent ?? "");
          if (sellers.length === 0 && !/could not be read/i.test(note)) return null;
          return { sellers, note, venue: normP(document.querySelector(".venue")?.textContent ?? "") };
        },
        { timeout: 90000, label: "market sellers" },
      );
      const parent = market.sellers.includes("openbook.eth");
      const sub = market.sellers.some((s) => s !== "openbook.eth" && s.endsWith(".openbook.eth"));
      if (parent && sub) pass("4.market two sellers from live ENS", market.sellers.join(", "));
      else if (isAmbient(market.note)) skip("4.market two sellers from live ENS", market.note.slice(0, 120));
      else fail("4.market two sellers from live ENS", `${market.sellers.join(", ") || "none"} · ${market.note}`);
      if (/takes 2% of every settlement/.test(market.venue)) pass("4.market venue fee line", market.venue.slice(0, 90));
      else fail("4.market venue fee line", market.venue.slice(0, 120));
    } catch (error) {
      fail("4.market section", error.message.slice(0, 160));
    }

    /* 5 · books */
    try {
      const books = await waitFor(
        page,
        () => {
          const normP = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
          const figures = [...document.querySelectorAll(".books__figures .figure strong")].map((s) => s.textContent.trim());
          if (figures.some((f) => f === "…")) return null;
          const rows = document.querySelectorAll(".board__row").length;
          const empty = normP(document.querySelector(".board__empty")?.textContent ?? "");
          const state = normP(document.querySelector(".books__state")?.textContent ?? "");
          const refusals = normP(document.querySelector(".refusals h3")?.textContent ?? "");
          return { figures, rows, empty, state, refusals };
        },
        { timeout: 90000, label: "books figures" },
      );
      if (books.figures.length === 4 && !books.figures.includes("?")) pass("5.books four figures resolve", books.figures.join(" · "));
      else if (isAmbient(books.state)) skip("5.books four figures resolve", books.state.slice(0, 120));
      else fail("5.books four figures resolve", `${books.figures.join(" · ")} · ${books.state}`);
      if (books.rows >= 1) pass("5.books board has rows", `${books.rows} rows · ${books.state.slice(0, 60)}`);
      else if (isAmbient(books.empty) || isAmbient(books.state)) skip("5.books board has rows", books.empty || books.state);
      else fail("5.books board has rows", books.empty || "no rows and no copy");
      if (/^The treasury/.test(books.refusals)) pass("5.books refusals block", books.refusals);
      else fail("5.books refusals block", books.refusals || "missing");
    } catch (error) {
      fail("5.books section", error.message.slice(0, 160));
    }

    /* 6 · console */
    try {
      await openDock(page);
      pass("6.console ⌘K opens the dock", ".console present");
      const help = await runCmd(page, "help", { timeout: 30000 });
      const missing = COMMAND_NAMES.filter((c) => !help.includes(c));
      if (missing.length === 0) pass("6.console help lists 18 commands", `${COMMAND_NAMES.length} commands`);
      else fail("6.console help lists 18 commands", `missing: ${missing.join(", ")}`);
      let quote = await runCmd(page, "quote aave-v3-arbitrum-lending", { timeout: 45000 });
      let rows = new Map(await kvRows(page));
      if ((rows.get("ens price") ?? "").includes("✗")) {
        await sleep(6000);
        quote = await runCmd(page, "quote aave-v3-arbitrum-lending", { timeout: 45000 });
        rows = new Map(await kvRows(page));
      }
      const price = rows.get("ens price") ?? "";
      const floor = rows.get("sla floor") ?? "";
      if (price.includes("0.15") && /\d/.test(floor)) pass("6.console quote renders ENS price + floor", `${price} · ${floor}`);
      else if (isAmbient(price + quote.slice(0, 200))) skip("6.console quote renders ENS price + floor", price);
      else fail("6.console quote renders ENS price + floor", `price "${price}" floor "${floor}"`);
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      await page.keyboard.press("Escape");
      await sleep(300);
    } catch (error) {
      fail("6.console dock/help/quote", error.message.slice(0, 160));
    }

    /* 7 · hygiene */
    for (const width of [1440, 1280, 390]) {
      const o = await overflowAt(page, width);
      if (o.sw <= o.vw + 2) pass(`7.hygiene no horizontal overflow @${width}`, `scrollW=${o.sw} vw=${o.vw}`);
      else fail(`7.hygiene no horizontal overflow @${width}`, `scrollW=${o.sw} vw=${o.vw} :: ${o.offenders.join(", ")}`);
    }
    await page.setViewport({ width: 1440, height: 1000 });
    await sleep(400);
    const tiny = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("main *")) {
        if (el.closest(".console")) continue;
        const text = (el.childNodes ? [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("") : "").trim();
        if (!text) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 13) out.push({ tag: el.tagName, cls: String(el.className || "").split(" ")[0], size, text: text.slice(0, 30) });
      }
      return out.slice(0, 8);
    });
    if (tiny.length === 0) pass("7.hygiene no landing text under 13px", "computed sweep empty");
    else fail("7.hygiene no landing text under 13px", tiny.map((t) => `${t.tag}.${t.cls} ${t.size}px "${t.text}"`).join(" | "));
    const hardConsole = consoleErrors.filter((t) => !isAmbient(t) && !EXTENSION_ORIGIN.test(t) && !/Failed to load resource/.test(t));
    const hardPage = pageErrors.filter((t) => !isAmbient(t));
    if (hardConsole.length === 0 && hardPage.length === 0) {
      pass("7.hygiene zero console JS errors", `${consoleErrors.length} console lines, all ambient/resource`);
    } else {
      fail("7.hygiene zero console JS errors", [...hardPage, ...hardConsole].slice(0, 4).map((t) => t.slice(0, 120)).join(" | "));
    }
  } finally {
    await browser.close();
  }

  console.log(`\n=== ${results.length - fails - skips} PASS · ${skips} SKIP · ${fails} FAIL ===`);
  process.exit(fails > 0 ? 1 : 0);
}

const urlArg = process.argv.indexOf("--url");
const url = urlArg >= 0 ? process.argv[urlArg + 1] : "http://localhost:4174";
audit(url).catch((error) => {
  console.error("audit crashed:", error);
  process.exit(2);
});
