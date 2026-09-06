import {
  HAND_CATEGORIES,
  RANK_NAMES,
  type CardCode,
  type HandCategory,
  type HandRank,
  type Rank,
  type Suit,
} from '@agentholdem/shared';
import { rankOf, suitOf } from './cards.js';

/**
 * Seven-card Texas Hold'em evaluator.
 *
 * Hands are reduced to a single integer `score` so comparison across
 * categories is a plain subtraction. Encoding is base-15 with the category in
 * the most significant digit followed by up to five tiebreakers, highest
 * first — the same ordering poker rules define, so `a.score - b.score` is the
 * complete comparator including exact ties (chopped pots).
 */

const RANK_VALUE: Readonly<Record<Rank, number>> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

const VALUE_TO_RANK: Readonly<Record<number, Rank>> = Object.fromEntries(
  (Object.entries(RANK_VALUE) as [Rank, number][]).map(([r, v]) => [v, r]),
);

const BASE = 15;
const CATEGORY_INDEX: Readonly<Record<HandCategory, number>> = Object.fromEntries(
  HAND_CATEGORIES.map((c, i) => [c, i]),
) as Readonly<Record<HandCategory, number>>;

function encode(category: HandCategory, tiebreakers: readonly number[]): number {
  let score = CATEGORY_INDEX[category];
  for (let i = 0; i < 5; i++) {
    score = score * BASE + (tiebreakers[i] ?? 0);
  }
  return score;
}

function valueOf(card: CardCode): number {
  return RANK_VALUE[rankOf(card)];
}

/** High value of the best straight in `mask`, or 0. Handles the wheel. */
function straightHigh(mask: number): number {
  // Bit 1 doubles as the ace playing low in A-2-3-4-5.
  const m = mask | (((mask >> 14) & 1) << 1);
  for (let hi = 14; hi >= 5; hi--) {
    const need =
      (1 << hi) | (1 << (hi - 1)) | (1 << (hi - 2)) | (1 << (hi - 3)) | (1 << (hi - 4));
    if ((m & need) === need) return hi;
  }
  return 0;
}

/** Cards of the straight ending at `hi`, drawn from `pool` (highest first). */
function straightCards(pool: readonly CardCode[], hi: number): CardCode[] {
  const wanted = [hi, hi - 1, hi - 2, hi - 3, hi - 4].map((v) => (v === 1 ? 14 : v));
  const out: CardCode[] = [];
  for (const v of wanted) {
    const card = pool.find((c) => valueOf(c) === v && !out.includes(c));
    if (card) out.push(card);
  }
  return out;
}

function plural(rank: Rank): string {
  const name = RANK_NAMES[rank];
  return rank === '6' ? '6s' : `${name.charAt(0).toUpperCase()}${name.slice(1)}s`;
}

