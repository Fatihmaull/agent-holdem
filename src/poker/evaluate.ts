import { type Card, rankOf, suitOf } from './cards';

/**
 * Hand categories, ordered weakest to strongest. The numeric value is the top
 * field of the packed score, so a higher category always beats a lower one.
 */
export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
} as const;

export type Category = (typeof CATEGORY)[keyof typeof CATEGORY];

const CATEGORY_NAMES: Record<Category, string> = {
  [CATEGORY.HIGH_CARD]: 'high card',
  [CATEGORY.PAIR]: 'pair',
  [CATEGORY.TWO_PAIR]: 'two pair',
  [CATEGORY.TRIPS]: 'three of a kind',
  [CATEGORY.STRAIGHT]: 'straight',
  [CATEGORY.FLUSH]: 'flush',
  [CATEGORY.FULL_HOUSE]: 'full house',
  [CATEGORY.QUADS]: 'four of a kind',
  [CATEGORY.STRAIGHT_FLUSH]: 'straight flush',
};

/**
 * Packs a category and five ordered tiebreak ranks into one comparable integer:
 * `cat << 20 | k1 << 16 | k2 << 12 | k3 << 8 | k4 << 4 | k5`.
 * Unused kicker slots are zero, which is safe because a real kicker is a rank
 * index 0..12 and slots are filled left to right.
 */
function pack(category: number, kickers: number[]): number {
  let score = category << 20;
  for (let i = 0; i < 5; i++) score |= (kickers[i] ?? 0) << (16 - i * 4);
  return score;
}

/** Ranks present, as a 13-bit mask. Bit 0 is a deuce, bit 12 an ace. */
const WHEEL = 0b1000000001111; // A,5,4,3,2

/** Highest rank that completes a five-card run in `mask`, or -1. */
function straightHigh(mask: number): number {
  for (let high = 12; high >= 4; high--) {
    const run = 0b11111 << (high - 4);
    if ((mask & run) === run) return high;
  }
  return (mask & WHEEL) === WHEEL ? 3 : -1; // wheel plays as five-high
}

/**
 * Scores the best five-card hand out of five to seven cards.
 * Returns a packed integer; compare two scores with `<` and `>`.
 */
export function evaluate(cards: Card[]): number {
  const rankCounts = new Int8Array(13);
  const suitCounts = new Int8Array(4);
  const suitMasks = new Int16Array(4);
  let rankMask = 0;

  for (const card of cards) {
    const rank = rankOf(card);
    const suit = suitOf(card);
    rankCounts[rank]++;
    suitCounts[suit]++;
    suitMasks[suit] |= 1 << rank;
    rankMask |= 1 << rank;
  }

  for (let suit = 0; suit < 4; suit++) {
    if (suitCounts[suit] < 5) continue;

    const high = straightHigh(suitMasks[suit]);
    if (high >= 0) return pack(CATEGORY.STRAIGHT_FLUSH, [high]);

    const flush: number[] = [];
    for (let rank = 12; rank >= 0 && flush.length < 5; rank--) {
      if (suitMasks[suit] & (1 << rank)) flush.push(rank);
    }
    return pack(CATEGORY.FLUSH, flush);
  }

  // Ranks grouped by how many of them there are, each group high to low.
  const quads: number[] = [];
  const trips: number[] = [];
  const pairs: number[] = [];
  const singles: number[] = [];
  for (let rank = 12; rank >= 0; rank--) {
    const count = rankCounts[rank];
    if (count === 4) quads.push(rank);
    else if (count === 3) trips.push(rank);
    else if (count === 2) pairs.push(rank);
    else if (count === 1) singles.push(rank);
  }

  if (quads.length) {
    const kicker = Math.max(...trips, ...pairs, ...singles, -1);
    return pack(CATEGORY.QUADS, [quads[0], kicker]);
  }

  if (trips.length >= 2) return pack(CATEGORY.FULL_HOUSE, [trips[0], trips[1]]);
  if (trips.length && pairs.length) return pack(CATEGORY.FULL_HOUSE, [trips[0], pairs[0]]);

  const high = straightHigh(rankMask);
  if (high >= 0) return pack(CATEGORY.STRAIGHT, [high]);

  if (trips.length) return pack(CATEGORY.TRIPS, [trips[0], ...singles.slice(0, 2)]);
  if (pairs.length >= 2) {
    const kicker = Math.max(...pairs.slice(2), ...singles, -1);
    return pack(CATEGORY.TWO_PAIR, [pairs[0], pairs[1], kicker]);
  }
  if (pairs.length) return pack(CATEGORY.PAIR, [pairs[0], ...singles.slice(0, 3)]);
  return pack(CATEGORY.HIGH_CARD, singles.slice(0, 5));
}

export function categoryOf(score: number): Category {
  return (score >> 20) as Category;
}

export function describe(score: number): string {
  return CATEGORY_NAMES[categoryOf(score)];
}
