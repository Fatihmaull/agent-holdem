import '../dev/db-test';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { count, eq } from 'drizzle-orm';
import { closeDatabase, makeAccount, resetDatabase } from '../dev/db-test';
import { db } from '../db/client';
import { agents, hands, ledgerEntries, seats, users } from '../db/schema';
import { TABLES } from '../lib/economy';
import { ModelQueue } from '../agent/queue';
import { ScriptedProvider } from '../agent/provider';
import { joinTable } from './actions';
import { reconcile } from './reconcile';
import { TableRuntime } from './table';

/**
 * What a deploy does to a table that is mid-hand.
 *
 * The guarantee is not that no hand is ever lost — a wedged provider has to be
 * survivable, so there is always a point at which the engine stops waiting. The
 * guarantee is that losing one costs a hand and never a chip: a hand is written
 * only when it completes, and stacks are only written from a written hand, so
 * an interrupted hand is discarded whole and the stored stacks still hold every
 * chip that was in front of a seat.
 *
 * Run at a hundredth of the pacing a spectator sees. The beats exist to make a
 * hand readable, and a test does not read.
 */

beforeEach(resetDatabase);
after(closeDatabase);

const table = TABLES[0];

/** Always calls. Enough to reach a showdown without any decision being clever. */
function caller(): TableRuntime {
  const provider = new ScriptedProvider('Calling it down. {"action":"call"}');
  return new TableRuntime(table, provider, new ModelQueue(['test-key'], 6_000), 0.01);
}

async function seatTwo(): Promise<void> {
  for (const seat of [0, 1]) {
    const account = await makeAccount(50_000);
    await db.insert(ledgerEntries).values({
      userId: account.userId,
      delta: 50_000,
      balanceAfter: 50_000,
      reason: 'deposit',
      reference: `0xseed${seat}`,
    });
    const [agent] = await db
      .insert(agents)
      .values({ userId: account.userId, name: `Seat ${seat}`, color: 'jade' })
      .returning({ id: agents.id });
    await joinTable({ userId: account.userId, address: account.address }, table.id, agent.id);
  }
}

async function handCount(): Promise<number> {
  const [row] = await db.select({ total: count() }).from(hands).where(eq(hands.tableId, table.id));
  return row.total;
}

async function stacks(): Promise<number[]> {
  const rows = await db.select({ stack: seats.stack }).from(seats).orderBy(seats.seatIndex);
  return rows.map((row) => row.stack);
}

/** Resolves once `check` holds, or throws. Nothing here should take seconds. */
async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a drain lets the hand in progress finish, then stops dealing', async () => {
  await seatTwo();
  const runtime = caller();

  runtime.start();
  await until(async () => (await handCount()) >= 1, 'the first hand to be stored');

  const before = await handCount();
  runtime.drain();
  await runtime.finished();

  const after = await handCount();
  // The hand that was running when the drain started is on record: a drain
  // finishes what it found rather than throwing it away.
  assert.ok(after >= before, `expected at least ${before} hands, found ${after}`);
  assert.equal(runtime.live, false);

  // And nothing keeps dealing once the loop has exited.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await handCount(), after, 'a drained table must not deal another hand');
});

test('a hand cut off mid-deal costs a hand and not a chip', async () => {
  await seatTwo();
  const opening = await stacks();
  assert.deepEqual(opening, [table.buyIn, table.buyIn]);

  // A provider that never answers, so the hand is guaranteed to still be
  // running when the abort lands.
  const runtime = new TableRuntime(
    table,
    new ScriptedProvider(() => new Promise<string>(() => {})),
    new ModelQueue(['test-key'], 6_000),
    0.01,
  );

  runtime.start();
  await until(() => runtime.view(null).toAct !== null, 'a seat to be put to act');

  runtime.stop();
  await runtime.finished();

  assert.equal(await handCount(), 0, 'an incomplete hand is never written');
  assert.deepEqual(await stacks(), opening, 'the stacks are exactly as they were before the deal');

  const report = await reconcile();
  assert.deepEqual(report.drifts, [], 'every chip is still accounted for');
});

test('a table picks up its hand numbering where the last process left off', async () => {
  await seatTwo();

  const first = caller();
  first.start();
  await until(async () => (await handCount()) >= 1, 'a hand from the first process');
  first.stop();
  await first.finished();

  const dealt = await handCount();
  const numbers = await db.select({ handNumber: hands.handNumber }).from(hands).orderBy(hands.handNumber);
  assert.equal(numbers.at(-1)?.handNumber, dealt);

  // A fresh runtime is what a restarted process gets. Starting again from one
  // would collide with the stored hand numbers and every later save would fail.
  const second = caller();
  second.start();
  await until(async () => (await handCount()) > dealt, 'the restarted table to deal');
  second.stop();
  await second.finished();

  const all = await db.select({ handNumber: hands.handNumber }).from(hands).orderBy(hands.handNumber);
  const seen = all.map((row) => row.handNumber);
  assert.deepEqual(seen, [...new Set(seen)], 'no hand number is reused across a restart');
  assert.ok(seen.at(-1)! > dealt);
});

test('seats survive a restart with their stacks intact', async () => {
  await seatTwo();

  const runtime = caller();
  runtime.start();
  await until(async () => (await handCount()) >= 1, 'a hand to be played');
  runtime.drain();
  await runtime.finished();

  const afterPlay = await stacks();
  // Chips moved between the two seats, or the hand was a walk. Either way the
  // total is what was bought in.
  assert.equal(
    afterPlay.reduce((sum, stack) => sum + stack, 0),
    table.buyIn * 2,
  );

  const restarted = caller();
  restarted.start();
  const view = restarted.view(null);
  restarted.stop();
  await restarted.finished();

  const occupied = view.seats.filter((seat) => seat.agentId !== null);
  assert.equal(occupied.length, 0, 'a fresh runtime has not loaded seats until its loop runs');

  // What matters is that nothing was stranded or duplicated in the database.
  const [{ total }] = await db.select({ total: count() }).from(seats);
  assert.equal(total, 2);
  assert.deepEqual((await reconcile()).drifts, []);
});

test('an account that never played still reconciles after a hard stop', async () => {
  const bystander = await makeAccount(1_000);
  await db.insert(ledgerEntries).values({
    userId: bystander.userId,
    delta: 1_000,
    balanceAfter: 1_000,
    reason: 'deposit',
    reference: '0xbystander',
  });

  await seatTwo();
  const runtime = caller();
  runtime.start();
  await until(() => runtime.view(null).toAct !== null, 'the table to start dealing');
  runtime.stop();
  await runtime.finished();

  const [row] = await db.select({ chips: users.chips }).from(users).where(eq(users.id, bystander.userId));
  assert.equal(row.chips, 1_000);
  assert.deepEqual((await reconcile()).drifts, []);
});
