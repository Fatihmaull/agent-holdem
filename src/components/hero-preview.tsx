'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ThinkingPanel, type BrainState } from './thinking-panel';
import { useTableStream } from './use-table-stream';
import { Badge, Card, LiveBadge } from './ui';

interface ReplayDecision {
  seatIndex: number;
  street: string;
  equity: number;
  handRead: { made: string; flushDraw: boolean; openEnded: boolean; gutshot: boolean; overcards: boolean } | null;
  reasoning: string;
  action: string;
  amount: number;
  elapsedMs: number;
  outcome: 'decided' | 'timeout' | 'error';
}

type Feed =
  | { mode: 'loading' }
  | { mode: 'live'; tableId: string }
  | {
      mode: 'replay';
      tableId: string;
      handNumber: number;
      lineup: Array<{ seatIndex: number; name: string }>;
      decisions: ReplayDecision[];
    }
  | { mode: 'empty' };

/**
 * A worked example of the thing the page is selling, shown before the reader
 * has to click anything. If a table is dealing it is that table; if one has
 * dealt before it is the last real hand; only when neither is true does it fall
 * back to a written sample, and then it says so on the card.
 */
export function HeroPreview() {
  const [feed, setFeed] = useState<Feed>({ mode: 'loading' });
  const [step, setStep] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/hands/latest', { cache: 'no-store' })
      .then((response) => response.json() as Promise<Feed>)
      .then((body) => {
        if (!cancelled) setFeed(body);
      })
      .catch(() => {
        if (!cancelled) setFeed({ mode: 'empty' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const live = useTableStream(feed.mode === 'live' ? feed.tableId : null);

  const count = feed.mode === 'replay' ? feed.decisions.length : 0;
  useEffect(() => {
    if (count === 0) return;
    const timer = setInterval(() => setStep((current) => (current + 1) % count), 4200);
    return () => clearInterval(timer);
  }, [count]);

  const brain = build(feed, live, step);
  const tableId = feed.mode === 'live' || feed.mode === 'replay' ? feed.tableId : null;

  return (
    <Card className="flex min-h-[30rem] flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
        <span className="text-[0.8125rem] font-medium text-ink">What you see while it plays</span>
        <span className="ml-auto">
          {feed.mode === 'live' ? (
            <LiveBadge />
          ) : feed.mode === 'replay' ? (
            <Badge>Last hand</Badge>
          ) : feed.mode === 'empty' ? (
            <Badge>Example</Badge>
          ) : null}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <ThinkingPanel
          brain={brain}
          deadline={feed.mode === 'live' ? (live.table?.deadline ?? null) : null}
          footnote={footnote(feed, step)}
        />
      </div>

      {tableId ? (
        <Link
          href={`/table/${tableId}`}
          className="shrink-0 border-t border-line px-4 py-2.5 text-[0.8125rem] font-medium text-accent transition-colors hover:bg-surface-2"
        >
          Open this table →
        </Link>
      ) : null}
    </Card>
  );
}

/**
 * Shown only when no hand has ever been dealt, and labelled Example on the card
 * so it is never mistaken for a real decision.
 */
const SAMPLE: BrainState = {
  seatName: 'Maverick',
  color: 'red',
  street: 'turn',
  reasoning:
    'He has bet every street and I have called every street. The flush card came and he cut his bet to a third of the pot. That is the size you pick when you want a cheap look at the river, not the size you pick holding a flush. I have nine cards to the nut flush and he is laying me better than three to one to go and get them.',
  streaming: false,
  equity: 0.384,
  potOdds: 0.31,
  made: 'Ace high',
  draws: ['flush draw'],
  action: 'raise',
  amount: 1200,
  outcome: 'decided',
  failure: null,
  elapsedMs: 4300,
};

function build(feed: Feed, live: ReturnType<typeof useTableStream>, step: number): BrainState | null {
  if (feed.mode === 'live') {
    const brain = live.table?.brain;
    if (!brain) return null;
    return {
      seatName: brain.seatName,
      color: brain.color,
      street: brain.street,
      reasoning: live.isStreaming ? live.streaming : brain.reasoning,
      streaming: live.isStreaming,
      equity: brain.equity,
      potOdds: brain.potOdds,
      made: brain.handRead?.made ?? null,
      draws: draws(brain.handRead),
      action: brain.action,
      amount: brain.amount ?? 0,
      outcome: brain.outcome,
      failure: brain.failure,
      elapsedMs: brain.elapsedMs,
    };
  }

  if (feed.mode === 'replay' && feed.decisions.length > 0) {
    const decision = feed.decisions[step % feed.decisions.length];
    return {
      seatName: feed.lineup.find((entry) => entry.seatIndex === decision.seatIndex)?.name ?? null,
      color: null,
      street: decision.street,
      reasoning: decision.reasoning,
      streaming: false,
      equity: decision.equity,
      potOdds: null,
      made: decision.handRead?.made ?? null,
      draws: draws(decision.handRead),
      action: decision.action,
      amount: decision.amount,
      outcome: decision.outcome,
      failure: decision.outcome === 'timeout' ? 'ran out of time' : null,
      elapsedMs: decision.elapsedMs,
    };
  }

  if (feed.mode === 'empty') return SAMPLE;
  return null;
}

function footnote(feed: Feed, step: number): string | null {
  if (feed.mode === 'loading') return 'Looking for a table that is dealing…';
  if (feed.mode === 'empty') return 'A written example. No hands have been dealt yet.';
  if (feed.mode === 'replay') {
    return feed.decisions.length > 0
      ? `Decision ${(step % feed.decisions.length) + 1} of ${feed.decisions.length}, hand ${feed.handNumber}`
      : 'That hand finished without a recorded decision.';
  }
  return null;
}

function draws(read: ReplayDecision['handRead']): string[] {
  if (!read) return [];
  return [
    read.flushDraw && 'flush draw',
    read.openEnded && 'open-ended',
    read.gutshot && 'gutshot',
    read.overcards && 'two overcards',
  ].filter((value): value is string => typeof value === 'string');
}
