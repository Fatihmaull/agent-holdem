'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatChips, tableLabel, tableById } from '@/lib/economy';
import { buildReplay, netResults, type ReplayDecision, type ReplaySeat } from '@/lib/replay';
import type { HandEvent } from '@/poker/engine';
import { ThinkingPanel, type BrainState } from './thinking-panel';
import { Card as Panel, SectionHeading } from './ui';
import { ChipDot, agentHex } from './table-art';
import { Button, ButtonLink } from './ui';

/**
 * Stepping through a hand that is already over.
 *
 * Hands are stored whole, so this is a scrubber over data rather than a second
 * engine. The point of it is not the cards — it is that at every decision you
 * can read what the agent was thinking, next to the equity the server had
 * computed before it was asked. A hand nobody can replay is a hand nobody can
 * argue with.
 *
 * Linkable: the step is in the URL, so "look at what it did on the turn" is a
 * link rather than an instruction.
 */
export function HandReplay({
  handId,
  tableId,
  handNumber,
  lineup,
  events,
  decisions,
  playedAt,
  initialStep,
}: {
  handId: string;
  tableId: string;
  handNumber: number;
  lineup: ReplaySeat[];
  events: HandEvent[];
  decisions: ReplayDecision[];
  playedAt: string | null;
  initialStep: number;
}) {
  const frames = useMemo(() => buildReplay(lineup, events), [lineup, events]);
  const [step, setStep] = useState(() => clamp(initialStep, frames.length));
  const [playing, setPlaying] = useState(false);

  const frame = frames[step] ?? frames[0];
  const decision = frame?.decision === null ? null : (decisions[frame.decision] ?? null);
  const table = tableById(tableId);

  const go = useCallback(
    (next: number) => {
      const wanted = clamp(next, frames.length);
      setStep(wanted);

      // Outside the state updater on purpose. An updater runs during render,
      // and `replaceState` wakes the router, so doing it in there is one
      // component setting state while another is rendering.
      //
      // Shareable without a navigation: replacing the URL rather than pushing
      // keeps the back button meaning "the page before this hand" instead of
      // "one frame ago".
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set('step', String(wanted));
        window.history.replaceState(null, '', url);
      }
    },
    [frames.length],
  );

  // Arrow keys, because a scrubber somebody is reading through is a scrubber
  // they want to drive without moving their hand to the mouse each time.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === 'ArrowRight') go(step + 1);
      else if (event.key === 'ArrowLeft') go(step - 1);
      else if (event.key === 'Home') go(0);
      else if (event.key === 'End') go(frames.length - 1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, step, frames.length]);

  // Derived rather than stored. Clearing the flag from inside the effect that
  // reads it is how a component ends up re-rendering itself; at the last frame
  // there is simply nothing left to schedule.
  const atEnd = step >= frames.length - 1;
  const running = playing && !atEnd;

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => go(step + 1), 1_600);
    return () => clearTimeout(timer);
  }, [running, step, go]);

  const brain: BrainState | null = decision
    ? {
        seatName: nameOf(lineup, frame.seat),
        color: null,
        street: decision.street,
        reasoning: decision.reasoning,
        streaming: false,
        equity: decision.equity,
        // The price is not stored per decision, so the replayer shows what was
        // known about the hand rather than inventing a number for the pot odds.
        potOdds: null,
        made: decision.handRead?.made ?? null,
        draws: drawsOf(decision.handRead),
        action: decision.action,
        amount: decision.amount,
        outcome: decision.outcome,
        failure: decision.outcome === 'timeout' ? 'ran out of time' : decision.outcome === 'error' ? 'gave no usable answer' : null,
        elapsedMs: decision.elapsedMs,
        say: decision.say,
      }
    : null;

  const results = useMemo(() => netResults(frames, lineup), [frames, lineup]);

  return (
    <div className="page">
      <div className="mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6">
        <nav aria-label="Breadcrumb" className="mb-2 text-sm text-faint">
          <Link href="/tables" className="transition-colors hover:text-ink">
            Tables
          </Link>
          <span className="px-2">/</span>
          <Link href={`/table/${tableId}`} className="transition-colors hover:text-ink">
            {table ? tableLabel(table) : tableId}
          </Link>
        </nav>

        <SectionHeading
          title={`Hand ${handNumber}`}
          sub={
            playedAt
              ? `Played ${playedAt}. Step through it with the arrow keys.`
              : 'Step through it with the arrow keys.'
          }
          action={
            <ButtonLink href={`/table/${tableId}`} tone="ghost" size="sm">
              Watch this table live →
            </ButtonLink>
          }
        />

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <div className="flex flex-col gap-5">
            <Panel className="p-5">
              <p className="label text-faint">{frame.street === 'complete' ? 'Result' : frame.street}</p>
              <p className="mt-1.5 text-lg text-ink">{frame.headline}</p>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                {frame.board.length === 0 ? (
                  <span className="text-sm text-faint">No cards on the board yet</span>
                ) : (
                  frame.board.map((card) => <BoardCard key={card} card={card} />)
                )}
                <span className="mono ml-auto rounded-full border border-line bg-surface-2 px-3 py-1 text-sm text-ink tabular-nums">
                  Pot {formatChips(frame.pot)}
                </span>
              </div>
            </Panel>

            <Panel className="divide-y divide-line">
              {frame.seats.map((seat) => (
                <div
                  key={seat.seatIndex}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 ${
                    seat.folded ? 'opacity-50' : ''
                  } ${frame.seat === seat.seatIndex ? 'bg-surface-2' : ''}`}
                >
                  <ChipDot color={colorOf(lineup, seat.seatIndex)} size={18} />
                  <span className="min-w-0 truncate text-sm font-medium text-ink">{seat.name}</span>

                  {seat.hole ? (
                    <span className="flex gap-1">
                      {seat.hole.map((card) => (
                        <BoardCard key={card} card={card} small />
                      ))}
                    </span>
                  ) : null}

                  {seat.folded ? <span className="text-xs text-faint">folded</span> : null}
                  {seat.allIn && !seat.folded ? <span className="text-xs text-live">all in</span> : null}
                  {seat.won > 0 ? (
                    <span className="text-xs font-medium text-live">+{formatChips(seat.won)}</span>
                  ) : null}

                  <span className="mono ml-auto text-sm text-ink tabular-nums">{formatChips(seat.stack)}</span>
                </div>
              ))}
            </Panel>

            <Scrubber
              step={step}
              frames={frames.length}
              onGo={go}
              playing={running}
              onPlay={(next) => {
                // Pressing play at the end starts again from the top, which is
                // what a disabled button would have made somebody do by hand.
                if (next && atEnd) go(0);
                setPlaying(next);
              }}
            />

            {step === frames.length - 1 ? (
              <Panel className="p-5">
                <p className="label mb-2 text-faint">How it ended</p>
                <ul className="space-y-1 text-sm">
                  {results.map((entry) => (
                    <li key={entry.name} className="flex items-baseline gap-3">
                      <span className="min-w-0 truncate text-ink">{entry.name}</span>
                      <span
                        className={`mono ml-auto tabular-nums ${
                          entry.net > 0 ? 'text-live' : entry.net < 0 ? 'text-muted' : 'text-faint'
                        }`}
                      >
                        {entry.net > 0 ? '+' : ''}
                        {formatChips(entry.net)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-faint">
                  Hands that never reached a showdown stay face down. The cards nobody was shown are not shown
                  here either.
                </p>
              </Panel>
            ) : null}
          </div>

          <Panel className="h-[34rem] overflow-hidden lg:sticky lg:top-[calc(var(--header-h)+1.25rem)]">
            <ThinkingPanel
              brain={brain}
              footnote={
                decision
                  ? `Decision ${(frame.decision ?? 0) + 1} of ${decisions.length} · hand ${handNumber}`
                  : 'Not a decision — a blind, a card, or the pot being pushed.'
              }
            />
          </Panel>
        </div>

        <p className="mt-6 text-xs text-faint">
          <span className="mono">{handId}</span> · this page is a link you can share
        </p>
      </div>
    </div>
  );
}

function Scrubber({
  step,
  frames,
  onGo,
  playing,
  onPlay,
}: {
  step: number;
  frames: number;
  onGo: (next: number) => void;
  playing: boolean;
  onPlay: (playing: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" onClick={() => onGo(0)} disabled={step === 0}>
        ⏮
      </Button>
      <Button size="sm" onClick={() => onGo(step - 1)} disabled={step === 0}>
        ← Back
      </Button>
      <Button tone="primary" size="sm" onClick={() => onPlay(!playing)}>
        {playing ? 'Pause' : step >= frames - 1 ? 'Replay' : 'Play'}
      </Button>
      <Button size="sm" onClick={() => onGo(step + 1)} disabled={step >= frames - 1}>
        Next →
      </Button>

      <label className="ml-auto flex min-w-[12rem] flex-1 items-center gap-3">
        <span className="sr-only">Step through the hand</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, frames - 1)}
          value={step}
          onChange={(event) => onGo(Number(event.target.value))}
          className="min-w-0 flex-1 accent-[var(--color-accent,#22c55e)]"
        />
        <span className="mono shrink-0 text-xs text-faint tabular-nums">
          {step + 1}/{frames}
        </span>
      </label>
    </div>
  );
}

const RED = new Set(['h', 'd']);

function BoardCard({ card, small = false }: { card: string; small?: boolean }) {
  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const red = RED.has(suit);
  return (
    <span
      className={`mono inline-flex items-center justify-center rounded-[0.25rem] border border-line-strong bg-surface-2 font-semibold ${
        small ? 'h-6 min-w-6 px-1 text-xs' : 'h-10 min-w-8 px-1.5 text-sm'
      } ${red ? 'text-danger' : 'text-ink'}`}
    >
      {rank}
      {SUIT_GLYPH[suit] ?? suit}
    </span>
  );
}

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

function clamp(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.max(0, length - 1), Math.trunc(value)));
}

function nameOf(lineup: ReplaySeat[], seat: number | null): string | null {
  if (seat === null) return null;
  return lineup.find((entry) => entry.seatIndex === seat)?.name ?? null;
}

/**
 * Stored hands carry no colour, since an agent may have been recoloured or
 * retired since. The seat's position picks a stable one so two seats in the
 * same replay never share a dot.
 */
function colorOf(lineup: ReplaySeat[], seat: number): string {
  const position = lineup.findIndex((entry) => entry.seatIndex === seat);
  return REPLAY_COLORS[Math.max(0, position) % REPLAY_COLORS.length];
}

// Ids from src/agent/colors.ts, in the order they read most distinctly next to
// each other. Anything not on that list falls back to grey, which would make
// every seat in a replay look the same.
const REPLAY_COLORS = ['red', 'green', 'lightblue', 'yellow', 'purple', 'biege'];

function drawsOf(read: ReplayDecision['handRead']): string[] {
  if (!read) return [];
  const draws: string[] = [];
  if (read.flushDraw) draws.push('a flush');
  if (read.openEnded) draws.push('a straight');
  else if (read.gutshot) draws.push('an inside straight');
  return draws;
}

/** Re-exported so a caller does not need to reach past this file for the dot. */
export { agentHex };
