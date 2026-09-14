/**
 * Model access, behind one small interface so the provider can change without
 * the rest of the agent noticing.
 *
 * This lives in the agent rather than in the arena because paying for thinking
 * is an agent's problem. The arena never holds a model key and never makes a
 * model call, which is what stops its running costs scaling with the number of
 * people playing.
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

/**
 * The provider the model brain streams from.
 *
 * Gemini is the only one shipped. Playing without a key is not a provider at
 * all: `AGENT_BRAIN=heuristic` never builds one.
 */
export function createProvider(model = process.env.GEMINI_MODEL ?? 'gemini-3-flash'): ModelProvider {
  return new GeminiProvider(model);
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
