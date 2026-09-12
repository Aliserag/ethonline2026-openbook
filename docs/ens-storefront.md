# OpenBook — ENSv2 Storefront (`openbook.eth`)

The OpenBook storefront is an **ENSv2 name on Sepolia** that any buyer, MCP server, or
frontend resolves live before paying. `openbook.eth` → its Owner's `OwnedResolver`
(deployed via the ENSv2 `VerifiableFactory`) → `svc.*` + ENSIP-25/26 text records. The
records are the *contract* of the storefront: Task 5 `get_quote` **hard-fails**
(`ENS_RESOLUTION_FAILED`) when `svc.price`/`svc.sla`/`svc.payee` are missing — there is
no default price anywhere in the code path. Task 7's frontend reads the same records
through viem.

```
Buyer / MCP (get_quote) ──getEnsText(fresh, key)──▶ UniversalResolverV2 (Sepolia)
                                                        │  name lookup
                                                        ▼
                                             openbook.eth (ETHRegistry, ENSv2)
                                                        │  registered resolver
                                                        ▼
                                        OwnedResolver (owner = TREASURY_EOA, full
                                        role bitmap incl. ROLE_SET_TEXT)  ◀── records
                                                        │
              svc.menu · svc.price · svc.sla · svc.payee · svc.operator · svc.pnl
              agent-context · agent-endpoint[mcp] · agent-endpoint[web]
              agent-registration[<ERC-7930 addr>][<AGENT_ID>] = "1"
                                                        │
                        missing svc.price/sla/payee  ⇒  get_quote → ENS_RESOLUTION_FAILED
```

**Why ENSv2 features are central, not cosmetic** (ENS bounty clause): the name has no
hard-coded price client-side; every quote is resolved live, the records are owned via a
per-account Permissioned Resolver with role-based access control (only the admin EOA can
write them), and the agent is discoverable from the name alone through ENSIP-25/26
machine-readable records.

## Ownership & permission model (verified on Sepolia)

- **Owner / deployer:** `TREASURY_EOA` (`SEPOLIA_PK`). Registration grants the owner the
  v2 registry roles (`ROLE_SET_SUBREGISTRY`, `ROLE_SET_RESOLVER`, `ROLE_CAN_TRANSFER_ADMIN`).
- **Resolver:** `ens resolver deploy <TREASURY_EOA> …` creates an `OwnedResolver` via the
  Verifiable Factory. The CREATE2 address is **predictable before deployment**
  `(factory, proxyLogic, deployer, salt)` — it can be committed into the registration
  before the deploy tx lands. The deployer (admin) receives the **full role bitmap**
  (incl. `ROLE_SET_TEXT`) at `ROOT_RESOURCE`, so the owner can `ens set batch` afterwards.
- **Why subname owners can't set records:** a subname owner holds *no* roles on the
  parent's resolver — a `setText` from anyone but an authorized role holder reverts with
  `EACUnauthorizedAccountRoles`. This is by design (EAC); the demo can lean on it as a
  live feature, but no feature depends on a non-owner writing the storefront.
- **Fee path:** registration is an **ERC-20 pull** — the registrar calls `transferFrom` on
  MockUSDC, so the owner MUST `approve(ETHRegistrar, …)` before the reveal. No ETH value.

## Sepolia anchors (verified 2026-09-09)

| Item | Address |
|---|---|
| ETHRegistry (ENSv2) | `0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2` |
| ETHRegistrar | `0xa88553F454b77203B0D036A05c894d555EAAa2Cc` |
| UniversalResolverV2 | `0x4a1817D13e9CF196F471725176355c1234b63c70` |
| VerifiableFactory | `0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef` |
| MockUSDC (open `mint(address,uint256)`, 6-dec) | `0x768F42455A2D082E23ceeF7d51e5787C82d67a39` |
| UserRegistryImpl | `0x624a25d67b59d587752ebec8dded8827dae52050` |
| ERC-8004 IdentityRegistry (Arc testnet, chain `5042002`) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| …as ERC-7930 interoperable address (used in the ENSIP-25 key) | `0x00010000034cef52148004a818bfb912233c491871b3d84c89a494bd9e` |

## Record keylist (`scripts/ens/records.json`)

