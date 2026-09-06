'use client';

import { AnimatePresence, motion } from 'framer-motion';
import type { SeatView } from '@agentholdem/shared';
import { formatChips, shortAddress } from '@/lib/format';
import { PlayingCard } from './PlayingCard';
import { ChipStack } from './ChipStack';

interface Props {
  seat: SeatView;
  isActing: boolean;
  isButton: boolean;
  isYou: boolean;
  /** Seconds left on the turn clock; null when it is not this seat's turn. */
  secondsLeft: number | null;
  turnTimeoutSeconds: number;
}

const ACTION_LABEL: Record<string, string> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  raise: 'Raise',
  'all-in': 'All-in',
};

export function Seat({
  seat,
  isActing,
  isButton,
  isYou,
  secondsLeft,
  turnTimeoutSeconds,
}: Props) {
  const clockRatio =
    secondsLeft === null ? 0 : Math.max(0, Math.min(1, secondsLeft / turnTimeoutSeconds));

  return (
    <div className="relative flex w-[188px] flex-col items-center gap-1.5">
      {/* Trash talk floats above the seat and fades on its own. */}
      <AnimatePresence>
        {seat.lastChat ? (
          <motion.div
            key={seat.lastChat}
            initial={{ opacity: 0, y: 8, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6 }}
            className="pointer-events-none absolute -top-9 z-20 max-w-[190px] rounded-2xl
              rounded-bl-sm border border-white/15 bg-slate-900/95 px-3 py-1.5 text-[11px]
              leading-snug text-slate-100 shadow-lg"
          >
            “{seat.lastChat}”
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div
        className={`relative w-full rounded-2xl border px-3 py-2.5 backdrop-blur transition-colors ${
          seat.folded
            ? 'border-white/5 bg-slate-950/50 opacity-55'
            : isActing
              ? 'border-cyan-400/70 bg-slate-900/90 animate-pulse-ring'
              : 'border-white/12 bg-slate-900/80'
        }`}
      >
        {isButton ? (
          <span
            className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full
              border border-white/25 bg-slate-100 text-[10px] font-bold text-slate-900"
            title="Dealer button"
          >
            D
          </span>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-semibold" title={seat.agentName}>
            {seat.agentName}
          </p>
          {isYou ? (
            <span className="shrink-0 rounded-md bg-cyan-400/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-cyan-200">
              You
            </span>
          ) : null}
        </div>

        <p className="truncate text-[10px] text-slate-500" title={seat.templateName}>
          {seat.templateName} · {shortAddress(seat.owner)}
        </p>

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-sm font-bold tabular-nums text-amber-300">
            {formatChips(seat.stack)}
          </span>
          {seat.allIn ? (
            <span className="rounded-md bg-rose-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-rose-200">
              All-in
            </span>
          ) : seat.lastAction ? (
            <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-300">
              {ACTION_LABEL[seat.lastAction.type] ?? seat.lastAction.type}
            </span>
          ) : null}
        </div>

        {/* Turn clock: the 30s deadline after which the engine auto check/folds. */}
        {isActing && secondsLeft !== null ? (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
            <motion.div
              className={`h-full rounded-full ${
                clockRatio < 0.25 ? 'bg-rose-400' : 'bg-cyan-400'
              }`}
              animate={{ width: `${clockRatio * 100}%` }}
              transition={{ ease: 'linear', duration: 0.3 }}
            />
          </div>
        ) : null}
      </div>

      <div className="flex h-[62px] items-center gap-1">
        {seat.holeCards ? (
          seat.holeCards.map((card, index) => (
            <PlayingCard key={card} card={card} size="md" index={index} dim={seat.folded} />
          ))
        ) : seat.folded ? null : (
          <>
            <PlayingCard faceDown size="md" index={0} />
            <PlayingCard faceDown size="md" index={1} />
          </>
        )}
      </div>

      <AnimatePresence>
        {seat.committed > 0 ? <ChipStack amount={seat.committed} size={18} /> : null}
      </AnimatePresence>
    </div>
  );
}
