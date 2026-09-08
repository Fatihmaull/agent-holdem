import '../dev/db-test';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, count, eq } from 'drizzle-orm';
import { closeDatabase, makeAccount, resetDatabase } from '../dev/db-test';
import { db } from '../db/client';
import { agents, ledgerEntries, seats, users } from '../db/schema';
import { TABLES, tableById } from '../lib/economy';
import type { Session } from './auth';
import { ActionError, createAgent, deployAgents, joinTable, leaveTable } from './actions';
import { reconcile } from './reconcile';

/**
 * Taking and leaving seats, against a real database.
 *
 * The rule with money behind it is that an agent holds one seat, so its stack
 * is never split; the rule with fairness behind it is that a wallet holds one
 * seat per table, so nobody plays both sides of a hand. Neither is enforceable
 * without the database — both are races, and a check that two concurrent
 * requests can both pass is not a rule.
 */

beforeEach(resetDatabase);
after(closeDatabase);

const headsUp = TABLES[0];
const sixMax = TABLES[4];

async function account(chips: number): Promise<Session> {
  const created = await makeAccount(chips);
  await db.insert(ledgerEntries).values({
    userId: created.userId,
    delta: chips,
    balanceAfter: chips,
    reason: 'deposit',
    reference: `0x${created.userId.replace(/-/g, '').slice(0, 40)}`,
  });
  return { userId: created.userId, address: created.address };
}

async function agentFor(session: Session, instructions = ''): Promise<string> {
  const { id } = await createAgent(session, { name: `Agent ${Date.now() % 10_000}`, instructions });
  return id;
}

async function balanceOf(session: Session): Promise<number> {
  const [row] = await db.select({ chips: users.chips }).from(users).where(eq(users.id, session.userId));
  return row.chips;
}

async function seatCount(tableId: string): Promise<number> {
  const [row] = await db.select({ total: count() }).from(seats).where(eq(seats.tableId, tableId));
  return row.total;
}

test('taking a seat moves the buy-in from the balance onto the table', async () => {
  const player = await account(50_000);
  const agentId = await agentFor(player);

  const { seatIndex } = await joinTable(player, headsUp.id, agentId);

  assert.equal(seatIndex, 0);
  assert.equal(await balanceOf(player), 50_000 - headsUp.buyIn);

  const [seat] = await db.select().from(seats).where(eq(seats.agentId, agentId));
  assert.equal(seat.stack, headsUp.buyIn);
  assert.deepEqual((await reconcile()).drifts, []);
});

test('a wallet cannot put two of its agents at one table', async () => {
  const player = await account(50_000);
  const first = await agentFor(player);
  const second = await agentFor(player);

  await joinTable(player, sixMax.id, first);

  // Two of your own agents in one hand is playing both sides of it, and the
  // spectator feed hides hole cards per agent rather than per account.
  await assert.rejects(joinTable(player, sixMax.id, second), ActionError);
  assert.equal(await seatCount(sixMax.id), 1);
});

