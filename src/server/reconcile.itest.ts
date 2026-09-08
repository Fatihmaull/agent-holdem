import '../dev/db-test';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql as raw } from 'drizzle-orm';
import { closeDatabase, makeAccount, resetDatabase } from '../dev/db-test';
import { db } from '../db/client';
import { agents, ledgerEntries, seats, users } from '../db/schema';
import { TABLES } from '../lib/economy';
import { joinTable } from './actions';
import { reconcile } from './reconcile';

/**
 * The arithmetic that proves nobody invented a chip.
 *
 * Half of these deliberately break something. A reconciliation that only ever
 * runs against healthy data tells you nothing: what matters is that it notices,
 * and that it does not cry wolf over a table where agents are simply winning
 * pots off each other.
 */

beforeEach(resetDatabase);
after(closeDatabase);

const table = TABLES[0];

async function seat(userId: string, tableId: string): Promise<string> {
  const [agent] = await db
    .insert(agents)
    .values({ userId, name: 'Tester', color: 'jade' })
    .returning({ id: agents.id });
  const account = await db.select({ address: users.address }).from(users).where(eq(users.id, userId));
  await joinTable({ userId, address: account[0].address }, tableId, agent.id);
  return agent.id;
}

test('an empty system reconciles', async () => {
  const report = await reconcile();
  assert.deepEqual(report.drifts, []);
  assert.equal(report.balances, 0);
  assert.equal(report.stacks, 0);
  assert.equal(report.ledger, 0);
});

test('a deposit and a buy-in reconcile', async () => {
  const account = await makeAccount(0);
  await db.insert(ledgerEntries).values({
    userId: account.userId,
    delta: 50_000,
    balanceAfter: 50_000,
    reason: 'deposit',
    reference: '0xdeadbeef',
  });
  await db.update(users).set({ chips: 50_000 }).where(eq(users.id, account.userId));

  await seat(account.userId, table.id);

  const report = await reconcile();
  assert.deepEqual(report.drifts, []);
  assert.equal(report.balances, 50_000 - table.buyIn);
  assert.equal(report.stacks, table.buyIn);
  // The buy-in left the account, so the ledger is lower by exactly what is now
  // sitting on the table. Nothing was destroyed: it is all still in circulation.
  assert.equal(report.ledger, 50_000 - table.buyIn);
  assert.equal(report.inCirculation, 50_000);
});

test('agents winning chips off each other at a table is not drift', async () => {
  const one = await makeAccount(50_000);
  const two = await makeAccount(50_000);
  for (const account of [one, two]) {
    await db.insert(ledgerEntries).values({
      userId: account.userId,
      delta: 50_000,
      balanceAfter: 50_000,
      reason: 'deposit',
      reference: '0xdeadbeef',
    });
  }
  await seat(one.userId, table.id);
  await seat(two.userId, table.id);

  // One agent takes a third of the other's stack, which is exactly what a hand
  // does and writes no ledger entry, because nothing left either account.
  const swing = Math.floor(table.buyIn / 3);
  await db
    .update(seats)
    .set({ stack: raw`${seats.stack} + ${swing}` })
    .where(eq(seats.seatIndex, 0));
  await db
    .update(seats)
    .set({ stack: raw`${seats.stack} - ${swing}` })
    .where(eq(seats.seatIndex, 1));

  const report = await reconcile();
  assert.deepEqual(report.drifts, [], 'chips moving inside a table must not read as drift');
});

test('a balance edited behind the ledger is caught', async () => {
  const account = await makeAccount(0);
  await db.insert(ledgerEntries).values({
    userId: account.userId,
    delta: 10_000,
    balanceAfter: 10_000,
    reason: 'deposit',
    reference: '0xdeadbeef',
  });
  await db.update(users).set({ chips: 10_000 }).where(eq(users.id, account.userId));
  assert.deepEqual((await reconcile()).drifts, []);

  // The failure this whole script exists for: chips appearing without a
  // ledger entry to say where they came from.
  await db.update(users).set({ chips: 999_999 }).where(eq(users.id, account.userId));

  const report = await reconcile();
  assert.ok(report.drifts.length > 0);
  assert.ok(
    report.drifts.some((drift) => drift.scope === 'system'),
    'chips that exist nowhere in the ledger break system conservation',
  );
  assert.ok(
    report.drifts.some((drift) => drift.scope.startsWith('account ') && drift.actual === 999_999),
    'and the account they landed in is named',
  );
});

