#!/usr/bin/env bash
# erc8183-smoke.sh — OpenBook Task 0, Spike 3: full ERC-8183 (Agentic Commerce) lifecycle on Arc testnet.
# Reference deployment (verified on arcscan): proxy 0x0747EEf0706327138c69792bF28Cd525089e4583
#   -> implementation 0xa316fd02827242d537f84730f8a37d0ba5fd351a, paymentToken = native USDC
#   (0x3600000000000000000000000000000000000000, 6 decimals), platformFeeBP/evaluatorFeeBP = 0,
#   hook address(0) whitelisted. Interface per EIP-8183 (draft).
# Roles (single funded key plays all three — legal per spec):
#   client    createJob/fund            (setBudget is called by the PROVIDER in this impl)
#   provider  setBudget/submit
#   evaluator complete/reject           (evaluator may equal client; ours equals the key)
# Run: bash scripts/spikes/erc8183-smoke.sh
#   - wallet unfunded/missing -> documentation mode (exact commands + expected output), exit 3
#   - wallet funded           -> executes happy path (Job A complete), reject path (Job B),
#                                expiry path (Job C claimRefund), verifies states, exit 0/1
set -uo pipefail
SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SPIKE_DIR/../.." && pwd)"
RPC="https://rpc.testnet.arc.io"
USDC="0x3600000000000000000000000000000000000000"                 # native USDC ERC-20 view (6 dec)
ESCROW="0x0747EEf0706327138c69792bF28Cd525089e4583"               # ERC-8183 reference deployment
ZERO="0x0000000000000000000000000000000000000000"
AMOUNT=10000                                                       # 0.01 USDC per escrowed job

get_env() { [ -f "$REPO_ROOT/.env" ] && sed -nE "s/^$1=(.*)$/\1/p" "$REPO_ROOT/.env" | tail -1 | tr -d '"' ; }
PK="$(get_env ARC_TESTNET_PK)"
ADDR="$(get_env ARC_TESTNET_ADDR)"

castc() { cast call "$@" --rpc-url "$RPC"; }
balance_of() { castc "$USDC" "balanceOf(address)(uint256)" "$1" | cut -d' ' -f1; }
job_counter() { castc "$ESCROW" "jobCounter()(uint256)" | cut -d' ' -f1; }
job_status() {
  # getJob returns (id, client, provider, evaluator, description, budget, expiredAt, status, hook);
  # status is the 8th comma-separated field: 0=Open 1=Funded 2=Submitted 3=Completed 4=Rejected 5=Expired
  castc "$ESCROW" "getJob(uint256)((uint256,address,address,address,string,uint256,uint256,uint8,address))" "$1" \
    | awk -F',' '{gsub(/[^0-9]/,"",$8); print $8}'
}
STATUS_NAME=(Open Funded Submitted Completed Rejected Expired)