test('two joins racing cannot get a wallet two seats at one table', async () => {
  const player = await account(50_000);
  const first = await agentFor(player);
  const second = await agentFor(player);

  // Without the row lock both reads see "no seat of mine here", pick different
  // open chairs, and both succeed.
  const outcomes = await Promise.allSettled([
    joinTable(player, sixMax.id, first),
    joinTable(player, sixMax.id, second),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(await seatCount(sixMax.id), 1);
  assert.equal(await balanceOf(player), 50_000 - sixMax.buyIn, 'only one buy-in was taken');
});

test('an agent already sitting somewhere cannot take a second seat', async () => {
  const player = await account(50_000);
  const agentId = await agentFor(player);

  await joinTable(player, headsUp.id, agentId);
  // One seat per agent is what keeps a stack whole.
  await assert.rejects(joinTable(player, TABLES[2].id, agentId), ActionError);
});

test('two different wallets share a table happily', async () => {
  const one = await account(50_000);
  const two = await account(50_000);

  await joinTable(one, headsUp.id, await agentFor(one));
  await joinTable(two, headsUp.id, await agentFor(two));

  assert.equal(await seatCount(headsUp.id), 2);
  assert.deepEqual((await reconcile()).drifts, []);
});

test('a full table is refused and costs nothing', async () => {
  const players = await Promise.all([account(50_000), account(50_000), account(50_000)]);
  await joinTable(players[0], headsUp.id, await agentFor(players[0]));
  await joinTable(players[1], headsUp.id, await agentFor(players[1]));

  const latecomer = players[2];
  const agentId = await agentFor(latecomer);
  await assert.rejects(joinTable(latecomer, headsUp.id, agentId), ActionError);

  assert.equal(await balanceOf(latecomer), 50_000, 'a refused seat takes no buy-in');
});

test('a buy-in nobody can afford is refused before a chair is claimed', async () => {
  const player = await account(100);
  const agentId = await agentFor(player);

  await assert.rejects(joinTable(player, headsUp.id, agentId), ActionError);
  assert.equal(await balanceOf(player), 100);
  assert.equal(await seatCount(headsUp.id), 0);
});

test('the word budget gates the seat, not the writing', async () => {
  const player = await account(50_000);
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const agentId = await agentFor(player, long);

  // Forty words is fine at a fifty-word table and not at a ten-word one.
  await assert.rejects(joinTable(player, headsUp.id, agentId), /10/);
  await joinTable(player, TABLES[1].id, agentId);
  assert.equal(await seatCount(TABLES[1].id), 1);
});

test('an agent of somebody else’s is not yours to seat', async () => {
  const owner = await account(50_000);
  const stranger = await account(50_000);
  const agentId = await agentFor(owner);

  await assert.rejects(joinTable(stranger, headsUp.id, agentId), ActionError);
  assert.equal(await seatCount(headsUp.id), 0);
});

test('leaving returns the stack the agent is actually holding', async () => {
  const winner = await account(50_000);
  const loser = await account(50_000);
  const winnerAgent = await agentFor(winner);
  const loserAgent = await agentFor(loser);
  await joinTable(winner, headsUp.id, winnerAgent);
  await joinTable(loser, headsUp.id, loserAgent);

  // A hand: 640 crosses the table. Not minted — taken off the other seat,
  // which is the only way a stack ever grows.
  await db.update(seats).set({ stack: headsUp.buyIn + 640 }).where(eq(seats.agentId, winnerAgent));
  await db.update(seats).set({ stack: headsUp.buyIn - 640 }).where(eq(seats.agentId, loserAgent));

  const outcome = await leaveTable(winner, winnerAgent);

  assert.equal(outcome.pending, false);
  assert.equal(await balanceOf(winner), 50_000 + 640, 'the winnings come home, not just the buy-in');
  assert.equal(await seatCount(headsUp.id), 1);
  assert.deepEqual((await reconcile()).drifts, []);

  await leaveTable(loser, loserAgent);
  assert.equal(await balanceOf(loser), 50_000 - 640);
  assert.deepEqual((await reconcile()).drifts, []);
});

test('leaving a table you are not at is not an error', async () => {
  const player = await account(50_000);
  const agentId = await agentFor(player);

  const outcome = await leaveTable(player, agentId);
  assert.equal(outcome.pending, false);
  assert.equal(await balanceOf(player), 50_000);
});

test('one piece of writing goes down at several tables at once', async () => {
  const player = await account(200_000);
  const wanted = [TABLES[0].id, TABLES[2].id];

  const result = await deployAgents(player, {
    name: 'Ranger',
    instructions: 'Fold weak hands. Punish limps.',
    tableIds: wanted,
  });

  assert.equal(result.seated.length, 2);
  assert.deepEqual(result.skipped, []);

  // Each table gets its own agent, because an agent holds one seat and one
  // undivided stack. They share the text, not the chips or the record.
  const seated = await db.select().from(seats);
  assert.equal(seated.length, 2);
  assert.equal(new Set(seated.map((seat) => seat.agentId)).size, 2);

  const spent = wanted.map((id) => tableById(id)!.buyIn).reduce((a, b) => a + b, 0);
  assert.equal(await balanceOf(player), 200_000 - spent);
  assert.deepEqual((await reconcile()).drifts, []);
});

test('a table that cannot be joined is reported and the rest still go down', async () => {
  const blocker = await account(50_000);
  const other = await account(50_000);
  await joinTable(blocker, headsUp.id, await agentFor(blocker));
  await joinTable(other, headsUp.id, await agentFor(other));

  const player = await account(200_000);
  const result = await deployAgents(player, {
    name: 'Ranger',
    instructions: 'Fold weak hands.',
    tableIds: [headsUp.id, TABLES[2].id],
  });

  // A batch is a convenience, not an all-or-nothing bet: an owner would rather
  // have one of two seats than none.
  assert.equal(result.seated.length, 1);
  assert.equal(result.seated[0].tableId, TABLES[2].id);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].tableId, headsUp.id);
  assert.match(result.skipped[0].reason, /full/i);
});

test('a deploy that can seat nowhere fails rather than reporting a quiet success', async () => {
  const player = await account(100);

  await assert.rejects(
    deployAgents(player, { name: 'Ranger', instructions: 'Fold.', tableIds: [headsUp.id] }),
    ActionError,
  );
  assert.equal(await seatCount(headsUp.id), 0);
});

test('a deploy skips the tables whose budget the writing does not fit', async () => {
  const player = await account(200_000);
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');

  const result = await deployAgents(player, {
    name: 'Essayist',
    instructions: long,
    // Ten words, then fifty. Only the second can carry forty.
    tableIds: [TABLES[0].id, TABLES[1].id],
  });

  assert.deepEqual(
    result.seated.map((seat) => seat.tableId),
    [TABLES[1].id],
  );
  assert.equal(result.skipped[0].tableId, TABLES[0].id);
  assert.match(result.skipped[0].reason, /10/);
});

test('an account cannot keep more agents than there are tables', async () => {
  const player = await account(500_000);

  for (let i = 0; i < TABLES.length; i++) await agentFor(player);
  // A seventh could never be seated anywhere, so it is refused rather than
  // created and left homeless.
  await assert.rejects(agentFor(player), ActionError);

  const [row] = await db.select({ total: count() }).from(agents).where(eq(agents.userId, player.userId));
  assert.equal(row.total, TABLES.length);
});

test('every seat an account holds is at a different table', async () => {
  const player = await account(500_000);

  const result = await deployAgents(player, {
    name: 'Spread',
    instructions: 'Play straightforwardly.',
    tableIds: TABLES.map((table) => table.id),
  });

  const tables = result.seated.map((seat) => seat.tableId);
  assert.deepEqual(tables, [...new Set(tables)]);

  const mine = await db
    .select({ tableId: seats.tableId })
    .from(seats)
    .innerJoin(agents, eq(agents.id, seats.agentId))
    .where(and(eq(agents.userId, player.userId)));
  assert.equal(new Set(mine.map((row) => row.tableId)).size, mine.length);
  assert.deepEqual((await reconcile()).drifts, []);
});
