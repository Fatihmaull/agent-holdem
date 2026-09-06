import { describe, expect, it, vi } from 'vitest';
import { countWords, validatePromptForMode } from '@agentholdem/shared';
import { AgentWorker } from '../src/llm/agentWorker.js';
import { extractJsonObject, parseDecision, type LlmProvider } from '../src/llm/provider.js';
import { contextFromEngine } from '../src/llm/promptBuilder.js';
import { heuristicDecision, profileFromPersona } from '../src/llm/heuristic.js';
import { HandEngine } from '../src/engine/hand.js';

function ctx(stacks = [1000, 1000]) {
  const engine = new HandEngine({
    seats: stacks.map((stack, i) => ({
      seat: i,
      agentName: `agent-${i}`,
      owner: `0x${i}`,
      stack,
    })),
    buttonIndex: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: 'agent-test',
    handNumber: 1,
  });
  return contextFromEngine(engine, engine.currentActor()!.index, {
    tableName: 'Test Table',
    mode: 'tactical',
    bigBlind: 20,
    actionLog: [],
    chatLog: [],
    timeoutSeconds: 30,
  });
}

function fakeProvider(
  impl: (system: string, user: string, signal: AbortSignal) => Promise<string>,
  name: 'groq' | 'gemini' = 'groq',
): LlmProvider {
  return { name, model: 'test-model', complete: impl };
}

describe('parseDecision', () => {
  it('parses a clean JSON object', () => {
    const d = parseDecision(
      '{"action":"raise","amount":120,"inner_thought":"strong","table_chat":"pay me"}',
    );
    expect(d).toEqual({
      action: 'raise',
      amount: 120,
      inner_thought: 'strong',
      table_chat: 'pay me',
    });
  });

  it('digs the object out of a fenced, chatty response', () => {
    const raw = 'Sure! Here is my move:\n```json\n{"action":"call","amount":20,' +
      '"inner_thought":"pot odds","table_chat":"call"}\n```\nGood luck.';
    expect(parseDecision(raw)?.action).toBe('call');
  });

  it('normalises common action synonyms', () => {
    expect(parseDecision('{"action":"SHOVE","amount":0}')?.action).toBe('all-in');
    expect(parseDecision('{"action":"bet","amount":50}')?.action).toBe('raise');
    expect(parseDecision('{"action":"Re-Raise","amount":50}')?.action).toBe('raise');
  });

  it('accepts a numeric amount sent as a string', () => {
    expect(parseDecision('{"action":"raise","amount":"80"}')?.amount).toBe(80);
  });

  it('rejects output with no usable action', () => {
    expect(parseDecision('I think I will fold this one.')).toBeNull();
    expect(parseDecision('{"action":"sleep","amount":0}')).toBeNull();
  });

  it('is not confused by braces inside strings', () => {
    const raw = '{"action":"check","amount":0,"inner_thought":"a {weird} thought",' +
      '"table_chat":"} not the end"}';
    expect(parseDecision(raw)?.inner_thought).toBe('a {weird} thought');
  });

  it('extracts only the first balanced object', () => {
    expect(extractJsonObject('noise {"a":{"b":1}} tail {"c":2}')).toBe('{"a":{"b":1}}');
  });
});

