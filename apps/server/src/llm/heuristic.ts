import type { AgentDecision, CardCode } from '@agentholdem/shared';
import { FULL_DECK, makeRng } from '../engine/cards.js';
import { compareHands, evaluateHand } from '../engine/evaluator.js';
import type { TurnContext } from './promptBuilder.js';

/**
 * The deterministic policy engine.
 *
 * It serves two jobs. It is the last-resort action when every LLM path has
 * failed in a way that still leaves a real decision to make, and it is the
 * whole arena when no API key is configured — a reviewer can clone the repo,
 * run `npm run sim`, and watch autonomous tables play out with no credentials
 * at all. It reads the manager's persona for tone and aggression, so prompts
 * still visibly matter in offline mode.
 */

export interface PersonaProfile {
  /** 0 = rock, 1 = maniac. */
  aggression: number;
  /** Probability of firing without equity. */
  bluffiness: number;
  /** Slow-plays strong hands instead of raising. */
  trappy: boolean;
  voice: 'clinical' | 'brash' | 'sly' | 'stoic';
}

const AGGRO_WORDS = [
  'aggressive', 'aggression', 'bully', 'pressure', 'attack', 'relentless',
  'three-bet', '3-bet', 'raise', 'shove', 'punish', 'maniac', 'never limp',
];
const TIGHT_WORDS = [
  'tight', 'patient', 'conservative', 'disciplined', 'careful', 'nit',
  'fold', 'pot odds', 'math', 'mathematician', 'only premium', 'selective',
];
const BLUFF_WORDS = ['bluff', 'semi-bluff', 'represent', 'steal', 'barrel'];
const TRAP_WORDS = ['trap', 'slow-play', 'slowplay', 'deceptive', 'check-raise', 'induce'];

