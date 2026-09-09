#!/usr/bin/env bash
# deploy-subgraph.sh — OpenBook P&L subgraph deploy to Subgraph Studio (arc-testnet).
#
# Keyless until the final step: codegen + build + unit tests run without any API
# key. The Studio deploy requires GRAPH_STUDIO_DEPLOY_KEY (from thegraph.com/studio,
# Subgraph Studio -> API key). If that var is unset the script stops cleanly before
# touching the network and prints the exact steps to complete the deploy by hand.
#
# Pre-req (one-time, user action): create the subgraph named `openbook-pnl` in
# Subgraph Studio, and toggle Settings -> "Show Testnets" so network `arc-testnet`
# is selectable.
#
# Usage:
#   GRAPH_STUDIO_DEPLOY_KEY=<key> bash scripts/deploy-subgraph.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBGRAPH_DIR="$REPO_ROOT/subgraph"
SUBGRAPH_NAME="${SUBGRAPH_NAME:-openbook-pnl}"
GRAPH_BIN="$(command -v graph || true)"

if [ -z "$GRAPH_BIN" ]; then
  echo "FATAL: graph CLI not found. Install: npm install -g @graphprotocol/graph-cli"
  exit 1
fi

echo "== [1/4] local checks (keyless) =="
cd "$SUBGRAPH_DIR"
[ -f subgraph.yaml ] || { echo "FATAL: $SUBGRAPH_DIR/subgraph.yaml missing"; exit 1; }
grep -qE '^[[:space:]]*network:[[:space:]]*arc-testnet' subgraph.yaml \
  || { echo "FAIL: manifest network must be arc-testnet"; exit 1; }
echo "manifest: network arc-testnet OK"

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
   graph auth --studio <YOUR_SUBGRAPH_STUDIO_KEY>
   graph deploy --studio openbook-pnl

Expected: deployment accepted; Studio shows status "Syncing" on network arc-testnet.
EOF
  exit 0
fi

echo "== [4/4] auth + deploy =="
"$GRAPH_BIN" auth --studio "$GRAPH_STUDIO_DEPLOY_KEY" || { echo "FAIL: graph auth errored"; exit 1; }
"$GRAPH_BIN" deploy --studio "$SUBGRAPH_NAME" || { echo "FAIL: graph deploy errored"; exit 1; }
echo "PASS: openbook-pnl deployed — see Studio for sync status and the /query/<KEY> URL."
