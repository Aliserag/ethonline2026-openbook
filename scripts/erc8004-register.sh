#!/usr/bin/env bash
# erc8004-register.sh — OpenBook Task 3 Step 4: register the agent's ERC-8004
# onchain identity on Arc testnet.
#
#   IdentityRegistry 0x8004A818BFB912233c491871b3d84c89A494BD9e
#   register(string metadataURI)  -> mints the agent identity NFT (ERC-721)
#   Agent ID = minted tokenId (from the Transfer event), recorded as AGENT_ID.
#
# Two paths (per docs.arc.io "Register your first AI agent"):
#
#   A) Circle Wallets dev-controlled SCA (tutorial path; fees sponsored by
#      Circle Gas Station). Requires CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET.
#      NOTE: implemented against the documented W3S REST surface but cannot be
#      exercised keylessly — on any API mismatch it prints the raw failure and
#      falls back to path B instructions.
#
#   B) Raw cast-send equivalent (self-managed EOA via ARC_TESTNET_PK) — no
#      Circle keys required. The exact command is ALWAYS printed so the
#      registration can run without any Circle credentials.
#
# Usage:
#   scripts/erc8004-register.sh --metadata-uri <URI>   # or positional <URI> / AGENT_METADATA_URI
# The URI is REQUIRED and verified (http(s) HEAD / IPFS CID) before any run.
#
# Exit codes (repo convention for key-gated scripts):
#   0  registered (path A) or verified fallback remains for the user
#   3  key(s) missing — instructions + exact commands printed
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${ARC_TESTNET_RPC:-https://rpc.testnet.arc.io}"
REGISTRY="${ERC8004_IDENTITY_REGISTRY:-0x8004A818BFB912233c491871b3d84c89A494BD9e}"

usage() {
  cat <<'EOF'
Usage: scripts/erc8004-register.sh --metadata-uri <URI>
       scripts/erc8004-register.sh <URI>            # positional form
       AGENT_METADATA_URI=<URI> scripts/erc8004-register.sh

  <URI>  http(s):// or ipfs:// URL of the agent's metadata JSON. This URI is
         stored onchain FOREVER as the identity NFT's tokenURI — pin the JSON
         at a public endpoint (IPFS preferred) BEFORE registering.
EOF
}

# --- metadata URI: REQUIRED (flag > positional > AGENT_METADATA_URI) -------------
METADATA_URI=""
POSITIONAL=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --metadata-uri)
      if [ "$#" -lt 2 ]; then
        usage
        echo "ERROR: --metadata-uri requires a value (use --metadata-uri <URI> or AGENT_METADATA_URI)."
        exit 3
      fi
      METADATA_URI="$2"; shift 2 ;;
    --metadata-uri=*) METADATA_URI="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) POSITIONAL="$1"; shift ;;
  esac
done
METADATA_URI="${METADATA_URI:-${POSITIONAL:-${AGENT_METADATA_URI:-}}}"
if [ -z "$METADATA_URI" ]; then
  usage
  echo "ERROR: a metadata URI is required (--metadata-uri <URI> or AGENT_METADATA_URI)."
  exit 3
fi

# --- verify the URI resolves before any funded run --------------------------------
check_metadata_uri() {
  local uri="$1"
  case "$uri" in
    http://*|https://*)
      local code
      code="$(curl -sIL -m 15 -o /dev/null -w '%{http_code}' "$uri" 2>/dev/null || echo 000)"
      case "$code" in
        2*|3*) echo "OK: metadata URI resolves (HTTP $code): $uri"; return 0 ;;
        *) echo "ERROR: metadata URI does not resolve (HTTP $code): $uri"; return 1 ;;
      esac ;;
    ipfs://*)
      local cid="${uri#ipfs://}"
      if ! [[ "$cid" =~ ^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,59})$ ]]; then
        echo "ERROR: invalid IPFS CID: $cid"; return 1
      fi
      # best-effort public gateway check — public gateways are rate-flaky, so a
      # failure here only warns (a private pin may serve fine)
      local gcode
      gcode="$(curl -sIL -m 15 -o /dev/null -w '%{http_code}' "https://ipfs.io/ipfs/$cid" 2>/dev/null || echo 000)"
      case "$gcode" in
        2*|3*) echo "OK: metadata resolves via IPFS gateway (HTTP $gcode): $uri" ;;
        *) echo "WARN: public gateway check failed (HTTP $gcode) — confirm your pin, then continue" ;;
      esac
      return 0 ;;
    *)
      echo "ERROR: unsupported metadata URI scheme (use http(s):// or ipfs://): $uri"; return 1 ;;
  esac
}
check_metadata_uri "$METADATA_URI" || exit 3

