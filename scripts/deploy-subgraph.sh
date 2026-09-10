#!/usr/bin/env bash
# deploy-subgraph.sh — OpenBook P&L subgraph deploy to Subgraph Studio (arc-testnet).
#
# Keyless until the final step: codegen + build + unit tests run without any API
# key. The Studio deploy requires GRAPH_STUDIO_DEPLOY_KEY (from thegraph.com/studio,
# Subgraph Studio -> API key). If that var is unset the script stops cleanly before
# touching the network and prints the exact steps to complete the deploy by hand.
#
# Provider scoping: the P&L subgraph books revenue/refunds ONLY for the seller
# whose address is `SELLER` in subgraph/src/mapping.ts (the ERC-8183 reference
# contract is shared with other ETHOnline agents). Pass SELLER_ADDRESS (the
# ERC-8004-registered operator address) to substitute it into the mapping before
# codegen; without it the mapping keeps the zero-address placeholder and the
# deploy is REFUSED (a placeholder deployment would silently book no P&L).
#
# Pre-req (one-time, user action): create the subgraph named `open-book` in
# Subgraph Studio, and toggle Settings -> "Show Testnets" so network `arc-testnet`
# is selectable.
#
# Usage:
#   SELLER_ADDRESS=<seller> GRAPH_STUDIO_DEPLOY_KEY=<key> bash scripts/deploy-subgraph.sh
# Mainnet (Arc Sep 16+): copy the mainnet manifest over subgraph.yaml, then
#   NETWORK=arc GRAPH_STUDIO_DEPLOY_KEY=<key> bash scripts/deploy-subgraph.sh
# (graph codegen/build/deploy always read ./subgraph.yaml, so the swap is the
# switch — keep subgraph-mainnet.yaml committed for the audit trail.)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBGRAPH_DIR="$REPO_ROOT/subgraph"
SUBGRAPH_NAME="${SUBGRAPH_NAME:-open-book}"
NETWORK="${NETWORK:-arc-testnet}"
GRAPH_BIN="${GRAPH_BIN:-$(command -v graph || echo "$HOME/.npm-global/bin/graph")}"

if [ -z "$GRAPH_BIN" ]; then
  echo "FATAL: graph CLI not found. Install: npm install -g @graphprotocol/graph-cli"
  exit 1
fi

echo "== [1/4] local checks (keyless) =="
cd "$SUBGRAPH_DIR"
[ -f subgraph.yaml ] || { echo "FATAL: $SUBGRAPH_DIR/subgraph.yaml missing"; exit 1; }
grep -qE "^[[:space:]]*network:[[:space:]]*$NETWORK" subgraph.yaml \
  || { echo "FAIL: manifest network must be $NETWORK"; exit 1; }
echo "manifest: network $NETWORK OK"

# Provider-scoped P&L: substitute the seller address into the mapping BEFORE
# codegen (the placeholder keeps `graph build` green and keyless-safe). The
# matchstick tests follow the SELLER constant, so they pass either way.
SELLER_PLACEHOLDER="0x0000000000000000000000000000000000000000"
SELLER_FILE="$SUBGRAPH_DIR/src/mapping.ts"
if [ -n "${SELLER_ADDRESS:-}" ]; then
  if ! echo "$SELLER_ADDRESS" | grep -qE '^0x[0-9a-fA-F]{40}$'; then
    echo "FATAL: SELLER_ADDRESS must be a 0x-prefixed 40-hex address (got '$SELLER_ADDRESS')"
    exit 1
  fi
  sed -i.bak "s|const SELLER = \"$SELLER_PLACEHOLDER\"|const SELLER = \"$SELLER_ADDRESS\"|" "$SELLER_FILE" \
    || { echo "FATAL: could not substitute SELLER in $SELLER_FILE"; exit 1; }
  # The substitution is build-time only — the source tree keeps the
  # placeholder (keyless-safe default; matchstick fixtures derive from it).
  # Restore after build no matter what, or the committed source silently
  # carries a deployment address and the scoping tests break (round-2 review).
  restore_seller() { [ -f "$SELLER_FILE.bak" ] && mv "$SELLER_FILE.bak" "$SELLER_FILE"; }
  trap restore_seller EXIT
  echo "substituted SELLER -> $SELLER_ADDRESS in $SELLER_FILE (restored after build)"
fi

echo "== [2/4] codegen + build (keyless) =="
"$GRAPH_BIN" codegen || { echo "FAIL: graph codegen errored"; exit 1; }
"$GRAPH_BIN" build   || { echo "FAIL: graph build errored"; exit 1; }
echo "PASS: codegen + build OK"

echo "== [3/4] Studio key gate =="
if [ -z "${GRAPH_STUDIO_DEPLOY_KEY:-}" ]; then
  cat <<'EOF'
No GRAPH_STUDIO_DEPLOY_KEY set — deploy skipped (clean exit). To deploy:

1. Create the subgraph `openbook-pnl` in https://thegraph.com/studio (subgraphs
   auto-create, but pre-creating avoids a silent rename).
2. In Studio, toggle Settings -> "Show Testnets" (arc-testnet must be selectable).
3. Run:

   cd subgraph
   graph auth <YOUR_GRAPH_STUDIO_DEPLOY_KEY>
   graph deploy openbook-pnl --node https://api.studio.thegraph.com/deploy/ --deploy-key <YOUR_GRAPH_STUDIO_DEPLOY_KEY>

   SELLER_ADDRESS (provider scoping — REQUIRED when deploying, else the subgraph
   books no P&L): rerun with SELLER_ADDRESS=<operator address> set.

Expected: deployment accepted; Studio shows status "Syncing" on network arc-testnet.
EOF
  exit 0
fi

echo "== [4/4] auth + deploy =="
# Deploying with the placeholder would yield a silently empty P&L ledger.
if grep -q "const SELLER = \"$SELLER_PLACEHOLDER\"" "$SELLER_FILE"; then
  echo "FATAL: subgraph/src/mapping.ts still holds the SELLER placeholder —" \
    "rerun with SELLER_ADDRESS=<seller address> set (provider-scoped P&L)."
  exit 1
fi
"$GRAPH_BIN" auth "$GRAPH_STUDIO_DEPLOY_KEY" || { echo "FAIL: graph auth errored"; exit 1; }
"$GRAPH_BIN" deploy "$SUBGRAPH_NAME" --node https://api.studio.thegraph.com/deploy/ --deploy-key "$GRAPH_STUDIO_DEPLOY_KEY" --version-label "${VERSION_LABEL:-v0.0.1}" < /dev/null || { echo "FAIL: graph deploy errored"; exit 1; }
echo "PASS: $SUBGRAPH_NAME deployed — see Studio for sync status and the /query/<KEY> URL."
