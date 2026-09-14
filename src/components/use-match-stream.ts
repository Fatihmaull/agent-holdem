'use client';

import { useEffect, useReducer } from 'react';
import type { ArenaEvent, LogLine, SeatView, TableView } from '@/server/view';

export interface StreamState {
  table: TableView | null;
  /** Whether a seat is deciding right now. */
  isStreaming: boolean;
  idleReason: string | null;
  connected: boolean;
  /** Seats whose stack changed on the last event, so the figure settles once. */
  moved: number[];
  /**
   * A counter per seat that steps every time that seat acts. It is the key the
   * action badge is drawn under, so a second identical action still replays the
   * animation instead of the same element sitting there unchanged.
   */
  actionKeys: Record<number, number>;
  /** Steps whenever the pot grows, so the figure can react to money arriving. */
  potKey: number;
}

const initial: StreamState = {
  table: null,
  isStreaming: false,
  idleReason: null,
  connected: false,
  moved: [],
  actionKeys: {},
  potKey: 0,
};

type Action = { type: 'event'; event: ArenaEvent } | { type: 'connected'; value: boolean };

function reduce(state: StreamState, action: Action): StreamState {
  if (action.type === 'connected') return { ...state, connected: action.value };

  const event = action.event;
  const table = state.table;

  switch (event.type) {
    case 'snapshot':
      return {
        ...state,
        // The server's epoch is not this browser's. Anchoring what is left of
        // the clock to the local one keeps the countdown honest across skew.
        table: {
          ...event.table,
          deadline: event.table.remainingMs === null ? null : Date.now() + event.table.remainingMs,
        },
        idleReason: null,
        isStreaming: event.table.toAct !== null,
        moved: [],
        actionKeys: {},
        potKey: state.potKey + 1,
      };

    case 'idle':
      return { ...state, idleReason: event.reason };

    case 'to-act':
      if (!table) return state;
      return {
        ...state,
        idleReason: null,
        isStreaming: true,
        moved: [],
        table: {
          ...table,
          street: event.street,
          toAct: event.seat,
          deadline: Date.now() + event.remainingMs,
          seats: table.seats.map((seat) =>
            seat.index === event.seat
              ? { ...seat, status: 'thinking', say: null, lastAction: null, lastActionAmount: null }
              : seat,
          ),
          brain: {
            seat: event.seat,
            seatName: event.seatName,
            color: event.color,
            street: event.street,
            reasoning: '',
            equity: null,
            handRead: null,
            potOdds: event.potOdds,
            action: null,
            amount: null,
            outcome: null,
            failure: null,
            elapsedMs: null,
            sealed: true,
          },
        },
      };

    case 'decision': {
      if (!table) return state;
      return {
        ...state,
        isStreaming: false,
        moved: [event.seat],
        actionKeys: { ...state.actionKeys, [event.seat]: (state.actionKeys[event.seat] ?? 0) + 1 },
        // Only money moving beats the pot. A fold is an action and changes
        // nothing in the middle, so it must not make the middle react.
        potKey: event.pot === table.pot ? state.potKey : state.potKey + 1,
        table: {
          ...table,
          pot: event.pot,
          toAct: null,
          deadline: null,
          seats: table.seats.map((seat) =>
            seat.index === event.seat
              ? {
                  ...seat,
                  stack: event.stack,
                  committed: event.committed,
                  status: event.action === 'fold' ? 'folded' : event.stack === 0 ? 'all-in' : 'acted',
                  lastAction: event.action,
                  lastActionMs: event.elapsedMs,
                  lastActionAmount: event.amount,
                  lastActionTo: event.to,
                  say: event.say,
                }
              : seat,
          ),
          brain: {
            seat: event.seat,
            seatName: table.brain?.seatName ?? null,
            color: table.brain?.color ?? null,
            street: table.brain?.street ?? (table.street === 'idle' ? 'preflop' : table.street),
            reasoning: '',
            equity: null,
            handRead: null,
            potOdds: table.brain?.potOdds ?? null,
            action: event.action,
            amount: event.amount,
            outcome: event.outcome,
            failure: event.failure,
            elapsedMs: event.elapsedMs,
            sealed: true,
          },
        },
      };
    }

    case 'reveal':
      if (!table) return state;
      return { ...state, isStreaming: false, table: { ...table, brain: event.brain } };

    case 'street': {
      if (!table) return state;
      // A snapshot can arrive holding cards this event is also carrying. The
      // board is a set of five, so anything already dealt is not dealt again.
      const fresh = event.cards.filter((card) => !table.board.includes(card));
      return {
        ...state,
        potKey: event.pot === table.pot ? state.potKey : state.potKey + 1,
        table: {
          ...table,
          street: event.street,
          board: [...table.board, ...fresh].slice(0, 5),
          pot: event.pot,
          seats: table.seats.map((seat) => ({
            ...seat,
            committed: 0,
            say: null,
            // The chips this said are in the pot now, so the words go with them.
            // A blind belongs to the same sweep: it was a preflop obligation.
            lastAction: null,
            lastActionAmount: null,
            lastActionTo: null,
            blind: null,
          })),
        },
      };
    }

    case 'showdown':
      if (!table) return state;
      return {
        ...state,
        table: {
          ...table,
          seats: table.seats.map((seat) => (seat.index === event.seat ? { ...seat, hole: event.hole } : seat)),
        },
      };

    case 'award':
      if (!table) return state;
      return {
        ...state,
        moved: [...state.moved, event.seat],
        table: {
          ...table,
          seats: table.seats.map((seat) =>
            seat.index === event.seat
              ? { ...seat, stack: event.stack, won: (seat.won ?? 0) + event.amount }
              : seat,
          ),
        },
      };

    case 'hand-end':
      if (!table) return state;
      return {
        ...state,
        isStreaming: false,
        table: {
          ...table,
          pot: 0,
          toAct: null,
          deadline: null,
          seats: table.seats.map((seat) => {
            const found = event.stacks.find((entry) => entry.seat === seat.index);
            return found ? { ...seat, stack: found.stack, committed: 0 } : seat;
          }),
        },
      };

    case 'log':
      if (!table) return state;
      return { ...state, table: { ...table, log: appendLog(table.log, event.line) } };

    default:
      return state;
  }
}

