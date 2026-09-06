import { describe, expect, it } from 'vitest';
import type { PlayerAction } from '@agentholdem/shared';
import { HandEngine, type HandSeatConfig } from '../src/engine/hand.js';
import { commitToSeed, layoutDeal, makeRng, verifyShuffle } from '../src/engine/cards.js';

function seats(...stacks: number[]): HandSeatConfig[] {
  return stacks.map((stack, i) => ({
    seat: i,
    agentName: `agent-${i}`,
    owner: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    stack,
  }));
}

function engine(stacks: number[], seed = 'seed-1', buttonIndex = 0, sb = 10, bb = 20) {
  return new HandEngine({
    seats: seats(...stacks),
    buttonIndex,
    smallBlind: sb,
    bigBlind: bb,
    seed,
    handNumber: 1,
  });
}

describe('blinds and action order', () => {
  it('heads-up: the button posts the small blind and acts first pre-flop', () => {
    const h = engine([1000, 1000]);
    expect(h.players[0]!.committed).toBe(10);
    expect(h.players[1]!.committed).toBe(20);
    expect(h.currentActor()!.player.seat).toBe(0);
  });

  it('heads-up: the big blind acts first post-flop', () => {
    const h = engine([1000, 1000]);
    h.applyAction({ type: 'call', amount: 20 }); // button completes
    h.applyAction({ type: 'check', amount: 0 }); // bb takes the option
    expect(h.street).toBe('flop');
    expect(h.currentActor()!.player.seat).toBe(1);
  });

  it('six-handed: blinds sit left of the button and UTG opens', () => {
    const h = engine([1000, 1000, 1000, 1000, 1000, 1000], 'six', 0);
    expect(h.players[1]!.committed).toBe(10);
    expect(h.players[2]!.committed).toBe(20);
    expect(h.currentActor()!.player.seat).toBe(3);
  });

  it('six-handed: post-flop action starts with the small blind', () => {
    const h = engine([1000, 1000, 1000, 1000, 1000, 1000], 'six', 0);
    for (let i = 0; i < 4; i++) h.applyAction({ type: 'fold', amount: 0 }); // 3,4,5,0
    h.applyAction({ type: 'call', amount: 20 }); // sb completes
    h.applyAction({ type: 'check', amount: 0 }); // bb checks option
    expect(h.street).toBe('flop');
    expect(h.currentActor()!.player.seat).toBe(1);
  });

  it('gives the big blind its option rather than closing the street early', () => {
    const h = engine([1000, 1000, 1000], 'option', 0);
    h.applyAction({ type: 'call', amount: 20 }); // button (utg 3-handed)
    h.applyAction({ type: 'call', amount: 20 }); // sb
    expect(h.street).toBe('preflop');
    expect(h.currentActor()!.player.seat).toBe(2);
  });
});

