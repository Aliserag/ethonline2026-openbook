#!/usr/bin/env bash
# deploy-app.sh — publish app/dist to BOTH judge-facing lanes, atomically:
#   1. Vercel  → ethonline2026-openbook.vercel.app (project `dist`, team pyefi)
#   2. Cloudflare Pages → openbook.litai.ca (project `openbook`, direct upload)
# then verifies both domains serve the same bundle. Run from the repo root:
#   bash scripts/deploy-app.sh
#
# Why both: litai.ca is the canonical URL in the README, the ENS record
# (agent-endpoint[web]) and SUBMISSION.md; the vercel.app alias is the backup
# link. Deploying one without the other is how judge-facing drift happens.
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)/app"

echo "== [1/6] pnl snapshot (build-time fallback for a walled Studio gateway)"
node scripts/fetch-pnl-snapshot.mjs

echo "== [2/6] build"
cd "$APP_DIR"
bun run build:worker >/dev/null
./node_modules/.bin/tsc --noEmit
# secrets never enter the browser bundle: the server routes hold them. The only
# key the page carries is the demo buyer (testnet play money), taken from the
# root .env (DEMO_BUYER_PK / DEMO_BUYER_ADDRESS) so app/.env.local is never the
# source of truth for a deploy.
set +u; set -a; . "$APP_DIR/../.env"; set +a; set -u
[ -n "${CIRCLE_BUYER_WALLET_ADDRESS:-}" ] || { echo "FAIL: CIRCLE_BUYER_WALLET_ADDRESS missing from .env (the page buys through Circle wallets)"; exit 1; }
# the page buys through Circle wallets (server-signed); only their ADDRESSES enter the bundle, no key
VITE_CIRCLE_BUYER_ADDRESS="${CIRCLE_BUYER_WALLET_ADDRESS:-}" VITE_CIRCLE_SELLER_ADDRESS="${CIRCLE_SELLER_WALLET_ADDRESS:-}" \
VITE_DEMO_BUYER_KEY= VITE_DEMO_BUYER_ADDRESS="${DEMO_BUYER_ADDRESS},0xE4AAeE76c53E9F3f16fcA969c31E18F8522B41Ef" \
VITE_GRAPH_GATEWAY_KEY= VITE_ALCHEMY_API_KEY= VITE_LLM_API_KEY= BASE_PATH=/ ./node_modules/.bin/vite build >/dev/null
echo "   dist: $(ls dist/assets | wc -l | tr -d ' ') assets"

echo "== [3/6] Vercel (project dist, team pyefi)"
DEPLOY_URL="$(vercel deploy dist --prod --yes 2>/dev/null | grep -oE 'https://dist-[a-z0-9]+-pyefi\.vercel\.app' | head -1)"
[ -n "$DEPLOY_URL" ] || { echo "FAIL: vercel deploy produced no URL"; exit 1; }
vercel alias set "$DEPLOY_URL" ethonline2026-openbook.vercel.app >/dev/null 2>&1
echo "   $DEPLOY_URL → ethonline2026-openbook.vercel.app"

echo "== [4/6] Cloudflare Pages (project openbook → openbook.litai.ca)"
cd /tmp && npx --yes wrangler pages deploy "$APP_DIR/dist" \
  --project-name openbook --branch main --commit-dirty=true 2>&1 | grep -E "Deployment complete|https://" | head -3

echo "== [5/6] verify both lanes serve the same bundle"
cd /tmp
V=$(curl -s -m 20 "https://ethonline2026-openbook.vercel.app/?cb=$(date +%s)" | grep -oE 'assets/index-[^"]+\.js' | head -1)
echo "   vercel: $V"
# Cloudflare Pages promotes a direct-upload deployment to the domain within
# ~15-60s — poll before warning.
for i in $(seq 1 12); do
  L=$(curl -s -m 20 "https://openbook.litai.ca/?cb=$(date +%s)" | grep -oE 'assets/index-[^"]+\.js' | head -1)
  [ "$L" = "$V" ] && break
  sleep 5
done
echo "   litai : $L"
if [ "$V" = "$L" ]; then
  echo "PASS: both domains serve the same bundle"
else
  echo "WARN: bundle names differ after 60s — check the Pages deployment in the dashboard"
fi

echo "== [6/6] /api/subgraph proxy on both lanes (expect MISS then HIT, HTTP 200)"
sleep 20   # Pages needs a moment to promote the new worker
for host in https://openbook.litai.ca https://ethonline2026-openbook.vercel.app; do
  for i in 1 2; do
    H=$(curl -s -D - -o /dev/null -m 20 -X POST "$host/api/subgraph" -H 'content-type: application/json' -d '{"query":"{ _meta { block { number } } }"}' | tr -d '\r')
    S=$(echo "$H" | awk 'NR==1{print $2}')
    C=$(echo "$H" | awk -F': ' 'tolower($1)=="x-openbook-cache"{print $2}')
    echo "   $host call $i: HTTP ${S:-none} cache ${C:-none}"
  done
done
