import type { AgentDecision } from '@agentholdem/shared';

export interface LlmProvider {
  readonly name: 'groq' | 'gemini';
  readonly model: string;
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Groq — the primary engine. Sub-second completions are what make a 30 second
 * turn clock comfortable rather than tight, and the OpenAI-compatible
 * `json_object` response format removes most parsing failures at the source.
 */
export class GroqProvider implements LlmProvider {
  readonly name = 'groq' as const;

  constructor(
    private readonly apiKey: string,
    readonly model = 'llama-3.3-70b-versatile',
    private readonly baseUrl = 'https://api.groq.com/openai/v1',
  ) {}

  async complete(system: string, user: string, signal: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.8,
        max_tokens: 320,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!res.ok) {
      throw new LlmError(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new LlmError('Groq returned no content');
    return content;
  }
}

/** Gemini Flash — the free-tier fallback when Groq is rate limited or down. */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;

  constructor(
    private readonly apiKey: string,
    readonly model = 'gemini-1.5-flash',
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  ) {}

  async complete(system: string, user: string, signal: AbortSignal): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 320,
            responseMimeType: 'application/json',
          },
        }),
      },
    );

    if (!res.ok) {
      throw new LlmError(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const content = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
    if (!content) throw new LlmError('Gemini returned no content');
    return content;
  }
}

/**
 * Extracts a decision from whatever the model actually said.
 *
 * Models wrap JSON in prose, in ```json fences, or emit a leading "Here is my
 * action:". Rather than failing the turn on cosmetics we scan for the first
 * balanced JSON object and coerce the fields; only genuinely unusable output
 * falls through to the retry and then the timeout fallback.
 */
export function parseDecision(raw: string): AgentDecision | null {
  const candidate = extractJsonObject(raw);
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const action = normaliseAction(obj['action']);
  if (!action) return null;

  const amountRaw = obj['amount'];
  const amount =
    typeof amountRaw === 'number' && Number.isFinite(amountRaw)
      ? Math.max(0, Math.floor(amountRaw))
      : typeof amountRaw === 'string' && amountRaw.trim() !== '' && Number.isFinite(Number(amountRaw))
        ? Math.max(0, Math.floor(Number(amountRaw)))
        : 0;

  return {
    action,
    amount,
    inner_thought: trimText(obj['inner_thought'], 400) || '(no reasoning provided)',
    table_chat: trimText(obj['table_chat'], 160),
  };
}

function normaliseAction(value: unknown): AgentDecision['action'] | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (v === 'fold') return 'fold';
  if (v === 'check') return 'check';
  if (v === 'call') return 'call';
  if (v === 'raise' || v === 'bet' || v === 're-raise' || v === 'reraise') return 'raise';
  if (v === 'all-in' || v === 'allin' || v === 'shove' || v === 'jam') return 'all-in';
  return null;
}

function trimText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Finds the first balanced `{...}`, ignoring braces inside string literals. */
export function extractJsonObject(raw: string): string | null {
  const text = raw.replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
