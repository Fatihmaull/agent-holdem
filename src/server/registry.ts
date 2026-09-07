import { createProvider } from '../agent/provider';
import { modelQueue } from '../agent/queue';
import { TABLES } from '../lib/economy';
import { TableRuntime } from './table';

/**
 * The tables live in this process for its whole life. `next dev` reloads
 * modules, so the registry hangs off globalThis to stop a hot reload from
 * starting a second copy of every table.
 */
const globalForTables = globalThis as unknown as {
  __agentholdemTables?: Map<string, TableRuntime>;
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

export function tableRuntime(id: string): TableRuntime | undefined {
  return registry().get(id);
}

export function allTables(): TableRuntime[] {
  return [...registry().values()];
}

export function startTables(): void {
  for (const table of registry().values()) table.start();
}

export function stopTables(): void {
  for (const table of registry().values()) table.stop();
}
