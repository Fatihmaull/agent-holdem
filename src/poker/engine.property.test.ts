import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from './cards';
import {
  applyAction,
  legalActions,
  startHand,
  totalPot,
  type Action,
  type HandState,
  type SeatConfig,
} from './engine';

/**
 * Randomised hands, checked against the rules that must hold for all of them.
 *
 * The example-based tests next door pin down cases somebody thought of. These
 * pin down the ones nobody did: a thousand hands of mismatched all-ins, odd
 * chips and folded contributors, each asserting the same three things.
 *
 * Chip conservation is the one with money behind it. The engine is where a
 * pot is built and split, and a side pot that pays out a chip more than was
 * staked mints chips at a table — which `pnpm reconcile` would eventually
 * catch in production, long after somebody had spent them.
 *
 * Seeded, so a failure is reproducible: the seed is in the assertion message.
 */

/** Chips handed back to seats so far. Zero until the hand settles. */
function awardedSoFar(state: HandState): number {
  return state.events.reduce((sum, event) => (event.type === 'award' ? sum + event.amount : sum), 0);
}

/**
 * Everything a hand must satisfy at every step, whatever was dealt.
 *
 * `contributed` is a record of the whole hand and is not cleared when the pot
 * is pushed, so once a hand settles the same chips are counted both in a
 * winner's stack and in the pot they came from. Subtracting what has been
 * awarded makes one statement that holds at every step rather than two that
 * each hold for half the hand.
 */
function checkInvariants(state: HandState, staked: number, seed: number, note: string): void {
  const where = `seed ${seed}, ${note}`;

  for (const seat of state.seats) {
    assert.ok(seat.stack >= 0, `${where}: seat ${seat.index} has a negative stack (${seat.stack})`);
    assert.ok(seat.contributed >= 0, `${where}: seat ${seat.index} contributed ${seat.contributed}`);
    assert.ok(
      Number.isInteger(seat.stack) && Number.isInteger(seat.contributed),
      `${where}: seat ${seat.index} holds a fraction of a chip`,
    );
    assert.ok(
      seat.committed <= seat.contributed,
      `${where}: seat ${seat.index} committed more this round than it has all hand`,
    );
  }

  // Chips are either in front of a seat or in the pot. Nowhere else exists.
  const held = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
  assert.equal(
    held + totalPot(state) - awardedSoFar(state),
    staked,
    `${where}: chips were created or destroyed`,
  );

  // Every layer of the pot is contested by somebody, or it can never be paid.
  // Layers are only built when the hand settles, so this says nothing until
  // then, which is exactly when it matters.
  for (const [index, pot] of state.pots.entries()) {
    assert.ok(pot.amount >= 0, `${where}: pot ${index} is negative`);
    assert.ok(pot.eligible.length > 0, `${where}: pot ${index} has nobody eligible for it`);
  }
}

/** Picks a legal action, weighted so that all-ins and folds both actually happen. */
function randomAction(state: HandState, random: () => number): Action {
  const legal = legalActions(state)!;
  const roll = random();

  if (legal.raise && roll < 0.18) {
    const { min, max } = legal.raise;
    // Half the raises are shoves, because that is where side pots come from.
    return { type: 'raise', to: roll < 0.09 ? max : min + Math.floor(random() * (max - min + 1)) };
  }
  if (legal.bet && roll < 0.3) {
    const { min, max } = legal.bet;
    return { type: 'bet', to: roll < 0.2 ? max : min + Math.floor(random() * (max - min + 1)) };
  }
  if (legal.call !== null && roll < 0.75) return { type: 'call' };
  if (legal.check) return { type: 'check' };
  if (legal.fold) return { type: 'fold' };
  // Only reachable when calling is the single option, which is a real spot.
  return { type: 'call' };
}

interface Played {
  state: HandState;
  staked: number;
}

function playRandomHand(seed: number, seatCount: number, stacks: number[]): Played {
  const random = mulberry32(seed);
  const configs: SeatConfig[] = stacks.slice(0, seatCount).map((stack, index) => ({
    agentId: `agent-${index}`,
    stack,
  }));
  const staked = configs.reduce((sum, seat) => sum + seat.stack, 0);

  let state = startHand({
    handId: `property-${seed}`,
    seats: configs,
    button: seed % seatCount,
    smallBlind: 10,
    bigBlind: 20,
    seed,
  });

  checkInvariants(state, staked, seed, 'after the deal');

  // Generous, and still a bound: a hand that cannot finish is a bug worth
  // failing on rather than a test that hangs.
  let steps = 0;
  while (state.toAct !== null) {
    if (++steps > 400) throw new Error(`seed ${seed}: the hand never finished`);
    const action = randomAction(state, random);
    state = applyAction(state, action);
    checkInvariants(state, staked, seed, `after ${action.type} (step ${steps})`);
  }

  return { state, staked };
}

