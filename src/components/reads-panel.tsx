'use client';

import { useEffect, useState } from 'react';
import { EmptyState } from './ui';

interface Read {
  author: string;
  subject: string;
  text: string;
  revisions: number;
  updatedAt: string;
}

/**
 * What each agent at this table has written about the others.
 *
 * This is the arena's only window into what an agent actually believes, as
 * opposed to what it did. Nothing here is computed: it is the agent's own
 * words, in its own phrasing, about a specific opponent it chose to remember.
 *
 * Polled rather than streamed, because a note changes at most once a hand and
 * an open socket for that would cost more than it saves.
 */
export function ReadsPanel({ matchId }: { matchId: string }) {
  const [reads, setReads] = useState<Read[] | null>(null);

  useEffect(() => {
    let live = true;

    const load = async () => {
      try {
        const response = await fetch(`/api/matches/${matchId}/notes`, { cache: 'no-store' });
        if (!response.ok) return;
        const body = (await response.json()) as { notes: Read[] };
        if (live) setReads(body.notes);
      } catch {
        // A failed poll leaves the last reads on screen. They were true a
        // moment ago, which beats blanking the panel over one dropped request.
      }
    };

    void load();
    const timer = setInterval(() => void load(), 8_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [matchId]);

  if (reads === null) {
    return <p className="px-4 py-4 text-sm text-muted">Reading the table&rsquo;s notes…</p>;
  }

  if (reads.length === 0) {
    return (
      <EmptyState
        title="Nobody has written anything down yet"
        body="An agent writes a note after a hand it asked to look back on. Reads appear here as they form, and change as they turn out to be wrong."
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <p className="border-b border-line px-4 py-2.5 text-xs text-faint">
        What each agent believes about the others. Its own words, written after a hand it chose to remember.
      </p>
      <ul>
        {reads.map((read) => (
          <li key={`${read.author}-${read.subject}`} className="border-b border-line px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
              <span className="text-[0.8125rem] font-semibold text-ink">{read.author}</span>
              <span className="text-xs text-faint">on</span>
              <span className="text-[0.8125rem] font-semibold text-ink">{read.subject}</span>
              {/* A read that has been rewritten is one that stopped predicting,
                  which is the interesting kind. */}
              {read.revisions > 1 ? (
                <span className="text-xs text-faint">· rewritten {read.revisions - 1}×</span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted">{read.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
