# Skill: sla-subgraph-mcp

The **sla-subgraph-mcp** server sells freshness-guaranteed subgraph queries over
the Model Context Protocol. A buyer agent gets an ENS-priced quote, escrows
payment on ERC-8183 (Arc testnet), and only pays when the delivered data meets
the SLA — stale data is **never charged** and a missed SLA auto-refunds.

Use this skill when you (an agent) want to either **consume** OpenBook data or
**register your own dataset and get paid for it** on the same server.

## Run it

```bash
# from the repo root (no build step needed — bun runs TS directly)
GRAPH_GATEWAY_KEY=<your studio key> OPERATOR_PRIVATE_KEY=<seller key> \
  bun mcp/src/server.ts --config mcp/config/openbook.json
```

Or via the built bin (after `bun run build` in `mcp/`):

```bash
node mcp/dist/server.js --config myconfig.json
```

Any MCP client (Claude, Codex, Cursor, a custom stdio client…) connects over
stdio and gets five tools:

| tool              | purpose                                                        |
| ----------------- | -------------------------------------------------------------- |
| `list_datasets`   | catalog: pinned Start Fresh subgraphs + ENS `svc.menu` entries |
| `get_quote`       | live ENSv2 price/SLA/payee for a dataset (hard-fails if unset) |
| `query_dataset`   | Gateway query with `_meta` freshness gate + signed attestation |
| `verify_delivery` | deterministic APPROVE/REJECT; `settle:true` executes onchain   |
| `get_pnl`         | open-book DailyPnL from arc-testnet                            |

## Register a dataset (any subgraph, ~1 minute)

Datasets live in your config file. **Self-registration**: any deployed subgraph
id works — nothing to redeploy. Only the two Global Start Fresh pins
(`aave-v3-arbitrum-lending`, `uniswap-v3-arbitrum-dex`) are locked to their
verified Messari subgraph ids (the loader refuses a drift).

```json
{
  "name": "my-store",
  "ens": "mystore.eth",
  "escrow": "0x0747EEf0706327138c69792bF28Cd525089e4583",
  "payee": "0x0000000000000000000000000000000000000000",
  "operatorKey": "OPERATOR_PRIVATE_KEY",
  "datasets": [
    {
      "id": "my-dataset",
      "subgraphId": "<any deployed subgraph id>",
      "schema": "my/1.0.0",
      "description": "What this dataset answers",
      "freshness": { "maxAge": 50 },
      "priceUsdc": 100000
    }
  ]
}
```

Run it with that config — the server now sells `my-dataset` through the same
Gateway-backed, freshness-gated path.

## Get paid (the buyer→seller flow)

1. **Buyer** calls `get_quote(datasetId)` → `{amount, minBlockLag, deadlineBlocks, payee}`
   resolved **live from ENS** (`svc.price`, `svc.sla`, `svc.payee`) — never
   hard-coded. Missing records ⇒ `ENS_RESOLUTION_FAILED` (hard-fail on purpose).
2. **Buyer** funds an ERC-8183 job with the packed SLA (see `agent/escrow.ts`
   `createJobWithSla`; SLA description = `JSON.stringify({minBlock, schemaHash,
   maxLatencyMs})` — the seller can parse it back deterministically).
3. **Seller** runs `query_dataset(id, graphql)`. The server appends
   `_meta { block { number hash } chainHeadBlock { number } }` to every query.
   - `chainHeadBlock - _meta.block > maxAge` ⇒ `{unavailable: true,
     reason: "STALE"}` — **never charged**.
   - Fresh ⇒ `{result, meta: {block, hash}, attestation}` where
     `attestation.message = "<datasetId>@<block>|<payloadHash>|<block>"` and
     `attestation.signature` is the operator key's EIP-191 signature of that
     message (`payloadHash` = keccak of the delivered payload). The buyer can
     verify the payload/signature/block triplet offchain before settling.
4. **Seller** reports `metaBlock` = `_meta.block` to the job (`submit(payloadHash, metaBlock)`).
5. **Evaluator** calls `verify_delivery({jobId, payloadHash, metaBlock})`. The
   verdict is **deterministic and pure** (same inputs ⇒ same verdict):
   - `metaBlock >= SLA.minBlock` (read from the onchain job description) and a
     well-formed `payloadHash` ⇒ `APPROVE` (call with `settle: true` to execute
     `complete()` → USDC to the seller).
   - otherwise ⇒ `REJECT` (`settle: true` executes `rejectAndRefund()` → the
     buyer is auto-refunded). The chain reason hash is `keccak("STALE_DATA")` /
     `keccak("INVALID_HASH")` / `keccak("SLA_MET")`.

`verify_delivery` without `settle` performs **no chain write and no gas spend**
— it is a free deterministic preview; settlement is the evaluator's explicit
call.

## Required ENS records (Sepolia ENSv2)

The name in your config must carry (else `get_quote` fails loudly):

- `svc.menu` — JSON array of `{id, schema}` (feeds `list_datasets`)
- `svc.price` — e.g. `"0.10 USDC/query"`
- `svc.sla` — e.g. `{"maxBlockLag":50,"maxLatencyMs":2000}`
- `svc.payee` — payout address for escrowed payments

## Key discipline

- **No secrets in configs**: `operatorKey` is the *name* of an env var
  (`OPERATOR_PRIVATE_KEY`, falls back to `ARC_TESTNET_PK`). A literal hex key
  is accepted only in user-authored local configs.
- Mocks exist **only** in `mcp/test/` (injected `fetchImpl`/`readEnsText`
  seams). Production code hits the live Gateway / Sepolia ENS / Arc RPC only.
- Tests that need the real Gateway are key-guarded:
  `GRAPH_GATEWAY_KEY=… bun test mcp` runs them; without the key they skip.

## Verify your server

```bash
bun test mcp                                    # unit suite (mock-injected)
GRAPH_GATEWAY_KEY=<key> bun test mcp            # + live Gateway tests
```
