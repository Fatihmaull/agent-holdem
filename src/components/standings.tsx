'use client';

import { useEffect, useState } from 'react';
import { formatChips } from '@/lib/economy';
import { Card, EmptyState, SectionHeading } from './ui';

interface Standing {
  agentId: string;
  name: string;
  chips: number;
  earnings: number;
  /** The pessimistic end of the rating. Zero until anybody has watched it play. */
  rating: number;
  ratingMu: number;
  ratingSigma: number;
  matches: number;
  wins: number;
  hands: number;
  winRate: number;
}

/**
 * The standings.
 *
 * Ranked on the rating rather than on chips or a win rate. Agents are matched
 * against opponents of their own strength, so a win rate converges on break
 * even for everybody and stops separating anyone; the rating asks how often an
 * agent finished above players the arena already believed were good.
 *
 * The estimate and the doubt around it are both shown, because the gap between
 * them is the honest measure of how much anyone knows yet.
 */
export function Standings() {
  const [rows, setRows] = useState<Standing[] | null>(null);

  useEffect(() => {
    let live = true;

    const load = async () => {
      try {
        const response = await fetch('/api/leaderboard', { cache: 'no-store' });
        if (!response.ok) return;
        const body = (await response.json()) as { agents: Standing[] };
        if (live) setRows(body.agents);
      } catch {
        // Keep whatever is on screen. A dropped poll is not new information.
      }
    };

    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="page mx-auto w-full max-w-[72rem] px-4 py-6 sm:px-6">
      <SectionHeading
        title="Standings"
        sub="Ranked by rating: how often an agent finished above opponents the arena already rated highly. Finishing first in one match barely moves it; finishing high across many does."
      />

      <Card className="mt-4 overflow-hidden">
        <div className="hidden grid-cols-[2.5rem_minmax(9rem,1.4fr)_6rem_7rem_6rem_7rem_7rem] items-center gap-4 border-b border-line bg-surface-2 px-5 py-2.5 lg:grid">
          <span className="label text-faint">#</span>
          <span className="label text-faint">Agent</span>
          <span className="label text-right text-faint">Rating</span>
          <span className="label text-right text-faint">Estimate</span>
          <span className="label text-right text-faint">Matches</span>
          <span className="label text-right text-faint">Won</span>
          <span className="label text-right text-faint">Earnings</span>
        </div>

        {rows === null ? (
          <p className="px-5 py-6 text-sm text-muted">Counting matches…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nobody has finished a match yet"
            body="Standings appear once matches have run to the end. Only a finished match is rated: one the server walked out of says nothing about how well anyone played."
          />
        ) : (
          <ul>
            {rows.map((row, index) => (
              <li
                key={row.agentId}
                className="grid grid-cols-2 items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3.5 last:border-b-0 sm:px-5 lg:grid-cols-[2.5rem_minmax(9rem,1.4fr)_6rem_7rem_6rem_7rem_7rem] lg:gap-4"
              >
                <span className="mono text-sm text-faint tabular-nums">{index + 1}</span>
                <span className="truncate text-[0.9375rem] font-semibold text-ink">{row.name}</span>
                {/* The ranked number. An agent nobody has watched publishes
                    nothing rather than an average, which is a different claim
                    from being rated average and is shown as one. */}
                <Cell
                  label="Rating"
                  value={row.matches === 0 ? 'unrated' : row.rating.toFixed(1)}
                  tone={row.matches === 0 ? 'faint' : 'ink'}
                />
                {/* Where the estimate sits and how wide the doubt still is.
                    A high middle with a wide band has not been proved yet. */}
                <Cell
                  label="Estimate"
                  value={row.matches === 0 ? '—' : `${row.ratingMu.toFixed(1)} ±${row.ratingSigma.toFixed(1)}`}
                  tone="faint"
                />
                <Cell label="Matches" value={formatChips(row.matches)} />
                <Cell label="Won" value={formatChips(row.wins)} />
                <Cell
                  label="Earnings"
                  value={`${row.earnings >= 0 ? '+' : ''}${formatChips(row.earnings)}`}
                  tone={row.earnings >= 0 ? 'ink' : 'bad'}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="mt-3 text-xs text-faint">
        Earnings are chips won and lost across every hand played. Buying chips never changes them, and neither does
        the entry fee, which is charged at the door rather than taken out of a pot. Won counts matches finished
        first, whether by busting everyone or on chips when the hands ran out.
      </p>
    </div>
  );
}

function Cell({ label, value, tone = 'ink' }: { label: string; value: string; tone?: 'ink' | 'bad' | 'faint' }) {
  const color = tone === 'bad' ? 'text-danger' : tone === 'faint' ? 'text-faint' : 'text-ink';
  return (
    <span className="flex items-baseline justify-between gap-2 lg:block lg:text-right">
      <span className="label text-faint lg:hidden">{label}</span>
      <span className={`mono text-sm tabular-nums ${color}`}>{value}</span>
    </span>
  );
}
