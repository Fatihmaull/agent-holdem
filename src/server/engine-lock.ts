import { sql } from '../db/client';

/**
 * Exactly one process deals.
 *
 * Table state lives in memory, so two server processes running the engine would
 * each deal their own copy of every table: two different hands with the same
 * hand number, two sets of decisions, and stacks that disagree with the seat
 * rows. Nothing downstream would flag it, because both processes would be
 * writing plausible records.
 *
 * The obvious answer is to pin the deployment to one instance, but that is a
 * setting rather than a property, and it is silently wrong the first time a
 * platform decides to run a second copy during a deploy or a restart. So the
 * lock lives in the database every process already talks to. A Postgres
 * advisory lock is held for the life of a connection and released the moment
 * that connection drops, which means a process that is killed hands the room to
 * the next one without anybody having to notice it died.
 *
 * A process that does not get the lock still serves pages. It just does not
 * deal, which is exactly what a second web instance should do.
 */

/**
 * The lock's name, as the arbitrary integer Postgres wants.
 *
 * Fixed so that every process of this application competes for the same one,
 * and unusual enough not to collide with anything else using advisory locks on
 * a shared database. Kept inside the range a double holds exactly, so it
 * survives the driver without a cast.
 */
const ENGINE_LOCK_KEY = 800_407_111_314_200;

type Reserved = Awaited<ReturnType<typeof sql.reserve>>;

/**
 * The connection holding the lock, kept out of the pool and off this module.
 *
 * It has to be the same session for as long as we hold it: a pooled connection
 * would be handed to some other query and the lock would travel with it, or be
 * released under us when that query finished.
 *
 * Parked on `globalThis` for the same reason the table registry is. The engine
 * is started from `instrumentation.ts` and read from a route, and those two do
 * not always resolve to the same copy of this module, so a module-level
 * variable would have the room dealing while every route insisted it was not.
 */
const globalForLock = globalThis as unknown as { __agentholdemEngineLock?: Reserved | null };

function held(): Reserved | null {
  return globalForLock.__agentholdemEngineLock ?? null;
}

/** Whether this process is the one dealing. */
export function dealing(): boolean {
  return held() !== null;
}

/**
 * Tries to become the dealing process.
 *
 * Returns false rather than throwing when another process already holds it,
 * because that is the ordinary case for a second web instance, not a fault. It
 * throws only when the database itself could not be asked.
 */
export async function claimEngine(): Promise<boolean> {
  if (held()) return true;

  const connection = await sql.reserve();
  try {
    const [row] = await connection`select pg_try_advisory_lock(${ENGINE_LOCK_KEY}) as locked`;
    if (!row?.locked) {
      connection.release();
      return false;
    }

    globalForLock.__agentholdemEngineLock = connection;
    return true;
  } catch (error) {
    connection.release();
    throw error;
  }
}

/**
 * Gives the room up.
 *
 * Called on shutdown so a redeploy hands over immediately rather than making
 * the next process wait for a dropped connection to be noticed. Releasing the
 * connection alone would be enough, but saying so explicitly means a pool that
 * recycles rather than closes cannot keep the lock alive.
 */
export async function releaseEngine(): Promise<void> {
  const connection = held();
  if (!connection) return;
  globalForLock.__agentholdemEngineLock = null;

  try {
    await connection`select pg_advisory_unlock(${ENGINE_LOCK_KEY})`;
  } catch {
    // Shutting down. The connection is about to close, which releases it
    // anyway, so there is nothing useful to do with this failure.
  } finally {
    connection.release();
  }
}
