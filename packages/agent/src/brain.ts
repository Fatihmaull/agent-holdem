import type { ActFrame, DecisionFrame } from '@pokertunity/protocol';
import { buildPrompt, SYSTEM_PROMPT } from './prompt';
import { ProviderError, createProvider, type ModelProvider } from './provider';
import { ModelQueue, modelQueue } from './queue';

/**
 * What turns a decision request into a move.
 *
 * Two are shipped. One asks a language model and streams what it says. One does
 * arithmetic on the numbers the arena already sent. They implement the same
 * interface because the arena cannot tell them apart and neither can anyone
 * watching: both stream reasoning, both answer inside the clock, and both are
 * checked against the legal move set on arrival.
 *
 * Neither is privileged. An agent that ignores this file entirely and answers
 * from a solver, a hand database or a lookup table plays the same game.
 */
export interface Brain {
  /**
   * Decides, streaming reasoning as it goes.
   *
   * Throwing is allowed and costs the hand rather than the connection: the
   * caller sends nothing, and the arena's own fallback checks when checking is
   * free and folds when it is not.
   */
  decide(
    frame: ActFrame,
    emit: (text: string) => void,
    signal: AbortSignal,
  ): Promise<Omit<DecisionFrame, 'type' | 'id'>>;
}

/* -------------------------------------------------------------------------- */

/**
 * Asks a model, in the agent's own words and on the agent's own key.
 *
 * The reasoning is streamed out as it arrives rather than buffered, because
 * spectators watch a decision form and a paragraph that appears all at once is
 * a result rather than a thought.
 */
export class ModelBrain implements Brain {
  constructor(
    private readonly strategy: string,
    private readonly provider: ModelProvider = createProvider(),
    private readonly queue: ModelQueue = modelQueue(),
  ) {}

  // Called through the Brain interface by the client, which static analysis does
  // not follow. It is the contract, not a spare method.
  // fallow-ignore-next-line unused-class-member
  async decide(
    frame: ActFrame,
    emit: (text: string) => void,
    signal: AbortSignal,
  ): Promise<Omit<DecisionFrame, 'type' | 'id'>> {
    const text = await this.queue.run(async (apiKey) => {
      let full = '';
      for await (const chunk of this.provider.stream(
        {
          system: SYSTEM_PROMPT,
          user: buildPrompt(frame, this.strategy),
          maxOutputTokens: Number(process.env.AGENT_MAX_OUTPUT_TOKENS ?? 2048),
          temperature: 0.9,
        },
        apiKey,
        signal,
      )) {
        full += chunk;
        emit(chunk);
      }
      return full;
    }, signal);

    const parsed = extractJson(text);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new ProviderError('the model returned no usable JSON');
    }

    const reply = parsed as { action?: unknown; to?: unknown; say?: unknown };
    const decision: Omit<DecisionFrame, 'type' | 'id'> = { action: String(reply.action) as DecisionFrame['action'] };
    if (reply.to !== undefined) decision.to = Number(reply.to);
    if (typeof reply.say === 'string') decision.say = reply.say;
    return decision;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Plays by the numbers the arena already computed.
 *
 * Free, instant, and never rate limited, which makes it what you run to fill a
 * field or to develop against with no key at all. It is also honest about what
 * it is: four sentences with the figures dropped in, not a thought.
 *
 * It reads the frame's own fields rather than parsing a prompt, which is the
 * one real gain from the arena sending structured facts instead of English.
 */
export class HeuristicBrain implements Brain {
  /** How far above the break-even price a hand has to be before it pays to continue. */
  constructor(private readonly edge = 0.04) {}

  // Called through the Brain interface by the client, which static analysis does
  // not follow. It is the contract, not a spare method.
  // fallow-ignore-next-line unused-class-member
  async decide(
    frame: ActFrame,
    emit: (text: string) => void,
    signal: AbortSignal,
  ): Promise<Omit<DecisionFrame, 'type' | 'id'>> {
    const { legal, equity } = frame;
    const pct = (equity.equity * 100).toFixed(0);
    const breakEven = legal.toCall > 0 ? legal.toCall / (frame.potSize + legal.toCall) : 0;

    let decision: Omit<DecisionFrame, 'type' | 'id'>;
    let reasoning: string;

    if (equity.equity > 0.66 && (legal.raise ?? legal.bet)) {
      const range = legal.raise ?? legal.bet!;
      decision = {
        action: legal.raise ? 'raise' : 'bet',
        to: Math.min(range.max, Math.round(range.min * 1.6)),
      };
      reasoning = `Ahead of the range here at ${pct}%, so this is a spot to build the pot.`;
    } else if (legal.call !== null && equity.equity > breakEven + this.edge) {
      decision = { action: 'call' };
      reasoning = `Priced in: ${pct}% against a break-even of ${(breakEven * 100).toFixed(0)}%.`;
    } else if (legal.check) {
      decision = { action: 'check' };
      reasoning = 'Nothing worth building yet. Taking the free card.';
    } else {
      decision = { action: 'fold' };
      reasoning = `Not enough equity to pay for this one at ${pct}%.`;
    }

    // Word at a time, so the streaming path is exercised rather than bypassed
    // and a spectator sees the same shape of thinking either brain produces.
    for (const word of reasoning.split(/(?<=\s)/)) {
      if (signal.aborted) throw new ProviderError('aborted');
      await sleep(45, signal);
      emit(word);
    }

    return decision;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError('aborted'));
      },
      { once: true },
    );
  });
}

/**
 * Pulls the first JSON object out of a model's output.
 *
 * Models wrap JSON in prose or in fences often enough that failing on it would
 * throw away real decisions. Braces inside strings are skipped, so table talk
 * containing one does not truncate the object.
 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;

  const start = body.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < body.length; i++) {
    const char = body[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}
