import { createProvider, type ModelProvider } from '../agent/provider';
import { modelQueue, type ModelQueue } from '../agent/queue';
import type { MatchConfig } from '../lib/economy';
import { MatchRuntime } from './table';
import type { MatchEnding } from './store';

/**
 * The matches being dealt in this process.
 *
 * A match lives here from the moment it is created until it is settled, and
 * then it is gone: matches are ephemeral by design, so this map turns over
 * constantly rather than holding a fixed roster.
 *
 * `next dev` reloads modules, so both the map and the model plumbing hang off
 * globalThis. A hot reload that built a second registry would deal every open
 * match twice.
 */
const globalForMatches = globalThis as unknown as {
  __agentholdemMatches?: Map<string, MatchRuntime>;
  __agentholdemEngine?: { provider: ModelProvider; queue: ModelQueue };
};

/**
 * One provider and one queue for every match. The queue is what holds the rate
 * limit, so a second one would hand out the same allowance twice.
 */
function engineParts(): { provider: ModelProvider; queue: ModelQueue } {
  if (!globalForMatches.__agentholdemEngine) {
    globalForMatches.__agentholdemEngine = { provider: createProvider(), queue: modelQueue() };
  }
  return globalForMatches.__agentholdemEngine;
}

function registry(): Map<string, MatchRuntime> {
  if (!globalForMatches.__agentholdemMatches) globalForMatches.__agentholdemMatches = new Map();
  return globalForMatches.__agentholdemMatches;
}

export function matchRuntime(id: string): MatchRuntime | undefined {
  return registry().get(id);
}

export function allMatches(): MatchRuntime[] {
  return [...registry().values()];
}

/**
 * Starts dealing a match that has already been created and seated.
 *
 * The seats exist by the time this is called, and the buy-ins have already left
 * their owners' balances, so this only puts a dealer on a game that is
 * otherwise ready.
 */
export function openMatch(
  matchId: string,
  config: MatchConfig,
  onFinished: (id: string, ending: MatchEnding, hands: number) => void,
): MatchRuntime {
  const open = registry().get(matchId);
  if (open) return open;

  const { provider, queue } = engineParts();
  const runtime = new MatchRuntime(matchId, config, provider, queue, onFinished);
  registry().set(matchId, runtime);
  runtime.start();
  return runtime;
}

/**
 * Takes a finished match off the floor.
 *
 * Only called once its chips have been returned and its result recorded.
 * Dropping a runtime before that would abandon whatever it was holding.
 */
export function closeMatch(id: string): void {
  const runtime = registry().get(id);
  if (!runtime) return;

  registry().delete(id);
  runtime.stop();
}

export function stopMatches(): void {
  for (const match of registry().values()) match.stop();
  registry().clear();
}