| Key | Value (final) | Notes / consumed by |
|---|---|---|
| `svc.menu` | `[{"id":"aave-v3-arbitrum-lending","schema":"lending/3.1.0"},{"id":"uniswap-v3-arbitrum-dex","schema":"dex-amm/4.0.1"}]` | Task 5 `list_datasets` merge (tolerant) |
| `svc.price` | `0.10 USDC/query` | Task 5 `get_quote` — parsed to 6-dec units (`parsePriceToAmount6dec`); **hard-fail when missing** |
| `svc.sla` | `{"maxBlockLag":50,"maxLatencyMs":2000}` | Task 5 freshness gate; **hard-fail when missing** |
| `svc.payee` | `0x4e83eB15EE973A49E40D9A79aB2cA89a4Eb4894E` (PolicyWallet, live) | Revenue recipient; Task 5/6 payouts; **hard-fail when missing** |
| `svc.operator` | `0x64A78b6d5e99274d01D1d0A70B180A73AAEb8d21` (live) | Operator / agent address |
| `svc.pnl` | `https://api.studio.thegraph.com/query/1760032/open-book/v0.0.8` (live) | Task 4 Studio subgraph endpoint (`get_pnl`, Task 7 dashboard) |
| `agent-context` | `OpenBook: …ERC-8004 agent 894065 on Arc.` *(ENSIP-26, live)* | Agent self-description for any AI client |
| `agent-endpoint[mcp]` | `https://github.com/Aliserag/OpenBook/tree/main/mcp` *(live)* | MCP endpoint (`sse`/streamable) |
| `agent-endpoint[web]` | `https://openbook.litai.ca` *(live)* | Buyer frontend |
| `agent-registration[0x00010000034cef52148004a818bfb912233c491871b3d84c89a494bd9e][894065]` | `1` (live) *(ENSIP-25)* | Binds `openbook.eth` ↔ ERC-8004 agent entry (`<registry>` = ERC-7930 interoperable address of the Arc registry; value is a non-empty attestation) |

`records-prep.json` is the **atomic init subset** (only the three records already final at
registration time: `svc.menu`, `svc.price`, `svc.sla`) — the resolver deploys with them
already set, so the storefront is immediately resolvable. The remaining records wait for
Task 2/3/7 outputs and land via one `ens set batch` in the funded run.

## Pipeline (`scripts/ens/setup.sh`)

Guarded: **without `SEPOLIA_PK` + `SEPOLIA_RPC` it is a read-only dry-run** — it validates
the records files, fetches the live price, generates every calldata blob, prints the exact
broadcast commands, exits 0, and never touches a keyed path. With the keys it executes:

1. `ens price openbook.eth --chain sepolia --payment-token 0x768F…` → total in 6-dec
   base units (live probe: **8000021** = 8.000021 USDC).
2. `ens resolver deploy <TREASURY_EOA> --chain sepolia --name openbook.eth --records <records-prep.json>`
   → predicted resolver (printed) + deploy calldata.
3. `ens register commit openbook.eth --owner <TREASURY_EOA> --resolver <PRED> --chain sepolia --json`
   → broadcast; **wait ≥ 60 s** (`MIN_COMMITMENT_AGE` — the script uses the window to
   broadcast the resolver deploy and the MockUSDC mint/approve), save the printed **secret**
   (`echo 'ENS_COMMIT_SECRET=<s>' >> .env`).
4. MockUSDC funding (idempotent — each step skips when already satisfied onchain):
   `cast send 0x768F… "mint(address,uint256)" <EOA> <2×total>` and
   `cast send 0x768F… "approve(address,uint256)" 0xa88553… <2×total>` — 2× total is a
   buffer: the fee is USD-denominated and can drift between step 1 and the reveal.
5. `ens register reveal openbook.eth --secret $ENS_COMMIT_SECRET --resolver <PRED> --payment-token 0x768F… --chain sepolia --json` → broadcast (value = 0; the registrar pulls the fee).
6. `ens set batch openbook.eth --chain sepolia --resolver <PRED> --data <scripts/ens/records.json>`
   → broadcast.
7. Verify: `ens get text openbook.eth --chain sepolia --key svc.price` returns
   `0.10 USDC/query` (script asserts this in execute mode).

**CHANGEME preflight:** in execute mode the script validates `records.json` **at startup
and aborts (exit 3) before any broadcast** — commit, reveal, and resolver-deploy are all
held while a `CHANGEME:` placeholder remains (stage 6 keeps the same check as a backstop).

### Broadcast options

`ens … --json` emits **unsigned calldata** (`{to, data, value}`). Broadcast either way:

- **`cast send`** (primary; used by the script):
  ```bash
  cast send <to> <data> --rpc-url $SEPOLIA_RPC --private-key $SEPOLIA_PK
  ```
- **transact.swiss-knife.xyz/send-tx** (zero-install, paste `to`/`data`/`value`):
  https://transact.swiss-knife.xyz/send-tx — good fallback for a demo machine without
  foundry, and the same flow ens-cli's `nextSteps` describes.

