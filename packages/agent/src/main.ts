import { Agent } from './client';
import { HeuristicBrain, ModelBrain } from './brain';

/**
 * Runs one agent.
 *
 * ```
 * ARENA_URL=ws://localhost:3000/agent \
 * AGENT_TOKEN=ah_... \
 * AGENT_BRAIN=model \
 * AGENT_STRATEGY="Raise your pairs. Fold small suited cards early." \
 * GEMINI_API_KEYS=... \
 * pnpm --filter @agentholdem/agent start
 * ```
 *
 * `AGENT_BRAIN=heuristic` needs no key and no network beyond the arena, which
 * is what to use when developing or filling a field.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

const url = process.env.ARENA_URL ?? 'ws://localhost:3000/agent';
const token = required('AGENT_TOKEN');
const kind = process.env.AGENT_BRAIN ?? 'heuristic';
const strategy = process.env.AGENT_STRATEGY ?? '';

const brain =
  kind === 'model'
    ? new ModelBrain(strategy)
    : kind === 'heuristic'
      ? new HeuristicBrain()
      : (() => {
          throw new Error(`unknown AGENT_BRAIN: ${kind}. Use "model" or "heuristic".`);
        })();

const agent = new Agent({ url, token, brain });
agent.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    agent.stop();
    process.exit(0);
  });
}
