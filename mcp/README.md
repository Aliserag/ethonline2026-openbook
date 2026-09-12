# sla-subgraph-mcp

OpenBook's reusable MCP server: it sells **freshness-guaranteed subgraph
queries** over The Graph Gateway with ENSv2-priced quotes (Sepolia), ERC-8183
escrow settlement (Arc testnet), and an onchain P&L (the open-book subgraph).
Stale data is never charged; a missed SLA auto-refunds.

Judge quickstart — from 0 to a live query in four commands.

## 1. Install

```bash
bun install          # from the repo root (workspace: mcp)
```

## 2. Env keys (all optional at server boot — key-gated per tool)

| var                  | needed for      | where to get it                                            |
| -------------------- | --------------- | ---------------------------------------------------------- |
| `GRAPH_GATEWAY_KEY`  | `query_dataset` | thegraph.com/studio → **API key** (Gateway queries are key-gated) |
| `OPERATOR_PRIVATE_KEY` | `query_dataset` attestation, `verify_delivery` settle | seller/operator key (falls back to `ARC_TESTNET_PK`) |
| `SEPOLIA_RPC`        | `get_quote`, `list_datasets` ENS reads | any Sepolia RPC (default: public Sepolia)      |
| `ARC_TESTNET_RPC`    | `verify_delivery` settle            | default `https://rpc.testnet.arc.io`          |
| `OPENBOOK_ESCROW`    | escrow anchor override              | overrides the config default escrow at boot (validated — a malformed value refuses to boot) |

No secrets live in the repo or in `mcp/config/*.json` — `operatorKey` names the
env var that holds the key.

## 3. Run

```bash
# from the repo root — bun runs the TS entry directly (no build step)
GRAPH_GATEWAY_KEY=<key> OPERATOR_PRIVATE_KEY=<key> \
  bun mcp/src/server.ts --config mcp/config/openbook.json
```

Or the packaged bin (build once, then `node` runs it anywhere):

```bash
cd mcp && bun run build     # -> dist/server.js (bun-bundled, node-runnable)
node mcp/dist/server.js --config mcp/config/openbook.json
```

The server talks **stdio MCP** — attach any MCP client, or pipe JSON-RPC:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_datasets","arguments":{}}}' \
  | bun mcp/src/server.ts --config mcp/config/openbook.json
```

## 4. Tools and expected output

| tool              | expected output (fresh key, records set)                                     |
| ----------------- | ---------------------------------------------------------------------------- |
| `list_datasets()` | the four datasets — `aave-v3-arbitrum-lending`, `uniswap-v3-arbitrum-dex`, `opensea-nft-trades`, `ens-registrations` — with schema/price/description (+ ENS `svc.menu` entries) |
| `get_quote(id)`   | `{amount: 100000, amountUsdc: "0.10", minBlockLag: 50, deadlineBlocks: 1, payee, source: "ENS"}` |
| `query_dataset(id, gql)` | fresh: `{result, meta: {block, hash}, attestation: {message, signature, signer}}`; stale: `{unavailable: true, reason: "STALE"}` |
| `verify_delivery({jobId, payloadHash, metaBlock})` | `{verdict: "APPROVE"}` or `{verdict: "REJECT", reason: "STALE_DATA"}`; add `settle: true` to execute the onchain settlement |
| `get_pnl()`       | `{dailyPnLs: [{id, revenue, costs, refunds, net}], metaBlock}` from the open-book subgraph (arc-testnet; public Studio endpoint — no key) |

`query_dataset` appends `_meta { block { number hash timestamp } hasIndexingErrors }`
to every query (the Gateway's `_Meta_` type has no chain-head field), then reads
the chain head from the **dataset's own chain RPC** (`mcp/src/chain-head.ts` —
the freshness math is same-chain: Arbitrum metaBlock vs Arbitrum head, not Arc's).
When `chainHead - _meta.block > dataset.freshness.maxAge` the result is
`unavailable` and **never charged** (the freshness gate fires
before any payment path). Fresh results carry the operator's EIP-191 signature
over `queryId|payloadHash|metaBlock` — a buyer can verify the delivery claims
offchain before settling an escrowed job.

`verify_delivery` is deterministic: `metaBlock >= SLA.minBlock` (parsed from the
onchain job description) + well-formed hash ⇒ `APPROVE`, else
`REJECT`/`STALE_DATA`/`INVALID_HASH`. Onchain writes (`complete()` /
`rejectAndRefund()` on ERC-8183 `0x0747…4583`) only run with `settle: true`.

## Live verification

Unit tests are mock-injected (never mocks in production). Live tests are
**key-guarded** — they hit the real Gateway only when the key is present:

```bash
bun test mcp                                  # 28 pass, 2 skip (live, no key)
GRAPH_GATEWAY_KEY=<key> bun test mcp          # + live Aave query & get_pnl
```

Expected live `query_dataset` output shows a real Arbitrum block number in
`meta.block` (e.g. `72819123`) with a 64-hex `meta.hash` and a valid
attestation signature from the operator key.

## Config reference

```jsonc
{
  "name": "my-store",
  "ens": "openbook.eth",                    // ENSv2 name (Sepolia) with svc.* records
  "escrow": "0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5", // our market escrow instance (2% venue fee)
                                            // override at boot with OPENBOOK_ESCROW
  "payee": "0x0000…0000",                   // set to your PolicyWallet; get_quote
                                            // uses the live svc.payee record anyway
  "operatorKey": "OPERATOR_PRIVATE_KEY",    // env var NAME (no secrets in repo)
  "gateway": { "keyEnv": "GRAPH_GATEWAY_KEY", "baseUrl": "https://gateway.thegraph.com" },
  "pnl": { "endpoint": "https://api.studio.thegraph.com/query/1760032/open-book/v0.0.6" },
  "datasets": [
    {
      "id": "aave-v3-arbitrum-lending",
      "subgraphId": "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf", // Start Fresh pin
      "schema": "lending/3.1.0",
      "description": "Aave V3 lending markets on Arbitrum (Messari lending/3.1.0)",
      "freshness": { "maxAge": 50 },
      "priceUsdc": 100000                    // 6-dec: 0.10 USDC (display; ENS is authoritative)
    }
  ]
}
```

`mcp/config/openbook.json` is the reference deployment (GLOBAL pins, verbatim
subgraph ids from the plan). **Reusability receipt:**
`mcp/config/demo2.json` runs the exact same server against the Compound V3
Ethereum subgraph (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`) — one server,
any subgraph. See `SKILL.md` for how any agent registers a dataset and gets
paid.
