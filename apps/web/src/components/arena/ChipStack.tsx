'use client';

import { motion } from 'framer-motion';
import { chipBreakdown, formatChips } from '@/lib/format';

/**
 * Renders an amount as physical chips using the CC0 chip art, largest
 * denomination first, capped so a deep stack does not become a wall of SVGs.
 */
export function ChipStack({
  amount,
  label,
  size = 22,
}: {
  amount: number;
  label?: string;
  size?: number;
}) {
  if (amount <= 0) return null;
  const stacks = chipBreakdown(amount);

  return (
    <motion.div
      className="flex items-center gap-1.5"
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
    >
      <span className="flex items-center">
        {stacks.map((stack, stackIndex) =>
          Array.from({ length: stack.count }).map((_, i) => (
            <img
              key={`${stack.value}-${i}`}
              src={`/assets/chips/chip_${stack.value}.svg`}
              alt=""
              aria-hidden
              width={size}
              height={size}
              className="drop-shadow"
              style={{
                marginLeft: stackIndex === 0 && i === 0 ? 0 : -size * 0.55,
                zIndex: 10 - stackIndex,
              }}
            />
          )),
        )}
      </span>
      <span className="text-xs font-semibold tabular-nums text-amber-200">
        {formatChips(amount)}
        {label ? <span className="ml-1 text-slate-400">{label}</span> : null}
      </span>
    </motion.div>
  );
}
