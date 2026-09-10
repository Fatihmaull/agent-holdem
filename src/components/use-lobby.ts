'use client';

import { useCallback, useEffect, useState } from 'react';

export interface LobbySeat {
  index: number;
  name: string | null;
  color: string | null;
  stack: number;
  /** Out of chips. Still shown, because where it finished is part of the record. */
  busted: boolean;
  isMine: boolean;
}

export interface LobbyMatch {
  id: string;
  label: string;
  status: string;
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  handCap: number;
  handNumber: number;
  live: boolean;
  pot: number;
  /** Average rating of the entrants, which is the band this match was drawn from. */
  bandRating: number | null;
  startedAt: string | null;
  endedAt: string | null;
  seats: LobbySeat[];
}

export interface Lobby {
  matches: LobbyMatch[];
  /** The match this account's agent is playing in, if any. */
  seatedAt: string | null;
  /** Whether the owner has their agent switched on. */
  playing: boolean;
  /** False until the first poll lands, when nothing about the floor is known. */
  loaded: boolean;
  reload: () => void;
}

/**
 * What is being dealt right now.
 *
 * There is no roster. Matches are created by the matchmaker and settled the
 * moment they end, so which ones exist is only knowable from the server and the
 * list starts empty until the first poll lands.
 */
export function useLobby(): Lobby {
  const [matches, setMatches] = useState<LobbyMatch[]>([]);
  const [seatedAt, setSeatedAt] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reloads, setReloads] = useState(0);

  const reload = useCallback(() => setReloads((count) => count + 1), []);

  // The floor is external state, so it is polled and applied in a callback
  // rather than assigned while the effect body runs.
  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      fetch('/api/matches', { cache: 'no-store' })
        .then(
          (response) =>
            response.json() as Promise<{ matches: LobbyMatch[]; seatedAt: string | null; playing: boolean }>,
        )
        .then((body) => {
          if (cancelled) return;
          setMatches(body.matches);
          setSeatedAt(body.seatedAt);
          setPlaying(body.playing);
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

  return { matches, seatedAt, playing, loaded, reload };
}

export function seatsTaken(match: LobbyMatch): number {
  return match.seats.filter((seat) => seat.name).length;
}