### Resuming after a flubbed tx

Every stage is idempotent: re-running a broadcast stage re-sends the same calldata
(harmless). Resume from a stage with `--from N` — stages past 2 need
`ENS_RESOLVER=<predicted>` and the reveal needs `ENS_COMMIT_SECRET` (both are printed with
exact `echo … >> .env` lines).

| Symptom | Fix |
|---|---|
| Commit broadcast dropped/pending | Re-run (`--from 3` with `ENS_RESOLVER` + `ENS_COMMIT_SECRET` exported first) |
| Reveal reverts `InsufficientAllowance` | Price drifted past the 2× buffer → re-run step 1, mint/approve the difference, re-run `--from 5` |
| Reveal reverts `CommitmentTooOld`/expiry | Recommit (`--from 3`) — `MIN_COMMITMENT_AGE` = 60 s, max 24 h |
| `ens set batch` reverts `EACUnauthorizedAccountRoles` | The sender is not the resolver admin — the reveal `--resolver` and the owner EOA must match stage 2's deployer |
| Records JSON rejected | `setup.sh` validates both records files at startup; `jq` must be installed |

## Live-verify (post-registration)

```bash
ens get text openbook.eth --chain sepolia --key svc.price     # → 0.10 USDC/query
ens get text openbook.eth --chain sepolia --key svc.sla       # → {"maxBlockLag":50,"maxLatencyMs":2000}
ens get text openbook.eth --chain sepolia --key svc.payee     # → <POLICY_WALLET_ADDR>
ens get text openbook.eth --chain sepolia --key agent-endpoint[mcp]
ens get text openbook.eth --chain sepolia --key 'agent-registration[0x00010000034cef52148004a818bfb912233c491871b3d84c89a494bd9e][<AGENT_ID>]'
```

A fresh viem read in `app/` (Task 7) must resolve **every** record from the same source —
no hard-coded values in the demo path:

```ts
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
const client = createPublicClient({ chain: sepolia, transport: http() });
const price = await client.getEnsText({ name: "openbook.eth", key: "svc.price" }); // "0.10 USDC/query"
```

Task 5's `get_quote` additionally requires the resolver to be injectable for tests, but
the production reader uses exactly this `getEnsText`-with-`sepolia` path
(`mcp/src/ens.ts`).

## Demo hygiene

- **Spare names:** register 1–2 spare labels during the hackathon (`ens available`, same
  pipeline with `OPENBOOK_NAME=…`); a flubbed reveal mid-demo is then a 5-minute switch.
- **Pre-mint MockUSDC:** `cast send 0x768F… "mint(address,uint256)" <EOA> 20000000`
  (20 USDC, 6-dec) before the demo; the registrar fee itself is only ~8 USDC/yr.
- **Sepolia ETH:** the treasury EOA needs Sepolia ETH for gas on the four broadcast txs
  (resolver deploy, commit, mint/approve, reveal, set batch — each ~10–15 s).
- **Commitment secret:** keep `ENS_COMMIT_SECRET` in `.env` (gitignored). The reveal
  recomputes the commitment from it — lose it and you must recommit and wait 60 s again.
- **Re-run before a judge:** `scripts/ens/setup.sh` (keys exported) sets any fresh name +
  records end-to-end; or demonstrate the *live* `ens set batch` on camera — that satisfies
  the "no hard-coded values" clause with a real onchain record write.

## Placeholder checklist (funded run)

Replace in `scripts/ens/records.json` before executing (setup.sh hard-refuses `CHANGEME:`):

> **✅ Executed 2026-09-10** — all five replacements landed and the records are
> live onchain (10/10 verified; see `the funded-run notes`). This list is
> kept as the reproducible procedure for a fresh name.

1. `CHANGEME:POLICY_WALLET_ADDR` → Task 2 `PolicyWallet` deploy address (or the ERC-8183
   payee address) — `svc.payee`.
2. `CHANGEME:AGENT_ADDR` → agent wallet (withdrawal caller / operator) — `svc.operator`.
3. `CHANGEME:AGENT_ID` → ERC-8004 agent `tokenId` from Task 3 — appears in
   `agent-context` and inside the `agent-registration[…]` key (`[CHANGEME:AGENT_ID]` → `[<id>]`).
4. `CHANGEME:MCP_HOST` → public MCP host — `agent-endpoint[mcp]` (`…/mcp`).
5. `CHANGEME:FRONTEND_URL` → deployed buyer frontend — `agent-endpoint[web]`.