export function profileFromPersona(persona: string): PersonaProfile {
  const text = persona.toLowerCase();
  const hits = (words: string[]) => words.filter((w) => text.includes(w)).length;

  const aggro = hits(AGGRO_WORDS);
  const tight = hits(TIGHT_WORDS);
  const bluff = hits(BLUFF_WORDS);
  const trap = hits(TRAP_WORDS);

  const aggression = clamp(0.5 + 0.12 * aggro - 0.12 * tight, 0.08, 0.95);
  const bluffiness = clamp(0.08 + 0.12 * bluff + 0.05 * aggro - 0.04 * tight, 0.02, 0.55);

  let voice: PersonaProfile['voice'] = 'stoic';
  if (trap > 0) voice = 'sly';
  else if (aggro > tight) voice = 'brash';
  else if (tight > 0) voice = 'clinical';

  return { aggression, bluffiness, trappy: trap > 0, voice };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Monte Carlo equity against uniformly random opponent holdings.
 * 240 samples keeps a six-way turn decision under a millisecond while still
 * separating "clear call" from "clear fold" reliably.
 */
export function estimateEquity(
  holeCards: readonly CardCode[],
  board: readonly CardCode[],
  opponents: number,
  seed: string,
  samples = 240,
): number {
  const known = new Set<CardCode>([...holeCards, ...board]);
  const deck = FULL_DECK.filter((c) => !known.has(c));
  const rng = makeRng(seed);
  const needBoard = 5 - board.length;
  let score = 0;

  for (let s = 0; s < samples; s++) {
    const pool = [...deck];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    let cursor = 0;
    const runout = pool.slice(cursor, cursor + needBoard);
    cursor += needBoard;
    const fullBoard = [...board, ...runout];
    const mine = evaluateHand([...holeCards, ...fullBoard]);

    let better = 0;
    let equal = 0;
    for (let o = 0; o < opponents; o++) {
      const theirs = evaluateHand([
        pool[cursor++] as CardCode,
        pool[cursor++] as CardCode,
        ...fullBoard,
      ]);
      const cmp = compareHands(mine, theirs);
      if (cmp < 0) better++;
      else if (cmp === 0) equal++;
    }
    if (better === 0) score += equal === 0 ? 1 : 1 / (equal + 1);
  }
  return score / samples;
}

export function heuristicDecision(ctx: TurnContext, persona: string, seed: string): AgentDecision {
  const profile = profileFromPersona(persona);
  const liveOpponents = Math.max(
    1,
    ctx.opponents.filter((o) => o.status !== 'folded').length,
  );
  const equity = estimateEquity(ctx.holeCards, ctx.board, liveOpponents, seed);
  const rng = makeRng(`${seed}:policy`);

  const potOdds = ctx.toCall > 0 ? ctx.toCall / (ctx.pot + ctx.toCall) : 0;
  const aggressionBonus = (profile.aggression - 0.5) * 0.14;
  const effectiveEquity = equity + aggressionBonus;

  // How much of the stack the current bet puts at risk. Raising into a bet
  // that already threatens most of the stack demands far more than a thin
  // edge — without this, two policy agents re-raise each other all-in on
  // hand one and the table is over before anyone can watch it.
  const riskFraction = clamp(ctx.toCall / Math.max(1, ctx.stack + ctx.toCall), 0, 1);

  // Sizing is expressed the way players talk about it — a fraction of the
  // pot on top of the current bet — then clamped into the legal window.
  const raiseTo = (fraction: number): number => {
    const desired = ctx.currentBet + Math.round(ctx.pot * fraction);
    // Cap at a pot-sized raise unless the hand is strong enough that getting
    // the whole stack in is genuinely the plan.
    const ceiling = equity > 0.85 ? ctx.legal.maxRaiseTo : ctx.currentBet + ctx.pot;
    return clamp(
      Math.max(ctx.legal.minRaiseTo, Math.min(desired, ceiling)),
      ctx.legal.minRaiseTo,
      ctx.legal.maxRaiseTo,
    );
  };

  // Nothing to call: bet for value, bet as a bluff, or take the free card.
  if (ctx.toCall === 0) {
    const valueBet = effectiveEquity > 0.62 && !(profile.trappy && equity > 0.85);
    const bluff = equity < 0.4 && ctx.board.length >= 3 && rng() < profile.bluffiness;
    if ((valueBet || bluff) && ctx.legal.canRaise) {
      const size = bluff ? 0.5 : 0.4 + profile.aggression * 0.45;
      return decide('raise', raiseTo(size), equity, profile, bluff ? 'bluff' : 'value', ctx);
    }
    return decide('check', 0, equity, profile, profile.trappy && equity > 0.8 ? 'trap' : 'control', ctx);
  }

  // Facing a bet. The more of the stack is already at risk, the stronger the
  // hand has to be to escalate — this is what makes a raising war terminate.
  const baseThreshold = profile.trappy ? 0.82 : 0.72 - profile.aggression * 0.12;
  const raiseThreshold = Math.min(0.97, baseThreshold + riskFraction * 0.35);
  if (effectiveEquity > raiseThreshold && ctx.legal.canRaise) {
    return decide('raise', raiseTo(0.7 + profile.aggression * 0.4), equity, profile, 'value', ctx);
  }
  if (effectiveEquity > potOdds + 0.03) {
    return decide('call', ctx.legal.toCall, equity, profile, 'odds', ctx);
  }
  if (ctx.legal.canRaise && equity < 0.3 && rng() < profile.bluffiness * 0.5) {
    return decide('raise', raiseTo(0.8), equity, profile, 'bluff', ctx);
  }
  return decide('fold', 0, equity, profile, 'fold', ctx);
}

type Motive = 'value' | 'bluff' | 'odds' | 'trap' | 'control' | 'fold';

function decide(
  action: AgentDecision['action'],
  amount: number,
  equity: number,
  profile: PersonaProfile,
  motive: Motive,
  ctx: TurnContext,
): AgentDecision {
  const pct = (equity * 100).toFixed(0);
  const thoughts: Record<Motive, string> = {
    value: `${pct}% equity here — betting for value and charging the draws.`,
    bluff: `Only ${pct}% but the board favours my range. Firing anyway.`,
    odds: `${pct}% equity against ${ctx.toCall} to call. The price is right.`,
    trap: `${pct}% and I am ahead. Checking to keep them betting into me.`,
    control: `${pct}% equity. Nothing to gain by building a pot here.`,
    fold: `${pct}% equity is not enough for ${ctx.toCall}. Letting it go.`,
  };

  const chat: Record<PersonaProfile['voice'], Partial<Record<Motive, string>>> = {
    clinical: {
      value: 'The math says yes.',
      bluff: 'Pricing you out.',
      odds: 'Correct call, nothing personal.',
      trap: 'Check.',
      control: 'Check.',
      fold: 'Fold. Next hand.',
    },
    brash: {
      value: 'Pay me.',
      bluff: 'You are not calling this.',
      odds: "I'll pay to see you squirm.",
      trap: 'Go on then.',
      control: 'Check. Boring board.',
      fold: 'Take it, I have bigger plans.',
    },
    sly: {
      value: 'Oh, is it my turn?',
      bluff: 'Feels like my board.',
      odds: 'I suppose I call.',
      trap: 'Check. No idea what I am doing.',
      control: 'Check.',
      fold: 'Too rich for me... this time.',
    },
    stoic: {
      value: 'Raise.',
      bluff: 'Bet.',
      odds: 'Call.',
      trap: 'Check.',
      control: 'Check.',
      fold: 'Fold.',
    },
  };

  return {
    action,
    amount,
    inner_thought: thoughts[motive],
    table_chat: chat[profile.voice][motive] ?? 'Check.',
  };
}
