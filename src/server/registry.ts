import { createProvider } from '../agent/provider';
import { modelQueue } from '../agent/queue';
import { TABLES } from '../lib/economy';
import { DepositWatcher } from './deposits';
import { TableRuntime } from './table';

/**
 * The tables live in this process for its whole life. `next dev` reloads
 * modules, so the registry hangs off globalThis to stop a hot reload from
 * starting a second copy of every table.
 */
const globalForTables = globalThis as unknown as {
  __agentholdemTables?: Map<string, TableRuntime>;
  __agentholdemDeposits?: DepositWatcher;
};

function registry(): Map<string, TableRuntime> {
  if (!globalForTables.__agentholdemTables) {
    const provider = createProvider();
    const queue = modelQueue();
    globalForTables.__agentholdemTables = new Map(
      TABLES.map((config) => [config.id, new TableRuntime(config, provider, queue)]),
    );
  }
  return globalForTables.__agentholdemTables;
}

/**
 * The deposit watcher, alongside the tables for the same reason: it holds a
 * scan cursor, and two of them would read the same logs twice.
 */
export function depositWatcher(): DepositWatcher {
  if (!globalForTables.__agentholdemDeposits) {
    globalForTables.__agentholdemDeposits = new DepositWatcher();
  }
  return globalForTables.__agentholdemDeposits;
}

export function tableRuntime(id: string): TableRuntime | undefined {
  return registry().get(id);
}

export function allTables(): TableRuntime[] {
  return [...registry().values()];
}

export function startTables(): void {
  for (const table of registry().values()) table.start();
}

/** Stops dealing new hands everywhere. Hands in progress are left to finish. */
export function drainTables(): void {
  for (const table of registry().values()) table.drain();
}

/** Gives up on whatever is in flight. Nothing incomplete is ever stored. */
export function stopTables(): void {
  for (const table of registry().values()) table.stop();
}

/**
 * Waits for every table to finish the hand it is on.
 *
 * Returns false if the deadline passed first, which is the caller's cue to stop
 * asking nicely. Time-boxed rather than unbounded: a deploy that waits forever
 * for one wedged table is an outage.
 */
export async function awaitTablesIdle(timeoutMs: number): Promise<boolean> {
  const idle = Promise.all([...registry().values()].map((table) => table.finished()));
  const expired = Symbol('timeout');
  const timer = new Promise<typeof expired>((resolve) => {
    const handle = setTimeout(() => resolve(expired), timeoutMs);
    handle.unref?.();
  });
  return (await Promise.race([idle, timer])) !== expired;
}

export interface EngineStatus {
  /** Tables that are still dealing, out of the whole roster. */
  dealing: number;
  tables: number;
  /** Most recent completed hand across the roster, as epoch milliseconds. */
  lastHandAt: number | null;
}

export function engineStatus(): EngineStatus {
  const tables = [...registry().values()];
  const stamps = tables.map((table) => table.lastHandAt).filter((at): at is number => at !== null);
  return {
    dealing: tables.filter((table) => table.live).length,
    tables: tables.length,
    lastHandAt: stamps.length > 0 ? Math.max(...stamps) : null,
  };
}
