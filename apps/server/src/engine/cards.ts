import { createHash, randomBytes } from 'node:crypto';
import { RANKS, SUITS, type CardCode, type Rank, type Suit } from '@agentholdem/shared';

/** All 52 cards, in a fixed canonical order. */
export const FULL_DECK: readonly CardCode[] = SUITS.flatMap((s) =>
  RANKS.map((r) => `${r}${s}` as CardCode),
);

export function rankOf(card: CardCode): Rank {
  return card[0] as Rank;
}

export function suitOf(card: CardCode): Suit {
  return card[1] as Suit;
}

/** 0 (deuce) .. 12 (ace). */
export function rankValue(card: CardCode): number {
  return RANKS.indexOf(rankOf(card));
}

/**
 * Deterministic PRNG (mulberry32) seeded from a hex string.
 *
 * Determinism is the point: every hand publishes `sha256(seed)` before the
 * deal and the seed itself afterwards, so a spectator can replay the exact
 * shuffle and check that the server did not deal itself a better board.
 */
export function makeRng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let a = h >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newSeed(): string {
  return randomBytes(16).toString('hex');
}

export function commitToSeed(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

/** Fisher-Yates, driven entirely by the seeded PRNG. */
export function shuffledDeck(seed: string): CardCode[] {
  const rng = makeRng(seed);
  const deck = [...FULL_DECK];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = deck[i] as CardCode;
    const b = deck[j] as CardCode;
    deck[i] = b;
    deck[j] = a;
  }
  return deck;
}

/**
 * Canonical deal layout.
 *
 * Cards leave the deck in real-table order: hole cards one at a time around
 * the table, then burn/flop, burn/turn, burn/river. Publishing the procedure
 * alongside the seed is what makes the commitment meaningful — anyone can
 * recompute the exact board from `seed` and `playerCount`.
 */
export interface DealLayout {
  holeCards: CardCode[][];
  flop: CardCode[];
  turn: CardCode;
  river: CardCode;
  burns: CardCode[];
}

export function layoutDeal(seed: string, playerCount: number): DealLayout {
  if (playerCount < 2 || playerCount > 10) {
    throw new Error(`layoutDeal supports 2-10 players, got ${playerCount}`);
  }
  const deck = shuffledDeck(seed);
  let i = 0;
  const take = (): CardCode => {
    const c = deck[i++];
    if (!c) throw new Error('Deck exhausted');
    return c;
  };

  const holeCards: CardCode[][] = Array.from({ length: playerCount }, () => []);
  for (let round = 0; round < 2; round++) {
    for (let p = 0; p < playerCount; p++) {
      (holeCards[p] as CardCode[]).push(take());
    }
  }
  const burns: CardCode[] = [];
  burns.push(take());
  const flop = [take(), take(), take()];
  burns.push(take());
  const turn = take();
  burns.push(take());
  const river = take();

  return { holeCards, flop, turn, river, burns };
}

/**
 * Replays a revealed seed and checks it reproduces both the pre-deal
 * commitment and the board that was actually shown.
 */
export function verifyShuffle(
  seed: string,
  commitment: string,
  playerCount: number,
  expectedBoard: readonly CardCode[],
): boolean {
  if (commitToSeed(seed) !== commitment) return false;
  const layout = layoutDeal(seed, playerCount);
  const board = [...layout.flop, layout.turn, layout.river];
  return expectedBoard.every((c, idx) => board[idx] === c);
}
