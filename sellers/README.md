# sellers/ — marketplace seller configs

Each file is a `SellerConfig` written by `sell init` (one storefront per file):

```jsonc
{
  "name": "alpha",                    // slug; the ENS subname is <slug>.openbook.eth
  "ens": "alpha.openbook.eth",        // ENSv2 name (Sepolia) whose svc.* records price the storefront
  "escrow": "0x967e005154D0F62C33Eac8E2F44b44d4C4C07Dd5",  // shared market escrow (2% venue fee)
  "hook": "0x606075F3Cf9b5B66E7e4DD2ea369894374Ff0846",    // SlaHook whitelisted on the escrow
  "payee": "0x…",                     // seller payout address (written as svc.payee)
  "operatorKey": "SELLER_ALPHA_PK",   // env var NAME of the seller's signing key — never a literal key
  "gateway": { "url": "https://gateway.thegraph.com", "gatewayKeyEnv": "GRAPH_GATEWAY_KEY" },
  "datasets": [ { "id": "aave-v3-arbitrum-lending", "subgraphId": "4xyas…", "schema": "lending/3.1.0",
                  "description": "…", "freshness": { "maxAge": 50 }, "priceUsdc": 120000, "chain": "arbitrum" } ]
}
```

No private keys live in these files. `operatorKey` names an environment variable
(e.g. `SELLER_ALPHA_PK`) that holds the key; `gateway.gatewayKeyEnv` names the
Graph gateway key variable. Both are loaded from the repo `.env` or the shell.

## Commands (run from the repo root)

```bash
bun agent/sell-cli.ts init --name alpha --schema lending/3.1.0 --price 0.12
      [--subgraph <id>] [--payee <address>] [--force]
      # writes sellers/alpha.json; refuses to overwrite an existing file without --force

bun agent/sell-cli.ts register --config sellers/alpha.json
      # creates <slug>.openbook.eth as an ENSv2 subname (owner = payee), writes
      # svc.menu / svc.price / svc.sla / svc.payee / svc.operator through the ens
      # CLI + cast (same pipeline as scripts/ens/setup.sh), then READS THE
      # RECORDS BACK live and prints them.
      # Requires SEPOLIA_PK + SEPOLIA_RPC (the parent storefront owner's key).
      # Re-runs are safe: an already-registered subname is detected and reused.

bun agent/sell-cli.ts serve --config sellers/alpha.json [--once] [--interval <ms>]
      [--lookback <blocks>] [--since <block>]
      # runs the existing seller loop (agent/seller.ts) with this config.
      # Requires the seller key named by operatorKey + GRAPH_GATEWAY_KEY.
```

Keyless runs (missing keys) print a SKIP notice and exit 0 — nothing is
broadcast or signed without the key that authorizes it, matching the repo's
keyless discipline.

## Record contract

Every `sell register` writes exactly five text records on `<slug>.openbook.eth`:

| key | value |
|---|---|
| `svc.menu` | `[{"id": <dataset id>, "schema": <dataset schema>}]` |
| `svc.price` | `"0.12 USDC/query"` (name-level; all datasets must share one price) |
| `svc.sla` | `{"maxBlockLag": <tightest maxAge>, "maxLatencyMs": 2000}` |
| `svc.payee` | the seller's payout address |
| `svc.operator` | the address derived from the `operatorKey` env key (falls back to payee) |

The records land on the parent storefront's OwnedResolver (the subname resolves
through it), so the buyer CLI, the ENS directory (`listSellers`) and the app all
see a registered seller with no code change.

## Reference sellers

- `openbook.eth` — the original storefront (records in `scripts/ens/records.json`).
- `alpha.json` — the first marketplace seller registered through this CLI:
  `alpha.openbook.eth`, `lending/3.1.0` at `0.12 USDC/query`, distinct key
  (`SELLER_ALPHA_PK`), registered live on Sepolia (evidence 1 in
  `docs/marketplace-brief.md` §5).

## Tests

```bash
bun test sellers/sell.test.ts        # repo root
cd app && bun test ../sellers/sell.test.ts   # also runnable from the app workspace
```
