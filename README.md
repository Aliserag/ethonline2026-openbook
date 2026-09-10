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
- **The Graph (the product):** `sla-subgraph-mcp` — a generic MCP server with a
  packaged, node-runnable bin (npm publishing is the one-line post-freeze step)
  that turns any subgraph into a paid, freshness-gated product; OpenBook is the reference
  deployment. Plus the `open-book` Studio subgraph on **arc-testnet** indexing every
  payment/refund/policy event — the agent's audited books.
- **ENS (storefront + business license):** `openbook.eth` on ENSv2 Sepolia publishes menu,
  pricing, SLA, and payee as text records; buyers hard-fail without resolution
  ("No ENS, no payment"). The `svc.payee` record names the PolicyWallet as the
  only payee — the storefront can never route money anywhere but the
  policy-gated treasury.

## Repo layout

- `contracts/` — PolicyWallet.sol (+ tests)
- `agent/` — agent loop, ERC-8183 settlement spine, buyer CLI
- `mcp/` — `sla-subgraph-mcp` (the Graph tooling entry) + `SKILL.md`
- `subgraph/` — `openbook-pnl` (Arc testnet)
- `app/` — minimal Vite + wagmi frontend (storefront → pay → P&L)
- `scripts/` — ENS setup, spikes, stale-replay proxy
- `docs/` — architecture, design decisions, demo script, submission copy

## Quickstart

**Judge the live agent keyless in ~60 seconds** (quote + P&L need no keys — ENS
records and the Studio endpoint are public):

```bash
git clone https://github.com/Aliserag/ethonline2026-openbook && cd ethonline2026-openbook
bun install

# talk to the seller agent over stdio MCP — list the menu, read the live quote,
# read the agent's onchain books:
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_quote","arguments":{"datasetId":"aave-v3-arbitrum-lending"}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_pnl","arguments":{}}}' \
  | bun mcp/src/server.ts --config mcp/config/openbook.json
```

Expected: the quote resolves `payee`/`price`/`sla` from the **live ENS records**
of `openbook.eth` (`"source": "ENS"`), and `get_pnl` returns the P&L rows the
`open-book` subgraph indexed from the escrow + policy contracts on Arc testnet.

```bash
bun test          # 71 unit tests, mock-injected, no keys needed
cd app && bun run dev   # storefront UI (quote + P&L work keyless;
                        # VITE_GRAPH_GATEWAY_KEY unlocks the live delivery step)
```

Full tool reference + the one-command live-data path:
[mcp/README.md](mcp/README.md). Deploy/verify scripts: `scripts/`.

**Live deployment (all verifiable, all read-only):**

| piece | where |
| --- | --- |
| **Live demo (no keys needed)** | https://ethonline2026-openbook.vercel.app — quote + P&L resolve keyless from live ENS records and the public subgraph |
| Storefront | `openbook.eth` on ENSv2 Sepolia (10 records: menu/price/SLA/payee/…/agent-registration; `agent-endpoint[web]` = the live demo URL) |
| Escrow rail | ERC-8183 `0x0747EEf0706327138c69792bF28Cd525089e4583` on Arc testnet (chain 5042002) |
| Policy treasury | `PolicyWallet` `0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E` (Arc testnet) |
| Agent identity | ERC-8004 **agentId 894065** on Arc testnet |
| Audited books | `open-book` subgraph — `https://api.studio.thegraph.com/query/1760032/open-book/version/latest` (public) |

## Status

Submission-ready build for ETHOnline 2026 (Sep 4–16); deployed pieces live on Arc testnet and Sepolia (see [RUNBOOK.md](RUNBOOK.md)).
