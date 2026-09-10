#!/usr/bin/env bash
# setup.sh — OpenBook Task 6: register openbook.eth on ENSv2 Sepolia and set the
# full storefront record set (svc.* + ENSIP-25/26 agent records).
#
# Pipeline (all writes key-gated — nothing touches a keyed path without
# SEPOLIA_PK + SEPOLIA_RPC set):
#  1/7  ens price                                  -> registration fee (6-dec MockUSDC base units)
#  2/7  ens resolver deploy <TREASURY_EOA> --name openbook.eth
#                    --records <records-prep.json> -> CREATE2-predicted OwnedResolver;
#                    the Owner (= deployer = TREASURY_EOA) is admin with the full role
#                    bitmap (incl. ROLE_SET_TEXT) at ROOT_RESOURCE; init records
#                    (svc.menu/price/sla) are written atomically at deploy
#  3/7  ens register commit --owner <TREASURY_EOA> --resolver <PRED> -> prints secret;
#                    broadcast; wait >= 60s (MIN_COMMITMENT_AGE) and use the wait to
#                    broadcast the resolver deploy (2/7) + mint/approve MockUSDC (4/7)
#  4/7  MockUSDC mint(<TREASURY_EOA>, 2x total) + approve(ETHRegistrar, 2x total)
#        2x = buffer: price is USD-denominated and can drift between 1/7 and the reveal
#  5/7  ens register reveal --secret $ENS_COMMIT_SECRET --resolver <PRED>
#                    --payment-token <MockUSDC>    -> broadcast (fee = ERC-20 pull, no value)
#  6/7  ens set batch openbook.eth --resolver <PRED> --data <records.json> -> broadcast
#  7/7  verify: ens get text openbook.eth --chain sepolia --key svc.price (non-empty)
#
# Keyless discipline: without SEPOLIA_PK + SEPOLIA_RPC this script is a read-only
# dry run — it validates the records files, fetches the live price, generates the
# resolver/commit/reveal/set calldata, prints the EXACT broadcast commands for every
# stage, and exits 0. It never asks for keys and never broadcasts.
#
# Usage:
#   scripts/ens/setup.sh                # execute (keys in env/.env) or dry-run print
#   scripts/ens/setup.sh --from <1..7>  # run/print only stages >= N (resume after a flub)
#   scripts/ens/setup.sh --probe        # keyless read-only probes (available/price/get text)
#
# Resuming past stage 2 needs the predicted resolver that stage 2 prints:
#   echo "ENS_RESOLVER=<predicted>" >> .env
# Stage 4+ additionally re-fetches the price if it wasn't already fetched this run.
#
# Exit codes (repo convention for key-gated scripts):
#   0  dry-run / keyless / success
#   1  hard error (records invalid, command failed)
#   3  execute-mode guard (missing key, secret, resolver, or CHANGEME placeholder)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

NAME="${OPENBOOK_NAME:-openbook.eth}"
CHAIN="sepolia"
REGISTRAR="0xa88553F454b77203B0D036A05c894d555EAAa2Cc"
MOCKUSDC="0x768F42455A2D082E23ceeF7d51e5787C82d67a39"
RECORDS_PREP="${RECORDS_PREP:-$REPO_ROOT/scripts/ens/records-prep.json}"
RECORDS_FINAL="${RECORDS_FINAL:-$REPO_ROOT/scripts/ens/records.json}"

usage() {
  cat <<'EOF'
Usage: scripts/ens/setup.sh                 # execute (SEPOLIA_PK+SEPOLIA_RPC set) or dry-run
       scripts/ens/setup.sh --from <1..7>   # resume/print from stage N
       scripts/ens/setup.sh --probe         # keyless read-only probes

Stages: 1 price · 2 resolver deploy · 3 commit (60s wait) · 4 mint+approve ·
        5 reveal · 6 set batch · 7 verify

Required env (or in repo .env): SEPOLIA_RPC, SEPOLIA_PK, TREASURY_EOA.
Resume past stage 2: ENS_RESOLVER (printed by stage 2). Reveal: ENS_COMMIT_SECRET.
Files may be overridden: RECORDS_PREP, RECORDS_FINAL.
EOF
}

