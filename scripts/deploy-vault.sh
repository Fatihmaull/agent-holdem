#!/usr/bin/env bash
#
# Deploys ChipVault to BNB testnet and wires the address into .env.
#
# Needs TREASURY_PRIVATE_KEY and VAULT_OWNER set, and that account funded with
# tBNB. Deployment is irreversible: the owner address it is given controls every
# redemption payout for the life of the contract.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env. Copy .env.example first."; exit 1; }

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${TREASURY_PRIVATE_KEY:?set TREASURY_PRIVATE_KEY in .env}"
: "${VAULT_OWNER:?set VAULT_OWNER in .env}"
: "${BSC_TESTNET_RPC_URL:?set BSC_TESTNET_RPC_URL in .env}"

BALANCE=$(cast balance "$VAULT_OWNER" --rpc-url "$BSC_TESTNET_RPC_URL")
if [ "$BALANCE" = "0" ]; then
  echo "$VAULT_OWNER has no tBNB. Fund it from a faucet, then run this again."
  exit 1
fi

echo "deploying as $VAULT_OWNER (balance $BALANCE wei)"

cd contracts
forge script script/DeployChipVault.s.sol \
  --rpc-url bsc_testnet \
  --private-key "$TREASURY_PRIVATE_KEY" \
  --broadcast

ADDRESS=$(python3 - <<'PY'
import json
run = json.load(open('broadcast/DeployChipVault.s.sol/97/run-latest.json'))
created = [tx['contractAddress'] for tx in run['transactions'] if tx.get('contractName') == 'ChipVault']
print(created[0])
PY
)

cd ..
python3 - "$ADDRESS" <<'PY'
import re, sys
address = sys.argv[1]
env = open('.env').read()
env = re.sub(r'^NEXT_PUBLIC_CHIP_VAULT_ADDRESS=.*$', f'NEXT_PUBLIC_CHIP_VAULT_ADDRESS={address}', env, flags=re.M)
open('.env', 'w').write(env)
PY

pnpm abi

echo
echo "ChipVault deployed: $ADDRESS"
echo "https://testnet.bscscan.com/address/$ADDRESS"
echo "Written to NEXT_PUBLIC_CHIP_VAULT_ADDRESS. Restart the dev server to pick it up."
