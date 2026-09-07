import { type Card, DECK_SIZE, rankOf, suitOf } from './cards';
import { CATEGORY, categoryOf, evaluate } from './evaluate';

export interface Equity {
  /** Share of the pot this hand expects to win, ties counted as half. */
  equity: number;
  win: number;
  tie: number;
  lose: number;
  samples: number;
}

/**
 * Monte Carlo equity against the given number of random opponent hands.
 *
 * Equity is computed here rather than asked of a language model. A model's
 * guess at a percentage is not a percentage, and the Brain Visualizer shows
 * this number to the viewer as fact.
 */
export function equityVsRandom(
  hole: readonly [Card, Card],
  board: readonly Card[],
  opponents: number,
  samples = 2000,
  random: () => number = Math.random,
): Equity {
  if (opponents < 1) throw new Error('need at least one opponent');

  const known = new Uint8Array(DECK_SIZE);
  known[hole[0]] = 1;
  known[hole[1]] = 1;
  for (const card of board) known[card] = 1;

  const stock: Card[] = [];
  for (let card = 0; card < DECK_SIZE; card++) if (!known[card]) stock.push(card);

  const boardNeeded = 5 - board.length;
  const draws = opponents * 2 + boardNeeded;
  if (draws > stock.length) throw new Error('not enough cards left to run out');

  const heroCards: Card[] = new Array(7);
  const opponentCards: Card[] = new Array(7);
  heroCards[0] = hole[0];
  heroCards[1] = hole[1];
  for (let i = 0; i < board.length; i++) {
    heroCards[2 + i] = board[i];
    opponentCards[2 + i] = board[i];
  }

  let win = 0;
  let tie = 0;

  for (let s = 0; s < samples; s++) {
    // Partial Fisher-Yates: only the cards this sample needs get shuffled.
    for (let i = 0; i < draws; i++) {
      const j = i + ((random() * (stock.length - i)) | 0);
      const swap = stock[i];
      stock[i] = stock[j];
      stock[j] = swap;
    }

    for (let i = 0; i < boardNeeded; i++) {
      const card = stock[i];
      heroCards[2 + board.length + i] = card;
      opponentCards[2 + board.length + i] = card;
    }

    const hero = evaluate(heroCards);

    let best = -1;
    for (let o = 0; o < opponents; o++) {
      const base = boardNeeded + o * 2;
      opponentCards[0] = stock[base];
      opponentCards[1] = stock[base + 1];
      const score = evaluate(opponentCards);
      if (score > best) best = score;
    }

    if (hero > best) win++;
    else if (hero === best) tie++;
  }

  const lose = samples - win - tie;
  return { equity: (win + tie / 2) / samples, win, tie, lose, samples };
}

export interface HandRead {
  /** Best made hand right now, using only the cards actually dealt. */
  made: string;
  category: number;
  /** Four to a flush with at least one card still to come. */
  flushDraw: boolean;
  /** Four to a straight that completes at either end. */
  openEnded: boolean;
  /** Four to a straight that completes only one way. */
  gutshot: boolean;
  /** Both hole cards rank above every board card. */
  overcards: boolean;
}

const CATEGORY_LABEL: Record<number, string> = {
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
 * Plain facts about a hand, in the vocabulary a player would use. These reach
 * both the model's prompt and the Brain Visualizer, so they must be true rather
 * than merely plausible.
 */
export function readHand(hole: readonly [Card, Card], board: readonly Card[]): HandRead {
  const cards = [hole[0], hole[1], ...board];
  const category =
    cards.length >= 5
      ? categoryOf(evaluate(cards))
      : rankOf(hole[0]) === rankOf(hole[1])
        ? CATEGORY.PAIR
        : CATEGORY.HIGH_CARD;

  const suitCounts = new Int8Array(4);
  for (const card of cards) suitCounts[suitOf(card)]++;
  const flushDraw = board.length > 0 && board.length < 5 && suitCounts.includes(4);

  let rankMask = 0;
  for (const card of cards) rankMask |= 1 << rankOf(card);
  const { openEnded, gutshot } =
    board.length > 0 && board.length < 5
      ? straightDraws(rankMask, category)
      : { openEnded: false, gutshot: false };

  const boardHigh = board.length ? Math.max(...board.map(rankOf)) : -1;
  const overcards = board.length > 0 && rankOf(hole[0]) > boardHigh && rankOf(hole[1]) > boardHigh;

  return { made: CATEGORY_LABEL[category] ?? 'high card', category, flushDraw, openEnded, gutshot, overcards };
}

/**
 * Straight draws over a 14-slot ladder: slot 0 is the ace playing low, slots
 * 1..13 run deuce to ace. A straight is five adjacent slots, so the wheel and
 * broadway both fall out without special cases.
 */
function straightDraws(rankMask: number, category: number): { openEnded: boolean; gutshot: boolean } {
  if (category >= CATEGORY.STRAIGHT) return { openEnded: false, gutshot: false };

  let ladder = rankMask << 1;
  if (rankMask & (1 << 12)) ladder |= 1;

  let openEnded = false;
  let gutshot = false;

  for (let start = 0; start + 3 <= 13; start++) {
    const run = 0b1111 << start;
    if ((ladder & run) !== run) continue;
    const completesLow = start - 1 >= 0;
    const completesHigh = start + 4 <= 13;
    if (completesLow && completesHigh) openEnded = true;
    else if (completesLow || completesHigh) gutshot = true;
  }

  for (let start = 0; start + 4 <= 13; start++) {
    let present = 0;
    let missing = -1;
    for (let i = 0; i < 5; i++) {
      if (ladder & (1 << (start + i))) present++;
      else missing = i;
    }
    if (present === 4 && missing > 0 && missing < 4) gutshot = true;
  }

  return { openEnded, gutshot: gutshot && !openEnded };
}
