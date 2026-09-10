import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes32ToIntent, intentToBytes32 } from './intent';

test('an intent id survives the trip through the contract', () => {
  const ids = [
    '00000000-0000-0000-0000-000000000000',
    'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ];

  for (const id of ids) {
    const encoded = intentToBytes32(id);
    assert.match(encoded, /^0x[0-9a-f]{64}$/, id);
    assert.equal(bytes32ToIntent(encoded), id);
  }
});

test('refuses anything that is not a uuid', () => {
  assert.throws(() => intentToBytes32('not-a-uuid'));
  assert.throws(() => intentToBytes32(''));
  assert.throws(() => intentToBytes32('f47ac10b58cc4372a5670e02b2c3d4'));
});

test('refuses a bytes32 that is not an intent this arena issued', () => {
  // Anybody can call the vault with an identifier of their own choosing, and
  // what comes out of here is looked up as a uuid. A value that is not one has
  // to be refused rather than reaching the database as a broken query.
  assert.throws(() => bytes32ToIntent('0xdeadbeef'), /not a bytes32/);
  assert.throws(() => bytes32ToIntent('nonsense'), /not a bytes32/);
  assert.throws(
    () => bytes32ToIntent(`0x${'ab'.repeat(16)}${'cd'.repeat(16)}`),
    /not an intent identifier/,
    'the low sixteen bytes are padding and must be empty',
  );
});

test('a real intent still survives the round trip', () => {
  const uuid = '3f1c2b7a-9d4e-4a61-8c05-77b2e1d90a3f';
  assert.equal(bytes32ToIntent(intentToBytes32(uuid)), uuid);
});
