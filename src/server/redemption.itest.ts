import '../dev/db-test';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { closeDatabase, makeAccount, resetDatabase } from '../dev/db-test';
import { db } from '../db/client';
import { ledgerEntries, redemptions, users } from '../db/schema';
import { quoteRedemption } from '../lib/economy';
import { ActionError, redeem } from './actions';
import { PayoutUncertain } from './chain';
import { SettlementRefused, refundRedemption, settlePaid, stuckRedemptions } from './settlement';

/**
 * Paying out, which is the half of the peg that had never been exercised.
 *
 * Three outcomes matter and they are not symmetric. A payout that succeeds
 * spends the chips. A payout the chain refused never happened, so the chips go
 * back. A payout that was broadcast and then went quiet may still land, and
 * returning the chips for that one would pay the same redemption twice — so it
 * is the single case that is deliberately left for a person.
 */

beforeEach(resetDatabase);
after(closeDatabase);

const TX = `0x${'c'.repeat(64)}` as `0x${string}`;

async function balanceOf(userId: string): Promise<number> {
  const [row] = await db.select({ chips: users.chips }).from(users).where(eq(users.id, userId));
  return row.chips;
}

async function redemptionRow(userId: string) {
  const [row] = await db.select().from(redemptions).where(eq(redemptions.userId, userId));
  return row;
}

test('a successful payout spends the chips and records the transaction', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  const result = await redeem(session, 4_000, async () => TX);

  assert.equal(result.txHash, TX);
  assert.equal(result.balance, 6_000);
  assert.equal(await balanceOf(account.userId), 6_000);

  const row = await redemptionRow(account.userId);
  assert.equal(row.status, 'sent');
  assert.equal(row.txHash, TX);
  assert.ok(row.sentAt, 'a sent redemption records when it went');
});

test('the fee taken matches the quote the player was shown', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };
  const quote = quoteRedemption(4_000);

  let paidWei: bigint | null = null;
  const result = await redeem(session, 4_000, async (_recipient, netWei) => {
    paidWei = netWei;
    return TX;
  });

  // What the contract is asked to send is what the cashier quoted, to the wei.
  assert.equal(paidWei, quote.netWei);
  assert.equal(result.netWei, quote.netWei.toString());
  assert.equal(result.feeWei, quote.feeWei.toString());
  assert.equal(quote.feeWei + quote.netWei, quote.grossWei);
});

test('a payout the chain refused returns the chips', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  await assert.rejects(
    redeem(session, 4_000, async () => {
      throw new Error('insufficient funds for gas');
    }),
    ActionError,
  );

  assert.equal(await balanceOf(account.userId), 10_000, 'nothing was paid, so nothing may be spent');

  const row = await redemptionRow(account.userId);
  assert.equal(row.status, 'failed');
  assert.equal(row.txHash, null);

  // The debit and the refund are both on the ledger, and the running balance
  // ends where it started. A refund that only edited users.chips would leave
  // the ledger disagreeing with the account for ever.
  const entries = await db
    .select({ delta: ledgerEntries.delta, balanceAfter: ledgerEntries.balanceAfter, reason: ledgerEntries.reason })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, account.userId))
    .orderBy(ledgerEntries.id);

  assert.deepEqual(entries, [
    { delta: -4_000, balanceAfter: 6_000, reason: 'redemption' },
    { delta: 4_000, balanceAfter: 10_000, reason: 'adjustment' },
  ]);
});

test('a payout that was broadcast and went quiet keeps the chips spent', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  await assert.rejects(
    redeem(session, 4_000, async () => {
      throw new PayoutUncertain('timed out waiting for the receipt', TX);
    }),
    ActionError,
  );

  // Returning them here would pay the same redemption twice if the transaction
  // is mined after all. It stays spent, and the row keeps the hash so a person
  // can settle it against the chain.
  assert.equal(await balanceOf(account.userId), 6_000);

  const row = await redemptionRow(account.userId);
  assert.equal(row.status, 'pending');
  assert.equal(row.txHash, TX);
});

test('redeeming more than the balance is refused before anything is sent', async () => {
  const account = await makeAccount(1_000);
  const session = { userId: account.userId, address: account.address };

  let called = false;
  await assert.rejects(
    redeem(session, 5_000, async () => {
      called = true;
      return TX;
    }),
    ActionError,
  );

  assert.equal(called, false, 'the treasury must not be asked to pay chips that do not exist');
  assert.equal(await balanceOf(account.userId), 1_000);
  assert.equal(await redemptionRow(account.userId), undefined);
});

