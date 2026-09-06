'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  ClientMessage,
  FeedEvent,
  LobbyTableView,
  ServerMessage,
  TableView,
} from '@agentholdem/shared';
import { WS_URL } from './api';

type Status = 'connecting' | 'open' | 'closed';

interface SocketState {
  status: Status;
  lobby: readonly LobbyTableView[] | null;
  view: TableView | null;
  feed: readonly FeedEvent[];
}

const FEED_CAP = 120;

/**
 * Spectator socket.
 *
 * Purely read-only — the arena keeps playing whether or not this is
 * connected, so a dropped socket is a display problem, not a game problem.
 * Reconnect backs off and re-subscribes, then the server replays the current
 * snapshot plus recent feed.
 */
export function useArenaSocket(options: { tableId?: string; lobby?: boolean }): SocketState {
  const { tableId, lobby } = options;
  const [state, setState] = useState<SocketState>({
    status: 'connecting',
    lobby: null,
    view: null,
    feed: [],
  });

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const send = (message: ClientMessage) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    const connect = () => {
      if (closedRef.current) return;
      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;
      setState((s) => ({ ...s, status: 'connecting' }));

      socket.onopen = () => {
        retryRef.current = 0;
        setState((s) => ({ ...s, status: 'open' }));
        if (lobby) send({ t: 'watch-lobby' });
        if (tableId) send({ t: 'subscribe', tableId });
      };

      socket.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }

        setState((prev) => {
          switch (message.t) {
            case 'lobby':
              return { ...prev, lobby: message.tables };
            case 'table':
              return {
                ...prev,
                view: message.view,
                // A refresh carries no feed; keep whatever we already have.
                feed: message.feed.length > 0 ? message.feed.slice(-FEED_CAP) : prev.feed,
              };
            case 'table-event':
              if (tableId && message.tableId !== tableId) return prev;
              return {
                ...prev,
                view: message.view,
                feed: [...prev.feed, message.event].slice(-FEED_CAP),
              };
            default:
              return prev;
          }
        });
      };

      const scheduleReconnect = () => {
        if (closedRef.current) return;
        setState((s) => ({ ...s, status: 'closed' }));
        const delay = Math.min(8_000, 500 * 2 ** retryRef.current);
        retryRef.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      socket.onclose = scheduleReconnect;
      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      closedRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, [tableId, lobby]);

  return state;
}
