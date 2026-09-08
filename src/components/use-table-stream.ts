'use client';

import { useEffect, useReducer } from 'react';
import type { ArenaEvent, LogLine, SeatView, TableView } from '@/server/view';

export interface StreamState {
  table: TableView | null;
  /** Reasoning as it arrives, before the decision lands. */
  streaming: string;
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
  /**
   * The most recent hand this table has finished and stored, so a spectator
   * can open what they have just watched. Null until one completes while the
   * page is open — a snapshot cannot carry it, because a snapshot describes
   * the hand being played rather than the one before it.
   */
  lastHand: { id: string; number: number } | null;
}

const initial: StreamState = {
  table: null,
  streaming: '',
  isStreaming: false,
  idleReason: null,
  connected: false,
  moved: [],
  actionKeys: {},
  potKey: 0,
  lastHand: null,
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
        streaming: event.table.brain?.reasoning ?? '',
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
        streaming: '',
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
          },
        },
      };

    case 'reasoning':
      return { ...state, streaming: state.streaming + event.delta };

    case 'equity':
      if (!table?.brain || table.brain.seat !== event.seat) return state;
      return {
        ...state,
        table: { ...table, brain: { ...table.brain, equity: event.equity, handRead: event.handRead } },
      };

    case 'decision': {
      if (!table) return state;
      return {
        ...state,
        streaming: event.reasoning,
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
            reasoning: event.reasoning,
            equity: event.equity,
            handRead: event.handRead,
            potOdds: table.brain?.potOdds ?? null,
            action: event.action,
            amount: event.amount,
            outcome: event.outcome,
            failure: event.failure,
            elapsedMs: event.elapsedMs,
          },
        },
      };
    }

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

    case 'hand-stored':
      return { ...state, lastHand: { id: event.handId, number: event.handNumber } };

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

/**
 * Subscribes to one table's feed. Passing null subscribes to nothing, which
 * lets a page decide what to watch without breaking the rules of hooks.
 * The browser reconnects on its own if the connection drops.
 */
export function useTableStream(tableId: string | null): StreamState {
  const [state, dispatch] = useReducer(reduce, initial);

  useEffect(() => {
    if (!tableId) return;
    const source = new EventSource(`/api/tables/${tableId}/stream`);

    source.onopen = () => dispatch({ type: 'connected', value: true });
    source.onerror = () => dispatch({ type: 'connected', value: false });
    source.onmessage = (message) => {
      try {
        dispatch({ type: 'event', event: JSON.parse(message.data) as ArenaEvent });
      } catch {
        // A malformed frame is dropped rather than breaking the arena.
      }
    };

    return () => source.close();
  }, [tableId]);

  return state;
}

export function seatLabel(seat: SeatView): string {
  return seat.name ?? `Seat ${seat.index + 1}`;
}