doc_mode() {
  echo "SKIP: wallet ${ADDR:-<none>} has no funded USDC on Arc testnet — ERC-8183 smoke waits for user funding."
  echo "Funding steps: docs/keys-needed.md (web faucet or Circle drips API)."
  echo ""
  echo "Exact commands once funded (run from repo root; assumes single key = client = provider = evaluator):"
  cat <<'EOF'
  RPC=https://rpc.testnet.arc.io
  ESCROW=0x0747EEf0706327138c69792bF28Cd525089e4583
  USDC=0x3600000000000000000000000000000000000000
  PK=$(sed -nE 's/^ARC_TESTNET_PK=(.*)$/\1/p' .env)
  ADDR=$(cast wallet address --private-key "$PK")

  # ---- JOB A: happy path (create -> setBudget -> approve -> fund -> submit -> complete) ----
  cast send $ESCROW "createJob(address,address,uint256,string,address)" $ADDR $ADDR $(( $(date +%s) + 3600 )) "test" 0x0000000000000000000000000000000000000000 --rpc-url $RPC --private-key $PK --gas-price "$LIVE_GAS"
  JOB=$(cast call $ESCROW "jobCounter()(uint256)" --rpc-url $RPC | cut -d' ' -f1)
  cast send $ESCROW "setBudget(uint256,uint256,bytes)" $JOB 10000 0x --rpc-url $RPC --private-key $PK --gas-price "$LIVE_GAS"     # provider
  cast send $USDC "approve(address,uint256)" $ESCROW 10000 --rpc-url $RPC --private-key $PK --gas-price "$LIVE_GAS"             # approve escrow
  cast send $ESCROW "fund(uint256,bytes)" $JOB 0x --rpc-url $RPC --private-key $PK --gas-price "$LIVE_GAS"                      # client funds
  cast send $ESCROW "submit(uint256,bytes32,bytes)" $JOB 0x80adce4a8a5654de547a0f2333538a0fb9cf51d5a2827dff1bb0c763eb887cc8 0x --rpc-url $RPC --private-key $PK --gas-price "$LIVE_GAS"
  cast send $ESCROW "complete(uint256,bytes32,bytes)" $JOB 0x80adce4a8a5654de547a0f2333538a0fb9cf51d5a2827dff1bb0c763eb887cc8 0x --rpc-url $RPC --private-key $PK --gas-price "$LIVE_GAS"  # evaluator
  # EXPECT: status 3 (Completed); provider balance +10000 (0.01 USDC); events PaymentReleased(10000)

  # ---- JOB B: reject path (create -> setBudget -> fund -> evaluator reject) ----
  # (fresh JOB from jobCounter after the createJob tx)
  # EXPECT: status 4 (Rejected); client refunded; event Refunded(10000)

  # ---- JOB C: expiry path (create expiredAt=now+360 -> setBudget -> fund -> sleep ~370 -> claimRefund) ----
  # NOTE: reference impl reverts expiredAt <= now+5min (ExpiryTooShort), so the shortest wait is ~5-6 min
  # EXPECT: status 5 (Expired); client refunded; event JobExpired + Refunded(10000)

  # All cycles must pass without revert -> Graph/Go decision: nanopayments + PolicyBlocked money shot;
  # NEVER start writing a custom escrow (pre-decided degrade).
EOF
  exit 3
}

