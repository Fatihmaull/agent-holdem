import { test } from 'node:test';
import assert from 'node:assert/strict';
// Must come before anything that reaches the database module. Nothing here
// runs a query, but that module refuses to load without a connection string.
import '../dev/test-env';
import { applyAction, startHand } from '../poker/engine';
import { MATCH } from '../lib/economy';
import { MatchRuntime, amountOf, tablePalette } from './table';
import type { SeatedAgent } from './store';
import type { BrainView } from './view';

const config = MATCH;

/** Chairs 1 and 2 occupied, chair 0 vacated: what a seat change leaves behind. */
function sparseTable() {
  const runtime = new MatchRuntime('m-1', config, () => {});
  const internals = runtime as unknown as Record<string, unknown>;

  const seated: SeatedAgent[] = [
    { seatIndex: 1, agentId: 'alice', name: 'Alice', color: 'red', stack: 2000, bustedAtHand: null },
    { seatIndex: 2, agentId: 'bob', name: 'Bob', color: 'green', stack: 2000, bustedAtHand: null },
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
  const runtime = new MatchRuntime('m-1', config, () => {});
  const internals = runtime as unknown as Record<string, unknown>;

  // Past the tenth account, colours are reused. Six of them cannot share a felt.
  internals.seated = [
    { seatIndex: 0, agentId: 'a', name: 'A', color: 'red', stack: 1, bustedAtHand: null },
    { seatIndex: 1, agentId: 'b', name: 'B', color: 'red', stack: 1, bustedAtHand: null },
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
  const runtime = new MatchRuntime('m-1', config, (_id, ending) => {
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

test('a decision in a live hand reaches every viewer sealed, its own owner included', () => {
  // Equity and reasoning are the holding by another name. An opponent's owner
  // reading them off the public feed mid-hand is reading the cards.
  const { runtime } = sparseTable();
  (runtime as unknown as Record<string, unknown>).brain = thinking();

  for (const viewer of [null, 'alice', 'bob']) {
    const brain = runtime.view(viewer).brain!;
    assert.equal(brain.sealed, true, `sealed for ${viewer ?? 'a stranger'}`);
    assert.equal(brain.reasoning, '');
    assert.equal(brain.equity, null);
    assert.equal(brain.handRead, null);
    assert.equal(brain.action, 'raise', 'what it did is public, only why is not');
    assert.equal(brain.elapsedMs, 2100, 'and so is how long it took');
  }
});

test('a decision opens once its cards have been turned over', () => {
  const { runtime } = sparseTable();
  const internals = runtime as unknown as Record<string, unknown>;
  internals.brain = thinking();
  internals.brainOpen = true;

  const brain = runtime.view(null).brain!;
  assert.equal(brain.sealed, false);
  assert.equal(brain.equity, 0.91);
  assert.match(brain.reasoning, /nut flush/);
});

test('each decision is stored with what it came to, not with the seat’s last action of that kind', () => {
  // A seat that calls twice in one hand made two different calls. Reading the
  // amount back out of the finished hand found the later one for both.
  let state = startHand({
    handId: 'h',
    seats: [
      { agentId: 'a', stack: 2000 },
      { agentId: 'b', stack: 2000 },
    ],
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: 7,
  });

  let cursor = state.events.length;
  state = applyAction(state, { type: 'call' });
  assert.equal(amountOf(state, cursor), 10, 'the button completes its small blind');

  state = applyAction(state, { type: 'check' });
  cursor = state.events.length;
  state = applyAction(state, { type: 'bet', to: 40 });
  assert.equal(amountOf(state, cursor), 40, 'a bet is stored as the level it reached');

  cursor = state.events.length;
  state = applyAction(state, { type: 'call' });
  assert.equal(amountOf(state, cursor), 40, 'and this call is its own, not the one before it');

  cursor = state.events.length;
  state = applyAction(state, { type: 'check' });
  assert.equal(amountOf(state, cursor), 0, 'a check puts nothing in');
});

function thinking(): BrainView {
  return {
    seat: 1,
    seatName: 'Alice',
    color: 'red',
    street: 'river',
    reasoning: 'I have the nut flush, so this raise is for value.',
    equity: 0.91,
    handRead: { made: 'flush', flushDraw: false, openEnded: false, gutshot: false, overcards: false },
    potOdds: 0.25,
    action: 'raise',
    amount: 600,
    outcome: 'decided',
    failure: null,
    elapsedMs: 2100,
    sealed: false,
  };
}
