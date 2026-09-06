/**
 * Room modes.
 *
 * A room's identity is its *prompt word budget*. The budget is enforced twice:
 * client-side by the live word counter in the Strategy Lab, and server-side on
 * enrolment (the server is the authority — a hand-crafted WebSocket frame does
 * not get to smuggle a 400 word prompt into the Micro room).
 */
export type RoomModeKey = 'micro' | 'tactical' | 'deep';

export interface RoomMode {
  readonly key: RoomModeKey;
  readonly label: string;
  readonly wordLimit: 10 | 50 | 100;
  readonly tagline: string;
  /** Tailwind-friendly accent, kept here so server-rendered logs match the UI. */
  readonly accent: string;
}

export const ROOM_MODES: readonly RoomMode[] = [
  {
    key: 'micro',
    label: 'Micro-Prompt',
    wordLimit: 10,
    tagline: 'Ten words. Every one has to earn its seat.',
    accent: '#22d3ee',
  },
  {
    key: 'tactical',
    label: 'Tactical',
    wordLimit: 50,
    tagline: 'Room for a persona plus conditional lines.',
    accent: '#a78bfa',
  },
  {
    key: 'deep',
    label: 'Deep Strategy',
    wordLimit: 100,
    tagline: 'Full strategy trees and layered bluffing scripts.',
    accent: '#fbbf24',
  },
] as const;

export const ROOM_MODE_BY_KEY: Readonly<Record<RoomModeKey, RoomMode>> = Object.fromEntries(
  ROOM_MODES.map((m) => [m.key, m]),
) as Readonly<Record<RoomModeKey, RoomMode>>;

export type TableFormat = 'heads-up' | 'multi';

export interface TableConfig {
  readonly id: string;
  readonly name: string;
  readonly mode: RoomModeKey;
  readonly format: TableFormat;
  /** Seats available. Heads-up is always 2. */
  readonly maxSeats: number;
  /** Chips deducted from bankroll to sit down. */
  readonly buyInChips: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** Hands played before the table settles and pays out. */
  readonly handsPerSession: number;
}

/**
 * Counts words the same way on the server and in the browser so the live
 * counter in the Strategy Lab can never disagree with the enrolment check.
 * Hyphenated compounds count once; punctuation-only tokens do not count.
 */
export function countWords(text: string): number {
  const matches = text
    .normalize('NFKC')
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu);
  return matches ? matches.length : 0;
}

export function validatePromptForMode(
  text: string,
  mode: RoomModeKey,
): { ok: true; words: number } | { ok: false; words: number; limit: number; reason: string } {
  const limit = ROOM_MODE_BY_KEY[mode].wordLimit;
  const words = countWords(text);
  if (words === 0) {
    return { ok: false, words, limit, reason: 'Prompt is empty.' };
  }
  if (words > limit) {
    return {
      ok: false,
      words,
      limit,
      reason: `Prompt is ${words} words; the ${ROOM_MODE_BY_KEY[mode].label} room allows ${limit}.`,
    };
  }
  return { ok: true, words };
}
