'use client';

import Link from 'next/link';
import { useAccount } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useArenaSocket } from '@/lib/useArenaSocket';
import { formatChips, formatSigned, relativeTime } from '@/lib/format';
import { PokerTable } from './PokerTable';
import { FeedPanel } from './FeedPanel';

/**
 * Spectator arena for one table.
 *
 * The socket carries live state; the REST calls fill in the durable record
 * (hand history with revealed seeds, per-turn decision logs) that outlives
 * any single connection.
 */
export function ArenaView({ tableId }: { tableId: string }) {
  const { address } = useAccount();
  const { view: liveView, feed, status } = useArenaSocket({ tableId });

  // Initial paint before the socket connects, and the fallback if it drops.
  const { data: snapshot, isError } = useQuery({
    queryKey: ['table', tableId],
    queryFn: () => api.table(tableId),
    refetchInterval: status === 'open' ? false : 4_000,
  });

  const { data: config } = useQuery({ queryKey: ['arena-config'], queryFn: api.config });
  const { data: history } = useQuery({
    queryKey: ['table-history', tableId],
    queryFn: () => api.history(tableId),
    refetchInterval: 15_000,
  });

  const view = liveView ?? snapshot?.view ?? null;
  const events = feed.length > 0 ? feed : (snapshot?.feed ?? []);

  if (isError && !view) {
    return (
      <div className="panel p-8 text-center">
        <p className="text-sm text-slate-300">That table is not available.</p>
        <Link href="/" className="btn-ghost mt-4">
          Back to the lobby
        </Link>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="panel grid h-72 place-items-center text-sm text-slate-500">
        Loading table…
      </div>
    );
  }

  const yourSeat = address
    ? view.seats.find((seat) => seat.owner.toLowerCase() === address.toLowerCase())
    : undefined;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <Link href="/" className="btn-ghost !py-1.5 text-xs">
          ← Lobby
        </Link>
        <h1 className="font-display text-xl font-semibold">{view.name}</h1>
        <span
          className={`chip-tag ${status === 'open' ? 'text-emerald-300' : 'text-amber-300'}`}
        >
          {status === 'open' ? 'Live feed' : 'Reconnecting…'}
        </span>
        {yourSeat ? (
          <span className="chip-tag border-cyan-400/30 text-cyan-200">
            Your agent: {yourSeat.agentName} · {formatChips(yourSeat.stack)} chips
          </span>
        ) : null}
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-5">
          <PokerTable
            view={view}
            {...(address ? { youAddress: address } : {})}
            turnTimeoutMs={config?.table.turnTimeoutMs ?? 30_000}
          />

          <section className="panel">
            <div className="panel-header">
              <h3 className="font-display text-base font-semibold">Hand history</h3>
              <span className="text-xs text-slate-500">
                {history?.hands.length ?? 0} recorded · seeds revealed
              </span>
            </div>
            <div className="scroll-thin max-h-64 divide-y divide-white/5 overflow-y-auto">
              {(history?.hands ?? []).length === 0 ? (
                <p className="px-5 py-8 text-center text-xs text-slate-500">
                  No completed hands yet.
                </p>
              ) : (
                history!.hands.map((hand) => (
                  <div key={`${hand.handNumber}-${hand.startedAt}`} className="px-5 py-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-200">
                        Hand #{hand.handNumber}
                      </span>
                      <span className="text-slate-500">{relativeTime(hand.endedAt)}</span>
                    </div>
                    <p className="mt-1 text-slate-400">
                      Board {hand.board.length > 0 ? hand.board.join(' ') : '—'}
                    </p>
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                      {hand.results.map((result) => (
                        <span
                          key={result.seat}
                          className={result.net >= 0 ? 'text-emerald-300' : 'text-rose-300'}
                        >
                          {result.agentName} {formatSigned(result.net)}
                        </span>
                      ))}
                    </p>
                    <p className="mt-1 truncate text-[10px] text-slate-600">
                      seed {hand.seed} · commitment {hand.commitment.slice(0, 20)}…
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <FeedPanel feed={events} />
      </div>
    </div>
  );
}
