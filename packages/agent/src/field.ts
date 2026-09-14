import { readFileSync } from 'node:fs';
import { Agent } from './client';
import { HeuristicBrain, ModelBrain, type Brain } from './brain';

/**
 * Runs several agents from one process.
 *
 * This is what keeps an arena inhabited. Two is a legal match, so an arena with
 * nobody in it is not a quiet arena, it is a broken one: the first person to
 * bring an agent has nobody to play and waits forever.
 *
 * One detail decides the shape of a field. The matchmaker refuses to seat two
 * agents with the same owner at one table, so a field spread across N accounts
 * can put at most N agents in a match. Running one more agent than that leaves
 * a spare permanently free, and a stranger who connects is seated against it
 * within seconds instead of waiting out somebody else's match.
 *
 * ```
 * ARENA_URL=ws://localhost:3000/agent \
 * AGENT_FIELD=./field.json \
 * pnpm --filter @pokertunity/agent field
 * ```
 *
 * Where field.json is a list of entries:
 *
 * ```json
 * [
 *   { "token": "ah_...", "brain": "model", "strategy": "Raise your pairs." },
 *   { "token": "ah_...", "brain": "heuristic" }
 * ]
 * ```
 */

interface Entry {
  token: string;
  brain?: 'model' | 'heuristic';
  strategy?: string;
}

function load(): Entry[] {
  const source = process.env.AGENT_FIELD?.trim();
  if (!source) throw new Error('AGENT_FIELD is not set. Point it at a JSON file or give it JSON directly.');

  const text = source.startsWith('[') ? source : readFileSync(source, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('AGENT_FIELD must be a non-empty list.');

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`entry ${index} is not an object`);
    const row = entry as Entry;
    if (typeof row.token !== 'string') throw new Error(`entry ${index} has no token`);
    return row;
  });
}

function brainFor(entry: Entry): Brain {
  return entry.brain === 'model' ? new ModelBrain(entry.strategy ?? '') : new HeuristicBrain();
}

const url = process.env.ARENA_URL ?? 'ws://localhost:3000/agent';
const field = load();
const agents = field.map((entry) => new Agent({ url, token: entry.token, brain: brainFor(entry) }));

// Staggered rather than all at once. Six sockets opening in the same
// millisecond is the one moment a reconnect storm looks exactly like an attack,
// and there is no reason to be in a hurry.
agents.forEach((agent, index) => setTimeout(() => agent.start(), index * 250));

console.log(`[field] starting ${agents.length} agents against ${url}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    for (const agent of agents) agent.stop();
    process.exit(0);
  });
}
