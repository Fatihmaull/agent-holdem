#!/usr/bin/env bash
#
# Deploys ChipVault to one chain and wires its address into .env.
#
#   pnpm deploy:vault bnb-testnet
#   pnpm deploy:vault monad-testnet
#
# The chain is named by its key in src/lib/chains.ts, which is also where its
# id, RPC endpoint and explorer come from, so this script has no network of its
# own baked in. Needs TREASURY_PRIVATE_KEY and VAULT_OWNER set, and that account
# funded on the chain being deployed to. Deployment is irreversible: the owner
# address it is given controls every redemption payout for the life of the
# contract, and each chain gets its own vault holding its own float.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env. Copy .env.example first."; exit 1; }

set -a
# shellcheck disable=SC1091
. ./.env
set +a

CHAIN_KEY="${1:-${DEFAULT_CHAIN:-}}"
if [ -z "$CHAIN_KEY" ]; then
  echo "usage: pnpm deploy:vault <chain-key>"
  echo "keys come from src/lib/chains.ts:"
  pnpm exec tsx -e "import { CHAINS } from './src/lib/chains'; for (const c of CHAINS) console.log('  ' + c.key + '  ' + c.name);"
  exit 1
fi

# One source of truth for what a chain is. The script reads the registry rather
# than carrying a second copy of the id and the explorer.
eval "$(pnpm exec tsx -e "
import { chainByKey, envPrefix } from './src/lib/chains';
const chain = chainByKey(process.argv[1]);
if (!chain) {
  console.log('echo \"no such chain: ' + process.argv[1] + '\"; exit 1');
} else {
  console.log('CHAIN_ID=' + chain.id);
  console.log('CHAIN_NAME=' + JSON.stringify(chain.name));
  console.log('CHAIN_EXPLORER=' + chain.explorer.url);
  console.log('CHAIN_FAUCET=' + chain.faucetUrl);
  console.log('CHAIN_SYMBOL=' + chain.nativeCurrency.symbol);
  console.log('CHAIN_PREFIX=' + envPrefix(chain.key));
  console.log('DEFAULT_RPC_URL=' + chain.defaultRpcUrl);
}
" "$CHAIN_KEY")"

: "${TREASURY_PRIVATE_KEY:?set TREASURY_PRIVATE_KEY in .env}"
: "${VAULT_OWNER:?set VAULT_OWNER in .env}"

RPC_URL="$(eval "echo \"\${${CHAIN_PREFIX}_RPC_URL:-}\"")"
[ -n "$RPC_URL" ] || RPC_URL="$DEFAULT_RPC_URL"
export "${CHAIN_PREFIX}_RPC_URL=$RPC_URL"

BALANCE=$(cast balance "$VAULT_OWNER" --rpc-url "$RPC_URL")
if [ "$BALANCE" = "0" ]; then
  echo "$VAULT_OWNER has no $CHAIN_SYMBOL on $CHAIN_NAME. Fund it at $CHAIN_FAUCET, then run this again."
  exit 1
fi

echo "deploying to $CHAIN_NAME as $VAULT_OWNER (balance $BALANCE wei)"

cd contracts
forge script script/DeployChipVault.s.sol \
  --rpc-url "$RPC_URL" \
  --private-key "$TREASURY_PRIVATE_KEY" \
  --broadcast

ADDRESS=$(python3 - "$CHAIN_ID" <<'PY'
import json, sys
run = json.load(open(f'broadcast/DeployChipVault.s.sol/{sys.argv[1]}/run-latest.json'))
created = [tx['contractAddress'] for tx in run['transactions'] if tx.get('contractName') == 'ChipVault']
print(created[0])
PY
)

cd ..
# The variable is named after the chain, so several vaults coexist in one .env.
python3 - "$ADDRESS" "${CHAIN_PREFIX}_VAULT_ADDRESS" <<'PY'
import re, sys
address, key = sys.argv[1], sys.argv[2]
env = open('.env').read()
line = f'{key}={address}'
if re.search(rf'^{re.escape(key)}=.*$', env, flags=re.M):
    env = re.sub(rf'^{re.escape(key)}=.*$', line, env, flags=re.M)
else:
    env = env.rstrip('\n') + f'\n{line}\n'
open('.env', 'w').write(env)
PY

pnpm abi

echo
echo "ChipVault deployed to $CHAIN_NAME: $ADDRESS"
echo "$CHAIN_EXPLORER/address/$ADDRESS"
echo "Written to ${CHAIN_PREFIX}_VAULT_ADDRESS. Restart the dev server to pick it up."
