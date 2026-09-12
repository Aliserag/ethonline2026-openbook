# Journey walkthrough: OpenBook, the live page

Driven against the deployed page (https://openbook.litai.ca) on 2026-09-12, in headless
Chrome and in a real browser. Every journey is keyed to observable evidence: a transaction
hash, a subgraph row, or a measured value. The scripted half of this is
`scripts/app-audit.mjs` (20 assertions, all passing on the live domain at submission).

## J1: zero-context judge, cold load (no wallet, no keys)

- Hero: the headline, one paragraph, two buttons (Buy a query, Watch a refund happen),
  the latest real refund as a receipt (amount, seller, reason, job id, ArcScan link),
  three live counters (refunds executed, USDC settled, sellers listed).
- Data arrives through the same-origin `/api/subgraph` proxy (20 s cache, stale copy on
  a Studio 429) and from ENSv2 Sepolia and the Arc RPC. Nothing is typed in; a failed
  source renders its reason in place ("could not be read right now"), never a fake value.
- Verified at 1280, 390 and 320 wide: no horizontal scroll, headline and primary button
  inside a 640 px tall phone screen.

## J2: buy a query (the happy path)

- Pick a dataset; the line under it reads the live ENS price and freshness promise
  ("0.15 USDC per query · fresh within 50 blocks (about 13 seconds) · sold by openbook.eth").
- Click Buy. Six rows land in about 25 s: price read from ENS, paid into escrow (job id,
  floor, tx), data delivered (indexed block), freshness checked (attest tx), settled
  (settle tx), fee split (98% seller, 2% treasury, derived from the receipt).
- Evidence: job 49 on Aave (settle tx `0xd95df8fa…502706`, split 0.147 / 0.003), job 50
  on OpenSea (Ethereum chain, 10-minute window), both settled.

## J3: make it fail (the refund)

- Click Make it fail. The data is delivered first, then the job is funded with the floor
  one block above the delivered block, the hook refuses `complete()` (`SlaNotMet`, shown
  in the verdict row), and `reject()` refunds the buyer in full. Five rows, about 30 s.
- The hero receipt switches to this refund ("confirming" until the subgraph indexes it);
  the board shows the row at the top.
- Evidence: job 48 (`0x6f35cb69…b731b1`), job 52 (`0xa589ed…1c093e`).

## J4: the market

- Two seller cards from live ENS (`openbook.eth`, `alpha.openbook.eth`) with per-dataset
  prices, the freshness promise, purchases / settled / refunded from the subgraph's
  provider stats (labeled when served from cache or the build-time snapshot), operator link.
- The venue line reads `platformFeeBP` and the treasury address from the escrow.

## J5: the books

- Four figures (settled, refunded, venue fees, treasury balance), the settlement board
  (12 latest jobs, seller name or dataset, outcome badge, tx or replay link), the
  treasury's refusals (`PolicyBlocked` rows with tx links).
- Session runs appear immediately and lose their "confirming" label once the v0.0.6
  subgraph indexes them (verified for jobs 48, 49, 50).

## J6: secondary surfaces

- Replay theater from any board row (`#theater/<jobId>`), the system map (`#map`), and
  the console (`⌘K`, or the footer link on desktop): `help` lists 18 commands, `quote`
  renders the ENS price and floor.

## Accessibility and motion (measured)

- Text contrast ≥ 4.5:1 on both grounds after the muted token was darkened (5.0 and 5.4).
- Every control shows a 2 px focus ring under real Tab key presses; tab order follows
  reading order.
- Four transitions and three keyframe animations, one easing family, none on layout
  properties; `prefers-reduced-motion` disables all of them.
- No text under 13 px on the landing surfaces.

## Known limits

- Both sellers and every buyer so far are ours; the mechanism is permissionless, the
  liquidity is not.
- The demo wallet plays buyer, provider and evaluator in the keyless runs (legal per
  ERC-8183); rows from those runs are labeled "our demo wallet (single-key run)".
- The staleness in Make it fail is staged (floor above the delivery); the hook's refusal
  is real and is the same path a natural miss takes.
