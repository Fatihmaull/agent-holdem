/**
 * Model access sits behind one small interface so the provider can change
 * without the poker code noticing. Development runs on a free tier; anything
 * user-facing runs on a paid key.
 */

import { NOTE_SYSTEM_PROMPT } from './prompt';

export interface ModelRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature: number;
}

export interface ModelProvider {
  readonly name: string;
  /** Yields text as it arrives. Throws `RateLimited` on 429 so the queue can back off. */
  stream(request: ModelRequest, apiKey: string, signal: AbortSignal): AsyncIterable<string>;
}

export class RateLimited extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

export class ProviderError extends Error {}

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Thinking budget to request, or null to leave the model's default alone. */
const thinkingBudget: number | null =
  process.env.GEMINI_THINKING_BUDGET === undefined ? null : Number(process.env.GEMINI_THINKING_BUDGET);

class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';

  constructor(private readonly model: string) {}

  async *stream(request: ModelRequest, apiKey: string, signal: AbortSignal): AsyncIterable<string> {
    const response = await fetch(
      `${GEMINI_ENDPOINT}/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: {
            temperature: request.temperature,
            maxOutputTokens: request.maxOutputTokens,
            // A reasoning model can spend the whole budget thinking and return
            // no text at all, which reaches the table as a silent fold. Set
            // GEMINI_THINKING_BUDGET to bound or disable that when the model in
            // use supports it; unset, the model's own default stands.
            ...(thinkingBudget === null ? {} : { thinkingConfig: { thinkingBudget } }),
          },
        }),
      },
    );

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new RateLimited('provider rate limit', Number.isFinite(retryAfter) ? retryAfter * 1000 : 30_000);
    }
    if (!response.ok || !response.body) {
      throw new ProviderError(`${this.name} returned ${response.status}: ${await safeText(response)}`);
    }

    let produced = 0;
    let finish: string | null = null;

    for await (const line of readServerSentEvents(response.body, signal)) {
      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      finish = finishReason(payload) ?? finish;
      const text = firstPartText(payload);
      if (text) {
        produced += text.length;
        yield text;
      }
    }

    // A stream that ends without a word is a failure, not an empty opinion.
    // Saying why beats letting the seat fold with nothing on the panel.
    if (produced === 0) {
      throw new ProviderError(
        finish === 'MAX_TOKENS'
          ? `${this.name} hit its output limit before writing anything. Raise AGENT_MAX_OUTPUT_TOKENS or set GEMINI_THINKING_BUDGET.`
          : `${this.name} returned no text${finish ? ` (${finish})` : ''}`,
      );
    }
  }
}

/** A provider that plays a fixed script. Used by tests, never wired into a table. */
export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';

  constructor(private readonly reply: string | (() => Promise<string>)) {}

  // Reached only through the ModelProvider interface, so static analysis sees
  // no direct caller. It is the contract, not a spare method.
  // fallow-ignore-next-line unused-class-member
  async *stream(_request: ModelRequest, _apiKey: string, signal: AbortSignal): AsyncIterable<string> {
    const text = typeof this.reply === 'string' ? this.reply : await this.reply();
    for (const word of text.split(/(?<=\s)/)) {
      if (signal.aborted) throw new ProviderError('aborted');
      yield word;
    }
  }
}

/**
 * A stand-in that plays by the numbers already in the prompt, so the whole
 * product runs with no API key at all.
 *
 * It is for development only. It reads the equity and the legal actions the
 * server computed and picks the arithmetically sensible line, which means it
 * ignores the owner's instructions entirely. That is the point: it exercises
 * the loop without pretending to be an agent with a personality.
 */
class HeuristicProvider implements ModelProvider {
  readonly name = 'heuristic';

  async *stream(request: ModelRequest, _apiKey: string, signal: AbortSignal): AsyncIterable<string> {
    // One method serves two prompts, so the system prompt is what says which
    // question was asked. Without this branch the loop still deals hands, but
    // notes are never written, which leaves a whole subsystem untested by a run
    // that looks fine.
    if (request.system === NOTE_SYSTEM_PROMPT) {
      yield* this.emit(notesFrom(request.user), signal);
      return;
    }
    const prompt = request.user;
    const equity = Number(/equity: ([\d.]+)%/.exec(prompt)?.[1] ?? '50') / 100;
    const call = Number(/- call (\d+)/.exec(prompt)?.[1] ?? 'NaN');
    const raise = /- raise, "to" between (\d+) and (\d+)/.exec(prompt);
    const bet = /- bet, "to" between (\d+) and (\d+)/.exec(prompt);
    const breakEven = Number(/needs ([\d.]+)% to break even/.exec(prompt)?.[1] ?? '0') / 100;
    const canCheck = /^- check$/m.test(prompt);

    const strong = equity > 0.66;
    const playable = equity > breakEven + 0.04;

    let reply: { action: string; to?: number; remember?: boolean };
    let reasoning: string;

    if (strong && (raise || bet)) {
      const range = raise ?? bet!;
      const min = Number(range[1]);
      const max = Number(range[2]);
      const to = Math.min(max, Math.round(min * 1.6));
      reply = { action: raise ? 'raise' : 'bet', to };
      reasoning = `Ahead of the range here at ${(equity * 100).toFixed(0)}%, so this is a spot to build the pot.`;
    } else if (Number.isFinite(call) && playable) {
      reply = { action: 'call' };
      reasoning = `Priced in: ${(equity * 100).toFixed(0)}% against a break-even of ${(breakEven * 100).toFixed(0)}%.`;
    } else if (canCheck) {
      reply = { action: 'check' };
      reasoning = 'Nothing worth building yet. Taking the free card.';
    } else {
      reply = { action: 'fold' };
      reasoning = `Not enough equity to pay for this one at ${(equity * 100).toFixed(0)}%.`;
    }

    // Folding to a bet is the spot a real agent most often wants to look back
    // at, and it is frequent enough that a short development run actually
    // exercises the note-writing path instead of leaving it dark.
    if (reply.action === 'fold') reply.remember = true;

    yield* this.emit(`${reasoning} ${JSON.stringify(reply)}`, signal);
  }

  /** Word at a time, so the streaming path is exercised rather than bypassed. */
  private async *emit(text: string, signal: AbortSignal): AsyncIterable<string> {
    for (const word of text.split(/(?<=\s)/)) {
      if (signal.aborted) throw new ProviderError('aborted');
      await new Promise((resolve) => setTimeout(resolve, 45));
      yield word;
    }
  }
}

/**
 * A note per opponent, counting what they did in the hand just played.
 *
 * Deliberately mechanical. The point is to move a real note through the write,
 * the revision count and the read-back, not to imitate a read: a note that says
 * the same thing every hand would never revise, and revising is the half of the
 * feature most likely to be broken.
 */
function notesFrom(prompt: string): string {
  const section = prompt.split('YOUR CURRENT NOTES')[1]?.split('\n\n')[0] ?? '';
  const hand = prompt.split('HAND')[1]?.split('\n\n')[0] ?? '';

  const notes: Record<string, string> = {};
  for (const line of section.split('\n')) {
    const name = /^- (.+?): /.exec(line)?.[1];
    if (!name) continue;

    const beats = hand.split('\n').filter((beat) => beat.includes(name));
    const aggressive = beats.filter((beat) => /\b(bets?|raises?)\b/i.test(beat)).length;
    const folded = beats.some((beat) => /\bfolds?\b/i.test(beat));

    notes[name] = folded && aggressive === 0
      ? 'Folded without putting money in. Nothing shown yet.'
      : `Put in ${aggressive} bet or raise this hand. Reweight when that stops holding.`;
  }

  return JSON.stringify(notes);
}


export function createProvider(): ModelProvider {
  const name = process.env.AGENT_PROVIDER ?? 'gemini';
  switch (name) {
    case 'gemini':
      return new GeminiProvider(process.env.GEMINI_MODEL ?? 'gemini-3-flash');
    case 'heuristic':
      if (process.env.NODE_ENV === 'production') {
        throw new ProviderError('the heuristic provider is for development only');
      }
      return new HeuristicProvider();
    default:
      throw new ProviderError(`unknown AGENT_PROVIDER: ${name}`);
  }
}

async function* readServerSentEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data && data !== '[DONE]') yield data;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function finishReason(payload: unknown): string | null {
  return (payload as { candidates?: Array<{ finishReason?: string }> })?.candidates?.[0]?.finishReason ?? null;
}

function firstPartText(payload: unknown): string {
  const candidate = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    ?.candidates?.[0];
  return candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '<no body>';
  }
}
