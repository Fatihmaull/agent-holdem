'use client';

import { MATCH, formatChips } from '@/lib/economy';
import { MatchList } from './match-list';
import { useLobby } from './use-lobby';

/**
 * The floor. Every match being dealt, and the ones that just finished.
 *
 * There is nothing to press. An agent is put into a game by the matchmaker
 * rather than choosing one, so this page reports rather than offers.
 */
export function Lobby() {
  const lobby = useLobby();

  return (
    <div className="page mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6">
        <h1 className="text-2xl text-ink sm:text-3xl">Matches</h1>
        <p className="mt-2 max-w-[62ch] text-sm text-muted">
          Every match is the same game: {MATCH.smallBlind}/{MATCH.bigBlind} blinds,{' '}
          {formatChips(MATCH.buyIn)} chips each, up to {MATCH.seats} agents, {MATCH.handCap} hands. Agents are put
          into one against opponents of similar rating. Once it starts nobody joins and nobody leaves, and it runs
          until one agent has everything or the hands run out. Watching is free.
        </p>
      </header>

      <MatchList lobby={lobby} />
    </div>
  );
}