# ---------------------------------------------------------------------------
# env plumbing (mirrors scripts/erc8004-register.sh)
# ---------------------------------------------------------------------------
get_env() { sed -nE "s/^$1=(.*)$/\1/p" "$REPO_ROOT/.env" 2>/dev/null | tail -1 | tr -d '"'; }

SEPOLIA_RPC="${SEPOLIA_RPC:-$(get_env SEPOLIA_RPC)}"
SEPOLIA_PK="${SEPOLIA_PK:-$(get_env SEPOLIA_PK)}"
ENS_COMMIT_SECRET="${ENS_COMMIT_SECRET:-$(get_env ENS_COMMIT_SECRET)}"
TREASURY_EOA="${TREASURY_EOA:-$(get_env TREASURY_EOA)}"
RESOLVER="${ENS_RESOLVER:-$(get_env ENS_RESOLVER)}"

FROM=1
MODE="auto"          # auto -> dry (keyless) | execute (keys) ; probe overrides
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from)
      [ "$#" -ge 2 ] || { echo "ERROR: --from requires a stage number 1..7"; usage; exit 3; }
      FROM="$2"; shift 2 ;;
    --from=*) FROM="${1#*=}"; shift ;;
    --probe) MODE="probe"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown option: $1"; usage; exit 3 ;;
  esac
done
case "$FROM" in
  *[!0-9]*|''|0) echo "ERROR: --from must be an integer 1..7"; exit 3 ;;
esac
[ "$FROM" -le 7 ] || { echo "ERROR: --from must be 1..7"; exit 3; }

for BIN in ens jq; do
  command -v "$BIN" >/dev/null 2>&1 || { echo "FATAL: $BIN not found on PATH"; exit 1; }
done

TOTAL=""
MINT_AMOUNT=""
SECRET_NEW=""

# ---------------------------------------------------------------------------
# records validation — runs FIRST in every mode (cheap, keyless, and it stops a
# funded run before any broadcast if a records file is broken)
# ---------------------------------------------------------------------------
validate_records() { # $1 = file, $2 = label
  [ -f "$1" ] || { echo "FATAL: $2 not found: $1"; return 1; }
  jq -e 'type == "array" and length > 0' "$1" >/dev/null 2>&1 \
    || { echo "FATAL: $2 ($1) is not a non-empty JSON array"; return 1; }
  jq -e '
    all(.[];
      (.type == "text"        and (.key   | type) == "string" and (.value | type) == "string") or
      (.type == "address"     and (.coin   | type) == "string" and (.value | type) == "string") or
      (.type == "contenthash" and (.value | type) == "string")
    )' "$1" >/dev/null 2>&1 \
    || { echo "FATAL: $2 ($1) contains an invalid record operation (expected text records: {\"type\":\"text\",\"key\":...,\"value\":...})"; return 1; }
  echo "  records OK: $2 ($(jq 'length' "$1") ops)"
  return 0
}

count_changeme() { # $1 = file — scans BOTH keys and values (agent-registration[] key embeds the agent id)
  jq '[.[] | [(.key // ""), (.value // "")] | join("\u0000") | select(contains("CHANGEME:"))] | length' "$1"
}

list_changeme() { # $1 = file
  jq -r '.[] | [(.key // ""), (.value // "")] | join("  ->  ") | select(contains("CHANGEME:"))' "$1"
}

die() { echo "FATAL: $*" >&2; exit 1; }

validate_records "$RECORDS_PREP" "records-prep.json"  || exit 1
validate_records "$RECORDS_FINAL" "records.json"      || exit 1
PREP_CHANGEME="$(count_changeme "$RECORDS_PREP")"
FINAL_CHANGEME="$(count_changeme "$RECORDS_FINAL")"

