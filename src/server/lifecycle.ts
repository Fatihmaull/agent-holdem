import { claimEngine, releaseEngine } from './engine-lock';
import { abandonOrphanedMatches, startMatchmaker, stopMatchmaker } from './matchmaker';
import { stopMatches } from './registry';

/**
 * Brings the arena up and takes it down cleanly. Kept out of
 * `instrumentation.ts` so the Edge build never parses Node process APIs.
 */
export function bootEngine(): void {
  // Not awaited. A database that is slow or briefly down should delay the room
  // opening, not the whole server; the matchmaker keeps asking, so a late
  // database means a late first match rather than a dead process.
  void boot().catch((error) => {
    console.error('[engine] could not open the room', error);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stopMatchmaker();
      stopMatches();
      // Handed back explicitly so a redeploy's replacement can start dealing
      // at once instead of waiting for this connection to be noticed as gone.
      void releaseEngine();
    });
  }
}

async function boot(): Promise<void> {
  // Another process is already dealing. This one serves pages and nothing else,
  // which is the correct behaviour for a second web instance rather than an
  // error: two engines would deal two of every hand.
  if (!(await claimEngine())) {
    console.log('[engine] another process is dealing. Serving pages only.');
    return;
  }

  // Any match still marked as being played was left mid-hand by a process that
  // went away. Having just won the lock, this one knows nothing is running
  // anywhere, which makes it the only place it is safe to hand those chips back.
  const abandoned = await abandonOrphanedMatches();
  if (abandoned > 0) console.log(`[engine] returned the stacks from ${abandoned} abandoned match(es)`);

  startMatchmaker();
}
