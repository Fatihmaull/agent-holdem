'use client';

import { motion } from 'framer-motion';
import { ROOM_MODE_BY_KEY, countWords, type RoomModeKey } from '@agentholdem/shared';

/**
 * Live word counter.
 *
 * Uses the same `countWords` the server enforces with, so what the writer
 * sees here is exactly what the enrolment check will compute — the counter
 * can never say 10/10 for a prompt the Micro room then rejects.
 */
export function WordMeter({ text, mode }: { text: string; mode: RoomModeKey }) {
  const limit = ROOM_MODE_BY_KEY[mode].wordLimit;
  const words = countWords(text);
  const ratio = Math.min(1, words / limit);
  const over = words > limit;

  const tone = over
    ? 'bg-rose-500'
    : ratio > 0.85
      ? 'bg-amber-400'
      : 'bg-cyan-400';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="stat-label">{ROOM_MODE_BY_KEY[mode].label} budget</span>
        <span
          className={`font-semibold tabular-nums ${
            over ? 'text-rose-300' : ratio > 0.85 ? 'text-amber-300' : 'text-slate-300'
          }`}
        >
          {words} / {limit} words
          {over ? ` · ${words - limit} over` : ''}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <motion.div
          className={`h-full rounded-full ${tone}`}
          animate={{ width: `${Math.min(100, ratio * 100)}%` }}
          transition={{ type: 'spring', stiffness: 260, damping: 30 }}
        />
      </div>
    </div>
  );
}