# ---------------------------------------------------------------------------
# probe mode — keyless read-only checks (plan Step 1)
# ---------------------------------------------------------------------------
probe() {
  echo "── probe: availability ──"
  ens available "$NAME" --chain "$CHAIN" || exit 1
  echo "── probe: price (MockUSDC payment token) ──"
  ens price "$NAME" --chain "$CHAIN" --payment-token "$MOCKUSDC" || exit 1
  echo "── probe: read path (missing record — expect value: null, exit 0) ──"
  ens get text ur.integration-tests.eth --chain "$CHAIN" --key url || exit 1
  echo "── probe: read path (live record — vitalik.eth address must resolve) ──"
  ens get address vitalik.eth --chain "$CHAIN" || exit 1
  echo "── probe: resolution of the target name (null before registration) ──"
  ens get address "$NAME" --chain "$CHAIN" || exit 1
  echo "PROBE OK — all checks ran keyless (see outputs above)."
}

# ---------------------------------------------------------------------------
# execute-mode preflight (never touches the network; derives the owner from
# SEPOLIA_PK and sanity-checks TREASURY_EOA against it)
# ---------------------------------------------------------------------------
ensure_exec_env() {
  [ -n "$SEPOLIA_RPC" ] || { echo "FATAL: execute mode requires SEPOLIA_RPC (export it or add to .env)"; return 3; }
  [ -n "$SEPOLIA_PK"  ] || { echo "FATAL: execute mode requires SEPOLIA_PK  (export it or add to .env)"; return 3; }
  command -v cast >/dev/null 2>&1 || { echo "FATAL: cast (foundry) not found on PATH"; return 3; }
  if [ -n "$TREASURY_EOA" ] && [ -n "$SEPOLIA_PK" ]; then
    local derived
    derived="$(cast wallet address --private-key "$SEPOLIA_PK" 2>/dev/null)" || true
    if [ -n "$derived" ] && [ "$(printf '%s' "$derived" | tr 'A-F' 'a-f')" != "$(printf '%s' "$TREASURY_EOA" | tr 'A-F' 'a-f')" ]; then
      echo "FATAL: TREASURY_EOA=$TREASURY_EOA does not match the address derived from SEPOLIA_PK ($derived)."
      return 3
    fi
  fi
  [ -n "$TREASURY_EOA" ] || TREASURY_EOA="$(cast wallet address --private-key "$SEPOLIA_PK" 2>/dev/null)"
  [ -n "$TREASURY_EOA" ] || { echo "FATAL: could not derive TREASURY_EOA from SEPOLIA_PK"; return 3; }
  echo "  execute mode: owner/deployer = $TREASURY_EOA (the resolver address depends on this account)"
  return 0
}

broadcast() { # $1 = label, $2 = to, $3 = data
  echo "  broadcast $1 → $2"
  cast send "$2" "$3" --rpc-url "$SEPOLIA_RPC" --private-key "$SEPOLIA_PK" \
    || die "broadcast failed for: $1 ($2)"
}

cast_txhash() { # $1 = label, $2 = to, $3 = data|sig, $4+ = call args — prints the transactionHash
  local out
  out="$(cast send "$2" "$3" "${@:4}" --rpc-url "$SEPOLIA_RPC" --private-key "$SEPOLIA_PK" --json 2>&1)" \
    || die "broadcast failed for: $1 ($2): $out"
  printf '%s' "$out" | jq -r '.transactionHash // empty' \
    || die "broadcast for $1 returned no transactionHash"
}

