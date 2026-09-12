#!/usr/bin/env bash
# Delegate (or revoke) the right to edit ONE text record on ONE subname to another key,
# then prove the boundary: the delegate can write that key, and every other write reverts
# EACUnauthorizedAccountRoles (0x4b27a133). ENSv2 Enhanced Access Control on the
# openbook.eth PermissionedResolver (Sepolia).
#
#   scripts/ens/delegate.sh alpha.openbook.eth svc.price 0xe09C…08Cc          # grant
#   scripts/ens/delegate.sh alpha.openbook.eth svc.price 0xe09C…08Cc revoke   # revoke
#
# Needs SEPOLIA_PK (the parent owner) and SEPOLIA_RPC in the env or the repo .env.
set -euo pipefail
NAME="${1:?subname, e.g. alpha.openbook.eth}"; KEY="${2:?text key, e.g. svc.price}"; ACCOUNT="${3:?delegate address}"; MODE="${4:-grant}"
RESOLVER="${ENS_RESOLVER:-0x59d9d95e8dEC7745a3A4243dB45458bfE513b0a3}"
if [ -z "${SEPOLIA_PK:-}" ] && [ -f "$(dirname "$0")/../../.env" ]; then set -a; . "$(dirname "$0")/../../.env"; set +a; fi
RPC="${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
: "${SEPOLIA_PK:?SEPOLIA_PK (parent owner key) is required}"
DNS=$(python3 -c "
n='$NAME'; out=b''
for l in n.split('.'): out+=bytes([len(l)])+l.encode()
print('0x'+(out+b'\x00').hex())")
NODE=$(cast namehash "$NAME")
GRANT=true; [ "$MODE" = "revoke" ] && GRANT=false
echo "authorizeTextRoles($NAME, $KEY, $ACCOUNT, $GRANT) from $(cast wallet address --private-key "$SEPOLIA_PK")"
cast send "$RESOLVER" 'authorizeTextRoles(bytes,string,address,bool)' "$DNS" "$KEY" "$ACCOUNT" "$GRANT" --rpc-url "$RPC" --private-key "$SEPOLIA_PK" --json | python3 -c "import sys,json;d=json.load(sys.stdin);print('  tx',d['transactionHash'],'status',d['status'])"
probe() { # $1 node $2 key $3 from
  if out=$(cast call "$RESOLVER" 'setText(bytes32,string,string)' "$1" "$2" 'probe' --from "$3" --rpc-url "$RPC" 2>&1); then echo "allowed"; else echo "$out" | grep -q 4b27a133 && echo "reverts EACUnauthorizedAccountRoles" || echo "reverts (other)"; fi
}
echo "$ACCOUNT writes $KEY on $NAME:            $(probe "$NODE" "$KEY" "$ACCOUNT")"
echo "$ACCOUNT writes svc.sla on $NAME:         $(probe "$NODE" svc.sla "$ACCOUNT")"
echo "0x000000000000000000000000000000000000dEaD writes $KEY on $NAME: $(probe "$NODE" "$KEY" 0x000000000000000000000000000000000000dEaD)"
PARENT=${NAME#*.}; echo "$ACCOUNT writes $KEY on $PARENT:          $(probe "$(cast namehash "$PARENT")" "$KEY" "$ACCOUNT")"
