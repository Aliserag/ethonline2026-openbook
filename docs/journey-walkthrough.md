# Journey Walkthrough — OpenBook (keyless + funded states)

Manually driven against the live app (vite dev, http://127.0.0.1:5173) after the UX review
loop (6 passes → SATISFIED). Every journey is keyed to observable evidence.

## J1 — Zero-context judge (keyless first load) ✅
- Masthead: brand `▤ OB`, "OpenBook — THE AGENT'S SETTLEMENT LEDGER", tagline with SLA
  tooltip, Connect wallet ghost button, chain badges (arc · 5042002 / ensv2 · sepolia /
  the graph · gateway / openbook.eth).
- Cards in order with live state chips: 1 See what's for sale — **failed** (red; records
  absent on openbook.eth — correct, no hardcoded values); 2 Get the price — waiting;
  3 Watch data arrive — **needs setup** (blue; Graph key card with exact 60s steps);
  4 Settle — or refund — waiting; The agent's books — needs setup; Daily rows — idle.
- Every disabled CTA carries a visible caption with the named prerequisite (aria-describedby
  linked); nothing is a silent dead end.

## J2 — ENSv2 storefront (Sepolia) ✅ (fails honestly)
- Records resolve via viem ≥2.35 against ENSv2 Sepolia; when absent the hard-fail notice
  names exactly the missing keys (by-name matching — regression-tested) and the setup card
  lists `scripts/ens/setup.sh` → reload → step 2 unlocks.
- After the funded run registers openbook.eth: table fills with live records; step 1 → done.

## J3 — Dataset select → query sync ✅
- aave-v3-arbitrum-lending → `{ markets(first: 3) { id } }`; uniswap-v3-arbitrum-dex →
  `{ pools(first: 3) { id } }`. Both directions verified live.

## J4 — Connect wallet (no provider) ✅
- Click "Connect wallet" → zero page errors, state unchanged (graceful wagmi no-op;
  documented). With a real provider the pay/settle path unlocks.

## J5 — Buyer flow (quote → pay → deliver → settle) — key-gated, proven at the spine
- Browser path needs an injected wallet + valid Graph key — not walkable keyless.
- The onchain spine is proven live separately: ERC-8183 lifecycle GREEN on funded wallets
  (createJob → setBudget → approve → fund → submit → complete, provider paid) + smoke
  script 3/3 cycles (complete / reject / expire-refund) without revert.
- UI steps verified statically + by unit tests (deriveSteps/chipClass/missingHardFailKeys).

## J6 — P&L books ✅ (blocked state)
- Keyless: "needs setup" + setup card with the exact key steps; statline placeholders; no
  fake rows. After the key lands: running balance + daily rows from openbook-pnl.

## J7 — The Tape ✅ (idle)
- Idle: status "idle", one event "tape idle — awaiting settlement activity", no ghost scale.
- Delivered/settled/refunded/stale states render conditionally (code-verified; the stale
  path is the deterministic stale-proxy money shot in docs/demo-script.md).

## J8 — Mobile (390px) ✅
- Zero horizontal overflow; wallet action topmost (grid areas, DOM-first); cards stack;
  tooltips viewport-anchored bottom banners (never clipped); 24px touch targets.

## J9 — Reload stability ✅
- 3 fresh loads + 2 reloads: identical terminal state, chip stays "failed", no stuck
  "resolving…", console clean (0 errors/warnings/pageerrors).

## J10 — Keyboard-first ✅
- Tab order: Connect wallet → SLA tip → step cards in order; tooltips open on focus;
  focus-visible outline; aria-live tape announces settlements; role=status on notices.

## Gated for the funded run (docs/keys-needed.md)
- Live Gateway queries + P&L rows: needs the Studio key (docs/keys-needed.md §4).
- Pay/settle in browser: needs an injected wallet on Arc testnet (MetaMask add-chain 5042002).
- ENS records set: needs SEPOLIA_PK + Sepolia ETH + MockUSDC mint (scripts/ens/setup.sh).