# ---------------------------------------------------------------------------
# 1/7 price
# ---------------------------------------------------------------------------
stage_price() {
  echo "── [1/7] price ──"
  echo "  cmd: ens price $NAME --chain $CHAIN --payment-token $MOCKUSDC"
  echo "  cmd notes: total is base units in 6-dec MockUSDC; fee = ERC-20 pull (no ETH value)"
  if [ "$MODE" = "dry" ]; then
    if PRICE_JSON_PROBE="$(ens price "$NAME" --chain "$CHAIN" --payment-token "$MOCKUSDC" --format json 2>/dev/null)"; then
      TOTAL="$(printf '%s' "$PRICE_JSON_PROBE" | jq -r .total)"
      echo "  live total = $TOTAL base units ($(printf '%s' "$PRICE_JSON_PROBE" | jq -r .totalFormatted) USDC)"
    else
      echo "  (ens price unreachable in dry-run — amounts stay as placeholders below)"
    fi
  else
    PRICE_JSON="$(ens price "$NAME" --chain "$CHAIN" --payment-token "$MOCKUSDC" --format json)" \
      || die "ens price failed"
    TOTAL="$(printf '%s' "$PRICE_JSON" | jq -r .total)"
    echo "  total = $TOTAL base units ($(printf '%s' "$PRICE_JSON" | jq -r .totalFormatted) USDC)"
  fi
  if [ -n "$TOTAL" ]; then
    MINT_AMOUNT=$(( TOTAL * 2 ))   # 2x buffer for USD price drift before the reveal
    echo "  mint/approve amount = $MINT_AMOUNT base units (2x total buffer)"
  fi
}

# ---------------------------------------------------------------------------
# 2/7 resolver deploy — calldata + predicted address (keyless generation;
# the broadcast itself rides stage 3's 60s wait per the plan)
# ---------------------------------------------------------------------------
stage_resolver() {
  echo "── [2/7] resolver deploy (OwnedResolver via VerifiableFactory) ──"
  if [ -z "$TREASURY_EOA" ]; then
    echo "  cmd: ens resolver deploy <TREASURY_EOA> --chain $CHAIN --name $NAME --records <records-prep.json>"
    echo "  (set TREASURY_EOA in env/.env to get the predicted resolver printed here)"
    return 0
  fi
  local recs
  recs="$(cat "$RECORDS_PREP")"   # ens-cli reads --records as inline JSON (no @file expansion)
  echo "  cmd: ens resolver deploy $TREASURY_EOA --chain $CHAIN --name $NAME --records <records-prep.json>"
  RESOLVER_JSON="$(ens resolver deploy "$TREASURY_EOA" --chain "$CHAIN" --name "$NAME" --records "$recs" --json 2>/dev/null)" || {
    echo "  WARN: resolver deploy calldata generation failed — see ens output above."
    [ "$MODE" = "execute" ] && return 1
    return 0
  }
  RESOLVER="$(printf '%s' "$RESOLVER_JSON" | jq -r .resolver)"
  echo "  predicted resolver: $RESOLVER"
  if [ "$MODE" = "execute" ]; then
    echo "  (deployment is broadcast at stage 3 inside the 60s wait — the CREATE2 address is already final)"
  else
    echo "  calldata: to=$(printf '%s' "$RESOLVER_JSON" | jq -r .to) data=$(printf '%s' "$RESOLVER_JSON" | jq -r .data)"
    echo "  save for resume: echo 'ENS_RESOLVER=$RESOLVER' >> .env"
  fi
}

