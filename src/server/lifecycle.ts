import { startTables, stopTables } from './registry';

/**
 * Brings the match engine up and takes it down cleanly. Kept out of
 * `instrumentation.ts` so the Edge build never parses Node process APIs.
 */
export function bootEngine(): void {
  startTables();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stopTables();
    });
  }
}
