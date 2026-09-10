import { test } from 'node:test';
import assert from 'node:assert/strict';
// Must come before anything that reaches the database module. Nothing here
// runs a query, but that module refuses to load without a connection string.
import '../dev/test-env';
import { startHand } from '../poker/engine';
import { MATCH } from '../lib/economy';
import { MatchRuntime, tablePalette } from './table';
import type { SeatedAgent } from './store';

const config = MATCH;

/** Chairs 1 and 2 occupied, chair 0 vacated: what a seat change leaves behind. */
function sparseTable() {
  const runtime = new MatchRuntime('m-1', config, {} as never, {} as never, () => {});
  const internals = runtime as unknown as Record<string, unknown>;

  const seated: SeatedAgent[] = [
    { seatIndex: 1, agentId: 'alice', name: 'Alice', color: 'red', instructions: '', stack: 2000, notesEnabled: true, bustedAtHand: null },
    { seatIndex: 2, agentId: 'bob', name: 'Bob', color: 'green', instructions: '', stack: 2000, notesEnabled: true, bustedAtHand: null },
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
  const runtime = new MatchRuntime('m-1', config, {} as never, {} as never, () => {});
  const internals = runtime as unknown as Record<string, unknown>;

  // Past the tenth account, colours are reused. Six of them cannot share a felt.
  internals.seated = [
    { seatIndex: 0, agentId: 'a', name: 'A', color: 'red', instructions: '', stack: 1, notesEnabled: true, bustedAtHand: null },
    { seatIndex: 1, agentId: 'b', name: 'B', color: 'red', instructions: '', stack: 1, notesEnabled: true, bustedAtHand: null },
  ] satisfies SeatedAgent[];
  internals.palette = tablePalette(internals.seated as SeatedAgent[]);

  const colors = runtime.view(null).seats.filter((seat) => seat.agentId).map((seat) => seat.color);
  assert.equal(new Set(colors).size, colors.length, 'no two seated agents draw in the same colour');
});

function nameOf(card: number): string {
  const ranks = '23456789TJQKA';
  return ranks[(card / 4) | 0] + 'cdhs'[card % 4];
}

test('a seat with no chips is not dealt into the next hand', () => {
  const { runtime } = sparseTable();
  const internals = runtime as unknown as Record<string, unknown>;

  const seated = internals.seated as SeatedAgent[];
  seated[0].stack = 0;
  seated[0].bustedAtHand = 4;

  const alive = (internals.alive as () => SeatedAgent[]).call(runtime);
  assert.deepEqual(
    alive.map((seat) => seat.agentId),
    ['bob'],
    'an eliminated agent stays on the record but is never dealt to again',
  );
});

test('a stack too short to post a big blind is out, whether or not it is marked', () => {
  // The marker is written after the hand that broke the seat. Between the two,
  // the stack itself is what says the agent cannot play, so both are checked.
  const { runtime } = sparseTable();
  const internals = runtime as unknown as Record<string, unknown>;

  const seated = internals.seated as SeatedAgent[];
  seated[0].stack = config.bigBlind - 1;

  const alive = (internals.alive as () => SeatedAgent[]).call(runtime);
  assert.deepEqual(alive.map((seat) => seat.agentId), ['bob']);
});

test('a match announces itself finished exactly once', () => {
  // The loop can reach an ending from several directions at once, and settling
  // twice would return every stack twice.
  const endings: string[] = [];
  const runtime = new MatchRuntime('m-1', config, {} as never, {} as never, (_id, ending) => {
    endings.push(ending);
  });

  const finish = (runtime as unknown as Record<string, unknown>).finish as (ending: string) => void;
  finish.call(runtime, 'elimination');
  finish.call(runtime, 'cap');
  finish.call(runtime, 'abandoned');

  assert.deepEqual(endings, ['elimination'], 'the first ending is the one that counts');
});

test('an agent that is not in this match is never treated as being in its hand', () => {
  const { runtime } = sparseTable();
  (runtime as unknown as Record<string, unknown>).handLive = true;

  assert.equal(runtime.isInLiveHand('alice'), true);
  assert.equal(runtime.isInLiveHand('carol'), false, 'a stranger to this lineup is nothing to do with it');
});
