'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { DecisionSource, FeedEvent } from '@agentholdem/shared';
import { formatChips } from '@/lib/format';

type Tab = 'all' | 'thoughts' | 'chat';

/** Marks turns the engine had to resolve itself rather than the model. */
const FALLBACK_SOURCES: DecisionSource[] = [
  'fallback-timeout',
  'fallback-invalid',
  'fallback-error',
  'fallback-no-provider',
  'heuristic',
];

/**
 * The live narrative: actions, private reasoning, and table talk.
 *
 * Inner monologue is the interesting part of an agent arena — it is the only
 * way to tell a good read from a lucky one — so it gets its own tab rather
 * than being buried in the action log.
 */
export function FeedPanel({ feed }: { feed: readonly FeedEvent[] }) {
  const [tab, setTab] = useState<Tab>('all');
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (tab === 'thoughts') return feed.filter((e) => e.kind === 'thought');
    if (tab === 'chat') return feed.filter((e) => e.kind === 'chat');
    return feed.filter((e) => e.kind !== 'thought');
  }, [feed, tab]);

  useEffect(() => {
    if (!pinned) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [filtered, pinned]);

  return (
    <section className="panel flex h-full flex-col">
      <div className="panel-header">
        <h3 className="font-display text-base font-semibold">Live feed</h3>
        <div className="flex gap-1 rounded-lg border border-white/10 bg-slate-950/60 p-0.5">
          {(
            [
              ['all', 'Action'],
              ['thoughts', 'Monologue'],
              ['chat', 'Table talk'],
            ] as [Tab, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                tab === value ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 40);
        }}
        className="scroll-thin flex-1 space-y-1.5 overflow-y-auto p-3"
        style={{ maxHeight: 560 }}
      >
        <AnimatePresence initial={false}>
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-500">
              Nothing here yet — the feed fills in as the agents act.
            </p>
          ) : (
            filtered.slice(-90).map((event, index) => (
              <motion.div
                key={`${event.at}-${event.kind}-${index}`}
                layout
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                className="text-xs leading-relaxed"
              >
                <FeedRow event={event} />
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>

      {!pinned ? (
        <button
          type="button"
          className="border-t border-white/10 py-2 text-[11px] text-cyan-300 hover:bg-white/5"
          onClick={() => setPinned(true)}
        >
          Jump to latest ↓
        </button>
      ) : null}
    </section>
  );
}

function FeedRow({ event }: { event: FeedEvent }) {
  switch (event.kind) {
    case 'hand-start':
      return (
        <p className="mt-2 border-t border-white/10 pt-2 font-semibold text-slate-300">
          Hand #{event.handNumber} · button seat {event.button}
        </p>
      );
    case 'blinds':
      return (
        <p className="text-slate-400">
          Blinds posted:{' '}
          {event.postings.map((p) => `seat ${p.seat} ${p.label.toUpperCase()} ${p.amount}`).join(', ')}
        </p>
      );
    case 'deal':
      return (
        <p className="text-slate-300">
          <span className="capitalize text-cyan-300">{event.street}</span>
          {event.board.length > 0 ? ` — ${event.board.join(' ')}` : ' — hole cards dealt'}
        </p>
      );
    case 'action': {
      const fallback = FALLBACK_SOURCES.includes(event.source);
      return (
        <p className="text-slate-200">
          <strong className="font-semibold">{event.agentName}</strong>{' '}
          {describeAction(event.action)}
          <span className="text-slate-500"> · pot {formatChips(event.potAfter)}</span>
          {fallback ? (
            <span
              className="ml-1.5 rounded bg-amber-400/15 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-200"
              title={`Resolved by the engine (${event.source}) rather than the model`}
            >
              {event.source === 'heuristic' ? 'policy' : 'auto'}
            </span>
          ) : null}
          {event.latencyMs > 0 ? (
            <span className="ml-1 text-[10px] text-slate-600">{event.latencyMs}ms</span>
          ) : null}
        </p>
      );
    }
    case 'thought':
      return (
        <p className="rounded-lg border-l-2 border-violet-400/60 bg-violet-400/[0.06] px-2.5 py-1.5 text-slate-300">
          <strong className="font-semibold text-violet-200">{event.agentName}</strong>{' '}
          <span className="italic">{event.text}</span>
        </p>
      );
    case 'chat':
      return (
        <p className="text-slate-300">
          <strong className="font-semibold text-cyan-200">{event.agentName}:</strong> “{event.text}”
        </p>
      );
    case 'showdown':
      return (
        <div className="rounded-lg bg-white/[0.04] px-2.5 py-1.5">
          <p className="font-semibold text-slate-200">Showdown</p>
          {event.reveals.map((reveal) => (
            <p key={reveal.seat} className="text-slate-400">
              Seat {reveal.seat}: {reveal.cards.join(' ')}
              {reveal.rank ? ` — ${reveal.rank.label}` : ''}
            </p>
          ))}
        </div>
      );
    case 'payout':
      return (
        <p className="font-semibold text-amber-200">
          {event.awards.length === 0
            ? 'No award'
            : event.awards
                .map((a) => `${a.agentName} wins ${formatChips(a.amount)}`)
                .join(' · ')}
        </p>
      );
    case 'seat-join':
      return (
        <p className="text-emerald-200">
          {event.agentName} takes seat {event.seat} with {formatChips(event.stack)}
        </p>
      );
    case 'seat-bust':
      return <p className="text-rose-300">{event.agentName} is out of chips</p>;
    case 'session-complete':
      return (
        <div className="mt-2 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.08] px-2.5 py-2">
          <p className="font-semibold text-emerald-200">Session complete</p>
          {event.standings.map((s) => (
            <p key={s.seat} className="text-slate-300">
              {s.agentName}: {formatChips(s.chips)} chips
            </p>
          ))}
          {event.settlementTx ? (
            <a
              className="mt-1 inline-block text-cyan-300 underline underline-offset-2"
              href={`https://testnet.bscscan.com/tx/${event.settlementTx}`}
              target="_blank"
              rel="noreferrer"
            >
              Settlement transaction ↗
            </a>
          ) : (
            <p className="mt-1 text-slate-500">Settled off chain (no escrow configured)</p>
          )}
        </div>
      );
    default:
      return <p className="text-slate-500">{(event as { text?: string }).text ?? ''}</p>;
  }
}

function describeAction(action: { type: string; amount: number }): string {
  switch (action.type) {
    case 'fold':
      return 'folds';
    case 'check':
      return 'checks';
    case 'call':
      return `calls ${formatChips(action.amount)}`;
    case 'raise':
      return `raises to ${formatChips(action.amount)}`;
    case 'all-in':
      return `moves all-in for ${formatChips(action.amount)}`;
    default:
      return action.type;
  }
}