test('a ledger entry with the wrong running balance is caught', async () => {
  const account = await makeAccount(10_000);
  await db.insert(ledgerEntries).values({
    userId: account.userId,
    delta: 10_000,
    // Deltas add up, but the running total does not match the balance. This is
    // what a half-applied migration or a hand-written fix looks like.
    balanceAfter: 7_000,
    reason: 'deposit',
    reference: '0xdeadbeef',
  });

  const drifts = (await reconcile()).drifts;
  assert.ok(
    drifts.some((drift) => drift.detail.includes('most recent ledger entry')),
    'the running total is checked, not only the sum of deltas',
  );
});

test('a stack at a table nobody bought into is caught', async () => {
  const account = await makeAccount(0);
  const [agent] = await db
    .insert(agents)
    .values({ userId: account.userId, name: 'Ghost', color: 'jade' })
    .returning({ id: agents.id });

  // A seat written without the buy-in that pays for it: chips from nowhere.
  await db.insert(seats).values({ tableId: table.id, seatIndex: 0, agentId: agent.id, stack: 2_000 });

  const drifts = (await reconcile()).drifts;
  assert.ok(drifts.some((drift) => drift.scope === `table ${table.id}`));
  assert.ok(drifts.some((drift) => drift.scope === 'system'));
});

test('a winner and a loser both standing up still reconciles', async () => {
  const one = await makeAccount(0);
  const two = await makeAccount(0);
  for (const account of [one, two]) {
    await db.insert(ledgerEntries).values({
      userId: account.userId,
      delta: 50_000,
      balanceAfter: 50_000,
      reason: 'deposit',
      reference: '0xdeadbeef',
    });
    await db.update(users).set({ chips: 50_000 }).where(eq(users.id, account.userId));
  }

  await seat(one.userId, table.id);
  await seat(two.userId, table.id);

  // A hand: 700 crosses the table. Nothing is created and nothing destroyed.
  await db.update(seats).set({ stack: raw`${seats.stack} + 700` }).where(eq(seats.seatIndex, 0));
  await db.update(seats).set({ stack: raw`${seats.stack} - 700` }).where(eq(seats.seatIndex, 1));

  const { leaveSeat } = await import('./store');
  await leaveSeat(table.id, 0);
  await leaveSeat(table.id, 1);

  const report = await reconcile();
  assert.deepEqual(report.drifts, []);
  assert.equal(report.stacks, 0);
  assert.equal(report.balances, 100_000, 'every chip came home, just not to the account it left');
  assert.equal(report.inCirculation, 100_000);
  assert.equal(report.issued, 100_000);
});

test('chips that appeared at a table without a hand to explain them are caught', async () => {
  const account = await makeAccount(0);
  await db.insert(ledgerEntries).values({
    userId: account.userId,
    delta: 50_000,
    balanceAfter: 50_000,
    reason: 'deposit',
    reference: '0xdeadbeef',
  });
  await db.update(users).set({ chips: 50_000 }).where(eq(users.id, account.userId));
  await seat(account.userId, table.id);

  // One seat gains chips with no opposing seat losing them: a hand that paid
  // out more than was staked, which is the engine bug this would catch.
  await db.update(seats).set({ stack: raw`${seats.stack} + 700` }).where(eq(seats.tableId, table.id));

  const drifts = (await reconcile()).drifts;
  assert.ok(drifts.some((drift) => drift.scope === `table ${table.id}`));
  assert.ok(drifts.some((drift) => drift.scope === 'system'));
});