function appendLog(log: LogLine[], line: LogLine): LogLine[] {
  const next = [...log, line];
  return next.length > 60 ? next.slice(-60) : next;
}

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Subscribes to one table's feed. Passing null subscribes to nothing, which
 * lets a page decide what to watch without breaking the rules of hooks.
 *
 * A dropped connection is retried by the browser itself, but a refused one is
 * not: `EventSource` gives up for good on anything other than a 200, and a 503
 * is what the feed answers while a deploy hands the room from one process to
 * the next. So a source the browser has closed is reopened here, backing off,
 * until the match says it is over.
 */
export function useMatchStream(matchId: string | null): StreamState {
  const [state, dispatch] = useReducer(reduce, initial);

  useEffect(() => {
    if (!matchId) return;

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let over = false;
    let delay = RETRY_MIN_MS;

    const open = () => {
      const current = new EventSource(`/api/matches/${matchId}/stream`);
      source = current;

      current.onopen = () => {
        delay = RETRY_MIN_MS;
        dispatch({ type: 'connected', value: true });
      };
      current.onerror = () => {
        dispatch({ type: 'connected', value: false });
        if (over || current.readyState !== EventSource.CLOSED) return;
        retry = setTimeout(open, delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      };
      current.onmessage = (message) => {
        let event: ArenaEvent;
        try {
          event = JSON.parse(message.data) as ArenaEvent;
        } catch {
          // A malformed frame is dropped rather than breaking the arena.
          return;
        }
        // Nothing more is coming, and reconnecting would only be told so again.
        if (event.type === 'idle') {
          over = true;
          current.close();
        }
        dispatch({ type: 'event', event });
      };
    };

    open();

    return () => {
      over = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [matchId]);

  return state;
}

export function seatLabel(seat: SeatView): string {
  return seat.name ?? `Seat ${seat.index + 1}`;
}