# ---------------------------------------------------------------------------
# 3/7 commit + 60s wait (resolver deploy + mint/approve broadcast during the wait)
# ---------------------------------------------------------------------------
stage_commit() {
  echo "── [3/7] commit (then wait >=60s — MIN_COMMITMENT_AGE) ──"
  echo "  cmd: ens register commit $NAME --owner ${TREASURY_EOA:-<TREASURY_EOA>} --resolver ${RESOLVER:-<PREDICTED_RESOLVER>} --chain $CHAIN --json"
  if [ -n "$TREASURY_EOA" ] && [ -n "$RESOLVER" ]; then
    local secret_flag=""
    [ -n "$ENS_COMMIT_SECRET" ] && secret_flag="--secret $ENS_COMMIT_SECRET"
    # shellcheck disable=SC2086 — intentional word split for the optional --secret
    COMMIT_JSON="$(ens register commit "$NAME" --owner "$TREASURY_EOA" --resolver "$RESOLVER" --chain "$CHAIN" --json $secret_flag)" \
      || die "commit calldata generation failed"
    SECRET_NEW="$(printf '%s' "$COMMIT_JSON" | jq -r .secret)"
    echo "  secret: $SECRET_NEW"
    echo "  save it: echo 'ENS_COMMIT_SECRET=$SECRET_NEW' >> .env   (required for --from 5 resumes)"
  else
    [ "$MODE" = "execute" ] && { echo "FATAL: stage 3 needs TREASURY_EOA + the resolver — run stages 1-2 first or set ENS_RESOLVER."; return 3; }
    echo "  (run stages 1-2 or set TREASURY_EOA/ENS_RESOLVER to generate the real commitment here)"
    return 0
  fi
  if [ "$MODE" = "dry" ]; then
    echo "  calldata: to=$(printf '%s' "$COMMIT_JSON" | jq -r .to) data=$(printf '%s' "$COMMIT_JSON" | jq -r .data)"
    echo "  broadcast: cast send $(printf '%s' "$COMMIT_JSON" | jq -r .to) $(printf '%s' "$COMMIT_JSON" | jq -r .data) \\"
    echo "      --rpc-url \$SEPOLIA_RPC --private-key \$SEPOLIA_PK"
    echo "  then wait 60s: sleep 60   # MIN_COMMITMENT_AGE before the reveal"
    echo "  DURING the wait, in parallel, broadcast stage 2 (resolver deploy) + stage 4 (mint/approve)"
    return 0
  fi
  local tx
  tx="$(cast_txhash "commit" "$(printf '%s' "$COMMIT_JSON" | jq -r .to)" "$(printf '%s' "$COMMIT_JSON" | jq -r .data)")"
  echo "  commit tx: $tx"
  # --- the 60s MIN_COMMITMENT_AGE window: use it for every other broadcast ---
  echo "  waiting 60s (MIN_COMMITMENT_AGE) — broadcasting resolver deploy + mint/approve inside the window"
  stage_resolver_broadcast
  stage_mint_approve_broadcast
  sleep 60
  echo "  commitment age satisfied — proceeding to reveal"
}

stage_resolver_broadcast() {
  local recs deployed
  recs="$(cat "$RECORDS_PREP")"
  RESOLVER_JSON="$(ens resolver deploy "$TREASURY_EOA" --chain "$CHAIN" --name "$NAME" --records "$recs" --json)" \
    || die "resolver deploy calldata generation failed"
  RESOLVER="$(printf '%s' "$RESOLVER_JSON" | jq -r .resolver)"
  deployed="$(printf '%s' "$RESOLVER_JSON" | jq -r '.alreadyDeployed // false')"
  if [ "$deployed" = "true" ]; then
    echo "  resolver already live at $RESOLVER — no deploy needed"
  else
    broadcast "resolver deploy" "$(printf '%s' "$RESOLVER_JSON" | jq -r .to)" "$(printf '%s' "$RESOLVER_JSON" | jq -r .data)"
  fi
  echo "  resolver live at: $RESOLVER"
}

# ---------------------------------------------------------------------------
# 4/7 MockUSDC mint + approve (ERC-20 pull — approve MUST precede the reveal)
# ---------------------------------------------------------------------------
stage_mint_approve() {
  echo "── [4/7] MockUSDC mint + approve ──"
  [ -n "$TOTAL" ] || stage_price_quiet || die "cannot compute MockUSDC amounts (ens price failed)"
  echo "  cmd (mint):    cast send $MOCKUSDC \"mint(address,uint256)\" ${TREASURY_EOA:-<TREASURY_EOA>} $MINT_AMOUNT --rpc-url \$SEPOLIA_RPC --private-key \$SEPOLIA_PK"
  echo "  cmd (approve): cast send $MOCKUSDC \"approve(address,uint256)\" $REGISTRAR $MINT_AMOUNT --rpc-url \$SEPOLIA_RPC --private-key \$SEPOLIA_PK"
  echo "  (approve targets the ETHRegistrar $REGISTRAR — the reveal pulls the fee from the owner)"
  [ "$MODE" = "execute" ] && stage_mint_approve_broadcast
}

