#!/usr/bin/env bash
# generate-key.sh — throwaway Arc testnet keypairs (testnet-only, safe to generate).
# Writes/refreshes ARC_* variables in <repo-root>/.env (gitignored). NEVER commit .env.
#   - ARC_TESTNET_ADDR/PK   : the funded wallet (faucet target; USDC is gas on Arc)
#   - ARC_RECIPIENT_ADDR/PK : spare recipient wallet (USDC transfer spike target)
# Requires cast (foundry). Usage: bash scripts/spikes/generate-key.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v cast >/dev/null 2>&1 || { echo >&2 "ERROR: cast (foundry) not found — install: brew install foundry"; exit 1; }

gen_keypair() {
  cast wallet new 2>/dev/null | awk -F': ' '/Address/ {addr=$2} /Private key/ {pk=$2} END {print addr " " pk}'
}

read -r ADDR PK < <(gen_keypair)    # funded wallet (faucet target)
read -r RADDR RPK < <(gen_keypair)  # spare recipient (transfer target)

ENV_FILE=".env"
touch "$ENV_FILE"
# strip existing ARC_* lines, preserving any other vars (e.g. GRAPH_STUDIO_KEY)
grep -v '^ARC_' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
mv "$ENV_FILE.tmp" "$ENV_FILE"

cat >> "$ENV_FILE" <<EOF
# Arc testnet (chain 5042002) throwaway keys — generated $(date -u +%Y-%m-%dT%H:%M:%SZ), testnet only. NEVER commit.
ARC_TESTNET_ADDR=$ADDR
ARC_TESTNET_PK=$PK
ARC_RECIPIENT_ADDR=$RADDR
ARC_RECIPIENT_PK=$RPK
EOF
chmod 600 "$ENV_FILE"

echo "Wrote throwaway Arc testnet keypairs to $ENV_FILE (gitignored)."
echo ""
echo "FUND THIS WALLET (USDC is the gas token on Arc):"
echo "  1) Web faucet: https://faucet.circle.com -> connect $ADDR -> Arc Testnet -> request USDC"
echo "     (limit ~20 USDC / 2h / address; select 'Arc' + USDC; optionally get EURC too)"
echo "  2) or programmatic drips API (requires a Circle developer API key):"
echo "     curl -X POST https://api.circle.com/v1/faucet/drips \\"
echo "       -H 'Authorization: Bearer <TEST_API_KEY>' -H 'Content-Type: application/json' \\"
echo "       -d '{\"address\":\"$ADDR\",\"blockchain\":\"ARC-TESTNET\",\"native\":true,\"usdc\":true}'"
echo "     (probed 2026-09-09: returns 401 without a key — key-gated; see docs/keys-needed.md)"
echo ""
echo "FUNDED ADDRESS: $ADDR"
echo "RECIPIENT ADDR: $RADDR"
echo "Keys are testnet-only; .env is gitignored and never committed."
