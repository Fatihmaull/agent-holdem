import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { depositWatcher, engineStatus } from '@/server/registry';
import { vaultConfigured } from '@/server/chain';

/**
 * Whether this instance is actually working, not merely answering.
 *
 * A process that responds while its tables have stopped dealing is the failure
 * that matters here: nothing 500s, no request errors, and the product is dead.
 * So the checks are the three things the product cannot run without — the
 * database, the match engine, and the deposit watcher — and any of them being
 * wrong is a 503 that an uptime check will page on.
 *
 * `AGENTHOLDEM_DISABLE_ENGINE=1` is a supported way to run this process, so a
 * missing engine is only a fault when one was meant to be running.
 */
export const dynamic = 'force-dynamic';

/**
 * How long the engine may go without finishing a hand before it is called
 * stalled. Generous: an empty table finishes no hands at all, and quiet is not
 * the same as broken, so this only fires once a table has dealt at least once.
 */
const STALL_AFTER_MS = Number(process.env.HEALTH_STALL_AFTER_MS ?? 10 * 60 * 1000);

export async function GET(): Promise<Response> {
  const engineExpected = process.env.AGENTHOLDEM_DISABLE_ENGINE !== '1';

  const database = await checkDatabase();
  const engine = engineExpected ? checkEngine() : { ok: true, detail: 'disabled by configuration' };
  const deposits = engineExpected ? checkDeposits() : { ok: true, detail: 'disabled by configuration' };

  const ok = database.ok && engine.ok && deposits.ok;
  return Response.json(
    { ok, checks: { database, engine, deposits }, at: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}

interface Check {
  ok: boolean;
  detail?: string;
  [field: string]: unknown;
}

async function checkDatabase(): Promise<Check> {
  const started = Date.now();
  try {
    await db.execute(sql`select 1`);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : 'unreachable' };
  }
}

function checkEngine(): Check {
  const status = engineStatus();
  if (status.dealing === 0) {
    return { ok: false, detail: 'no table is dealing', ...status };
  }
  // Only meaningful once a hand has actually completed. Before that, silence
  // means the tables are waiting for a second agent, which is not a fault.
  if (status.lastHandAt !== null && Date.now() - status.lastHandAt > STALL_AFTER_MS) {
    return { ok: false, detail: 'no hand has finished recently', ...status };
  }
  return { ok: true, ...status };
}

function checkDeposits(): Check {
  if (!vaultConfigured()) {
    // Nobody can deposit yet, so a watcher with nothing to watch is correct.
    return { ok: true, detail: 'no vault configured' };
  }

  const status = depositWatcher().status();
  if (!status.watching) return { ok: false, detail: 'the deposit watcher is not running' };
  if (status.lastError) return { ok: false, detail: `last sweep failed: ${status.lastError}` };
  return { ok: true, lastSweepAt: status.lastSweepAt };
}
