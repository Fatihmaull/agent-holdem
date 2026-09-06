import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { CardCode } from '@agentholdem/shared';
import { compareHands, evaluateHand } from '../src/engine/evaluator.js';
import { FULL_DECK, makeRng } from '../src/engine/cards.js';

const require = createRequire(import.meta.url);
// pokersolver is a CommonJS reference implementation used purely as a test
// oracle: our evaluator has to agree with it on category *and* on ordering.
const { Hand } = require('pokersolver') as {
  Hand: {
    solve(cards: string[]): { name: string; descr: string; rank: number };
    winners(hands: unknown[]): unknown[];
  };
};

const SOLVER_TO_CATEGORY: Record<string, string> = {
  'Royal Flush': 'straight-flush',
  'Straight Flush': 'straight-flush',
  'Four of a Kind': 'quads',
  'Full House': 'full-house',
  Flush: 'flush',
  Straight: 'straight',
  'Three of a Kind': 'trips',
  'Two Pair': 'two-pair',
  Pair: 'pair',
  'High Card': 'high-card',
};

function cards(s: string): CardCode[] {
  return s.split(/\s+/).filter(Boolean) as CardCode[];
}

describe('evaluateHand — known hands', () => {
  const cases: [string, string, string][] = [
    ['As Ks Qs Js Ts 2c 3d', 'straight-flush', 'Royal Flush'],
    ['9h 8h 7h 6h 5h Ad Kc', 'straight-flush', 'Straight Flush, 9 high'],
    ['Ah 2h 3h 4h 5h Kc Qd', 'straight-flush', 'Straight Flush, 5 high'],
    ['7c 7d 7h 7s 2c 3d 4h', 'quads', 'Four of a Kind, 7s'],
    ['Kc Kd Kh 4s 4c 2d 3h', 'full-house', 'Full House, Kings over 4s'],
    ['Kc Kd Kh 4s 4c 4d 3h', 'full-house', 'Full House, Kings over 4s'],
    ['Ac Tc 8c 5c 2c Kd Qh', 'flush', 'Flush, Ace high'],
    ['Ac 2d 3h 4s 5c Kd Qh', 'straight', 'Straight, 5 high'],
    ['Tc Jd Qh Ks Ac 2d 3h', 'straight', 'Straight, Ace high'],
    ['9c 9d 9h 2s 3c 4d 5h', 'trips', 'Three of a Kind, 9s'],
    ['Jc Jd 8h 8s 3c 4d 5h', 'two-pair', 'Two Pair, Jacks and 8s'],
    ['Jc Jd 8h 7s 3c 4d 2h', 'pair', 'Pair of Jacks'],
    ['Ac Jd 9h 7s 5c 3d 2h', 'high-card', 'Ace high'],
  ];

  for (const [hand, category, label] of cases) {
    it(`${hand} → ${label}`, () => {
      const rank = evaluateHand(cards(hand));
      expect(rank.category).toBe(category);
      expect(rank.label).toBe(label);
      expect(rank.cards).toHaveLength(5);
      // The five reported cards must actually be in the seven dealt.
      for (const c of rank.cards) expect(cards(hand)).toContain(c);
    });
  }

  it('rejects duplicate cards instead of silently ranking them', () => {
    expect(() => evaluateHand(cards('As As Kd Qc Jh'))).toThrow(/duplicate/i);
  });

  it('orders categories correctly', () => {
    const ordered = [
      'Ac Jd 9h 7s 5c',
      'Jc Jd 8h 7s 3c',
      'Jc Jd 8h 8s 3c',
      '9c 9d 9h 2s 3c',
      'Ac 2d 3h 4s 5c',
      'Ac Tc 8c 5c 2c',
      'Kc Kd Kh 4s 4c',
      '7c 7d 7h 7s 2c',
      '9h 8h 7h 6h 5h',
    ].map((h) => evaluateHand(cards(h)));

    for (let i = 1; i < ordered.length; i++) {
      expect(compareHands(ordered[i]!, ordered[i - 1]!)).toBeGreaterThan(0);
    }
  });

  it('treats identical hand strength as a chop', () => {
    // Same board plays for both: the board is a straight nobody improves on.
    const a = evaluateHand(cards('2c 3d Ts Jh Qc Kd Ah'));
    const b = evaluateHand(cards('2h 3s Ts Jh Qc Kd Ah'));
    expect(compareHands(a, b)).toBe(0);
  });
});

describe('evaluateHand — differential against pokersolver', () => {
  const ITERATIONS = 4000;

  function randomSeven(rng: () => number): CardCode[] {
    const deck = [...FULL_DECK];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    return deck.slice(0, 7);
  }

  it('agrees on hand category for random seven-card hands', () => {
    const rng = makeRng('differential-category');
    for (let n = 0; n < ITERATIONS; n++) {
      const hand = randomSeven(rng);
      const ours = evaluateHand(hand);
      const theirs = Hand.solve([...hand]);
      expect(
        SOLVER_TO_CATEGORY[theirs.name],
        `hand ${hand.join(' ')} → ours=${ours.category} theirs=${theirs.name}`,
      ).toBe(ours.category);
    }
  });

  it('agrees on which of two hands wins, sharing a board', () => {
    const rng = makeRng('differential-showdown');
    for (let n = 0; n < ITERATIONS; n++) {
      const deck = randomSevenPlusBoard(rng);
      const a = [...deck.a, ...deck.board];
      const b = [...deck.b, ...deck.board];

      const ours = Math.sign(compareHands(evaluateHand(a), evaluateHand(b)));

      const ha = Hand.solve([...a]);
      const hb = Hand.solve([...b]);
      const winners = Hand.winners([ha, hb]);
      const theirs =
        winners.length === 2 ? 0 : winners[0] === ha ? 1 : -1;

      expect(
        theirs,
        `A=${a.join(' ')} B=${b.join(' ')} ours=${ours} theirs=${theirs}`,
      ).toBe(ours);
    }
  });

  function randomSevenPlusBoard(rng: () => number) {
    const deck = [...FULL_DECK];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    return {
      a: deck.slice(0, 2),
      b: deck.slice(2, 4),
      board: deck.slice(4, 9),
    };
  }
});
