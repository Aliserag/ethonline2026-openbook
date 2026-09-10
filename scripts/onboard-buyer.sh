#!/usr/bin/env bash
# onboard-buyer.sh — zero-to-first-paid-query for an external buyer (~10 min).
#
# What this does:
#   1. generates a fresh Arc testnet buyer key (or keeps your ARC_TESTNET_PK)
#   2. prints the faucet link for that address and waits for the USDC drip
#   3. runs one full paid query against the live OpenBook agent
#      (quote from openbook.eth ENS records -> escrow pay -> delivery ->
#      deterministic verify -> settle)
#
# Honest topology: with only a buyer key the CLI signs BOTH sides itself
# (buyer==provider — the single-key demo is legal per the ERC-8183 spec), so
# the escrow/refund machinery is fully exercised on the live contract. A missed
# SLA is claimable back after the deadline — the auto-refund is the product.
#
# Prereqs: bun + foundry's cast. GRAPH_GATEWAY_KEY (thegraph.com/studio, free)
# in .env for the live delivery leg.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="${ARC_TESTNET_RPC:-https://rpc.testnet.arc.io}"
USDC="0x3600000000000000000000000000000000000000"

if ! command -v cast >/dev/null 2>&1; then
  echo "foundry's cast is required: https://getfoundry.sh"; exit 1
fi

# --- 1. key ------------------------------------------------------------------
if [ -z "${ARC_TESTNET_PK:-}" ]; then
  OUT="$(cast wallet new --json)"
  ARC_TESTNET_PK="$(printf '%s' "$OUT" | jq -r '.[0].private_key')"
  ADDR="$(printf '%s' "$OUT" | jq -r '.[0].address')"
  echo "ARC_TESTNET_PK=$ARC_TESTNET_PK" >> .env
  echo "fresh buyer key generated: $ADDR (saved to .env, gitignored)"
else
  ADDR="$(cast wallet address "$ARC_TESTNET_PK")"
  echo "using existing ARC_TESTNET_PK: $ADDR"
fi

# --- 2. faucet ----------------------------------------------------------------
# cast annotates large uints ("15847877 [1.584e7]") — keep only the first word.
BAL="$(cast call "$USDC" "balanceOf(address)(uint256)" "$ADDR" --rpc-url "$RPC" 2>/dev/null || echo 0)"
BAL="${BAL%% *}"
if [ "$BAL" -lt 100000 ]; then
  echo
  echo "Fund the buyer (free testnet USDC):"
  echo "  https://faucet.arc.network  -> paste $ADDR"
  echo "waiting for the drip (polling, Ctrl-C to abort)…"
  for _ in $(seq 1 60); do
    sleep 10
    BAL="$(cast call "$USDC" "balanceOf(address)(uint256)" "$ADDR" --rpc-url "$RPC" 2>/dev/null || echo 0)"
    BAL="${BAL%% *}"
    [ "$BAL" -ge 100000 ] && break
  done
fi
[ "$BAL" -ge 100000 ] || { echo "no funds after 10 min — faucet may be down; retry later"; exit 1; }
echo "buyer funded: $((BAL / 1000000)).$((BAL % 1000000)) USDC"

# --- 3. first paid query -------------------------------------------------------
echo
echo "running one paid query against openbook.eth…"
exec bun agent/buyer-cli.ts --dataset aave-v3-arbitrum-lending
