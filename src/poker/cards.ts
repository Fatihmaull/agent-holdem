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

/**
 * Fisher-Yates over whatever random source it is given.
 *
 * Only as unpredictable as that source, so it is for tests and simulations. A
 * deck a real hand is dealt from comes from `src/server/deck.ts`.
 */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = (random() * (i + 1)) | 0;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A copy of a deck, refused unless it is all 52 cards exactly once.
 *
 * A deck arriving from outside the engine that repeated a card or dropped one
 * would still deal, and the hand it dealt would be wrong in a way no later check
 * notices.
 */
export function checkedDeck(deck: readonly Card[]): Card[] {
  const seen = new Uint8Array(DECK_SIZE);
  for (const card of deck) {
    if (!Number.isInteger(card) || card < 0 || card >= DECK_SIZE || seen[card]) {
      throw new Error('a deck is every card exactly once');
    }
    seen[card] = 1;
  }
  if (deck.length !== DECK_SIZE) throw new Error('a deck is every card exactly once');
  return [...deck];
}

/**
 * Deterministic 32-bit PRNG, for tests that need the same hand twice.
 *
 * Never deals a real hand. Its whole state is one 32-bit number, and a seat
 * shown its hole cards and a flop can search that space in seconds.
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
