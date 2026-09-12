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

echo "== [1/4] build"
cd "$APP_DIR"
./node_modules/.bin/tsc --noEmit
BASE_PATH=/ ./node_modules/.bin/vite build >/dev/null
echo "   dist: $(ls dist/assets | wc -l | tr -d ' ') assets"

echo "== [2/4] Vercel (project dist, team pyefi)"
DEPLOY_URL="$(vercel deploy dist --prod --yes 2>/dev/null | grep -oE 'https://dist-[a-z0-9]+-pyefi\.vercel\.app' | head -1)"
[ -n "$DEPLOY_URL" ] || { echo "FAIL: vercel deploy produced no URL"; exit 1; }
vercel alias set "$DEPLOY_URL" ethonline2026-openbook.vercel.app >/dev/null 2>&1
echo "   $DEPLOY_URL → ethonline2026-openbook.vercel.app"

echo "== [3/4] Cloudflare Pages (project openbook → openbook.litai.ca)"
cd /tmp && npx --yes wrangler pages deploy "$APP_DIR/dist" \
  --project-name openbook --branch main --commit-dirty=true 2>&1 | grep -E "Deployment complete|https://" | head -3

echo "== [4/4] verify both lanes serve the same bundle"
cd /tmp
V=$(curl -s -m 20 "https://ethonline2026-openbook.vercel.app/?cb=$(date +%s)" | grep -oE 'assets/index-[^"]+\.js' | head -1)
L=$(curl -s -m 20 "https://openbook.litai.ca/?cb=$(date +%s)" | grep -oE 'assets/index-[^"]+\.js' | head -1)
echo "   vercel: $V"
echo "   litai : $L"
[ "$V" = "$L" ] && echo "PASS: both domains serve the same bundle" || echo "WARN: bundle names differ — check Pages deployment (cdn may lag a minute; re-run the check)"
