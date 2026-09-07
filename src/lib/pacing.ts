/** Shortest a decision is held on screen, and the hard ceiling on making one. */
export const PACE_FLOOR_MS = 1_500;
export const PACE_SPREAD_MS = 3_500;
export const ACT_CLOCK_MS = 30_000;

/**
 * The beats between things happening.
 *
 * A hand that resolves as fast as the engine can resolve it is unreadable: six
 * decisions, three streets and a showdown arrive inside a second and a viewer
 * sees only the aftermath. Every beat below buys back one thing a spectator has
 * to be able to read before the next thing overwrites it, so they are sized by
 * what is on screen during them rather than by taste.
 */
/** A decision stays alone on screen before the next seat is put to act. */
export const ACTION_BEAT_MS = 900;
/** The lull after the last bet of a street, before the board changes. */
export const STREET_BEAT_MS = 1_500;
/** New board cards are read before anybody acts on them. */
export const STREET_SETTLE_MS = 1_000;
/** The pause on a finished board, before anyone turns a hand over. */
export const SHOWDOWN_BEAT_MS = 1_400;
/** One hand is turned over at a time, the way a live showdown runs. */
export const REVEAL_BEAT_MS = 750;
/** The pot sits whole after the last reveal, before it is pushed to a winner. */
export const AWARD_BEAT_MS = 1_100;
/** The winner keeps the pot on screen before the table is cleared. */
export const HAND_END_BEAT_MS = 1_700;
/** The table sits empty between hands. */
export const BETWEEN_HANDS_MS = 4_000;

/**
 * How long to hold a decision on screen.
 *
 * A decision far from the break-even price resolves quickly; one sitting on top
 * of it stalls. That is what makes an agent look like it is agonising rather
 * than computing, and it is honest, because the gap between equity and price is
 * exactly what made the decision hard. The model's own latency counts toward
 * this floor, so a slow answer is never padded further.
 */
export function pacingFloor(equity: number, potOdds: number | null): number {
  const breakEven = potOdds ?? 0.5;
  const gap = Math.abs(equity - breakEven);
  const tension = Math.max(0, Math.min(1, 1 - gap / 0.35));
  return PACE_FLOOR_MS + tension * PACE_SPREAD_MS;
}
