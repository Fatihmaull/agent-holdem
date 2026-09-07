/**
 * A card is an integer 0..51. Rank is `card / 4`, suit is `card % 4`.
 * Ranks run 0 (deuce) to 12 (ace). Suits are ordered to match the asset
 * filenames in `public/cards`, so `cardName(card)` is also the image stem.
 */
export type Card = number;

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
const SUITS = ['c', 'd', 'h', 's'] as const;

type RankChar = (typeof RANKS)[number];
type SuitChar = (typeof SUITS)[number];

export const DECK_SIZE = 52;

export function rankOf(card: Card): number {
  return (card / 4) | 0;
}

export function suitOf(card: Card): number {
  return card % 4;
}

function makeCard(rank: number, suit: number): Card {
  return rank * 4 + suit;
}

/** `"As"`, `"Th"`, `"2c"`. Matches `public/cards/<name>.png`. */
export function cardName(card: Card): string {
  return RANKS[rankOf(card)] + SUITS[suitOf(card)];
}

export function parseCard(name: string): Card {
  const rank = RANKS.indexOf(name[0]?.toUpperCase() as RankChar);
  const suit = SUITS.indexOf(name[1]?.toLowerCase() as SuitChar);
  if (rank < 0 || suit < 0) throw new Error(`not a card: ${name}`);
  return makeCard(rank, suit);
}

export function fullDeck(): Card[] {
  return Array.from({ length: DECK_SIZE }, (_, i) => i);
}

/** Fisher-Yates. Takes the random source so hands can be replayed from a seed. */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = (random() * (i + 1)) | 0;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Deterministic 32-bit PRNG. Hands are dealt from a seed so a match can be
 * replayed exactly, which matters for the landing page's replay of the last hand.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two hole cards in the shorthand players use: `AKs`, `AKo`, `77`. */
export function holeShorthand(a: Card, b: Card): string {
  const [hi, lo] = rankOf(a) >= rankOf(b) ? [a, b] : [b, a];
  const ranks = RANKS[rankOf(hi)] + RANKS[rankOf(lo)];
  if (rankOf(hi) === rankOf(lo)) return ranks;
  return ranks + (suitOf(hi) === suitOf(lo) ? 's' : 'o');
}