describe('AgentWorker turn contract', () => {
  const base = {
    turnTimeoutMs: 2_000,
    attemptTimeoutMs: 800,
    useHeuristicFallback: false,
  };

  it('returns the model decision when the first call succeeds', async () => {
    const worker = new AgentWorker({
      ...base,
      providers: [
        fakeProvider(async () =>
          '{"action":"raise","amount":60,"inner_thought":"t","table_chat":"c"}',
        ),
      ],
    });
    const result = await worker.takeTurn(ctx(), 'Aggressive bully.', 's');
    expect(result.source).toBe('llm');
    expect(result.decision.action).toBe('raise');
  });

  it('retries once, then reports the retry as the source', async () => {
    const calls = vi.fn();
    const worker = new AgentWorker({
      ...base,
      providers: [
        fakeProvider(async () => {
          calls();
          return calls.mock.calls.length === 1
            ? 'sorry, I cannot decide'
            : '{"action":"call","amount":20,"inner_thought":"t","table_chat":"c"}';
        }),
      ],
    });
    const result = await worker.takeTurn(ctx(), 'Tight and patient.', 's');
    expect(calls).toHaveBeenCalledTimes(2);
    expect(result.source).toBe('llm-retry');
  });

  it('falls over to the secondary provider when the primary fails', async () => {
    const worker = new AgentWorker({
      ...base,
      providers: [
        fakeProvider(async () => {
          throw new Error('groq 429 rate limited');
        }),
        fakeProvider(
          async () => '{"action":"check","amount":0,"inner_thought":"t","table_chat":"c"}',
          'gemini',
        ),
      ],
    });
    const result = await worker.takeTurn(ctx(), 'Careful.', 's');
    expect(result.source).toBe('llm-retry');
    expect(result.provider).toBe('gemini');
  });

  it('folds when the clock runs out facing a bet', async () => {
    const worker = new AgentWorker({
      ...base,
      turnTimeoutMs: 400,
      attemptTimeoutMs: 200,
      providers: [
        fakeProvider(
          (_s, _u, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }),
        ),
      ],
    });
    // The button faces the big blind pre-flop, so checking is not available.
    const result = await worker.takeTurn(ctx(), 'Anything.', 's');
    expect(result.source).toBe('fallback-timeout');
    expect(result.decision.action).toBe('fold');
  });

  it('checks when the clock runs out and checking is free', async () => {
    const engine = new HandEngine({
      seats: [0, 1].map((i) => ({ seat: i, agentName: `a${i}`, owner: `0x${i}`, stack: 1000 })),
      buttonIndex: 0,
      smallBlind: 10,
      bigBlind: 20,
      seed: 'free-check',
      handNumber: 1,
    });
    engine.applyAction({ type: 'call', amount: 20 });
    const freeContext = contextFromEngine(engine, engine.currentActor()!.index, {
      tableName: 'T',
      mode: 'micro',
      bigBlind: 20,
      actionLog: [],
      chatLog: [],
      timeoutSeconds: 30,
    });

    const worker = new AgentWorker({ ...base, turnTimeoutMs: 200, providers: [] });
    const result = await worker.takeTurn(freeContext, 'Anything.', 's');
    expect(result.decision.action).toBe('check');
  });

  it('never leaves a turn unresolved when every provider is broken', async () => {
    const worker = new AgentWorker({
      ...base,
      useHeuristicFallback: true,
      providers: [
        fakeProvider(async () => {
          throw new Error('network down');
        }),
      ],
    });
    const result = await worker.takeTurn(ctx(), 'The Mathematician plays pot odds.', 's');
    expect(result.source).toBe('fallback-error');
    expect(['fold', 'check', 'call', 'raise', 'all-in']).toContain(result.decision.action);
  });
});

describe('deterministic policy engine', () => {
  it('reads aggression out of the persona text', () => {
    const bully = profileFromPersona('Relentless pressure. Raise weakness, three-bet often.');
    const nit = profileFromPersona('Tight and patient. Fold marginal spots, respect pot odds.');
    expect(bully.aggression).toBeGreaterThan(nit.aggression);
    expect(profileFromPersona('Slow-play monsters and check-raise turns.').trappy).toBe(true);
  });

  it('produces a legal, deterministic decision for the same seed', () => {
    const c = ctx();
    const a = heuristicDecision(c, 'Aggressive bully.', 'seed-x');
    const b = heuristicDecision(c, 'Aggressive bully.', 'seed-x');
    expect(a).toEqual(b);
  });
});

describe('room word limits', () => {
  it('counts words the same way the UI counter does', () => {
    expect(countWords('Play pot odds strictly. Fold marginal spots.')).toBe(7);
    expect(countWords('three-bet or fold')).toBe(3);
    expect(countWords('  ...  !!!  ')).toBe(0);
  });

  it('rejects a prompt that overflows the room budget', () => {
    const long = Array.from({ length: 11 }, (_, i) => `word${i}`).join(' ');
    const result = validatePromptForMode(long, 'micro');
    expect(result.ok).toBe(false);
    expect(validatePromptForMode(long, 'tactical').ok).toBe(true);
  });

  it('rejects an empty prompt', () => {
    expect(validatePromptForMode('   ', 'deep').ok).toBe(false);
  });
});