exec_mode() {
  [ -n "$PK" ] && [ -n "$ADDR" ] || { echo "FATAL: ARC_TESTNET_PK / ARC_TESTNET_ADDR missing in .env — run scripts/spikes/generate-key.sh"; exit 1; }
  local bal need
  bal="$(balance_of "$ADDR")"
  need=$((AMOUNT * 3 + 100000))   # 3 escrowed jobs + ~0.1 USDC gas buffer (avg tx ~ $0.004)
  if [ -z "$bal" ] || [ "$bal" -eq 0 ] 2>/dev/null || [ "$bal" -lt "$need" ]; then
    echo "FATAL: wallet $ADDR balance $bal < required $need (3x 0.01 escrow + gas buffer). Fund via faucet first."
    exit 3
  fi
  local LIVE_GAS="$(cast gas-price --rpc-url "$RPC")"   # live base fee (floats above the 20 Gwei floor)
  local FLAGS=(--rpc-url "$RPC" --private-key "$PK" --gas-price "$LIVE_GAS")   # Arc 20 Gwei fee floor trap
  local now job st deliv
  deliv="0x80adce4a8a5654de547a0f2333538a0fb9cf51d5a2827dff1bb0c763eb887cc8"   # keccak("openbook-spike-deliverable-1")

  echo "== JOB A: happy path (expect Completed=3) =="
  now="$(date +%s)"
  cast send "$ESCROW" "createJob(address,address,uint256,string,address)" "$ADDR" "$ADDR" $((now + 3600)) "test" "$ZERO" "${FLAGS[@]}" || { echo "FAIL: createJob (A)"; exit 1; }
  job="$(job_counter)"
  cast send "$ESCROW" "setBudget(uint256,uint256,bytes)" "$job" "$AMOUNT" 0x "${FLAGS[@]}" || { echo "FAIL: setBudget (A)"; exit 1; }
  cast send "$USDC" "approve(address,uint256)" "$ESCROW" "$AMOUNT" "${FLAGS[@]}" || { echo "FAIL: approve (A)"; exit 1; }
  cast send "$ESCROW" "fund(uint256,bytes)" "$job" 0x "${FLAGS[@]}" || { echo "FAIL: fund (A)"; exit 1; }
  cast send "$ESCROW" "submit(uint256,bytes32,bytes)" "$job" "$deliv" 0x "${FLAGS[@]}" || { echo "FAIL: submit (A)"; exit 1; }
  cast send "$ESCROW" "complete(uint256,bytes32,bytes)" "$job" "$deliv" 0x "${FLAGS[@]}" || { echo "FAIL: complete (A)"; exit 1; }
  st="$(job_status "$job")"
  echo "JOB A status=$st (${STATUS_NAME[$st]}) — expect 3 (Completed)"
  [ "$st" = "3" ] || { echo "FAIL: Job A not Completed"; exit 1; }

  echo "== JOB B: reject path (expect Rejected=4) =="
  now="$(date +%s)"
  cast send "$ESCROW" "createJob(address,address,uint256,string,address)" "$ADDR" "$ADDR" $((now + 3600)) "reject-test" "$ZERO" "${FLAGS[@]}" || { echo "FAIL: createJob (B)"; exit 1; }
  job="$(job_counter)"
  cast send "$ESCROW" "setBudget(uint256,uint256,bytes)" "$job" "$AMOUNT" 0x "${FLAGS[@]}" || { echo "FAIL: setBudget (B)"; exit 1; }
  cast send "$USDC" "approve(address,uint256)" "$ESCROW" "$AMOUNT" "${FLAGS[@]}" || { echo "FAIL: approve (B)"; exit 1; }
  cast send "$ESCROW" "fund(uint256,bytes)" "$job" 0x "${FLAGS[@]}" || { echo "FAIL: fund (B)"; exit 1; }
  cast send "$ESCROW" "reject(uint256,bytes32,bytes)" "$job" "$deliv" 0x "${FLAGS[@]}" || { echo "FAIL: reject (B)"; exit 1; }
  st="$(job_status "$job")"
  echo "JOB B status=$st (${STATUS_NAME[$st]}) — expect 4 (Rejected) + client refund"
  [ "$st" = "4" ] || { echo "FAIL: Job B not Rejected"; exit 1; }

  echo "== JOB C: expiry path (expect Expired=5) — waiting ~6 min =="
  now="$(date +%s)"
  cast send "$ESCROW" "createJob(address,address,uint256,string,address)" "$ADDR" "$ADDR" $((now + 360)) "expiry-test" "$ZERO" "${FLAGS[@]}" || { echo "FAIL: createJob (C)"; exit 1; }
  job="$(job_counter)"
  cast send "$ESCROW" "setBudget(uint256,uint256,bytes)" "$job" "$AMOUNT" 0x "${FLAGS[@]}" || { echo "FAIL: setBudget (C)"; exit 1; }
  cast send "$USDC" "approve(address,uint256)" "$ESCROW" "$AMOUNT" "${FLAGS[@]}" || { echo "FAIL: approve (C)"; exit 1; }
  cast send "$ESCROW" "fund(uint256,bytes)" "$job" 0x "${FLAGS[@]}" || { echo "FAIL: fund (C)"; exit 1; }
  echo "(sleeping 370s so onchain expiredAt passes — reference impl enforces expiredAt > now+5min)"
  sleep 370
  cast send "$ESCROW" "claimRefund(uint256)" "$job" "${FLAGS[@]}" || { echo "FAIL: claimRefund (C)"; exit 1; }
  st="$(job_status "$job")"
  echo "JOB C status=$st (${STATUS_NAME[$st]}) — expect 5 (Expired) + client refund"
  [ "$st" = "5" ] || { echo "FAIL: Job C not Expired"; exit 1; }

  echo "PASS: all three ERC-8183 cycles (complete / reject / expire-refund) ran without revert."
  echo "Decision: reference contract behavior confirmed -> nanopayments + PolicyBlocked money shot; no custom escrow."
}

# funding detection: any USDC? (zero/empty -> documentation mode)
BAL="$( { [ -n "$ADDR" ] && balance_of "$ADDR" 2>/dev/null; } || true )"
if [ -z "$PK" ] || [ -z "$BAL" ] || [ "$BAL" -eq 0 ] 2>/dev/null; then
  doc_mode
else
  exec_mode
fi
