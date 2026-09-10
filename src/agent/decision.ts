import type { Action, LegalActions } from '../poker/engine';

export type DecisionOutcome = 'decided' | 'timeout' | 'error';

export interface AgentDecision {
  action: Action;
  /** Why it acted, in its own words. Shown live in the Brain Visualizer. */
  reasoning: string;
  /** Optional short line of table talk. */
  say: string | null;
  /**
   * The agent asked to come back to this hand once it is over and write down
   * what it learned. Costs it a second request, so it is its own call to make
   * rather than something the table decides for it.
   */
  remember?: boolean;
}

interface ModelReply {
  action: string;
  to?: unknown;
  reasoning?: unknown;
  say?: unknown;
  remember?: unknown;
}

const MAX_REASONING = 600;
const MAX_SAY = 90;

/**
 * Longest note an agent may keep on one opponent. Short on purpose: an agent
 * that must fit a read into a couple of sentences has to decide what actually
 * matters, and that decision is the thing worth measuring. An unbounded note
 * becomes a transcript, which is a log rather than a judgement.
 */
export const MAX_NOTE = 500;

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
  // Anything other than a literal true is a no. A model that omits the field,
  // or writes "maybe" into it, has not asked for the extra request its owner
  // would pay for.
  const remember = candidate.remember === true;

  switch (action) {
    case 'fold':
      return legal.fold ? { action: { type: 'fold' }, reasoning, say, remember } : null;
    case 'check':
      return legal.check ? { action: { type: 'check' }, reasoning, say, remember } : null;
    case 'call':
      return legal.call !== null ? { action: { type: 'call' }, reasoning, say, remember } : null;
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
      return { action: { type: action, to: clamped }, reasoning, say, remember };
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
/** One agent's new note about one opponent. Empty text erases what it had. */
export interface NoteUpdate {
  name: string;
  text: string;
}

/**
 * Reads a reply of notes, keeping only the opponents that were actually at the
 * table.
 *
 * A model that invents a name, or writes about itself, is writing about
 * somebody who was not in the hand. Matching on the spelling it was given keeps
 * a note attached to a real agent rather than to a near miss.
 */
export function validateNotes(reply: unknown, opponents: readonly string[]): NoteUpdate[] {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return [];

  const bySpelling = new Map(opponents.map((name) => [name.trim().toLowerCase(), name]));
  const updates: NoteUpdate[] = [];

  for (const [key, value] of Object.entries(reply as Record<string, unknown>)) {
    const spelling = key.trim().toLowerCase();
    const name = bySpelling.get(spelling);
    if (name === undefined || typeof value !== 'string') continue;
    // Taking the name out settles a reply that lists somebody twice: the first
    // note wins, rather than whichever key the parser happened to see last.
    bySpelling.delete(spelling);
    updates.push({ name, text: clamp(value, MAX_NOTE) });
  }

  return updates;
}

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
