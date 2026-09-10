/**
 * The four numbers that are the hypothesis, stated as arithmetic.
 *
 * The claim is that agents detect patterns, exploit weaknesses, adapt, and
 * deceive each other. A chip count says none of that: the agent that made the
 * most money and the agent that played best are routinely different, and
 * published work on LLM poker found exactly that. So each claim gets its own
 * number, measured from what the agents actually did.
 *
 * Everything here is pure so the definitions can be argued with, and tested,
 * without a database in the way.
 */

export type AxisAction = 'fold' | 'check' | 'call' | 'bet' | 'raise';

export interface AxisDecision {
  handId: string;
  agentId: string;
  street: string;
  action: AxisAction;
  /** Chance of winning at the moment of the decision, 0 to 1. */
  equity: number;
}

export interface AxisResult {
  handId: string;
  agentId: string;
  matchId: string;
  bigBlind: number;
  net: number;
  /** Average published rating of the opponents, as it stood when the hand was dealt. */
  opponentRating: number;
  showdown: boolean;
}

export interface Axes {
  /** Continuing more against loose opponents than tight ones. */
  reading: number | null;
  /** Share of low-equity bets that took the pot down. */
  deception: number | null;
  /** Change in win rate from the first half of a stint to the second. */
  adaptation: number | null;
  /** Win rate against the weakest half of the field, less what everyone else manages there. */
  exploitation: number | null;
}

/**
 * A bet or raise made with a hand that is probably behind. Not every one is a
 * bluff in the strict sense, but a player who never makes them cannot bluff at
 * all, and one who makes them and wins is being believed.
 */
const BLUFF_EQUITY = 0.35;

/** Below these, the number would be noise wearing a decimal point. */
const MIN_BLUFFS = 10;
const MIN_WEAK_HANDS = 50;
const MIN_HANDS_PER_SIDE = 25;
const MIN_SESSIONS = 3;
const MIN_HANDS_PER_SESSION = 20;

export interface AxisInput {
  agentId: string;
  /** This agent's decisions, oldest first. */
  decisions: AxisDecision[];
  /** This agent's results, oldest first. */
  results: AxisResult[];
  /**
   * How often each agent at the table voluntarily put money in preflop, by
   * agent id. Computed across the whole field, because what matters is whether
   * this agent's opponents were loose, not who owned them.
   */
  looseness: ReadonlyMap<string, number>;
  /** Who else was in each hand, by hand id. */
  opponentsByHand: ReadonlyMap<string, string[]>;
  /**
   * The rating at or below which opposition counts as weak. The median across
   * every hand on record, so it moves with the field rather than being a number
   * somebody picked.
   */
  weakOpponentRating: number | null;
  /** What the field as a whole manages against that half, in big blinds per 100 hands. */
  fieldVersusWeak: number | null;
}

export function computeAxes(input: AxisInput): Axes {
  return {
    reading: reading(input),
    deception: deception(input.decisions, input.results),
    adaptation: adaptation(input.results),
    exploitation: exploitation(input.results, input.weakOpponentRating, input.fieldVersusWeak),
  };
}

/**
 * Voluntary preflop entry, the oldest read in poker.
 *
 * Counted from decisions rather than from money, because posting a blind is not
 * a choice and calling one is. A high number is a loose player, whose bets mean
 * less and who can be called wider.
 */
export function loosenessOf(decisions: AxisDecision[]): number | null {
  const preflop = decisions.filter((decision) => decision.street === 'preflop');
  if (preflop.length === 0) return null;

  const entered = preflop.filter((decision) => decision.action !== 'fold' && decision.action !== 'check');
  return entered.length / preflop.length;
}

/**
 * Reading: does this agent play differently against loose opponents?
 *
 * Its hands are split by how loose the table was, and its willingness to keep
 * paying is compared across the two halves. An agent that reads the table
 * continues more against opponents whose bets mean less. One that plays its own
 * cards and nothing else scores near zero, which is the honest result for it.
 */
