# Bounty technology map

Every technology the three prize pages name, where it sits in OpenBook, and what proves it.
"Live" means verified on the deployed app or onchain on 2026-09-13; tx hashes are testnet.
Sources: the ETHGlobal prize pages for Arc, The Graph and ENS, read on 2026-09-13.

## Arc (prize: Best DeFi/Onchain Finance Application)

| Product | Where it fits | Status | Proof |
|---|---|---|---|
| Arc, USDC as gas | every escrow, hook and treasury transaction | Live | any tx on the escrow `0x967e…7Dd5`; gas paid in native USDC |
| Circle Contracts (ERC-8183 reference escrow) | the settlement rail; our `SlaHook` is whitelisted on our own instance | Live | escrow `0x967e…7Dd5`, hook `0x6060…0846` |
| Circle Wallets (developer-controlled, SCA) | the page's buyer and seller wallets; the browser signs nothing | Live | buyer `0x00e8…59dc`, seller `0xb63f…6ca9`; jobs 84 to 86; `app/worker/circle.ts` |
| Circle Gas Station | gas for both SCA wallets (Arc testnet default policy) | Live | the seller wallet holds no USDC and still submits (job 86 submit tx `0x66135a8c…`) |
| App Kit Bridge (CCTP v2) | treasury funds the buyer from another chain | Live | Arbitrum Sepolia burn `0x49ea8d62…`, forwarder mint on Arc `0xe54af84c…` (`scripts/circle/fund-buyer.ts`) |
| Gateway (Unified Balance) | treasury deposits once on another chain, spends on Arc | Live | deposit on Arbitrum Sepolia `0x577395fb…`, spend on Arc `0xa956aabe…` (1 USDC to the buyer wallet, about ten minutes after the deposit) |
| Paymaster | not needed: Gas Station sponsors the SCA wallets | Not used | Arc's own docs: gas is USDC; the EIP-3009 relayer path is for plain transfers |
| Agent Stack (CLI wallet), Nanopayments, x402 | a pay-per-call lane for agents that want no recourse | Not used | the product is a refundable purchase, which x402 cannot express; Agent Stack CLI needs an email login |
| StableFX, Swap Kit | no fit (single-currency venue) | Not used | |
| ERC-8004 identity | the venue's agent identity | Live | agent 894065, `agent-registration` ENS record |

Prize label: DeFi/Onchain Finance. The Agentic prize brief centres on the Agent Stack; we use Circle Wallets and Gas Station instead, and say so.

## The Graph (prize: Best AI Tooling or AI Use Case, From Scratch)

| Product | Where it fits | Status | Proof |
|---|---|---|---|
| Subgraph Studio (own subgraph) | the public books: every job, settlement, refund, fee | Live | `open-book` v0.0.8, read through `/api/subgraph` |
| Gateway subgraphs with a Studio key | the datasets sold (Messari standardized schemas + ENS + Overtime) | Live | `/api/deliver` returns data, `_meta` block and an EIP-191 proof |
| Subgraph `_meta` as the settlement fact | the block the hook enforces | Live | `SlaNotMet(attested, floor)` reverts on every fail run |
| MCP server (AI tooling) | `sla-subgraph-mcp`, seven tools, keyless quickstart | Live | `bun mcp/src/server.ts`; 62 tests |
| Reasoning over data | `choose_seller`: live ENS terms + index lag → decision with rationale; console ask lane (LLM proposes, registry executes) | Live | MCP tests; ask lane on the page |
| Subgraph MCP (official) | `discover_datasets` searches the catalog through it and returns paste-ready config entries | Live | `mcp/src/subgraph-mcp.ts`; MCP tests |
| Substreams, one-prompt challenge | not attempted | Not used | |
| Messari standardized subgraphs | three of five datasets share the standard schema | Live | `mcp/config/openbook.json` |

Pool: Start Fresh (all commits inside the event window).

## ENS (prize: Best Use of ENSv2)

| Feature | Where it fits | Status | Proof |
|---|---|---|---|
| ENSv2 registry hierarchy (Sepolia) | `openbook.eth` with a UserRegistry subregistry | Live | registry `0xBDC8…F0E2`, subregistry `0x8eC4…5f29` |
| Text records as the price sheet | `svc.price / svc.sla / svc.payee / svc.menu / svc.pnl / svc.attester`, hard-fail without them | Live | quotes read live; `ens show` |
| Wildcard resolution | `alpha.openbook.eth` has no resolver, resolves through the parent | Live | `getResolver("alpha") = 0x0` |
| Subname pricing | `aave-v3-arbitrum-lending.openbook.eth` overrides the parent's price; its `svc.payee` is the Circle seller wallet | Live | 0.15 vs 0.10; payee `0xb63f…6ca9` |
| Enhanced Access Control (delegation) | alpha's own key may edit only `svc.price` on its own node | Live | grant `0x09589d0e…`, reprice `0x0b2c1336…`; `ens can-edit`, `scripts/ens/delegate.sh` |
| ENSIP-25 / ENSIP-26 | `agent-registration`, `agent-context`, `agent-endpoint[web]` | Live | records on `openbook.eth` |
| Permissioned Resolver per subname | a subname that fully owns its data | Not done | candidate: `beta.openbook.eth` with its own resolver |
| Record / namespace aliasing | two names sharing one record set | Not done | |
| Subname lifecycle types (expiring, revocable, forever) | | Not done | |

## What changed on 2026-09-13

The page stopped shipping a private key. Buyer and seller are Circle developer-controlled
wallets driven from the server; the treasury funds the buyer across chains with App Kit.