test('a thousand random hands neither create nor destroy a chip', () => {
  for (let seed = 1; seed <= 1_000; seed++) {
    const seatCount = 2 + (seed % 5);
    // Deliberately uneven, so short stacks run out mid-street and side pots
    // have to be built. Equal stacks almost never produce one.
    const stacks = Array.from({ length: seatCount }, (_, i) => 40 + ((seed * 37 + i * 511) % 4_000));

    const { state, staked } = playRandomHand(seed, seatCount, stacks);

    assert.equal(state.street, 'complete', `seed ${seed}: the hand did not finish`);
    const final = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
    assert.equal(final, staked, `seed ${seed}: ${final} chips at the end of a hand that started with ${staked}`);
  }
});

test('every chip staked is awarded to somebody', () => {
  for (let seed = 2_000; seed < 2_300; seed++) {
    const seatCount = 2 + (seed % 5);
    const stacks = Array.from({ length: seatCount }, (_, i) => 60 + ((seed * 17 + i * 293) % 2_500));
    const { state } = playRandomHand(seed, seatCount, stacks);

    const staked = state.seats.reduce((sum, seat) => sum + seat.contributed, 0);
    const awarded = state.events
      .filter((event) => event.type === 'award')
      .reduce((sum, event) => sum + (event.type === 'award' ? event.amount : 0), 0);

    // An odd chip has to go somewhere. Leaving one behind is the classic
    // side-pot bug and it is invisible until the totals are added up.
    assert.equal(awarded, staked, `seed ${seed}: ${awarded} awarded against ${staked} staked`);
  }
});

test('nobody wins more than they could have been owed', () => {
  for (let seed = 3_000; seed < 3_200; seed++) {
    const seatCount = 3 + (seed % 4);
    const stacks = Array.from({ length: seatCount }, (_, i) => 100 + ((seed * 91 + i * 733) % 1_800));
    const { state } = playRandomHand(seed, seatCount, stacks);

    for (const seat of state.seats) {
      // The most a seat can take is its own contribution matched by everybody
      // else's, capped at what each of them actually put in.
      const ceiling = state.seats.reduce(
        (sum, other) => sum + Math.min(other.contributed, seat.contributed),
        0,
      );
      const won = state.events
        .filter((event) => event.type === 'award' && event.seat === seat.index)
        .reduce((sum, event) => sum + (event.type === 'award' ? event.amount : 0), 0);

      assert.ok(
        won <= ceiling,
        `seed ${seed}: seat ${seat.index} won ${won} but could only be owed ${ceiling}`,
      );
    }
  }
});

test('a short stack all-in against two deep stacks builds a side pot it cannot win', () => {
  // The awkward case named in the backlog, pinned down exactly rather than
  // left to chance. Pots are built when the hand settles, not as the chips go
  // in, so this plays the hand out and then reads the layers.
  let state = startHand({
    handId: 'side-pot',
    seats: [
      { agentId: 'short', stack: 100 },
      { agentId: 'deep-one', stack: 1_000 },
      { agentId: 'deep-two', stack: 1_000 },
    ],
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: 7,
  });

  const staked = 2_100;

  // Short shoves; the deep stacks raise past it and carry on betting between
  // themselves, which is what creates a layer the short stack cannot win.
  state = applyAction(state, { type: 'raise', to: 100 });
  const shortIndex = state.seats.findIndex((seat) => seat.agentId === 'short');
  assert.equal(state.seats[shortIndex].allIn, true);

  state = applyAction(state, { type: 'raise', to: 300 });
  state = applyAction(state, { type: 'call' });
  checkInvariants(state, staked, 7, 'after the deep stacks raise past the short one');

  // Check the rest of the way down so nothing more goes in.
  let steps = 0;
  while (state.toAct !== null) {
    if (++steps > 100) throw new Error('the hand never finished');
    const legal = legalActions(state)!;
    state = applyAction(state, legal.check ? { type: 'check' } : { type: 'call' });
    checkInvariants(state, staked, 7, `check-down step ${steps}`);
  }

  assert.equal(state.seats[shortIndex].contributed, 100);

  // Two layers: one everybody contested, one only the deep stacks could.
  assert.equal(state.pots.length, 2, 'a short all-in against deeper money makes exactly two layers');
  assert.equal(state.pots[0].amount, 300, 'the main pot is capped at three times the short stack');
  assert.ok(state.pots[0].eligible.includes(shortIndex));
  assert.equal(state.pots[1].amount, 400, 'the two hundred each the deep stacks added beyond it');
  assert.ok(
    !state.pots[1].eligible.includes(shortIndex),
    'the short stack cannot contest chips it never matched',
  );

  assert.equal(
    state.seats.reduce((sum, seat) => sum + seat.stack, 0),
    staked,
  );
});

