/** Card / hand primitives shared by the engine and the UI. */

export const SUITS = ['c', 'd', 'h', 's'] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export type Rank = (typeof RANKS)[number];

/** Two-character card code, e.g. `As`, `Td`, `7c`. */
export type CardCode = `${Rank}${Suit}`;

export const SUIT_NAMES: Readonly<Record<Suit, string>> = {
  c: 'clubs',
  d: 'diamonds',
  h: 'hearts',
  s: 'spades',
};

export const RANK_NAMES: Readonly<Record<Rank, string>> = {
  '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8',
  '9': '9', T: '10', J: 'jack', Q: 'queen', K: 'king', A: 'ace',
};

/** Path of the CC0 SVG for a card, relative to the web app's `public/`. */
export function cardAssetPath(card: CardCode): string {
  const rank = card[0] as Rank;
  const suit = card[1] as Suit;
  return `/assets/cards/${SUIT_NAMES[suit]}_${RANK_NAMES[rank]}.svg`;
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export type ActionType = 'fold' | 'check' | 'call' | 'raise' | 'all-in';

export interface PlayerAction {
  readonly type: ActionType;
  /** Total chips the player is putting in *this street* after the action. */
  readonly amount: number;
}

export const HAND_CATEGORIES = [
  'high-card',
  'pair',
  'two-pair',
  'trips',
  'straight',
  'flush',
  'full-house',
  'quads',
  'straight-flush',
] as const;
export type HandCategory = (typeof HAND_CATEGORIES)[number];

export const HAND_CATEGORY_LABEL: Readonly<Record<HandCategory, string>> = {
  'high-card': 'High Card',
  pair: 'Pair',
  'two-pair': 'Two Pair',
  trips: 'Three of a Kind',
  straight: 'Straight',
  flush: 'Flush',
  'full-house': 'Full House',
  quads: 'Four of a Kind',
  'straight-flush': 'Straight Flush',
};

export interface HandRank {
  readonly category: HandCategory;
  /** Higher is better. Comparable with a plain `-` across all categories. */
  readonly score: number;
  /** The five cards that make the hand. */
  readonly cards: readonly CardCode[];
  readonly label: string;
}
