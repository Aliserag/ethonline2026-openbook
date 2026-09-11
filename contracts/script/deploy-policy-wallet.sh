#!/usr/bin/env bash
# Deploy PolicyWallet to Arc testnet (5042002).
# Keyless-safe: NEVER broadcasts. Checks $ARC_TESTNET_PK + deployer funding,
# prints the exact `forge create --broadcast` command once both exist, and
# exits 0 with "awaiting key"/"awaiting funding" otherwise (no keys yet —
# see the setup notes).
#
# Env overrides:
#   ARC_TESTNET_PK    deployer key (required to broadcast; optional here)
#   ARC_TESTNET_RPC   default https://rpc.testnet.arc.io
#   AGENT_ADDR        agent key address (constructor arg; default $ARC_RECIPIENT_ADDR)
#   PER_TX_CAP        per-tx cap, 6-dec USDC units (default 1000000 = 1 USDC)
#   DAILY_CAP         daily cap, 6-dec units (default 10000000 = 10 USDC)
set -euo pipefail

cd "$(dirname "$0")/../.." # repo root

# Load gitignored .env if present, so `bash contracts/script/deploy-policy-wallet.sh` works unadorned.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

RPC="${ARC_TESTNET_RPC:-https://rpc.testnet.arc.io}"
USDC="${USDC_ADDR:-0x3600000000000000000000000000000000000000}"
AGENT="${AGENT_ADDR:-${ARC_RECIPIENT_ADDR:-}}"
PER_TX="${PER_TX_CAP:-1000000}"
DAILY="${DAILY_CAP:-10000000}"

if [[ -z "${ARC_TESTNET_PK:-}" ]]; then
  echo "awaiting key: \$ARC_TESTNET_PK is unset (drip a testnet key at https://faucet.circle.com — see the setup notes)"
  exit 0
fi
if [[ -z "$AGENT" ]]; then
  echo "awaiting config: \$AGENT_ADDR (or \$ARC_RECIPIENT_ADDR) must name the agent key — the address that calls requestWithdrawal"
  exit 0
fi

DEPLOYER="$(cast wallet address --private-key "$ARC_TESTNET_PK")"
BALANCE="$(cast balance --rpc-url "$RPC" "$DEPLOYER")"

if [[ "$BALANCE" == "0" || -z "$BALANCE" ]]; then
  echo "awaiting funding: deployer $DEPLOYER has 0 USDC on Arc testnet ($RPC)."
  echo "  Drip ~5 USDC at https://faucet.circle.com (USDC is the gas token; avg tx ≈ \$0.004)."
  exit 0
fi

cat <<EOF
PolicyWallet deploy ready — deployer $DEPLOYER funded ($BALANCE wei).

Exact command:

  forge create contracts/src/PolicyWallet.sol:PolicyWallet \\
    --constructor-args $USDC $AGENT $PER_TX $DAILY \\
    --rpc-url $RPC --private-key \$ARC_TESTNET_PK --broadcast

Note: Arc gas floor is 20 Gwei (verified trap — lower tips are silently dropped);
if the tx vanishes, re-run with --gas-price 20000000000.

Set POLICY_WALLET_ADDR=<deployed> in .env, then:
  1. Faucet USDC directly to the wallet address (USDC is its balance, 6-dec view).
  2. Owner (deployer) calls setAllowlist(<payee>, true) so withdrawals can pass.
  3. Agent ($AGENT) calls requestWithdrawal(<payee>, <6dec-amount>) — perTxCap=$PER_TX, dailyCap=$DAILY.
EOF
exit 0