describe('raise legality', () => {
  it('enforces the minimum raise size', () => {
    const h = engine([1000, 1000]);
    const legal = h.currentActor()!.legal;
    expect(legal.minRaiseTo).toBe(40); // call 20 + one big blind
    const applied = h.applyAction({ type: 'raise', amount: 25 });
    expect(applied.amount).toBe(40);
  });

  it('raises the bar after a big raise', () => {
    const h = engine([1000, 1000]);
    h.applyAction({ type: 'raise', amount: 100 }); // raise to 100, size 80
    expect(h.currentActor()!.legal.minRaiseTo).toBe(180);
  });

  it('clamps an over-sized raise to the stack and marks it all-in', () => {
    const h = engine([300, 1000]);
    const applied = h.applyAction({ type: 'raise', amount: 99999 });
    expect(applied).toEqual({ type: 'all-in', amount: 300 });
    expect(h.players[0]!.allIn).toBe(true);
  });

  it('does not reopen betting for a short all-in raise', () => {
    // Button opens to 100, BB shoves 150 (a 50 raise, less than the 80 needed
    // for a full re-raise). The button may call or fold, not re-raise.
    const h = engine([1000, 150]);
    h.applyAction({ type: 'raise', amount: 100 });
    h.applyAction({ type: 'all-in', amount: 150 });
    const legal = h.currentActor()!.legal;
    expect(legal.canRaise).toBe(false);
    expect(legal.toCall).toBe(50);
    const applied = h.applyAction({ type: 'raise', amount: 400 });
    expect(applied.type).toBe('call');
  });

  it('reopens betting when the all-in is a full raise', () => {
    const h = engine([1000, 200]);
    h.applyAction({ type: 'raise', amount: 100 });
    h.applyAction({ type: 'all-in', amount: 200 });
    expect(h.currentActor()!.legal.canRaise).toBe(true);
  });

  it('converts a fold into a check when checking is free', () => {
    const h = engine([1000, 1000]);
    h.applyAction({ type: 'call', amount: 20 });
    const applied = h.applyAction({ type: 'fold', amount: 0 });
    expect(applied.type).toBe('check');
    expect(h.players[1]!.folded).toBe(false);
  });

  it('converts an impossible check into a fold when facing a bet', () => {
    const h = engine([1000, 1000]);
    const applied = h.applyAction({ type: 'check', amount: 0 });
    expect(applied.type).toBe('fold');
    expect(h.players[0]!.folded).toBe(true);
  });
});

describe('hand resolution', () => {
  it('awards the pot without a showdown when everyone folds', () => {
    const h = engine([1000, 1000]);
    h.applyAction({ type: 'fold', amount: 0 }); // button folds its sb
    expect(h.complete).toBe(true);
    const result = h.result();
    expect(result.wentToShowdown).toBe(false);
    const bb = result.seats.find((s) => s.seat === 1)!;
    expect(bb.won).toBe(30);
    expect(bb.net).toBe(10);
  });

  it('conserves chips exactly', () => {
    const h = engine([1000, 1000]);
    h.applyAction({ type: 'all-in', amount: 1000 });
    h.applyAction({ type: 'call', amount: 1000 });
    const result = h.result();
    const total = result.seats.reduce((s, x) => s + x.stackAfter, 0);
    expect(total).toBe(2000);
    expect(result.seats.reduce((s, x) => s + x.net, 0)).toBe(0);
  });

  it('keeps a single pot when every stack is covered', () => {
    const h = engine([100, 100, 100], 'sidepot', 0);
    h.applyAction({ type: 'all-in', amount: 0 }); // seat 0 (utg, 3-handed)
    h.applyAction({ type: 'all-in', amount: 0 }); // seat 1 (sb)
    h.applyAction({ type: 'all-in', amount: 0 }); // seat 2 (bb)

    const pots = h.buildPots();
    expect(pots).toHaveLength(1);
    expect(pots[0]!.amount).toBe(300);
    expect(pots[0]!.eligible).toEqual([0, 1, 2]);
    expect(h.result().seats.reduce((s, x) => s + x.stackAfter, 0)).toBe(300);
  });

  it('treats "all-in" as a shove regardless of the amount the model asked for', () => {
    const h = engine([1000, 1000], 'shove');
    const applied = h.applyAction({ type: 'all-in', amount: 42 });
    expect(applied).toEqual({ type: 'all-in', amount: 1000 });
  });

  it('excludes short stacks from the side pot they cannot cover', () => {
    const h = engine([1000, 1000, 100], 'sidepot-2', 0);
    h.applyAction({ type: 'raise', amount: 400 }); // seat 0
    h.applyAction({ type: 'call', amount: 400 }); // seat 1
    h.applyAction({ type: 'all-in', amount: 100 }); // seat 2 all-in short

    const pots = h.buildPots();
    expect(pots).toHaveLength(2);
    expect(pots[0]).toEqual({ amount: 300, eligible: [0, 1, 2] });
    expect(pots[1]).toEqual({ amount: 600, eligible: [0, 1] });
  });

  it('returns an uncalled bet to the bettor via a single-eligibility pot', () => {
    const h = engine([1000, 300], 'uncalled', 0);
    h.applyAction({ type: 'all-in', amount: 1000 });
    h.applyAction({ type: 'fold', amount: 0 });
    const result = h.result();
    // Seat 0 gets its own 1000 back plus the 20 big blind it won.
    expect(result.seats.find((s) => s.seat === 0)!.stackAfter).toBe(1020);
    expect(result.seats.find((s) => s.seat === 1)!.stackAfter).toBe(280);
    expect(result.pots).toEqual([{ amount: 1020, eligible: [0] }]);
  });

  it('runs the board out when everyone is all-in', () => {
    const h = engine([500, 500], 'runout');
    h.applyAction({ type: 'all-in', amount: 500 });
    h.applyAction({ type: 'call', amount: 500 });
    expect(h.board).toHaveLength(5);
    expect(h.street).toBe('showdown');
    expect(h.result().wentToShowdown).toBe(true);
  });
});

