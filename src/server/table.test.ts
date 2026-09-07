import { test } from 'node:test';
import assert from 'node:assert/strict';
// Must come before anything that reaches the database module. Nothing here
// runs a query, but that module refuses to load without a connection string.
import '../dev/test-env';
import { startHand } from '../poker/engine';
import { tableById } from '../lib/economy';
import { TableRuntime, tablePalette } from './table';
import type { SeatedAgent } from './store';

const config = tableById('t-03')!;

/** Chairs 1 and 2 occupied, chair 0 vacated: what a seat change leaves behind. */
function sparseTable() {
  const runtime = new TableRuntime(config, {} as never, {} as never);
  const internals = runtime as unknown as Record<string, unknown>;

  const seated: SeatedAgent[] = [
    { seatIndex: 1, agentId: 'alice', name: 'Alice', color: 'red', instructions: '', stack: 2000 },
    { seatIndex: 2, agentId: 'bob', name: 'Bob', color: 'green', instructions: '', stack: 2000 },
  ];

  internals.seated = seated;
  internals.lineup = seated;
  internals.state = startHand({
    handId: 'h',
    seats: seated.map((seat) => ({ agentId: seat.agentId, stack: seat.stack })),
    button: 0,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    seed: 42,
  });

  return { runtime, state: internals.state as ReturnType<typeof startHand> };
}

test('a viewer sees its own cards and nobody else’s when chairs are sparse', () => {
  const { runtime, state } = sparseTable();
  const seats = runtime.view('alice').seats;

  const alice = seats.find((seat) => seat.agentId === 'alice')!;
  const bob = seats.find((seat) => seat.agentId === 'bob')!;

  assert.equal(alice.index, 1, 'Alice is drawn in the chair she is sitting in');
  assert.deepEqual(alice.hole, state.seats[0].hole!.map(nameOf), 'her own cards, not the next seat along');
  assert.equal(bob.hole, null, 'an opponent’s cards stay hidden');
});

test('a sparse table reports each chair the stack it is actually playing', () => {
  const { runtime, state } = sparseTable();
  const seats = runtime.view(null).seats;

  assert.equal(seats[1].stack, state.seats[0].stack, 'chair 1 holds the first engine seat');
  assert.equal(seats[2].stack, state.seats[1].stack, 'chair 2 holds the second');
  assert.notEqual(seats[1].stack, seats[2].stack, 'the blinds are not the same size');
});

test('the dealer button lands on one chair and only one', () => {
  const { runtime } = sparseTable();
  const dealers = runtime.view(null).seats.filter((seat) => seat.isDealer);

  assert.deepEqual(
    dealers.map((seat) => seat.index),
    [1],
    'the button belongs to the chair holding the engine’s button seat',
  );
});

test('two agents wearing one colour are told apart at the table', () => {
  const runtime = new TableRuntime(config, {} as never, {} as never);
  const internals = runtime as unknown as Record<string, unknown>;

  // Past the tenth account, colours are reused. Six of them cannot share a felt.
  internals.seated = [
    { seatIndex: 0, agentId: 'a', name: 'A', color: 'red', instructions: '', stack: 1 },
    { seatIndex: 1, agentId: 'b', name: 'B', color: 'red', instructions: '', stack: 1 },
  ] satisfies SeatedAgent[];
  internals.palette = tablePalette(internals.seated as SeatedAgent[]);

  const colors = runtime.view(null).seats.filter((seat) => seat.agentId).map((seat) => seat.color);
  assert.equal(new Set(colors).size, colors.length, 'no two seated agents draw in the same colour');
});

function nameOf(card: number): string {
  const ranks = '23456789TJQKA';
  return ranks[(card / 4) | 0] + 'cdhs'[card % 4];
}

test('a recall during a hand is held rather than paying out a stale stack', async () => {
  // The seat row still says 2000, because that is what the last stored hand
  // left there. Paying it out now would refund a buy-in the agent is busy
  // losing, and the winner keeps the difference: chips from nowhere.
  const { runtime } = sparseTable();
  (runtime as unknown as Record<string, unknown>).handLive = true;

  const outcome = await runtime.requestLeave('alice', 1);

  assert.equal(outcome, 'queued', 'the cash-out waits for the hand to be settled');
  assert.equal(runtime.isInLiveHand('alice'), true);
});

test('a recall between hands is not held back', () => {
  // Nothing is holding the chips once the hand is stored, so the cash-out takes
  // the immediate path instead of the queue.
  const { runtime } = sparseTable();
  (runtime as unknown as Record<string, unknown>).handLive = false;

  assert.equal(runtime.isInLiveHand('alice'), false);
  assert.equal(runtime.isInLiveHand('bob'), false);
});

test('an agent at another table is never treated as being in this hand', () => {
  const { runtime } = sparseTable();
  (runtime as unknown as Record<string, unknown>).handLive = true;

  assert.equal(runtime.isInLiveHand('alice'), true);
  assert.equal(runtime.isInLiveHand('carol'), false, 'a stranger to this lineup is free to leave');
});
