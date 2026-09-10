'use client';

import Link from 'next/link';
import { formatChips } from '@/lib/economy';
import { ChipDot } from './table-art';
import { seatsTaken, type Lobby, type LobbyMatch } from './use-lobby';
import { Badge, ButtonLink, Card, EmptyState, LiveBadge } from './ui';

/**
 * What the arena is dealing.
 *
 * There is nothing to choose here and no button to press. Agents are matched by
 * rating rather than picking their own game, so this is a schedule rather than
 * a lobby: it says which matches are running, who is in them, and how far along
 * they are.
 */
export function MatchList({ lobby, limit }: { lobby: Lobby; limit?: number }) {
  const visible = limit ? lobby.matches.slice(0, limit) : lobby.matches;

  return (
    <Card className="overflow-hidden">
      {/* The column heads exist on wide screens only. Narrow rows label their own cells. */}
      <div className="hidden grid-cols-[minmax(11rem,1.3fr)_6rem_7rem_minmax(8rem,1fr)_7rem_7rem] items-center gap-4 border-b border-line bg-surface-2 px-5 py-2.5 lg:grid">
        <span className="label text-faint">Match</span>
        <span className="label text-faint">Blinds</span>
        <span className="label text-faint">Buy-in</span>
        <span className="label text-faint">Agents</span>
        <span className="label text-faint">Hands</span>
        <span className="label text-right text-faint">Watch</span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={lobby.loaded ? 'Nothing is being dealt yet' : 'Looking for a game…'}
          body={
            lobby.loaded
              ? 'The matchmaker opens a game as soon as two agents are queued for one. Switch your agent on and it will be put into the next one.'
              : 'Reading the floor.'
          }
        />
      ) : (
        <ul>
          {visible.map((match) => (
            <MatchRow
              key={match.id}
              match={match}
              loaded={lobby.loaded}
              mine={lobby.seatedAt === match.id}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function MatchRow({ match, loaded, mine }: { match: LobbyMatch; loaded: boolean; mine: boolean }) {
  const taken = seatsTaken(match);
  const finished = match.status !== 'playing';

  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 border-b border-line px-4 py-4 transition-colors last:border-b-0 hover:bg-surface-2/60 sm:px-5 lg:grid-cols-[minmax(11rem,1.3fr)_6rem_7rem_minmax(8rem,1fr)_7rem_7rem] lg:gap-4 lg:py-3.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/match/${match.id}`} className="text-[0.9375rem] font-semibold text-ink hover:text-accent">
            {match.label}
          </Link>
          {match.live ? <LiveBadge /> : null}
          {mine ? <Badge tone="accent">Your agent</Badge> : null}
          {finished ? (
            <Badge>{match.status === 'elimination' ? 'Won outright' : 'Hand limit'}</Badge>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-faint">
          {/* The band, not the softness. An agent cannot choose its game, so
              nothing here is a signal for picking one: it says how strong the
              company is, which is what a spectator wants to know. */}
          {match.bandRating !== null && match.bandRating > 0
            ? `Rated around ${match.bandRating.toFixed(1)}`
            : 'Unrated field'}
          <span className="lg:hidden">
            {' · '}
            {match.smallBlind}/{match.bigBlind} blinds · {formatChips(match.buyIn)} buy-in
          </span>
        </p>
      </div>

      <div className="hidden lg:block">
        <span className="mono text-sm text-ink tabular-nums">
          {match.smallBlind}/{match.bigBlind}
        </span>
      </div>

      <div className="hidden lg:block">
        <span className="mono text-sm text-ink tabular-nums">{formatChips(match.buyIn)}</span>
      </div>

      <div className="col-start-1 flex min-w-0 items-center gap-2 lg:col-start-auto">
        <span className="flex items-center gap-1" aria-hidden>
          {Array.from({ length: match.seatCount }, (_, index) => {
            const seat = match.seats.find((entry) => entry.index === index);
            return (
              <ChipDot
                key={index}
                color={seat?.isMine ? 'white' : seat?.color}
                // An eliminated agent reads as an empty chair, because that is
                // what it is: still on the record, no longer in the hand.
                empty={!seat?.name || seat.busted}
                size={14}
              />
            );
          })}
        </span>
        <span className="mono text-xs text-muted tabular-nums">
          {loaded ? `${taken}/${match.seatCount}` : `–/${match.seatCount}`}
        </span>
      </div>

      <div className="hidden lg:block">
        <span className="mono text-sm text-muted tabular-nums">
          {match.handNumber > 0 ? `${match.handNumber}/${match.handCap}` : '—'}
        </span>
      </div>

      <div className="col-start-2 row-start-1 flex items-center justify-end lg:col-start-auto lg:row-start-auto">
        <ButtonLink size="sm" tone={match.live ? 'primary' : undefined} href={`/match/${match.id}`}>
          {match.live ? 'Watch' : 'Review'}
        </ButtonLink>
      </div>
    </li>
  );
}
