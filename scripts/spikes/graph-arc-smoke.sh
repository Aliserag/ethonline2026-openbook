#!/usr/bin/env bash
# graph-arc-smoke.sh — OpenBook Task 0, Spike 2: The Graph arc-testnet path.
# Keyless portion: manifest validation (network arc-testnet, USDC address) + graph codegen + graph build.
# Key-gated portion (Studio API key): script prints the exact deploy command; outcome is recorded
# in docs/design/spike-results.md as "awaits key". Plan B if deploy fails: Sepolia shadow ledger.
# Run: bash scripts/spikes/graph-arc-smoke.sh
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPIKE_DIR="$REPO_ROOT/subgraph/spike"

[ -f "$SPIKE_DIR/subgraph.yaml" ] || { echo "FATAL: $SPIKE_DIR/subgraph.yaml missing"; exit 1; }

echo "== [1/5] manifest: network + dataSource =="
NETWORK="$(sed -nE 's/^[[:space:]]*network:[[:space:]]*([a-z0-9-]+).*/\1/p' "$SPIKE_DIR/subgraph.yaml" | head -1)"
echo "network: $NETWORK (expect arc-testnet)"
grep -qE '^[[:space:]]*network:[[:space:]]*arc-testnet' "$SPIKE_DIR/subgraph.yaml" \
  || { echo "FAIL: network must be arc-testnet (Studio deploy target)"; exit 1; }
grep -q '0x3600000000000000000000000000000000000000' "$SPIKE_DIR/subgraph.yaml" \
  || { echo "FAIL: dataSource must be Arc testnet USDC (native ERC-20 view)"; exit 1; }
echo "PASS: manifest uses network arc-testnet + verified Arc USDC 0x3600…0000"

echo "== [2/5] graph CLI =="
GRAPH_BIN="$(command -v graph 2>/dev/null || true)"
if [ -z "$GRAPH_BIN" ]; then
  for cand in "$HOME/.npm-global/bin/graph" "$(npm prefix -g 2>/dev/null)/bin/graph"; do
    [ -x "$cand" ] && GRAPH_BIN="$cand" && break
  done
fi
if [ -z "$GRAPH_BIN" ]; then
  cat <<'EOF'
MISSING: graph CLI not found. Install: npm install -g @graphprotocol/graph-cli
Local codegen/build skipped; the deploy command in section [5/5] still applies.
EOF
  exit 2
fi
echo "graph: $("$GRAPH_BIN" --version)"

echo "== [3/5] ensure @graphprotocol/graph-ts for the build =="
if [ ! -d "$SPIKE_DIR/node_modules/@graphprotocol/graph-ts" ]; then
  echo "(installing @graphprotocol/graph-ts locally in $SPIKE_DIR)"
  (cd "$SPIKE_DIR" && npm install --save-dev @graphprotocol/graph-ts >/dev/null 2>&1) \
    || { echo "FAIL: could not install graph-ts"; exit 1; }
fi
echo "graph-ts: present"

echo "== [4/5] codegen + build (keyless) =="
(cd "$SPIKE_DIR" && "$GRAPH_BIN" codegen && "$GRAPH_BIN" build) \
  || { echo "FAIL: graph codegen/build errored"; exit 1; }
echo "PASS: codegen + build OK — spike subgraph compiles to WASM without any API key"

echo "== [5/5] deploy (awaits Subgraph Studio API key — user action) =="
cat <<'EOF'
From repo root, after adding GRAPH_STUDIO_KEY to .env (from https://thegraph.com/studio):
  cd subgraph/spike
  graph auth --studio <YOUR_SUBGRAPH_STUDIO_API_KEY>
  graph deploy --studio openbook-spike
Expected: deployment accepted, Studio shows status "Syncing" on network arc-testnet
(start block 61291300 keeps the initial sync short).
Decision rule: if deploy fails -> Plan B = Sepolia shadow ledger (MIRROR_TO_SEPOLIA), Task 4.
EOF
echo "PASS(partial): local index pipeline green; deploy outcome awaits user key."