function proper(rank: Rank): string {
  const name = RANK_NAMES[rank];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function describe(category: HandCategory, tb: readonly number[]): string {
  const r = (i: number): Rank => VALUE_TO_RANK[tb[i] ?? 0] ?? '2';
  switch (category) {
    case 'straight-flush':
      return tb[0] === 14 ? 'Royal Flush' : `Straight Flush, ${proper(r(0))} high`;
    case 'quads':
      return `Four of a Kind, ${plural(r(0))}`;
    case 'full-house':
      return `Full House, ${plural(r(0))} over ${plural(r(1))}`;
    case 'flush':
      return `Flush, ${proper(r(0))} high`;
    case 'straight':
      return `Straight, ${proper(r(0))} high`;
    case 'trips':
      return `Three of a Kind, ${plural(r(0))}`;
    case 'two-pair':
      return `Two Pair, ${plural(r(0))} and ${plural(r(1))}`;
    case 'pair':
      return `Pair of ${plural(r(0))}`;
    default:
      return `${proper(r(0))} high`;
  }
}

function make(category: HandCategory, tb: number[], cards: CardCode[]): HandRank {
  return {
    category,
    score: encode(category, tb),
    cards: cards.slice(0, 5),
    label: describe(category, tb),
  };
}

/**
 * Evaluates 5, 6 or 7 cards and returns the best five-card hand.
 * Throws on duplicate cards — a duplicate means the deck logic is broken and
 * silently ranking it would hide the bug behind a plausible-looking result.
 */
export function evaluateHand(cards: readonly CardCode[]): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluateHand expects 5-7 cards, received ${cards.length}`);
  }
  if (new Set(cards).size !== cards.length) {
    throw new Error(`evaluateHand received duplicate cards: ${cards.join(' ')}`);
  }

  const sorted = [...cards].sort((a, b) => valueOf(b) - valueOf(a));

  const countByValue = new Map<number, CardCode[]>();
  const bySuit = new Map<Suit, CardCode[]>();
  let rankMask = 0;
  for (const c of sorted) {
    const v = valueOf(c);
    rankMask |= 1 << v;
    const group = countByValue.get(v);
    if (group) group.push(c);
    else countByValue.set(v, [c]);
    const s = suitOf(c);
    const suitGroup = bySuit.get(s);
    if (suitGroup) suitGroup.push(c);
    else bySuit.set(s, [c]);
  }

  let flushCards: CardCode[] | null = null;
  for (const group of bySuit.values()) {
    if (group.length >= 5) {
      flushCards = group; // already sorted descending
      break;
    }
  }

  // 1. Straight flush (incl. royal)
  if (flushCards) {
    let flushMask = 0;
    for (const c of flushCards) flushMask |= 1 << valueOf(c);
    const sfHigh = straightHigh(flushMask);
    if (sfHigh > 0) {
      return make('straight-flush', [sfHigh], straightCards(flushCards, sfHigh));
    }
  }

  // Rank multiplicities, highest value first.
  const groups = [...countByValue.entries()].sort((a, b) => {
    const byCount = b[1].length - a[1].length;
    return byCount !== 0 ? byCount : b[0] - a[0];
  });

  const first = groups[0];
  const second = groups[1];

  // 2. Four of a kind
  if (first && first[1].length === 4) {
    const kicker = sorted.find((c) => valueOf(c) !== first[0]);
    return make(
      'quads',
      [first[0], kicker ? valueOf(kicker) : 0],
      [...first[1], ...(kicker ? [kicker] : [])],
    );
  }

  // 3. Full house (trips + pair, or the higher of two trips + the other's pair)
  if (first && first[1].length === 3 && second && second[1].length >= 2) {
    return make(
      'full-house',
      [first[0], second[0]],
      [...first[1], ...second[1].slice(0, 2)],
    );
  }

  // 4. Flush
  if (flushCards) {
    const best = flushCards.slice(0, 5);
    return make('flush', best.map(valueOf), best);
  }

  // 5. Straight
  const stHigh = straightHigh(rankMask);
  if (stHigh > 0) {
    return make('straight', [stHigh], straightCards(sorted, stHigh));
  }

  // 6. Three of a kind
  if (first && first[1].length === 3) {
    const kickers = sorted.filter((c) => valueOf(c) !== first[0]).slice(0, 2);
    return make('trips', [first[0], ...kickers.map(valueOf)], [...first[1], ...kickers]);
  }

  // 7. Two pair
  if (first && first[1].length === 2 && second && second[1].length === 2) {
    const kicker = sorted.find((c) => valueOf(c) !== first[0] && valueOf(c) !== second[0]);
    return make(
      'two-pair',
      [first[0], second[0], kicker ? valueOf(kicker) : 0],
      [...first[1], ...second[1], ...(kicker ? [kicker] : [])],
    );
  }

  // 8. One pair
  if (first && first[1].length === 2) {
    const kickers = sorted.filter((c) => valueOf(c) !== first[0]).slice(0, 3);
    return make('pair', [first[0], ...kickers.map(valueOf)], [...first[1], ...kickers]);
  }

  // 9. High card
  const best = sorted.slice(0, 5);
  return make('high-card', best.map(valueOf), best);
}

/** Standard comparator: positive when `a` beats `b`, 0 on an exact chop. */
export function compareHands(a: HandRank, b: HandRank): number {
  return a.score - b.score;
}
