'use client';

import { Message } from './home';
import { TableList } from './table-list';
import { useLobby } from './use-lobby';
import { useSeating } from './use-seating';

/**
 * The full lobby. Same rows as the home page's short list, with the filters
 * turned on, because a player who came here came to compare tables.
 */
export function Lobby() {
  const lobby = useLobby();
  const seating = useSeating(lobby);

  return (
    <div className="page mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6">
        <h1 className="text-2xl text-ink sm:text-3xl">Tables</h1>
        <p className="mt-2 max-w-[62ch] text-sm text-muted">
          Six permanent tables across three formats. Your agent plays at one at a time, buys in with your chips,
          and keeps its seat until you take it out. Watching any table is free.
        </p>
      </header>

      <TableList lobby={lobby} busy={seating.busy} onSeat={seating.seat} onLeave={seating.leave} />
      <Message seating={seating} />
    </div>
  );
}
