import type { Street } from '../poker/engine';
import type { DecisionOutcome } from '../agent/decision';

/**
 * What a spectator is allowed to know. Hole cards are omitted unless they
 * belong to the viewer's own agent or have been shown at a real showdown, so
 * redaction happens on the server and never in the browser.
 */

export type SeatStatus = 'empty' | 'waiting' | 'thinking' | 'acted' | 'folded' | 'all-in';

export interface SeatView {
  index: number;
  agentId: string | null;
  name: string | null;
  /** Chip colour id from the asset palette. */
  color: string | null;
  stack: number;
  committed: number;
  status: SeatStatus;
  isDealer: boolean;
  /** Present only when this viewer is entitled to see them. */
  hole: string[] | null;
  /** Milliseconds the last decision took, with no reason attached. */
  lastActionMs: number | null;
  lastAction: string | null;
  /** Chips the last action put in, and the level it put this seat at. */
  lastActionAmount: number | null;
  lastActionTo: number | null;
  /** Chips won this hand, held until the next one is dealt. */
  won: number | null;
  /** The blind this seat was made to post, until it acts of its own accord. */
  blind: { kind: 'small' | 'big'; amount: number } | null;
  say: string | null;
}

export interface BrainView {
  seat: number;
  /** Carried here rather than looked up, because a seat can empty between hands. */
  seatName: string | null;
  color: string | null;
  street: Street;
  /** Reasoning as it has arrived so far. */
  reasoning: string;
  equity: number | null;
  handRead: {
    made: string;
    flushDraw: boolean;
    openEnded: boolean;
    gutshot: boolean;
    overcards: boolean;
  } | null;
  potOdds: number | null;
  action: string | null;
  amount: number | null;
  outcome: DecisionOutcome | null;
  /** Plain statement of what went wrong, shown only on the terminal half. */
  failure: string | null;
  elapsedMs: number | null;
}

export interface TableView {
  tableId: string;
  label: string;
  format: string;
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  handNumber: number;
  street: Street | 'idle';
  board: string[];
  pot: number;
  seats: SeatView[];
  toAct: number | null;
  /** Epoch milliseconds the act clock expires, if a seat is thinking. */
  deadline: number | null;
  /**
   * Milliseconds left on the act clock when this was rendered. The viewer's
   * clock is not the server's, so a countdown reads this and runs against its
   * own clock rather than subtracting a foreign epoch.
   */
  remainingMs: number | null;
  brain: BrainView | null;
  log: LogLine[];
}

export interface LogLine {
  id: number;
  at: number;
  text: string;
  seat: number | null;
}

export type ArenaEvent =
  | { type: 'snapshot'; table: TableView }
  | { type: 'hand-start'; handNumber: number; button: number; seats: SeatView[] }
  | {
      type: 'to-act';
      seat: number;
      seatName: string;
      color: string;
      deadline: number;
      /** Milliseconds on the clock, counted down against the viewer's own. */
      remainingMs: number;
      potOdds: number | null;
      street: Street;
    }
  | { type: 'reasoning'; seat: number; delta: string }
  | { type: 'equity'; seat: number; equity: number; handRead: BrainView['handRead'] }
  | {
      type: 'decision';
      seat: number;
      action: string;
      amount: number;
      to: number;
      equity: number;
      handRead: BrainView['handRead'];
      outcome: DecisionOutcome;
      failure: string | null;
      elapsedMs: number;
      say: string | null;
      reasoning: string;
      stack: number;
      committed: number;
      pot: number;
    }
  | { type: 'street'; street: Street; cards: string[]; pot: number }
  | { type: 'showdown'; seat: number; hole: string[]; hand: string }
  | { type: 'award'; seat: number; amount: number; uncontested: boolean; stack: number }
  | { type: 'hand-end'; stacks: Array<{ seat: number; stack: number }> }
  | { type: 'seats'; seats: SeatView[] }
  | { type: 'log'; line: LogLine }
  | { type: 'idle'; reason: string };
