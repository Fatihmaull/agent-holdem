import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from './cards';
import {
  type Action,
  type HandState,
  applyAction,
  IllegalAction,
  legalActions,
  startHand,
  totalPot,
} from './engine';

function table(stacks: number[], overrides: Partial<Parameters<typeof startHand>[0]> = {}): HandState {
  return startHand({
    handId: 'h1',
    seats: stacks.map((stack, i) => ({ agentId: `a${i}`, stack })),
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: 42,
    ...overrides,
  });
}

// Once a hand settles the pot has already been paid into the stacks, so only
// an unfinished hand still has chips sitting in the middle.
const chipsInPlay = (state: HandState) =>
  state.seats.reduce((sum, s) => sum + s.stack, 0) + (state.street === 'complete' ? 0 : totalPot(state));
const play = (state: HandState, actions: Action[]) => actions.reduce((s, a) => applyAction(s, a), state);

test('posts blinds and seats the first actor left of the big blind', () => {
  const state = table([1000, 1000, 1000, 1000, 1000, 1000]);
  assert.equal(state.seats[1].contributed, 10);
  assert.equal(state.seats[2].contributed, 20);
  assert.equal(state.toAct, 3);
  assert.equal(state.currentBet, 20);
});

test('heads-up puts the button on the small blind and acts first preflop', () => {
  const state = table([1000, 1000]);
  assert.equal(state.seats[0].contributed, 10, 'button posts the small blind');
  assert.equal(state.seats[1].contributed, 20);
  assert.equal(state.toAct, 0);
});

test('heads-up reverses order after the flop', () => {
  const state = play(table([1000, 1000]), [{ type: 'call' }, { type: 'check' }]);
  assert.equal(state.street, 'flop');
  assert.equal(state.toAct, 1, 'the big blind acts first out of position');
});

test('deals two hole cards to every live seat and no duplicates', () => {
  const state = table([1000, 1000, 1000, 1000]);
  const dealt = state.seats.flatMap((seat) => seat.hole ?? []);
  assert.equal(dealt.length, 8);
  assert.equal(new Set(dealt).size, 8);
});

test('a free check cannot be folded', () => {
  const state = play(table([1000, 1000]), [{ type: 'call' }]);
  const legal = legalActions(state)!;
  assert.equal(legal.toCall, 0);
  assert.equal(legal.check, true);
  assert.equal(legal.fold, false);
  assert.throws(() => applyAction(state, { type: 'fold' }), IllegalAction);
});

test('the big blind keeps the option after a round of calls', () => {
  const state = play(table([1000, 1000, 1000]), [{ type: 'call' }, { type: 'call' }]);
  assert.equal(state.toAct, 2, 'big blind still owes an action');
  const legal = legalActions(state)!;
  assert.equal(legal.check, true);
  assert.notEqual(legal.raise, null);
});

test('everyone folding awards the pot uncontested and shows no cards', () => {
  const state = play(table([1000, 1000, 1000]), [{ type: 'fold' }, { type: 'fold' }]);
  assert.equal(state.street, 'complete');
  assert.equal(state.seats[2].stack, 1010);
  assert.ok(state.events.some((e) => e.type === 'award' && e.uncontested));
  assert.ok(!state.events.some((e) => e.type === 'showdown'));
});

test('enforces the minimum raise', () => {
  const state = table([1000, 1000, 1000]);
  const legal = legalActions(state)!;
  assert.equal(legal.raise!.min, 40, 'a raise must at least double the twenty');
  assert.throws(() => applyAction(state, { type: 'raise', to: 30 }), IllegalAction);
});

test('a reraise must clear the previous raise size', () => {
  const state = play(table([1000, 1000, 1000]), [{ type: 'raise', to: 60 }]);
  assert.equal(legalActions(state)!.raise!.min, 100, 'previous raise was forty');
});

test('a short all-in does not reopen betting for players who already acted', () => {
  // Button on seat 2 makes the order seat 2, then the blinds on seats 0 and 1.
  // Seat 2 raises to 60, seat 1 shoves 70 which is only a ten-chip raise.
  const state = play(table([1000, 70, 1000], { button: 2 }), [
    { type: 'raise', to: 60 },
    { type: 'fold' },
    { type: 'raise', to: 70 },
  ]);

  assert.equal(state.toAct, 2, 'the original raiser owes the extra ten');
  const legal = legalActions(state)!;
  assert.equal(legal.call, 10);
  assert.equal(legal.raise, null, 'a short shove does not reopen the betting');
});

test('runs the board out and shows cards when everyone is all in', () => {
  const state = play(table([200, 200], { smallBlind: 10, bigBlind: 20 }), [
    { type: 'raise', to: 200 },
    { type: 'call' },
  ]);
  assert.equal(state.street, 'complete');
  assert.equal(state.board.length, 5);
  assert.equal(state.events.filter((e) => e.type === 'showdown').length, 2);
});