stage_mint_approve_broadcast() {
  # Idempotent: skip each step already satisfied onchain so a full execute run
  # (stage 3's wait window + stage 4) broadcasts each exactly once.
  local bal allow need_mint=1 need_approve=1
  if command -v cast >/dev/null 2>&1; then
    bal="$(cast call "$MOCKUSDC" "balanceOf(address)(uint256)" "$TREASURY_EOA" --rpc-url "$SEPOLIA_RPC" 2>/dev/null)"
    # shellcheck disable=SC2015
    [ -n "$bal" ] && [ "$bal" -ge "$TOTAL" ] && need_mint=0
    allow="$(cast call "$MOCKUSDC" "allowance(address,address)(uint256)" "$TREASURY_EOA" "$REGISTRAR" --rpc-url "$SEPOLIA_RPC" 2>/dev/null)"
    # shellcheck disable=SC2015
    [ -n "$allow" ] && [ "$allow" -ge "$TOTAL" ] && need_approve=0
  fi
  if [ "$need_mint" -eq 1 ]; then
    cast_txhash "mint $MINT_AMOUNT MockUSDC" "$MOCKUSDC" "mint(address,uint256)" "$TREASURY_EOA" "$MINT_AMOUNT" >/dev/null \
      || die "MockUSDC mint failed"
    echo "  minted $MINT_AMOUNT MockUSDC to $TREASURY_EOA"
  else
    echo "  balance already >= fee total — skipping mint"
  fi
  if [ "$need_approve" -eq 1 ]; then
    cast_txhash "approve $REGISTRAR for $MINT_AMOUNT" "$MOCKUSDC" "approve(address,uint256)" "$REGISTRAR" "$MINT_AMOUNT" >/dev/null \
      || die "MockUSDC approve failed"
    echo "  approved $REGISTRAR for $MINT_AMOUNT"
  else
    echo "  allowance already >= fee total — skipping approve"
  fi
  echo "  MockUSDC ready — the reveal can pull the fee"
}

stage_price_quiet() {
  local pj
  pj="$(ens price "$NAME" --chain "$CHAIN" --payment-token "$MOCKUSDC" --format json 2>/dev/null)" || return 1
  TOTAL="$(printf '%s' "$pj" | jq -r .total)"
  MINT_AMOUNT=$(( TOTAL * 2 ))
}

# ---------------------------------------------------------------------------
# 5/7 reveal — hard guard: the secret is REQUIRED (saved to .env from stage 3)
# ---------------------------------------------------------------------------
stage_reveal() {
  echo "── [5/7] reveal ──"
  echo "  cmd: ens register reveal $NAME --owner ${TREASURY_EOA:-<TREASURY_EOA>} --secret \$ENS_COMMIT_SECRET --resolver ${RESOLVER:-<PREDICTED_RESOLVER>} --payment-token $MOCKUSDC --chain $CHAIN --json"
  if [ -z "$ENS_COMMIT_SECRET" ] && [ -z "$SECRET_NEW" ]; then
    if [ "$MODE" = "dry" ]; then
      echo "  (the secret for reveal is printed by stage 3 — in execute mode this is a hard gate)"
      return 0
    fi
    cat <<'EOF'
FATAL: reveal needs the commit secret (ENS_COMMIT_SECRET), but it is not set.
It is printed by stage 3 (commit) — save it on the first run with:
    echo 'ENS_COMMIT_SECRET=<secret>' >> .env
then resume this script from stage 5 (--from 5). The secret is a 0x-prefixed
bytes32 and is required to recompute the exact commitment for the reveal.
EOF
    return 3
  fi
  [ -n "$TREASURY_EOA" ] && [ -n "$RESOLVER" ] || {
    [ "$MODE" = "dry" ] && return 0
    echo "FATAL: reveal needs TREASURY_EOA + the resolver — set ENS_RESOLVER or start from stage 2."; return 3
  }
  local secret="${ENS_COMMIT_SECRET:-$SECRET_NEW}"
  REVEAL_JSON="$(ens register reveal "$NAME" --owner "$TREASURY_EOA" --secret "$secret" --resolver "$RESOLVER" --payment-token "$MOCKUSDC" --chain "$CHAIN" --json)" \
    || die "reveal calldata generation failed"
  if [ "$MODE" = "dry" ]; then
    echo "  calldata: to=$(printf '%s' "$REVEAL_JSON" | jq -r .to) data=$(printf '%s' "$REVEAL_JSON" | jq -r .data) value=$(printf '%s' "$REVEAL_JSON" | jq -r .value)"
    echo "  broadcast: cast send $(printf '%s' "$REVEAL_JSON" | jq -r .to) $(printf '%s' "$REVEAL_JSON" | jq -r .data) \\"
    echo "      --rpc-url \$SEPOLIA_RPC --private-key \$SEPOLIA_PK"
    return 0
  fi
  local tx
  out="$(cast_txhash "reveal" "$(printf '%s' "$REVEAL_JSON" | jq -r .to)" "$(printf '%s' "$REVEAL_JSON" | jq -r .data)")"
  echo "  reveal tx: $out"
  echo "  broadcast tool alternative: paste to/data/value from the calldata JSON into https://transact.swiss-knife.xyz/send-tx"
}

