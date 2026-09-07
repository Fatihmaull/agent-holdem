'use client';

import { useCallback, useEffect, useState } from 'react';
import { TABLES, tableLabel } from '@/lib/economy';
import type { TableFormat } from '@/lib/economy';
import type { PromptBudget } from '@/lib/instructions';

export interface LobbySeat {
  index: number;
  name: string | null;
  color: string | null;
  stack: number;
  isMine: boolean;
}

export interface LobbyTable {
  id: string;
  label: string;
  format: TableFormat;
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  /** Words of owner instruction a seat here may carry. */
  wordLimit: PromptBudget;
  handNumber: number;
  live: boolean;
  pot: number;
  seats: LobbySeat[];
}

/**
 * The roster is a fixed six known without asking the server, so the lobby draws
 * itself complete on the first paint and the poll only fills in who is sitting
 * where. A skeleton would be inventing suspense about a list that never changes.
 */
const ROSTER: LobbyTable[] = TABLES.map((table) => ({
  id: table.id,
  label: tableLabel(table),
  format: table.format,
  seatCount: table.seats,
  smallBlind: table.smallBlind,
  bigBlind: table.bigBlind,
  buyIn: table.buyIn,
  wordLimit: table.wordLimit,
  handNumber: 0,
  live: false,
  pot: 0,
  seats: [],
}));

export interface Lobby {
  tables: LobbyTable[];
  /** Every table this account has an agent at. One seat per table each. */
  seatedAt: string[];
  /** False until the first poll lands, when seat counts are not yet known. */
  loaded: boolean;
  reload: () => void;
}

export function useLobby(): Lobby {
  const [tables, setTables] = useState<LobbyTable[]>(ROSTER);
  const [seatedAt, setSeatedAt] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reloads, setReloads] = useState(0);

  const reload = useCallback(() => setReloads((count) => count + 1), []);

  // The roster is external state, so it is polled and applied in a callback
  // rather than assigned while the effect body runs.
  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      fetch('/api/tables', { cache: 'no-store' })
        .then((response) => response.json() as Promise<{ tables: LobbyTable[]; seatedAt: string[] }>)
        .then((body) => {
          if (cancelled) return;
          setTables(body.tables);
          setSeatedAt(body.seatedAt ?? []);
          setLoaded(true);
        })
        .catch(() => {});
    };

    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reloads]);

  return { tables, seatedAt, loaded, reload };
}

export function seatsTaken(table: LobbyTable): number {
  return table.seats.filter((seat) => seat.name).length;
}