test('two redemptions racing cannot spend the same chips twice', async () => {
  const account = await makeAccount(5_000);
  const session = { userId: account.userId, address: account.address };

  const outcomes = await Promise.allSettled([
    redeem(session, 4_000, async () => TX),
    redeem(session, 4_000, async () => `0x${'d'.repeat(64)}` as `0x${string}`),
  ]);

  const paid = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  assert.equal(paid.length, 1, 'only one of them is covered by the balance');
  assert.equal(await balanceOf(account.userId), 1_000);
});

test('a whole number of chips is required', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  for (const bad of [0, -100, 1.5]) {
    await assert.rejects(redeem(session, bad, async () => TX), ActionError);
  }
  assert.equal(await balanceOf(account.userId), 10_000);
});

/**
 * Settling the ones `redeem` deliberately left open.
 *
 * The vault refuses to pay a redemption id twice, so `redemptionPaid` is the
 * authority here. Everything below is about not acting until it has spoken.
 */

test('a pending redemption the vault has paid is closed without moving chips', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  await assert.rejects(
    redeem(session, 4_000, async () => {
      throw new PayoutUncertain('no receipt', TX);
    }),
    ActionError,
  );

  const closed = await settlePaid(async () => true);

  const row = await redemptionRow(account.userId);
  assert.equal(closed.length, 1);
  assert.equal(row.status, 'sent');
  // The chips were spent when the redemption was raised, and the tBNB did
  // leave the treasury, so closing the row must not give them back.
  assert.equal(await balanceOf(account.userId), 6_000);
});

test('a pending redemption the vault has not paid is left alone', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  await assert.rejects(
    redeem(session, 4_000, async () => {
      throw new PayoutUncertain('no receipt', TX);
    }),
    ActionError,
  );

  const closed = await settlePaid(async () => false);

  assert.equal(closed.length, 0);
  assert.equal((await redemptionRow(account.userId)).status, 'pending');
});

test('a stuck redemption is reported with what the chain says about it', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  await assert.rejects(
    redeem(session, 4_000, async () => {
      throw new PayoutUncertain('no receipt', TX);
    }),
    ActionError,
  );

  const [inFlight] = await stuckRedemptions(async () => false);
  assert.equal(inFlight.verdict, 'in-flight');
  assert.equal(inFlight.txHash, TX);
  assert.equal(inFlight.chips, 4_000);
  assert.equal(inFlight.address, account.address);

  const [paid] = await stuckRedemptions(async () => true);
  assert.equal(paid.verdict, 'paid');
});

test('an unreachable chain leaves a stuck redemption unknown rather than guessing', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  await assert.rejects(
    redeem(session, 4_000, async () => {
      throw new PayoutUncertain('no receipt', TX);
    }),
    ActionError,
  );

  const [row] = await stuckRedemptions(async () => {
    throw new Error('rpc down');
  });
  assert.equal(row.verdict, 'unknown');

  // Nothing is settled on a verdict nobody could reach.
  assert.equal((await settlePaid(async () => { throw new Error('rpc down'); })).length, 0);
});

test('refunding an unpaid redemption returns the chips and closes the row', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  await assert.rejects(
    redeem(session, 4_000, async () => {
      throw new PayoutUncertain('no receipt', TX);
    }),
    ActionError,
  );
  const row = await redemptionRow(account.userId);

  const result = await refundRedemption(row.id, async () => false);

  assert.equal(result.chips, 4_000);
  assert.equal(await balanceOf(account.userId), 10_000);
  assert.equal((await redemptionRow(account.userId)).status, 'failed');
});

test('a redemption the vault has paid can never be refunded', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  await assert.rejects(
    redeem(session, 4_000, async () => {
      throw new PayoutUncertain('no receipt', TX);
    }),
    ActionError,
  );
  const row = await redemptionRow(account.userId);

  // Giving the chips back here would hand the player their tBNB and their
  // chips for the same redemption.
  await assert.rejects(refundRedemption(row.id, async () => true), SettlementRefused);
  assert.equal(await balanceOf(account.userId), 6_000);
  assert.equal((await redemptionRow(account.userId)).status, 'pending');
});

test('refunding twice is refused rather than paying the chips out again', async () => {
  const account = await makeAccount(10_000);
  const session = { userId: account.userId, address: account.address };

  await assert.rejects(
    redeem(session, 4_000, async () => {
      throw new PayoutUncertain('no receipt', TX);
    }),
    ActionError,
  );
  const row = await redemptionRow(account.userId);

  await refundRedemption(row.id, async () => false);
  await assert.rejects(refundRedemption(row.id, async () => false), SettlementRefused);
  assert.equal(await balanceOf(account.userId), 10_000);
});
