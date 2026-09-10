import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAINS, addressUrl, chainById, chainByKey, envPrefix, txUrl } from './chains';

test('every chain is uniquely identified by both its key and its id', () => {
  assert.equal(new Set(CHAINS.map((chain) => chain.key)).size, CHAINS.length, 'keys are unique');
  assert.equal(new Set(CHAINS.map((chain) => chain.id)).size, CHAINS.length, 'chain ids are unique');

  for (const chain of CHAINS) {
    assert.equal(chainByKey(chain.key), chain);
    assert.equal(chainById(chain.id), chain);
  }
});

test('the testnets this deployment was built for are present', () => {
  assert.equal(chainByKey('bnb-testnet')?.id, 97);
  assert.equal(chainByKey('arbitrum-sepolia')?.id, 421614);
  assert.equal(chainByKey('monad-testnet')?.id, 10143);
});

test('nothing in the registry is missing what a wallet needs to add it', () => {
  for (const chain of CHAINS) {
    assert.ok(chain.defaultRpcUrl.startsWith('https://'), `${chain.key} has an https endpoint`);
    assert.ok(chain.explorer.url.startsWith('https://'), `${chain.key} has an explorer`);
    assert.ok(!chain.explorer.url.endsWith('/'), `${chain.key} explorer has no trailing slash`);
    assert.equal(chain.nativeCurrency.decimals, 18, `${chain.key} is an 18-decimal chain`);
    assert.ok(chain.nativeCurrency.symbol.length > 0);
  }
});

// Mainnet money is not the point of this build, and a mainnet key in
// TREASURY_PRIVATE_KEY would be spent by the same code path as a testnet one.
test('the registry offers testnets only', () => {
  for (const chain of CHAINS) assert.equal(chain.testnet, true, `${chain.key} is a testnet`);
});

test('environment variable names are derived from the key', () => {
  assert.equal(envPrefix('bnb-testnet'), 'BNB_TESTNET');
  assert.equal(envPrefix('monad-testnet'), 'MONAD_TESTNET');
  assert.equal(envPrefix('arbitrum-sepolia'), 'ARBITRUM_SEPOLIA');
});

test('explorer links are built from the chain rather than hard-coded', () => {
  const bnb = chainByKey('bnb-testnet')!;
  assert.equal(txUrl(bnb, '0xabc'), 'https://testnet.bscscan.com/tx/0xabc');
  assert.equal(addressUrl(bnb, '0xdef'), 'https://testnet.bscscan.com/address/0xdef');
});