function reading(input: AxisInput): number | null {
  const scored = input.results
    .map((result) => {
      const opponents = input.opponentsByHand.get(result.handId) ?? [];
      const rates = opponents.map((id) => input.looseness.get(id)).filter((rate): rate is number => rate !== undefined);
      if (rates.length === 0) return null;
      return { handId: result.handId, loose: rates.reduce((sum, rate) => sum + rate, 0) / rates.length };
    })
    .filter((entry): entry is { handId: string; loose: number } => entry !== null);

  if (scored.length < MIN_HANDS_PER_SIDE * 2) return null;

  // Split by rank rather than by comparing against the median value. Opponent
  // looseness is usually bimodal, a table of stations or a table of rocks, and
  // a value comparison puts every hand on one side of it.
  const ranked = [...scored].sort((a, b) => a.loose - b.loose);
  const half = Math.floor(ranked.length / 2);
  const tightHands = new Set(ranked.slice(0, half).map((entry) => entry.handId));
  const looseHands = new Set(ranked.slice(ranked.length - half).map((entry) => entry.handId));

  const loose = continuationRate(input.decisions.filter((decision) => looseHands.has(decision.handId)));
  const tight = continuationRate(input.decisions.filter((decision) => tightHands.has(decision.handId)));
  if (loose === null || tight === null) return null;

  return loose - tight;
}

/**
 * How often it keeps paying when it could fold instead.
 *
 * Only decisions taken against a bet count. Checking is free and says nothing
 * about willingness to call, so including it would just measure how often the
 * agent was in a pot nobody had bet into.
 */
function continuationRate(decisions: AxisDecision[]): number | null {
  const facing = decisions.filter(
    (decision) => decision.action === 'fold' || decision.action === 'call' || decision.action === 'raise',
  );
  if (facing.length < MIN_HANDS_PER_SIDE) return null;

  return facing.filter((decision) => decision.action !== 'fold').length / facing.length;
}

/**
 * Deception: how often a bet made with a weak hand took the pot down.
 *
 * A bluff worked if the hand ended in profit without anyone's cards being
 * compared. Winning at showdown with a weak hand is luck, not persuasion, and
 * is deliberately not counted.
 */
function deception(decisions: AxisDecision[], results: AxisResult[]): number | null {
  const bluffHands = new Set(
    decisions
      .filter(
        (decision) =>
          (decision.action === 'bet' || decision.action === 'raise') && decision.equity < BLUFF_EQUITY,
      )
      .map((decision) => decision.handId),
  );
  if (bluffHands.size < MIN_BLUFFS) return null;

  const attempted = results.filter((result) => bluffHands.has(result.handId));
  if (attempted.length < MIN_BLUFFS) return null;

  return attempted.filter((result) => !result.showdown && result.net > 0).length / attempted.length;
}

/**
 * Adaptation: does it do better later in a stint than earlier?
 *
 * A stint is one match, which is exactly the window an agent accumulates
 * knowledge of these particular opponents over: it sits down knowing nobody and
 * plays the same five faces until it ends. Splitting it
 * in half and comparing win rates asks whether that knowledge was worth
 * anything. Averaged across stints, because one lucky second half is not
 * learning.
 */
function adaptation(results: AxisResult[]): number | null {
  const deltas: number[] = [];

  for (const stint of stints(results)) {
    if (stint.length < MIN_HANDS_PER_SESSION) continue;
    const half = Math.floor(stint.length / 2);
    deltas.push(bbPer100(stint.slice(half)) - bbPer100(stint.slice(0, half)));
  }

  if (deltas.length < MIN_SESSIONS) return null;
  return deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
}

/** Unbroken runs inside one match, in the order they were played. */
export function stints(results: AxisResult[]): AxisResult[][] {
  const runs: AxisResult[][] = [];

  for (const result of results) {
    const current = runs[runs.length - 1];
    if (current && current[0].matchId === result.matchId) current.push(result);
    else runs.push([result]);
  }

  return runs;
}

/**
 * Exploitation: how much harder it punishes weak opponents than the field does.
 *
 * Weak means measured as weak, by rating, rather than scripted to be. Measured
 * against what everyone else achieves against the same half of the field rather
 * than in absolute terms, because beating weak players a little is not a skill,
 * it is arithmetic.
 */
function exploitation(
  results: AxisResult[],
  weakOpponentRating: number | null,
  fieldVersusWeak: number | null,
): number | null {
  if (weakOpponentRating === null || fieldVersusWeak === null) return null;

  const versusWeak = results.filter((result) => result.opponentRating <= weakOpponentRating);
  if (versusWeak.length < MIN_WEAK_HANDS) return null;

  return bbPer100(versusWeak) - fieldVersusWeak;
}

export function bbPer100(results: AxisResult[]): number {
  if (results.length === 0) return 0;
  const total = results.reduce((sum, result) => sum + result.net / result.bigBlind, 0);
  return (total / results.length) * 100;
}
