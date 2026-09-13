import { claimEngine, releaseEngine } from './engine-lock';
import { abandonOrphanedMatches, startMatchmaker, stopMatchmaker } from './matchmaker';
import { stopMatches } from './registry';

/**
 * Brings the arena up and takes it down cleanly. Kept out of
 * `instrumentation.ts` so the Edge build never parses Node process APIs.
 */

/** How often a process that is not dealing offers to take over. */
const CLAIM_RETRY_MS = 15_000;

let retry: NodeJS.Timeout | null = null;
let announced = false;

export function bootEngine(): void {
  // A process that is told not to deal serves pages and nothing else. Useful
  // for a second instance, and for running the site against a database some
  // other process is already dealing on without the two racing for the lock.
  if (process.env.AGENTHOLDEM_DISABLE_ENGINE === '1') {
    console.log('[engine] disabled by AGENTHOLDEM_DISABLE_ENGINE. Serving pages only.');
    return;
  }

  // Not awaited. A database that is slow or briefly down should delay the room
  // opening, not the whole server; the matchmaker keeps asking, so a late
  // database means a late first match rather than a dead process.
  void open();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (retry) clearTimeout(retry);
      retry = null;
      stopMatchmaker();
      stopMatches();
      // Handed back explicitly so a redeploy's replacement can start dealing
      // at once instead of waiting for this connection to be noticed as gone.
      void releaseEngine();
    });
  }
}

async function open(): Promise<void> {
  try {
    // Another process is already dealing. This one serves pages and nothing
    // else, which is the correct behaviour for a second web instance rather
    // than an error: two engines would deal two of every hand.
    if (!(await claimEngine())) {
      if (!announced) {
        console.log('[engine] another process is dealing. Serving pages only.');
        announced = true;
      }
      return later();
    }

    // Any match still marked as being played was left mid-hand by a process
    // that went away. Having just won the lock, this one knows nothing is
    // running anywhere, which makes it the only place it is safe to hand those
    // chips back.
    const abandoned = await abandonOrphanedMatches();
    if (abandoned > 0) console.log(`[engine] returned the stacks from ${abandoned} abandoned match(es)`);

    startMatchmaker();
    console.log('[engine] dealing');
  } catch (error) {
    console.error('[engine] could not open the room', error);
    later();
  }
}

/**
 * Asks again shortly.
 *
 * Claiming once would be enough on a machine that is restarted, and wrong
 * everywhere a deploy overlaps: the replacement starts while the outgoing
 * process still holds the lock, loses the race, and would then serve pages
 * forever with nobody dealing at all. Unreffed so it never holds the process
 * open on its own.
 */
function later(): void {
  if (retry) return;
  retry = setTimeout(() => {
    retry = null;
    void open();
  }, CLAIM_RETRY_MS);
  retry.unref();
}
