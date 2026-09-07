import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHIP_PACKAGES,
  TABLES,
  chipsToWei,
  formatBnb,
  quoteRedemption,
  weiToChips,
  WEI_PER_CHIP,
} from './economy';

test('the peg holds in both directions', () => {
  assert.equal(chipsToWei(1), WEI_PER_CHIP);
  assert.equal(chipsToWei(50_000), 500_000_000_000_000_000n, '50,000 chips is half a tBNB');
  assert.equal(weiToChips(chipsToWei(12_345)), 12_345);
});

test('a deposit that does not fill a chip buys nothing', () => {
  assert.equal(weiToChips(WEI_PER_CHIP - 1n), 0);
  assert.equal(weiToChips(WEI_PER_CHIP * 3n + 999n), 3);
});

test('rejects amounts that are not whole chips', () => {
  assert.throws(() => chipsToWei(1.5));
  assert.throws(() => chipsToWei(-1));
  assert.throws(() => weiToChips(-1n));
});

test('redemption keeps five percent and pays out the rest', () => {
  const quote = quoteRedemption(10_000);
  assert.equal(quote.grossWei, 100_000_000_000_000_000n, 'ten thousand chips is a tenth of a tBNB');
  assert.equal(quote.feeWei, 5_000_000_000_000_000n);
  assert.equal(quote.netWei, 95_000_000_000_000_000n);
  assert.equal(quote.feeWei + quote.netWei, quote.grossWei, 'the fee and the payout account for everything');
});

test('the fee never rounds in the player\'s favour or loses wei', () => {
  for (const chips of [1, 3, 7, 19, 9_999, 123_457]) {
    const { grossWei, feeWei, netWei } = quoteRedemption(chips);
    assert.equal(feeWei + netWei, grossWei, `chips=${chips}`);
    assert.ok(feeWei >= 0n && netWei >= 0n);
  }
});

test('packages are priced by the same peg the tables use', () => {
  const regular = CHIP_PACKAGES.find((entry) => entry.id === 'regular')!;
  assert.equal(regular.chips, 50_000);
  assert.equal(chipsToWei(regular.chips), 500_000_000_000_000_000n);
  assert.equal(CHIP_PACKAGES.filter((entry) => entry.popular).length, 1, 'exactly one package is marked popular');
});

test('formats tBNB without trailing noise', () => {
  assert.equal(formatBnb(chipsToWei(10_000)), '0.1');
  assert.equal(formatBnb(chipsToWei(50_000)), '0.5');
  assert.equal(formatBnb(chipsToWei(250_000)), '2.5');
  assert.equal(formatBnb(0n), '0');
});

test('every table buy-in is a workable number of big blinds', () => {
  for (const table of TABLES) {
    const blinds = table.buyIn / table.bigBlind;
    assert.ok(blinds >= 50 && blinds <= 200, `${table.id} gives ${blinds} big blinds`);
    assert.equal(table.bigBlind, table.smallBlind * 2);
  }
  assert.equal(new Set(TABLES.map((table) => table.id)).size, TABLES.length, 'table ids are unique');
});