test('a folded seat’s chips still pay the winner', () => {
  // Somebody who puts chips in and folds has left them in the pot. A pot that
  // only counted live contributors would quietly lose them.
  let state = startHand({
    handId: 'folded-contributor',
    seats: [
      { agentId: 'a', stack: 500 },
      { agentId: 'b', stack: 500 },
      { agentId: 'c', stack: 500 },
    ],
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: 11,
  });

  const staked = 1_500;
  let steps = 0;
  let folded = false;
  while (state.toAct !== null) {
    if (++steps > 200) throw new Error('the hand never finished');
    const legal = legalActions(state)!;
    // The first seat that can fold does, after money is already in.
    const action: Action =
      !folded && legal.fold && totalPot(state) > 30
        ? ((folded = true), { type: 'fold' })
        : legal.check
          ? { type: 'check' }
          : legal.call !== null
            ? { type: 'call' }
            : { type: 'fold' };
    state = applyAction(state, action);
    checkInvariants(state, staked, 11, `step ${steps}`);
  }

  assert.ok(folded, 'the scenario needs somebody to fold with chips in');
  const awarded = state.events
    .filter((event) => event.type === 'award')
    .reduce((sum, event) => sum + (event.type === 'award' ? event.amount : 0), 0);
  assert.equal(awarded, totalPot(state), 'the folded seat’s chips were awarded with the rest');
  assert.equal(
    state.seats.reduce((sum, seat) => sum + seat.stack, 0),
    staked,
  );
});

test('an odd chip in a split pot is not left on the table', () => {
  // Two seats, an odd number of chips: one of them has to get the extra.
  let state = startHand({
    handId: 'odd-chip',
    seats: [
      { agentId: 'a', stack: 205 },
      { agentId: 'b', stack: 205 },
    ],
    button: 0,
    smallBlind: 5,
    bigBlind: 15,
    seed: 3,
  });

  let steps = 0;
  while (state.toAct !== null) {
    if (++steps > 200) throw new Error('the hand never finished');
    const legal = legalActions(state)!;
    state = applyAction(state, legal.call !== null ? { type: 'call' } : { type: 'check' });
  }

  const awarded = state.events
    .filter((event) => event.type === 'award')
    .reduce((sum, event) => sum + (event.type === 'award' ? event.amount : 0), 0);

  assert.equal(awarded, totalPot(state));
  assert.equal(
    state.seats.reduce((sum, seat) => sum + seat.stack, 0),
    410,
  );
});

test('every seat all-in for a different amount still settles exactly', () => {
  for (let seed = 5_000; seed < 5_120; seed++) {
    const seatCount = 3 + (seed % 4);
    // Small, mutually indivisible stacks: every one of these ends with several
    // side pots and an odd chip somewhere.
    const stacks = Array.from({ length: seatCount }, (_, i) => 21 + ((seed + i * 13) % 97));
    const staked = stacks.slice(0, seatCount).reduce((sum, stack) => sum + stack, 0);

    let state = startHand({
      handId: `all-in-${seed}`,
      seats: stacks.map((stack, index) => ({ agentId: `agent-${index}`, stack })),
      button: seed % seatCount,
      smallBlind: 5,
      bigBlind: 10,
      seed,
    });

    let steps = 0;
    while (state.toAct !== null) {
      if (++steps > 200) throw new Error(`seed ${seed}: the hand never finished`);
      const legal = legalActions(state)!;
      // Shove whenever possible, call otherwise. Nobody ever folds, so every
      // chip on the table has to be settled at a showdown.
      const action: Action = legal.raise
        ? { type: 'raise', to: legal.raise.max }
        : legal.bet
          ? { type: 'bet', to: legal.bet.max }
          : legal.call !== null
            ? { type: 'call' }
            : { type: 'check' };
      state = applyAction(state, action);
      checkInvariants(state, staked, seed, `step ${steps}`);
    }

    assert.equal(
      state.seats.reduce((sum, seat) => sum + seat.stack, 0),
      staked,
      `seed ${seed}: chips changed across a hand where everybody was all in`,
    );
  }
});
