import type { Action, HandState, LegalActions } from '../poker/engine';
import { legalActions, totalPot } from '../poker/engine';
import { type Equity, type HandRead, equityVsRandom, readHand } from '../poker/equity';
import { type AgentDecision, type DecisionOutcome, defaultAction, extractJson, validateDecision } from './decision';
import { type DecisionContext, type OpponentView, SYSTEM_PROMPT, buildPrompt } from './prompt';
import type { ModelProvider } from './provider';
import type { ModelQueue } from './queue';

export interface AgentIdentity {
  id: string;
  name: string;
  instructions: string;
}

export interface DecideOptions {
  agent: AgentIdentity;
  state: HandState;
  seatIndex: number;
  bigBlind: number;
  /** Hard ceiling on the act clock. Expiry checks or folds. */
  clockMs: number;
  /**
   * Display name for each agent id at the table. Opponents read as the names
   * their owners gave them; without this they arrive as bare identifiers, which
   * tells the model nothing and reads as a leak of internals.
   */
  opponentNames?: ReadonlyMap<string, string>;
  provider: ModelProvider;
  queue: ModelQueue;
  equitySamples?: number;
  /** Called as reasoning arrives, so the Brain Visualizer can show it streaming. */
  onToken?: (text: string) => void;
  /** Called once the simulation finishes, before the model is asked anything. */
  onEquity?: (equity: Equity, read: HandRead) => void;
  signal?: AbortSignal;
}

export interface DecisionRecord extends AgentDecision {
  equity: Equity;
  read: HandRead;
  outcome: DecisionOutcome;
  elapsedMs: number;
  /** Whether a model was consulted at all. */
  source: 'rules' | 'model';
  /** Set when the outcome is not `decided`, for the terminal half to report. */
  failure: string | null;
}

/**
 * Room for the reply. Two sentences and a small JSON object need very little,
 * but a model that thinks before answering spends this budget on the thinking
 * too, and one that runs out returns nothing at all.
 */
const MAX_OUTPUT_TOKENS = Number(process.env.AGENT_MAX_OUTPUT_TOKENS ?? 2048);

const POSITIONS_BY_SEATS: Record<number, string[]> = {
  2: ['button', 'big blind'],
  3: ['button', 'small blind', 'big blind'],
  4: ['button', 'small blind', 'big blind', 'cutoff'],
  5: ['button', 'small blind', 'big blind', 'under the gun', 'cutoff'],
  6: ['button', 'small blind', 'big blind', 'under the gun', 'hijack', 'cutoff'],
};

export function positionName(state: HandState, seatIndex: number): string {
  const live = state.seats.filter((seat) => !seat.sittingOut).length;
  const names = POSITIONS_BY_SEATS[live] ?? POSITIONS_BY_SEATS[6];
  const offset = (seatIndex - state.button + state.seats.length) % state.seats.length;
  return names[offset] ?? `seat ${seatIndex + 1}`;
}

/**
 * Produces one action for one seat.
 *
 * Three things are settled before a model is involved: what the hand actually
 * is, what it is worth, and which moves are legal. The model chooses among
 * legal moves and explains itself. It never computes the equity and it never
 * decides what is allowed.
 */
