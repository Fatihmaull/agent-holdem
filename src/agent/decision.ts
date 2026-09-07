import type { Action, LegalActions } from '../poker/engine';

export type DecisionOutcome = 'decided' | 'timeout' | 'error';

export interface AgentDecision {
  action: Action;
  /** Why it acted, in its own words. Shown live in the Brain Visualizer. */
  reasoning: string;
  /** Optional short line of table talk. */
  say: string | null;
}

interface ModelReply {
  action: string;
  to?: unknown;
  reasoning?: unknown;
  say?: unknown;
}

const MAX_REASONING = 600;
const MAX_SAY = 90;

/**
 * The engine is the authority on what may happen. A model reply is a request,
 * and it is checked against the legal move set before it becomes an action.
 * The worst an injected instruction can achieve is bad poker: it can never make
 * an illegal move, and it never sees another seat's cards to leak.
 */
export function validateDecision(reply: unknown, legal: LegalActions): AgentDecision | null {
  if (typeof reply !== 'object' || reply === null) return null;
  const candidate = reply as ModelReply;

  const reasoning = clamp(candidate.reasoning, MAX_REASONING);
  const say = clamp(candidate.say, MAX_SAY) || null;
  const action = String(candidate.action ?? '').toLowerCase().trim();

  switch (action) {
    case 'fold':
      return legal.fold ? { action: { type: 'fold' }, reasoning, say } : null;
    case 'check':
      return legal.check ? { action: { type: 'check' }, reasoning, say } : null;
    case 'call':
      return legal.call !== null ? { action: { type: 'call' }, reasoning, say } : null;
    case 'bet':
    case 'raise': {
      const range = action === 'bet' ? legal.bet : legal.raise;
      if (!range) return null;
      // A missing or unreadable size is a slip in the reply, not a change of
      // mind. Discarding the whole decision would turn an intended bet into a
      // fold, so an unusable size falls back to the smallest legal one.
      const requested = Math.round(Number(candidate.to));
      const to = Number.isFinite(requested) ? requested : range.min;
      // A size just outside the legal range is a rounding slip, not an attack.
      // Clamping keeps the hand moving instead of burning the agent's clock.
      const clamped = Math.min(Math.max(to, range.min), range.max);
      return { action: { type: action, to: clamped }, reasoning, say };
    }
    default:
      return null;
  }
}

/**
 * What a seat does when its agent never produced a usable decision: check if
 * checking is free, otherwise fold. The same rule covers a timeout, a provider
 * error, and a malformed reply.
 */
export function defaultAction(legal: LegalActions): Action {
  return legal.check ? { type: 'check' } : { type: 'fold' };
}

/**
 * Pulls the first JSON object out of a model's output. Models wrap JSON in
 * prose or fences often enough that failing on it would waste real decisions.
 */
export function extractJson(text: string): unknown {
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
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(body.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function clamp(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
