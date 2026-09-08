/**
 * Model access sits behind one small interface so the provider can change
 * without the poker code noticing. Development runs on a free tier; anything
 * user-facing runs on a paid key.
 */

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

/**
 * The provider could not be reached, or refused this key.
 *
 * Separate from `ProviderError` because the two call for opposite responses.
 * An unavailable provider or a rejected key is worth trying another key for; a
 * reply that came back and was unusable is not, and retrying it on four keys
 * spends four times as much to get the same answer.
 */
export class ProviderUnavailable extends ProviderError {
  constructor(
    message: string,
    /** How long this key should sit out. Null leaves the queue's default. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** A key the provider will keep refusing, so it sits out far longer than a blip. */
const BAD_KEY_COOLDOWN_MS = 5 * 60_000;

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Thinking budget to request, or null to leave the model's default alone. */
const thinkingBudget: number | null =
  process.env.GEMINI_THINKING_BUDGET === undefined ? null : Number(process.env.GEMINI_THINKING_BUDGET);

class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';

  constructor(private readonly model: string) {}

  async *stream(request: ModelRequest, apiKey: string, signal: AbortSignal): AsyncIterable<string> {
    const response = await reach(() => fetch(
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
    ));

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new RateLimited('provider rate limit', Number.isFinite(retryAfter) ? retryAfter * 1000 : 30_000);
    }
    // A rejected key never recovers on its own, so it sits out long enough that
    // the pool stops paying for it on every hand. A 5xx is the provider having
    // a moment, and the next key along will probably work.
    if (response.status === 401 || response.status === 403) {
      throw new ProviderUnavailable(`${this.name} refused this key (${response.status})`, BAD_KEY_COOLDOWN_MS);
    }
    if (response.status >= 500) {
      throw new ProviderUnavailable(`${this.name} returned ${response.status}: ${await safeText(response)}`);
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
    const prompt = request.user;
    const equity = Number(/equity: ([\d.]+)%/.exec(prompt)?.[1] ?? '50') / 100;
    const call = Number(/- call (\d+)/.exec(prompt)?.[1] ?? 'NaN');
    const raise = /- raise, "to" between (\d+) and (\d+)/.exec(prompt);
    const bet = /- bet, "to" between (\d+) and (\d+)/.exec(prompt);
    const breakEven = Number(/needs ([\d.]+)% to break even/.exec(prompt)?.[1] ?? '0') / 100;
    const canCheck = /^- check$/m.test(prompt);

    const strong = equity > 0.66;
    const playable = equity > breakEven + 0.04;

    let reply: { action: string; to?: number };
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

    for (const word of `${reasoning} ${JSON.stringify(reply)}`.split(/(?<=\s)/)) {
      if (signal.aborted) throw new ProviderError('aborted');
      await new Promise((resolve) => setTimeout(resolve, 45));
      yield word;
    }
  }
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

/**
 * Turns a dead socket into something the queue can act on.
 *
 * `fetch` rejects with an opaque `TypeError` when a host is unreachable, and an
 * opaque error would be raised straight to the seat instead of moving to the
 * next key.
 */
async function reach(call: () => Promise<Response>): Promise<Response> {
  try {
    return await call();
  } catch (error) {
    // An abort is our own doing — the act clock or a shutdown — and must not be
    // mistaken for the provider being down.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ProviderUnavailable(error instanceof Error ? error.message.slice(0, 200) : 'the provider is unreachable');
  }
}
