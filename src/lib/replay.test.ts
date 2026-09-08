import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, legalActions, startHand } from '../poker/engine';
import { buildReplay, netResults, type ReplaySeat } from './replay';

/**
 * The replayer, checked against hands the engine actually played.
 *
 * The property that matters most is not that the frames look right — it is
 * that a mucked hand stays mucked. Reconstructing the hand from its stored
 * seed would be less code and would hand every reader the folded cards of
 * everybody who did not show, which is not something a player agreed to.
 */

const LINEUP: ReplaySeat[] = [
  { seatIndex: 0, agentId: 'a', name: 'Alice', startingStack: 2_000 },
  { seatIndex: 1, agentId: 'b', name: 'Bob', startingStack: 2_000 },
  { seatIndex: 2, agentId: 'c', name: 'Carol', startingStack: 2_000 },
];

/** Plays a hand with a fixed policy and returns what would have been stored. */
function play(seed: number, policy: 'call-down' | 'fold-early') {
  let state = startHand({
    handId: `replay-${seed}`,
    seats: LINEUP.map((seat) => ({ agentId: seat.agentId, stack: seat.startingStack })),
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed,
  });

  let acted = 0;
  while (state.toAct !== null) {
    const legal = legalActions(state)!;
    const foldNow = policy === 'fold-early' && acted === 0 && legal.fold;
    state = applyAction(
      state,
      foldNow ? { type: 'fold' } : legal.check ? { type: 'check' } : legal.call !== null ? { type: 'call' } : { type: 'fold' },
    );
    acted += 1;
  }
  return state;
}

test('every seat starts on the stack it sat down with', () => {
  const state = play(11, 'call-down');
  const frames = buildReplay(LINEUP, state.events);

  assert.ok(frames.length > 0);
  const opening = frames[0];
  // The blinds are already posted in the opening frame, so the two who posted
  // are down by exactly what they put in and nobody else has moved.
  const total = opening.seats.reduce((sum, seat) => sum + seat.stack, 0) + opening.pot;
  assert.equal(total, 6_000);
});

test('chips are conserved in every frame', () => {
  const state = play(23, 'call-down');
  for (const frame of buildReplay(LINEUP, state.events)) {
    const held = frame.seats.reduce((sum, seat) => sum + seat.stack, 0);
    assert.equal(held + frame.pot, 6_000, `frame "${frame.headline}" has lost or invented chips`);
  }
});

test('the pot is empty and the stacks are whole once it has been pushed', () => {
  const state = play(31, 'call-down');
  const frames = buildReplay(LINEUP, state.events);
  const last = frames.at(-1)!;

  assert.equal(last.pot, 0, 'every chip in the pot was awarded to somebody');
  assert.equal(
    last.seats.reduce((sum, seat) => sum + seat.stack, 0),
    6_000,
  );
});

test('a hand that was never shown is never revealed', () => {
  const state = play(41, 'fold-early');
  const shown = new Set(
    state.events.flatMap((event) => (event.type === 'showdown' ? [event.seat] : [])),
  );
  const frames = buildReplay(LINEUP, state.events);
  const last = frames.at(-1)!;

  for (const seat of last.seats) {
    if (shown.has(seat.seatIndex)) {
      assert.ok(seat.hole, `${seat.name} showed at showdown and should be visible`);
    } else {
      // The seed is stored and would give these up. It is deliberately not used.
      assert.equal(seat.hole, null, `${seat.name} never showed and must stay hidden`);
    }
  }
});

test('a fold is recorded as one, and the folded seat stops moving', () => {
  const state = play(41, 'fold-early');
  const frames = buildReplay(LINEUP, state.events);

  const foldAt = frames.findIndex((frame) => frame.headline.includes('folds'));
  assert.ok(foldAt >= 0, 'somebody folded in this hand');

  const folder = frames[foldAt].seats.find((seat) => seat.folded)!;
  const stackWhenFolded = folder.stack;

  for (const frame of frames.slice(foldAt)) {
    const later = frame.seats.find((seat) => seat.seatIndex === folder.seatIndex)!;
    assert.equal(later.folded, true, 'a folded seat stays folded');
    assert.ok(later.stack >= stackWhenFolded, 'a folded seat never puts in another chip');
  }
});

test('board cards accumulate and never go backwards', () => {
  const state = play(53, 'call-down');
  const frames = buildReplay(LINEUP, state.events);

  let seen = 0;
  for (const frame of frames) {
    assert.ok(frame.board.length >= seen, `the board shrank at "${frame.headline}"`);
    assert.ok(frame.board.length <= 5);
    assert.deepEqual(frame.board, [...new Set(frame.board)], 'no card is dealt twice');
    seen = frame.board.length;
  }
});

test('each action frame points at the decision that produced it', () => {
  const state = play(67, 'call-down');
  const frames = buildReplay(LINEUP, state.events);

  const actions = state.events.filter((event) => event.type === 'action').length;
  const pointed = frames.filter((frame) => frame.decision !== null).map((frame) => frame.decision);

  // Actions and decision rows are written one for one, in order, so the
  // indexes have to be exactly 0..n-1 with nothing skipped or repeated.
  assert.deepEqual(pointed, Array.from({ length: actions }, (_, i) => i));
});

test('blinds and board cards are not decisions', () => {
  const state = play(71, 'call-down');
  for (const frame of buildReplay(LINEUP, state.events)) {
    if (frame.headline.includes('blind') || frame.headline.startsWith('Flop')) {
      assert.equal(frame.decision, null, `"${frame.headline}" is not something a model decided`);
    }
  }
});

test('the net result of a hand adds up to nothing', () => {
  const state = play(83, 'call-down');
  const frames = buildReplay(LINEUP, state.events);
  const results = netResults(frames, LINEUP);

  assert.equal(results.length, 3);
  assert.equal(
    results.reduce((sum, entry) => sum + entry.net, 0),
    0,
    'one seat’s winnings are another’s losses',
  );
});

test('a hand with no events still produces something to look at', () => {
  const frames = buildReplay(LINEUP, []);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].seats.length, 3);
  assert.equal(frames[0].pot, 0);
});