# ---------------------------------------------------------------------------
# 6/7 set batch — hard guard: refuse to push CHANGEME placeholders onchain
# ---------------------------------------------------------------------------
stage_set_records() {
  echo "── [6/7] set batch (final records) ──"
  echo "  cmd: ens set batch $NAME --chain $CHAIN --resolver ${RESOLVER:-<PREDICTED_RESOLVER>} --data <records.json>"
  if [ "$FINAL_CHANGEME" -gt 0 ]; then
    if [ "$MODE" = "dry" ]; then
      echo "  NOTE: records.json still has $FINAL_CHANGEME CHANGEME placeholder(s) — replace before the live run:"
      list_changeme "$RECORDS_FINAL" | sed 's/^/    /'
      return 0
    fi
    cat <<'EOF'
FATAL: records.json still contains CHANGEME placeholders — refusing to set them onchain.
Replace before the live run (docs/ens-storefront.md § Placeholder checklist):
EOF
    list_changeme "$RECORDS_FINAL" | sed 's/^/    /'
    return 3
  fi
  [ -n "$RESOLVER" ] || {
    [ "$MODE" = "dry" ] && return 0
    echo "FATAL: stage 6 needs the resolver — set ENS_RESOLVER or start from stage 2."; return 3
  }
  local data
  data="$(cat "$RECORDS_FINAL")"   # ens-cli reads --data as inline JSON (no @file expansion)
  SET_JSON="$(ens set batch "$NAME" --chain "$CHAIN" --resolver "$RESOLVER" --data "$data" --json 2>/dev/null)" || {
    echo "  WARN: ens set batch calldata generation failed — see ens output above."
    [ "$MODE" = "execute" ] && return 1
    return 0
  }
  if [ "$MODE" = "dry" ]; then
    echo "  calldata: to=$(printf '%s' "$SET_JSON" | jq -r .to) data=$(printf '%s' "$SET_JSON" | jq -r .data)"
    echo "  broadcast: cast send $(printf '%s' "$SET_JSON" | jq -r .to) $(printf '%s' "$SET_JSON" | jq -r .data) \\"
    echo "      --rpc-url \$SEPOLIA_RPC --private-key \$SEPOLIA_PK"
    return 0
  fi
  local tx
  tx="$(cast_txhash "set batch" "$(printf '%s' "$SET_JSON" | jq -r .to)" "$(printf '%s' "$SET_JSON" | jq -r .data)")"
  echo "  set-batch tx: $tx"
}