describe('provable shuffle', () => {
  it('publishes a commitment that the revealed seed satisfies', () => {
    const h = engine([1000, 1000], 'provable');
    expect(h.commitment).toBe(commitToSeed('provable'));
    h.applyAction({ type: 'all-in', amount: 1000 });
    h.applyAction({ type: 'call', amount: 1000 });
    const result = h.result();
    expect(verifyShuffle(result.seed, result.commitment, 2, result.board)).toBe(true);
    expect(verifyShuffle('wrong-seed', result.commitment, 2, result.board)).toBe(false);
  });

  it('deals every player distinct hole cards', () => {
    const layout = layoutDeal('distinct', 6);
    const all = [...layout.holeCards.flat(), ...layout.flop, layout.turn, layout.river, ...layout.burns];
    expect(new Set(all).size).toBe(all.length);
  });

  it('replays identically from the same seed', () => {
    expect(layoutDeal('same', 4)).toEqual(layoutDeal('same', 4));
    expect(layoutDeal('same', 4)).not.toEqual(layoutDeal('other', 4));
  });
});

describe('fuzz: random legal play never leaks or invents chips', () => {
  it('conserves the total across 2000 randomised hands', () => {
    const rng = makeRng('fuzz-conservation');
    for (let n = 0; n < 2000; n++) {
      const count = 2 + Math.floor(rng() * 5);
      const stacks = Array.from({ length: count }, () => 40 + Math.floor(rng() * 2000));
      const before = stacks.reduce((a, b) => a + b, 0);
      const h = engine(stacks, `fuzz-${n}`, Math.floor(rng() * count));

      let guard = 0;
      while (!h.complete) {
        if (guard++ > 500) throw new Error(`Hand ${n} did not terminate`);
        const actor = h.currentActor();
        if (!actor) break;
        h.applyAction(randomAction(actor.legal, rng));
      }

      const result = h.result();
      const after = result.seats.reduce((a, s) => a + s.stackAfter, 0);
      expect(after, `hand ${n}`).toBe(before);
      expect(result.seats.reduce((a, s) => a + s.net, 0)).toBe(0);
      for (const s of result.seats) expect(s.stackAfter).toBeGreaterThanOrEqual(0);

      const potTotal = result.pots.reduce((a, p) => a + p.amount, 0);
      const invested = result.seats.reduce((a, s) => a + s.invested, 0);
      expect(potTotal).toBe(invested);
      expect(result.seats.reduce((a, s) => a + s.won, 0)).toBe(potTotal);
    }
  });

  function randomAction(
    legal: ReturnType<HandEngine['legalActions']>,
    rng: () => number,
  ): PlayerAction {
    const roll = rng();
    if (roll < 0.15) return { type: 'fold', amount: 0 };
    if (roll < 0.5) {
      return legal.canCheck ? { type: 'check', amount: 0 } : { type: 'call', amount: legal.toCall };
    }
    if (roll < 0.9 && legal.canRaise) {
      const span = legal.maxRaiseTo - legal.minRaiseTo;
      return { type: 'raise', amount: legal.minRaiseTo + Math.floor(rng() * (span + 1)) };
    }
    return { type: 'all-in', amount: legal.maxRaiseTo };
  }
});
