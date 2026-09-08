import { cardName, type Card } from '../poker/cards';
import type { HandEvent } from '../poker/engine';

/**
 * Turning a stored hand back into something you can step through.
 *
 * A hand is written whole — its lineup, its board and every event in order —
 * so a replayer is a fold over data we already have rather than a second
 * engine. That matters for one reason beyond simplicity: **the events are
 * exactly what a spectator was entitled to see at the time.**
 *
 * The hand also stores its seed, and re-running `startHand` with it would
 * reproduce every hole card including the ones that were folded and never
 * shown. That would turn the replayer into a way to study an opponent's
 * folding range, which is not something a player agreed to when they sat down.
 * So this reads the events and nothing else: a hand appears in a frame only if
 * a `showdown` event put it there.
 *
 * Pure, so it runs on the server for the first paint and in the browser for
 * every step after it.
 */

export interface ReplaySeat {
  seatIndex: number;
  agentId: string;
  name: string;
  startingStack: number;
}

export interface ReplaySeatFrame {
  seatIndex: number;
  agentId: string;
  name: string;
  stack: number;
  /** Chips this seat has put in across the whole hand so far. */
  contributed: number;
  folded: boolean;
  allIn: boolean;
  /** Only ever set from a showdown event. A mucked hand stays mucked. */
  hole: string[] | null;
  lastAction: string | null;
  lastAmount: number;
  /** Chips pushed to this seat at the end, once the pot is awarded. */
  won: number;
}

export interface ReplayFrame {
  /** What just happened, as a sentence. */
  headline: string;
  street: string;
  board: string[];
  pot: number;
  seats: ReplaySeatFrame[];
  /** Which seat this frame is about, when it is about one. */
  seat: number | null;
  /**
   * Index into the hand's decision rows, when this frame is an action a model
   * actually made. Blinds and board cards are not decisions.
   */
  decision: number | null;
}

/** A decision row as the replayer needs it. The rest of the row is not its business. */
export interface ReplayDecision {
  street: string;
  equity: number;
  reasoning: string;
  say: string | null;
  action: string;
  amount: number;
  elapsedMs: number;
  outcome: 'decided' | 'timeout' | 'error';
  handRead: { made?: string; flushDraw?: boolean; openEnded?: boolean; gutshot?: boolean } | null;
}

const STREET_NAMES: Record<string, string> = {
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
  complete: 'Showdown',
};

/**
 * One frame per thing that happened, in order.
 *
 * Blinds are folded into the opening frame rather than given one each: nobody
 * steps through a hand to watch the small blind be posted, and three frames
 * before anything is decided is three clicks before the hand starts.
 */
export function buildReplay(lineup: ReplaySeat[], events: HandEvent[]): ReplayFrame[] {
  const seats = new Map<number, ReplaySeatFrame>(
    lineup.map((seat) => [
      seat.seatIndex,
      {
        seatIndex: seat.seatIndex,
        agentId: seat.agentId,
        name: seat.name,
        stack: seat.startingStack,
        contributed: 0,
        folded: false,
        allIn: false,
        hole: null,
        lastAction: null,
        lastAmount: 0,
        won: 0,
      },
    ]),
  );

  const frames: ReplayFrame[] = [];
  const board: Card[] = [];
  let street = 'preflop';
  let pot = 0;
  let decisionIndex = 0;
  const blinds: string[] = [];

  const snapshot = (headline: string, seat: number | null, decision: number | null): void => {
    frames.push({
      headline,
      street,
      board: board.map(cardName),
      pot,
      seats: [...seats.values()].map((entry) => ({ ...entry })),
      seat,
      decision,
    });
  };

  for (const event of events) {
    switch (event.type) {
      case 'blind': {
        const seat = seats.get(event.seat);
        if (!seat) break;
        seat.stack -= event.amount;
        seat.contributed += event.amount;
        seat.allIn = event.allIn;
        pot += event.amount;
        blinds.push(`${seat.name} posts the ${event.kind} blind, ${event.amount}`);
        break;
      }

      case 'hole-dealt':
        // The blinds are down and everybody has cards: this is the hand as it
        // was when the first decision was asked for.
        snapshot(blinds.join('. ') || 'The hand is dealt.', null, null);
        break;

      case 'action': {
        const seat = seats.get(event.seat);
        if (!seat) break;
        seat.stack -= event.amount;
        seat.contributed += event.amount;
        seat.lastAction = event.action;
        seat.lastAmount = event.amount;
        if (event.action === 'fold') seat.folded = true;
        if (event.allIn) seat.allIn = true;
        pot += event.amount;
        // Actions and decision rows are written in the same order, one for
        // one, so position is the whole of the pairing.
        snapshot(describeAction(seat.name, event.action, event.amount, event.to), event.seat, decisionIndex);
        decisionIndex += 1;
        break;
      }

      case 'street': {
        street = event.street;
        board.push(...event.cards);
        snapshot(
          `${STREET_NAMES[event.street] ?? event.street}: ${event.cards.map(cardName).join(' ')}`,
          null,
          null,
        );
        break;
      }

      case 'showdown': {
        const seat = seats.get(event.seat);
        if (!seat) break;
        street = 'showdown';
        seat.hole = [...event.hole].map(cardName);
        snapshot(`${seat.name} shows ${seat.hole.join(' ')}`, event.seat, null);
        break;
      }

      case 'award': {
        const seat = seats.get(event.seat);
        if (!seat) break;
        seat.stack += event.amount;
        seat.won += event.amount;
        pot -= event.amount;
        street = 'complete';
        snapshot(
          event.uncontested
            ? `${seat.name} takes the pot, ${event.amount}, uncontested`
            : `${seat.name} wins ${event.amount}`,
          event.seat,
          null,
        );
        break;
      }

      default:
        break;
    }
  }

  // A hand with no events at all should still show its seats rather than an
  // empty scrubber.
  if (frames.length === 0) snapshot('Nothing was recorded for this hand.', null, null);
  return frames;
}

function describeAction(name: string, action: string, amount: number, to: number): string {
  switch (action) {
    case 'fold':
      return `${name} folds`;
    case 'check':
      return `${name} checks`;
    case 'call':
      return `${name} calls ${amount}`;
    case 'bet':
      return `${name} bets ${to}`;
    case 'raise':
      return `${name} raises to ${to}`;
    default:
      return `${name} acts`;
  }
}

/** Net chips each seat took out of the hand, for the summary line. */
export function netResults(frames: ReplayFrame[], lineup: ReplaySeat[]): Array<{ name: string; net: number }> {
  const last = frames.at(-1);
  if (!last) return [];
  return lineup.map((seat) => {
    const finished = last.seats.find((entry) => entry.seatIndex === seat.seatIndex);
    return { name: seat.name, net: (finished?.stack ?? seat.startingStack) - seat.startingStack };
  });
}