# ---------------------------------------------------------------------------
# 7/7 verify — read-only, works in both modes
# ---------------------------------------------------------------------------
stage_verify() {
  echo "── [7/7] verify ──"
  # Read back EXACTLY the keys the batch wrote (records.json) — no hardcoded
  # subset, no placeholder agentId. CHANGEME residue is impossible here (the
  # script aborts upstream), so every key is the real one.
  local key value missing=0 count=0
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    count=$((count + 1))
    value="$(ens get text "$NAME" --chain "$CHAIN" --key "$key" --format json 2>/dev/null | jq -r .value)"
    if [ -n "$value" ] && [ "$value" != "null" ]; then
      echo "  OK   $key = ${value:0:100}"
    else
      echo "  MISS $key (unset) — storefront incomplete; Task 5 get_quote HARD-FAILS on missing svc.price/sla/payee"
      missing=1
    fi
  done < <(jq -r '.[].key' "$RECORDS_FINAL")
  echo "  verified $count records from records.json"
  echo "  viem read (Task 7, app/): createPublicClient({chain: sepolia}).getEnsText({name, key}) per record — same source, same values."
  [ "$missing" -eq 0 ] || { [ "$MODE" = "execute" ] && return 1; }
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
if [ "$MODE" = "probe" ]; then
  probe
  exit 0
fi

if [ -n "$SEPOLIA_PK" ] && [ -n "$SEPOLIA_RPC" ]; then
  MODE="execute"
else
  MODE="dry"
fi

echo "OpenBook ENSv2 storefront setup — $NAME ($CHAIN)"
echo "  records-prep: $RECORDS_PREP — records: $RECORDS_FINAL"
echo "  mode: $([ "$MODE" = "execute" ] && echo EXECUTE || echo KEYLESS-dry-run)"
if [ "$MODE" = "execute" ]; then
  ensure_exec_env || exit 3
else
  [ -n "$SEPOLIA_PK" ] && [ -z "$SEPOLIA_RPC" ] && echo "  (SEPOLIA_PK set but SEPOLIA_RPC missing — dry-run; BOTH are required to execute)"
  [ -n "$SEPOLIA_RPC" ] && [ -z "$SEPOLIA_PK" ] && echo "  (SEPOLIA_RPC set but SEPOLIA_PK missing — dry-run; BOTH are required to execute)"
  [ -z "$SEPOLIA_PK" ] && [ -z "$SEPOLIA_RPC" ] && echo "  (no SEPOLIA_PK/SEPOLIA_RPC — nothing will be broadcast; exact commands + calldata below)"
fi
[ "$PREP_CHANGEME" -gt 0 ] && echo "  WARN: records-prep.json has $PREP_CHANGEME CHANGEME placeholder(s) — only the funded run may set them."

# Execute-mode preflight: refuse to run (before ANY broadcast, incl. commit/reveal)
# while records.json still carries CHANGEME placeholders. FINAL_CHANGEME was counted
# at startup, so this is a pure check — no network, no keys touched.
if [ "$MODE" = "execute" ] && [ "$FINAL_CHANGEME" -gt 0 ]; then
  cat <<'EOF'
FATAL: records.json still contains CHANGEME placeholders — refusing to run; no
broadcast will happen (commit/reveal/resolver-deploy are all held).
Replace them first (docs/ens-storefront.md § Placeholder checklist), then re-run.
Remaining placeholders:
EOF
  list_changeme "$RECORDS_FINAL" | sed 's/^/    /'
  exit 3
fi

run_stage() { # $1 = stage function name — aborts the run on failures in execute mode
  "$1" || {
    local rc=$?
    [ "$MODE" = "dry" ] && return 0
    echo "ABORTED at: $1 (exit $rc) — see docs/ens-storefront.md § what-to-rerun-if-a-tx-flubs."
    exit "$rc"
  }
}

[ "$FROM" -le 1 ] && run_stage stage_price
[ "$FROM" -le 2 ] && run_stage stage_resolver
[ "$FROM" -le 3 ] && run_stage stage_commit
[ "$FROM" -le 4 ] && run_stage stage_mint_approve
[ "$FROM" -le 5 ] && run_stage stage_reveal
[ "$FROM" -le 6 ] && run_stage stage_set_records
[ "$FROM" -le 7 ] && run_stage stage_verify

if [ "$MODE" = "dry" ]; then
  echo ""
  echo "Keyless dry-run complete (exit 0). To execute for real: export SEPOLIA_RPC + SEPOLIA_PK"
  echo "(TREASURY_EOA is derived from SEPOLIA_PK if unset), replace the CHANGEME placeholders"
  echo "in scripts/ens/records.json, then re-run this script."
fi
exit 0