get_env() { sed -nE "s/^$1=(.*)$/\1/p" "$REPO_ROOT/.env" 2>/dev/null | tail -1 | tr -d '"'; }
CIRCLE_API_KEY="${CIRCLE_API_KEY:-$(get_env CIRCLE_API_KEY)}"
CIRCLE_ENTITY_SECRET="${CIRCLE_ENTITY_SECRET:-$(get_env CIRCLE_ENTITY_SECRET)}"
ARC_TESTNET_PK="${ARC_TESTNET_PK:-$(get_env ARC_TESTNET_PK)}"

print_registered() { # $1 = txHash
  echo ""
  echo "REGISTERED: https://testnet.arcscan.app/tx/$1"
  echo "Metadata URI (stored as identity tokenURI): $METADATA_URI"
}

print_agent_id_instructions() { # $1 = owner address (sender of register())
  local owner="$1"
  cat <<EOF

Retrieve the agent ID from the mint Transfer event (tokenId):

  RPC=$RPC
  OWNER=$owner
  TXHASH=<hash from the register tx above>
  cast receipt "\$TXHASH" --json --rpc-url "\$RPC" \\
    | jq -r '.logs[] | select(.topics[0] == "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" and .topics[1] == "0x0000000000000000000000000000000000000000000000000000000000000000") | .topics[3]'
  AGENT_ID=\$(cast receipt "\$TXHASH" --json --rpc-url "\$RPC" | jq -r '.logs[] | select(.topics[0] == "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") | .topics[3]' | tail -1)
  AGENT_ID=\$(cast to-dec "\$AGENT_ID")
  echo "AGENT_ID=\$AGENT_ID   # -> add to .env (or run: cast call $REGISTRY 'ownerOf(uint256)(address)' \$AGENT_ID to confirm)"
EOF
}

print_cast_send() { # the raw cast-send equivalent — runnable with ONLY ARC_TESTNET_PK
  local owner
  if [ -n "$ARC_TESTNET_PK" ]; then
    owner="$(cast wallet address --private-key "$ARC_TESTNET_PK" 2>/dev/null)"
  else
    owner="<YOUR_WALLET_ADDRESS>"
  fi
  cat <<EOF

---------- RAW cast-send equivalent (no Circle API keys needed) ----------
# 1) Fund $owner on Arc testnet (faucet.circle.com) if not already (native
#    USDC is the gas token; avg tx ~\$0.004).
# 2) Register the agent (20 Gwei maxFeePerGas floor — Arc trap):
cast send $REGISTRY "register(string)" "$METADATA_URI" \\
  --rpc-url $RPC \\
  --private-key \$ARC_TESTNET_PK \\
  --max-fee-per-gas 20000000000
# 3) TXHASH = the 'transactionHash' line from the cast send output; then:
$(print_agent_id_instructions "$owner" | sed 's/^/# /' | sed 's/^# # /#   /')
# 4) Record it: echo "AGENT_ID=<tokenId>" >> .env
--------------------------------------------------------------------------
# Metadata JSON example to pin (structure is application-defined per ERC-8004):
# {"name":"OpenBook","description":"Autonomous freshness-guaranteed data-query seller",
#  "image":"ipfs://<avatar>","agent_type":"data-seller",
#  "capabilities":["subgraph_query","sla_settlement","usdc_payments"],"version":"1.0.0"}
EOF
}

if [ -z "$CIRCLE_API_KEY" ] || [ -z "$CIRCLE_ENTITY_SECRET" ]; then
  echo "SKIP: Circle Wallets credentials absent (CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET) —"
  echo "registration is keyless via the cast-send path instead."
  print_cast_send
  echo ""
  echo "Circle-keys users (path A): console.circle.com -> Keys -> Create key -> API key (Standard),"
  echo "plus an entity secret (console.circle.com/wallets/dev/configurator/entity-secret)."
  exit 3
fi

# ------------------------- Path A: Circle Wallets dev-controlled SCA ----------
command -v curl >/dev/null || { echo "FATAL: curl required for path A"; exit 1; }
command -v jq >/dev/null || { echo "FATAL: jq required for path A"; exit 1; }

