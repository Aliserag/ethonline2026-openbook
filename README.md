# OpenBook — Chargebacks for the Machine Economy

> An autonomous agent that sells freshness-guaranteed onchain data queries, pays its own
> costs, and publishes its P&L onchain. Built for ETHOnline 2026 (Sep 4–16).

**Bounties targeted (one project, three sponsors):**
- **Arc — Best Agentic Economy Application with Circle Agent Stack** ($3,500; +$2,500 if deployed to Arc Mainnet by Sep 30 — see [RUNBOOK.md](RUNBOOK.md))
- **The Graph — Best AI Tooling or AI Use Case with The Graph (Start Fresh)** ($5,000 pool)
- **ENS — Best Use of ENSv2** ($4,500)

## The pitch

Payment is the last mile of agent autonomy. Agents can hold keys and sign transactions, but
counterparties can't trust them: no service guarantees, no refunds, no recourse when the data
is stale. Everyone is building payment rails; nobody is building the control layer.

OpenBook's mechanic: **SLA-bound payments.** Every query carries verifiable conditions
committed at payment time — freshness block height, deliverable hash, deadline — through
Arc's ERC-8183 escrow standard. Settlement checks them deterministically. **Miss the SLA and
the refund executes onchain, automatically.** Money flows both ways.

## Architecture

See [docs/architecture.md](docs/architecture.md). The three sponsors are organs, not stickers:

- **Arc (rail + cash register):** ERC-8004 agent identity, USDC nanopayments, ERC-8183
  escrow settlement, custom policy-gated treasury (`PolicyWallet.sol` with onchain
  `PolicyBlocked` events — Circle's built-in policies are mainnet-only; ours is the
  testnet-demoable path).
- **The Graph (the product):** `sla-subgraph-mcp` — a generic, npx-publishable MCP server
  that turns any subgraph into a paid, freshness-gated product; OpenBook is the reference
  deployment. Plus `openbook-pnl`, a Studio subgraph on **arc-testnet** indexing every
  payment/refund/policy event — the agent's audited books.
- **ENS (storefront + business license):** `openbook.eth` on ENSv2 Sepolia publishes menu,
  pricing, SLA, and payee as text records; buyers hard-fail without resolution
  ("No ENS, no payment"). The name's manager key = the treasury admin key.

## Repo layout

- `contracts/` — PolicyWallet.sol (+ tests)
- `agent/` — agent loop, ERC-8183 settlement spine, buyer CLI
- `mcp/` — `sla-subgraph-mcp` (the Graph tooling entry) + `SKILL.md`
- `subgraph/` — `openbook-pnl` (Arc testnet)
- `app/` — minimal Vite + wagmi frontend (storefront → pay → P&L)
- `scripts/` — ENS setup, spikes, stale-replay proxy
- `docs/` — architecture, design decisions, demo script, submission copy

## Quickstart

See [docs/superpowers/plans/2026-09-09-openbook.md](docs/superpowers/plans/2026-09-09-openbook.md)
for the full task-by-task build plan. Copy `.env.example` → `.env` and fill keys.

## Status

Submission-ready build for ETHOnline 2026 (Sep 4–16); deployed pieces live on Arc testnet and Sepolia (see [RUNBOOK.md](RUNBOOK.md)).
