import { awaitTablesIdle, depositWatcher, drainTables, startTables, stopTables } from './registry';
import { logger } from './log';

/**
 * Brings the match engine up and takes it down cleanly. Kept out of
 * `instrumentation.ts` so the Edge build never parses Node process APIs.
 */

/**
 * How long a hand in progress is given to finish once a deploy has started.
 *
 * Longer than the act clock times a full table, so an ordinary hand always
 * lands, and short enough to stay inside a platform's own termination grace
 * period — which must be set higher than this or the container is killed
 * before the drain can do anything.
 */
const DRAIN_TIMEOUT_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 45_000);

/** After the abort, how long to let the loops unwind before giving up on them. */
const ABORT_TIMEOUT_MS = 5_000;

export function bootEngine(): void {
  startTables();
  depositWatcher().start();

  // Next installs its own SIGINT and SIGTERM handlers that call process.exit as
  // soon as the HTTP server is closed, which would cut a hand off mid-deal
  // however patiently we drained. Setting NEXT_MANUAL_SIG_HANDLE hands the
  // signals to us instead — so if it is not set, say so once rather than
  // letting an operator believe hands are being drained when they are not.
  const owned = Boolean(process.env.NEXT_MANUAL_SIG_HANDLE);
  logger.info('engine.started', {
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    gracefulShutdown: owned,
    detail: owned ? undefined : 'set NEXT_MANUAL_SIG_HANDLE=1 so a deploy can finish the hand in progress',
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal, owned);
    });
  }
}

let shuttingDown = false;

/**
 * Ends the process without losing a hand.
 *
 * Three steps, in this order. Stop dealing new hands, so the set of hands that
 * still matter is finite. Wait for the ones in flight, because a hand that
 * finishes is stored and a hand that does not is thrown away. Then abort, so a
 * table wedged on an unresponsive provider cannot hold the deploy open forever.
 *
 * Nothing here can lose chips: an incomplete hand is never written, and the
 * stored stacks still hold every chip that was in front of a seat when the last
 * hand was recorded. The cost of the abort is a hand that has to be replayed
 * from its starting stacks, not a hand that was half paid for.
 */
async function shutdown(signal: 'SIGINT' | 'SIGTERM', owned: boolean): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const started = Date.now();
  logger.info('engine.draining', { signal, timeoutMs: DRAIN_TIMEOUT_MS });

  depositWatcher().stop();
  drainTables();

  const drained = await awaitTablesIdle(DRAIN_TIMEOUT_MS);
  if (!drained) {
    logger.warn('engine.drain-timeout', {
      elapsedMs: Date.now() - started,
      detail: 'a hand was still running and is being abandoned; its chips are untouched',
    });
    stopTables();
    await awaitTablesIdle(ABORT_TIMEOUT_MS);
  }

  logger.info('engine.stopped', { signal, elapsedMs: Date.now() - started, drained });

  // Only ours to end when Next has handed us the signals. Otherwise Next is
  // already on its way out and calling exit here would race its own cleanup.
  if (owned) process.exit(signal === 'SIGINT' ? 130 : 143);
}
