'use client';

import { useEffect, useState } from 'react';

/**
 * Milliseconds left on a deadline, ticking while there is one.
 *
 * Every seat on the felt calls this and only one of them is on the clock.
 * Ticking for the other five is five timers running to report a number nobody
 * reads, so no deadline starts no timer.
 */
export function useRemaining(deadline: number | null): number {
  const [remaining, setRemaining] = useState(() =>
    deadline == null ? 0 : Math.max(0, deadline - Date.now()),
  );

  useEffect(() => {
    if (deadline == null) return;
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [deadline]);

  // Read through rather than stored, so a seat that has stopped acting reports
  // nothing left on the clock without waiting for a render to clear it.
  return deadline == null ? 0 : remaining;
}