export async function decide(options: DecideOptions): Promise<DecisionRecord> {
  const { agent, state, seatIndex, clockMs, provider, queue } = options;
  const started = Date.now();
  const seat = state.seats[seatIndex];
  const legal = legalActions(state);

  if (!legal || !seat.hole) throw new Error(`seat ${seatIndex} is not to act`);

  const liveOpponents = state.seats.filter(
    (other) => other.index !== seatIndex && !other.folded && !other.sittingOut,
  );
  const equity = equityVsRandom(
    seat.hole,
    state.board,
    Math.max(1, liveOpponents.length),
    options.equitySamples ?? sampleCount(state.board.length),
  );
  const read = readHand(seat.hole, state.board);
  options.onEquity?.(equity, read);

  const forced = forcedMove(legal, equity);
  if (forced) {
    return {
      ...forced,
      equity,
      read,
      outcome: 'decided',
      elapsedMs: Date.now() - started,
      source: 'rules',
      failure: null,
    };
  }

  const context: DecisionContext = {
    agentName: agent.name,
    instructions: agent.instructions,
    street: state.street,
    hole: seat.hole,
    board: state.board,
    stack: seat.stack,
    potSize: totalPot(state),
    legal,
    bigBlind: options.bigBlind,
    position: positionName(state, seatIndex),
    opponents: describeOpponents(state, seatIndex, options.opponentNames ?? new Map()),
    equity,
    read,
    clockSeconds: Math.round(clockMs / 1000),
  };

  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new ClockExpired()), clockMs);
  const signal = options.signal ? AbortSignal.any([options.signal, clock.signal]) : clock.signal;

  let streamed = '';
  try {
    streamed = await queue.run(async (apiKey) => {
      let text = '';
      for await (const chunk of provider.stream(
        { system: SYSTEM_PROMPT, user: buildPrompt(context), maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.9 },
        apiKey,
        signal,
      )) {
        text += chunk;
        options.onToken?.(chunk);
      }
      return text;
    }, signal);
  } catch (error) {
    clearTimeout(timer);
    const timedOut = clock.signal.aborted;
    return {
      action: defaultAction(legal),
      reasoning: '',
      say: null,
      equity,
      read,
      outcome: timedOut ? 'timeout' : 'error',
      elapsedMs: Date.now() - started,
      source: 'model',
      failure: timedOut ? 'ran out of time' : describeError(error),
    };
  }
  clearTimeout(timer);

  const decision = validateDecision(withProseReasoning(streamed), legal);
  if (!decision) {
    return {
      action: defaultAction(legal),
      reasoning: '',
      say: null,
      equity,
      read,
      outcome: 'error',
      elapsedMs: Date.now() - started,
      source: 'model',
      failure: 'returned no usable action',
    };
  }

  return {
    ...decision,
    equity,
    read,
    outcome: 'decided',
    elapsedMs: Date.now() - started,
    source: 'model',
    failure: null,
  };
}

class ClockExpired extends Error {}

/**
 * Guards for spots where no judgement is involved: a move with no alternative,
 * or a call that cannot win on any runout.
 *
 * Both are rare in practice. Hold'em almost always leaves at least two options,
 * and a hand with literally zero equity against a random holding is close to
 * unreachable, so this is a correctness guard rather than a way to save
 * requests. Rate pressure is handled by the queue and the act clock instead.
 */
function forcedMove(legal: LegalActions, equity: Equity): AgentDecision | null {
  const options: Action[] = [];
  if (legal.fold) options.push({ type: 'fold' });
  if (legal.check) options.push({ type: 'check' });
  if (legal.call !== null) options.push({ type: 'call' });
  if (legal.bet) options.push({ type: 'bet' });
  if (legal.raise) options.push({ type: 'raise' });

  if (options.length === 1) {
    return { action: options[0], reasoning: 'No other move was available.', say: null };
  }

  if (legal.toCall > 0 && equity.win === 0 && equity.tie === 0) {
    return { action: { type: 'fold' }, reasoning: 'Drawing dead. No runout wins this pot.', say: null };
  }

  return null;
}

/** More samples early, when there is more still to come and the number matters most. */
function sampleCount(boardSize: number): number {
  if (boardSize === 0) return 3000;
  if (boardSize === 3) return 2500;
  if (boardSize === 4) return 2000;
  return 1000;
}

function describeOpponents(state: HandState, seatIndex: number, names: ReadonlyMap<string, string>): OpponentView[] {
  const lastAction = new Map<number, { action: string; to: number }>();
  for (const event of state.events) {
    if (event.type === 'action') lastAction.set(event.seat, { action: event.action, to: event.to });
  }

  return state.seats
    .filter((seat) => seat.index !== seatIndex && !seat.sittingOut)
    .map((seat) => ({
      name: names.get(seat.agentId) ?? seat.agentId,
      stack: seat.stack,
      committed: seat.committed,
      status: seat.folded ? 'folded' : seat.allIn ? 'all-in' : 'in',
      lastAction: lastAction.get(seat.index)?.action ?? null,
      // Timing is filled in by the runtime, which is the only layer that knows
      // how long a seat actually took. Opponents see the duration, never the cause.
      lastActionMs: null,
    }));
}

/**
 * The model writes reasoning as prose and then a JSON object. Everything before
 * the object is the reasoning, unless the object carried its own.
 */
function withProseReasoning(text: string): unknown {
  const parsed = extractJson(text);
  if (typeof parsed !== 'object' || parsed === null) return parsed;

  const record = parsed as Record<string, unknown>;
  if (typeof record.reasoning === 'string' && record.reasoning.trim()) return record;

  const braceAt = text.indexOf('{');
  const prose = (braceAt >= 0 ? text.slice(0, braceAt) : text).replace(/```(?:json)?/g, '').trim();
  return { ...record, reasoning: prose };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 120);
  return 'provider failed';
}