test('builds side pots when a short stack is all in', () => {
  // Seat 1 can only cover 100. Seats 0 and 2 shove past it into a side pot.
  const state = play(table([1000, 100, 1000], { button: 2 }), [
    { type: 'raise', to: 1000 },
    { type: 'call' },
    { type: 'call' },
  ]);

  assert.equal(state.street, 'complete');
  assert.equal(state.pots.length, 2);
  assert.equal(state.pots[0].amount, 300, 'main pot is three times the short stack');
  assert.deepEqual([...state.pots[0].eligible].sort(), [0, 1, 2]);
  assert.equal(state.pots[1].amount, 1800);
  assert.deepEqual([...state.pots[1].eligible].sort(), [0, 2]);
});

test('conserves chips across every path', () => {
  const scripts: Action[][] = [
    [{ type: 'fold' }, { type: 'fold' }],
    [{ type: 'call' }, { type: 'call' }, { type: 'check' }],
    [{ type: 'raise', to: 60 }, { type: 'call' }, { type: 'fold' }],
    [{ type: 'raise', to: 1000 }, { type: 'call' }, { type: 'fold' }],
  ];

  for (const script of scripts) {
    const state = table([1000, 1000, 1000]);
    const before = chipsInPlay(state);
    let live = state;
    for (const action of script) {
      if (live.toAct === null) break;
      live = applyAction(live, action);
    }
    assert.equal(chipsInPlay(live), before, JSON.stringify(script));
    assert.equal(before, 3000);
  }
});

test('plays a full hand to showdown with the pot fully awarded', () => {
  let state = table([1000, 1000, 1000]);
  const guard = 200;
  let steps = 0;

  while (state.toAct !== null && steps++ < guard) {
    const legal = legalActions(state)!;
    state = applyAction(state, legal.check ? { type: 'check' } : { type: 'call' });
  }

  assert.equal(state.street, 'complete');
  assert.equal(state.board.length, 5);
  const awarded = state.events.filter((e) => e.type === 'award').reduce((sum, e) => sum + e.amount, 0);
  assert.equal(awarded, totalPot(state));
  assert.equal(chipsInPlay(state), 3000);
});

test('a folded seat cannot win the pot it paid into', () => {
  const state = play(table([1000, 1000, 1000]), [{ type: 'raise', to: 100 }, { type: 'fold' }, { type: 'fold' }]);
  const awards = state.events.filter((e) => e.type === 'award');
  assert.equal(awards.length, 1, 'one winner, one pot');
  assert.equal(awards[0].seat, 0);
  assert.equal(state.seats[0].stack, 1030, 'wins its own hundred back plus both blinds');
});

test('survives thousands of random hands without losing a chip', () => {
  const random = mulberry32(2024);
  const pick = <T,>(items: T[]) => items[(random() * items.length) | 0];

  for (let hand = 0; hand < 3000; hand++) {
    const players = 2 + ((random() * 5) | 0);
    const stacks = Array.from({ length: players }, () => 40 + ((random() * 2000) | 0));
    const expected = stacks.reduce((sum, stack) => sum + stack, 0);

    let state = startHand({
      handId: `fuzz-${hand}`,
      seats: stacks.map((stack, i) => ({ agentId: `a${i}`, stack })),
      button: (random() * players) | 0,
      smallBlind: 10,
      bigBlind: 20,
      seed: (random() * 2 ** 31) | 0,
    });

    let steps = 0;
    while (state.toAct !== null) {
      assert.ok(steps++ < 500, 'hand did not terminate');
      const legal = legalActions(state)!;
      const choices: Action[] = [];
      if (legal.fold) choices.push({ type: 'fold' });
      if (legal.check) choices.push({ type: 'check' });
      if (legal.call !== null) choices.push({ type: 'call' });
      for (const range of [legal.bet, legal.raise]) {
        if (!range) continue;
        const to = range.min + ((random() * (range.max - range.min + 1)) | 0);
        choices.push({ type: range === legal.bet ? 'bet' : 'raise', to });
      }
      assert.ok(choices.length > 0, 'a seat to act always has a legal action');
      state = applyAction(state, pick(choices));
    }

    assert.equal(state.street, 'complete');
    const after = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
    assert.equal(after, expected, `hand ${hand} leaked chips`);
    assert.ok(state.seats.every((seat) => seat.stack >= 0), 'no seat may go negative');
  }
});

test('blinds that put everyone all in still get a board and a showdown', () => {
  // Nobody is left to act, but the hand is not over: settling here would pick a
  // winner by comparing two hole cards against nothing.
  const state = startHand({
    handId: 'all-in-blinds',
    seats: [
      { agentId: 'a', stack: 10 },
      { agentId: 'b', stack: 10 },
    ],
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: 7,
  });

  assert.equal(state.street, 'complete');
  assert.equal(state.board.length, 5, 'the board runs out before anyone can win it');
  assert.equal(
    state.events.filter((event) => event.type === 'showdown').length,
    2,
    'both hands are shown, because both are still live',
  );
  assert.equal(
    state.seats.reduce((sum, seat) => sum + seat.stack, 0),
    20,
    'every chip is still on the table',
  );
});
