'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ROOM_MODE_BY_KEY, type TableView } from '@agentholdem/shared';
import { formatChips } from '@/lib/format';
import { PlayingCard } from './PlayingCard';
import { ChipStack } from './ChipStack';
import { Seat } from './Seat';

/**
 * The felt.
 *
 * Seats are laid out around an ellipse so a heads-up duel and a six-handed
 * table use the same component, and the board sits in the middle with the
 * pot. Everything here is driven by the spectator view — nothing on this
 * page can influence the hand.
 */
export function PokerTable({
  view,
  youAddress,
  turnTimeoutMs,
}: {
  view: TableView;
  youAddress?: string;
  turnTimeoutMs: number;
}) {
  const mode = ROOM_MODE_BY_KEY[view.mode];
  const [now, setNow] = useState(() => Date.now());

  // Local ticker for the turn clock; the deadline itself comes from the server.
  useEffect(() => {
    if (view.actionDeadline === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [view.actionDeadline]);

  const secondsLeft =
    view.actionDeadline === null ? null : Math.max(0, (view.actionDeadline - now) / 1000);

  const seatCount = Math.max(view.seats.length, 2);

  return (
    <div className="relative">
      <div
        className="relative overflow-hidden rounded-[2.5rem] border border-white/10 shadow-felt"
        style={{
          backgroundImage: "url('/assets/felt/felt-green.svg')",
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          aspectRatio: '12 / 7',
          minHeight: 440,
        }}
      >
        {/* Header strip: which room this is and where the session is up to. */}
        <div className="absolute inset-x-0 top-0 flex flex-wrap items-center justify-between gap-2 p-4">
          <div className="flex items-center gap-2">
            <span
              className="rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider"
              style={{ backgroundColor: `${mode.accent}22`, color: mode.accent }}
            >
              {mode.wordLimit}-word {mode.label}
            </span>
            <span className="chip-tag !bg-slate-950/60">
              {view.format === 'heads-up' ? 'Heads-up' : `${view.seats.length}-handed`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="chip-tag !bg-slate-950/60">
              Hand {view.handNumber}/{view.handsPerSession}
            </span>
            <span className="chip-tag !bg-slate-950/60 capitalize">{view.street}</span>
            <span
              className={`chip-tag !bg-slate-950/60 ${
                view.status === 'running' ? 'text-emerald-300' : 'text-slate-400'
              }`}
            >
              {view.status}
            </span>
          </div>
        </div>

        {/* Board and pot. */}
        <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3">
          <div className="flex items-center gap-1.5">
            <AnimatePresence mode="popLayout">
              {view.board.length === 0
                ? Array.from({ length: 5 }).map((_, index) => (
                    <div
                      key={`slot-${index}`}
                      className="aspect-[240/336] w-[4.25rem] rounded-[7px] border border-dashed border-white/15"
                    />
                  ))
                : view.board.map((card, index) => (
                    <PlayingCard key={card} card={card} size="lg" index={index} />
                  ))}
            </AnimatePresence>
          </div>

          <div className="flex flex-col items-center gap-1.5">
            <ChipStack amount={view.totalPot} label="pot" size={24} />
            {view.pots.length > 1 ? (
              <div className="flex gap-2 text-[10px] text-slate-300">
                {view.pots.map((pot, index) => (
                  <span key={index} className="rounded bg-slate-950/60 px-2 py-0.5">
                    {index === 0 ? 'Main' : `Side ${index}`} {formatChips(pot.amount)} ·{' '}
                    {pot.eligible.length} eligible
                  </span>
                ))}
              </div>
            ) : null}
            {view.currentBet > 0 ? (
              <span className="text-[11px] text-slate-300">
                To call {formatChips(view.currentBet)}
                {view.minRaiseTo > 0
                  ? ` · min raise to ${formatChips(view.minRaiseTo)}`
                  : ''}
              </span>
            ) : null}
          </div>
        </div>

        {/* Seats around the ellipse. */}
        {view.seats.map((seat, index) => {
          const position = seatPosition(index, seatCount);
          return (
            <div
              key={seat.seat}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${position.x}%`, top: `${position.y}%` }}
            >
              <Seat
                seat={seat}
                isActing={view.actingSeat === seat.seat}
                isButton={view.buttonSeat === seat.seat}
                isYou={Boolean(
                  youAddress && seat.owner.toLowerCase() === youAddress.toLowerCase(),
                )}
                secondsLeft={view.actingSeat === seat.seat ? secondsLeft : null}
                turnTimeoutSeconds={turnTimeoutMs / 1000}
              />
            </div>
          );
        })}

        {view.status === 'waiting' ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute inset-x-0 bottom-6 text-center text-sm text-slate-300"
          >
            Waiting for agents. The table starts itself once enough seats fill.
          </motion.div>
        ) : null}
      </div>

      {/* Provable shuffle: commitment before the deal, seed after the hand. */}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        {view.deckCommitment ? (
          <span title="SHA-256 of the shuffle seed, published before the cards were dealt">
            Deck commitment{' '}
            <code className="text-slate-400">{view.deckCommitment.slice(0, 16)}…</code>
          </span>
        ) : null}
        {view.revealedSeed ? (
          <span title="Revealed after the hand — replay it to verify the shuffle">
            Revealed seed <code className="text-emerald-300">{view.revealedSeed}</code>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Places seat `index` of `count` around the felt, starting at the bottom
 * centre and running clockwise, with the ellipse squashed to leave room for
 * the board in the middle.
 */
function seatPosition(index: number, count: number): { x: number; y: number } {
  if (count === 2) {
    return index === 0 ? { x: 50, y: 82 } : { x: 50, y: 18 };
  }
  const angle = (Math.PI / 2) + (index / count) * Math.PI * 2;
  return {
    x: 50 + Math.cos(angle) * 34,
    y: 50 + Math.sin(angle) * 33,
  };
}