API="https://api.circle.com/v1/w3s"
AUTH="Authorization: Bearer $CIRCLE_API_KEY"
SECRET="X-Entity-Secret: $CIRCLE_ENTITY_SECRET"
fail() { # $1 = step, $2 = response body
  echo "ERROR: $1 failed — response: ${2:-<empty>}"
  echo "If the request shape drifted from current Circle docs, adjust the script;"
  echo "the raw cast-send fallback below always works:"
  print_cast_send
  exit 1
}

# 1. wallet set (reuse CIRCLE_WALLET_SET_ID if provided)
WALLET_SET_ID="${CIRCLE_WALLET_SET_ID:-}"
if [ -z "$WALLET_SET_ID" ]; then
  WALLET_SET_ID="$(curl -sS -X POST "$API/wallet-sets" -H "$AUTH" -H "Content-Type: application/json" \
    -d '{"name":"openbook-agent"}' | jq -r '.data.walletSet.id // empty')" \
    || WALLET_SET_ID=""
  [ -n "$WALLET_SET_ID" ] || fail "create wallet set" ""
fi

# 2. wallet (reuse CIRCLE_WALLET_ADDRESS if provided)
WALLET_ADDRESS="${CIRCLE_WALLET_ADDRESS:-}"
if [ -z "$WALLET_ADDRESS" ]; then
  WALLETS_JSON="$(curl -sS -X POST "$API/wallets" -H "$AUTH" -H "$SECRET" -H "Content-Type: application/json" \
    -d "{\"blockchains\":[\"ARC-TESTNET\"],\"count\":1,\"walletSetId\":\"$WALLET_SET_ID\",\"accountType\":\"SCA\"}")"
  WALLET_ADDRESS="$(printf '%s' "$WALLETS_JSON" | jq -r '.data.wallets[0].address // empty')"
  WALLET_ID="$(printf '%s' "$WALLETS_JSON" | jq -r '.data.wallets[0].id // empty')"
  [ -n "$WALLET_ADDRESS" ] || fail "create SCA wallet" "$WALLETS_JSON"
else
  WALLET_ID="${CIRCLE_WALLET_ID:-}"
  [ -n "$WALLET_ID" ] || { echo "WARN: CIRCLE_WALLET_ADDRESS set without CIRCLE_WALLET_ID — pass CIRCLE_WALLET_ID too"; }
fi
echo "Agent owner (Circle SCA): $WALLET_ADDRESS"
echo "Registering metadata URI: $METADATA_URI"

# 3. createContractExecutionTransaction (developer-controlled; gas sponsored)
TX_JSON="$(curl -sS -X POST "$API/developer/transactions/contractExecution" -H "$AUTH" -H "$SECRET" -H "Content-Type: application/json" \
  -d "{\"walletIds\":[\"$WALLET_ID\"],\"blockchain\":\"ARC-TESTNET\",\"contractAddress\":\"$REGISTRY\",\"abiFunctionSignature\":\"register(string)\",\"abiParameters\":[\"$METADATA_URI\"],\"fee\":{\"type\":\"level\",\"config\":{\"feeLevel\":\"MEDIUM\"}}}")"
TX_ID="$(printf '%s' "$TX_JSON" | jq -r '.data.id // empty')"
[ -n "$TX_ID" ] || fail "create contract execution transaction" "$TX_JSON"
echo "Transaction created: $TX_ID (polling…)"

# 4. poll until COMPLETE / FAILED (sub-second finality; 30 x 2s cap)
TX_HASH=""
for _ in $(seq 1 30); do
  sleep 2
  TX="$(curl -sS "$API/transactions/$TX_ID" -H "$AUTH")"
  STATE="$(printf '%s' "$TX" | jq -r '.data.transaction.state // "UNKNOWN"')"
  if [ "$STATE" = "COMPLETE" ]; then
    TX_HASH="$(printf '%s' "$TX" | jq -r '.data.transaction.txHash // empty')"
    break
  fi
  [ "$STATE" = "FAILED" ] && fail "transaction $TX_ID" "$TX"
done
[ -n "$TX_HASH" ] || fail "transaction $TX_ID (timeout)" "$TX"
print_registered "$TX_HASH"
print_agent_id_instructions "$WALLET_ADDRESS"
echo ""
echo "Success: record AGENT_ID in .env (echo 'AGENT_ID=<tokenId>' >> .env)."
exit 0
