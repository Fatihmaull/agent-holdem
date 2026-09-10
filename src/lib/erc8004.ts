/**
 * What this arena publishes to ERC-8004, and why anyone should believe it.
 *
 * ERC-8004's own weak point is that reputation is self-reported. An agent, or
 * whoever runs one, posts feedback about itself or about its friends, and
 * nothing in the standard makes that expensive. Published work on the ecosystem
 * says the same: the registries are sound, the signals going into them are not.
 *
 * A poker record is the opposite kind of signal. It is adversarial, it is
 * measured in money that came from somewhere, and every match costs an entry
 * fee. Nobody can Sybil their way to a rating: the only way to have finished
 * above somebody is to have taken chips off them while they tried to keep them,
 * and the arena chose the opponents rather than the agent.
 *
 * So two things go on chain, and they answer different questions.
 *
 *   Reputation says how good the agent is, as its rating. It is signed, because
 *   an agent that keeps finishing last rates below where it started.
 *
 *   Validation says how much that figure is worth believing, as the 0 to 100
 *   the standard asks for, derived from the rating's own uncertainty. That is a
 *   more direct answer than any proxy: the uncertainty term literally means how
 *   sure we are.
 *
 * Everything here is pure. The numbers can be checked against the published
 * evidence document by anybody, without this server's cooperation.
 */

import { DEFAULT_RATING, conservative, type Rating } from './rating';

/**
 * Uncertainty this wide says nothing at all, so it scores zero.
 *
 * The starting sigma is exactly that: an agent nobody has watched play. A
 * confidence of zero for one is not harshness, it is the truth.
 */
const USELESS_SIGMA = DEFAULT_RATING.sigma;

/** Two decimals on the reputation value, so a rating of 27.34 survives the trip. */
export const REPUTATION_DECIMALS = 2;

/** Both registries take these, and both are indexed, so they are the query. */
export const REPUTATION_TAGS = { game: 'texas-holdem', metric: 'trueskill-rating' } as const;
export const VALIDATION_TAG = 'poker-record';

/**
 * How much to believe the rating, as the 0 to 100 the Validation Registry takes.
 *
 * Read straight off the uncertainty, which is the one input an attacker cannot
 * fake: it only closes by playing matches the arena chose the opponents for,
 * each of which costs an entry fee. A confidently terrible agent scores high
 * here and should, because the arena is sure about it.
 */
export function confidenceIn(rating: Rating): number {
  if (!Number.isFinite(rating.sigma) || rating.sigma >= USELESS_SIGMA) return 0;

  const closed = 1 - rating.sigma / USELESS_SIGMA;
  return Math.max(0, Math.min(100, Math.round(closed * 100)));
}

/** The rating as the signed fixed-point integer `giveFeedback` wants. */
export function reputationValue(rating: Rating): bigint {
  return BigInt(Math.round(conservative(rating) * 10 ** REPUTATION_DECIMALS));
}

/**
 * The document a reader fetches to check the claim.
 *
 * Its hash goes on chain beside the score, so an operator that later edits the
 * record breaks its own attestation rather than quietly rewriting history.
 */
export interface Attestation {
  /** The document format, so a reader knows what it is holding. */
  schema: 'agentholdem/attestation/2';
  agentId: string;
  name: string;
  /** Matches the rating was earned over, and hands played across them. */
  matches: number;
  hands: number;
  /** The published rating: the pessimistic end of the estimate. */
  rating: number;
  ratingMu: number;
  ratingSigma: number;
  /** Matches won outright. */
  wins: number;
  /** Net chips won at the tables. Purchases and the daily top-up never touch it. */
  earnings: number;
  /** Big blinds per 100 hands, published beside the rating rather than instead of it. */
  winRateBb100: number;
  /** The 0 to 100 that went into the Validation Registry, restated here. */
  confidence: number;
  /** When this was measured, so a stale attestation is visible as stale. */
  measuredAt: string;
  method: string;
}

const METHOD =
  'The rating is a TrueSkill-family estimate updated from the finishing order of every match, computed as pairwise comparisons within each one. The published figure is three standard deviations below the estimate, so it climbs with evidence rather than with luck. Opponents are chosen by the arena, not by the agent, and every seat costs a fixed buy-in plus an entry fee. Confidence is how far the uncertainty has closed from where an unseen agent starts.';

export function buildAttestation(input: {
  agentId: string;
  name: string;
  rating: Rating;
  matches: number;
  wins: number;
  hands: number;
  winRateBb100: number;
  earnings: number;
  measuredAt: Date;
}): Attestation {
  return {
    schema: 'agentholdem/attestation/2',
    agentId: input.agentId,
    name: input.name,
    matches: input.matches,
    hands: input.hands,
    rating: round(conservative(input.rating)),
    ratingMu: round(input.rating.mu),
    ratingSigma: round(input.rating.sigma),
    wins: input.wins,
    earnings: input.earnings,
    winRateBb100: round(input.winRateBb100),
    confidence: confidenceIn(input.rating),
    measuredAt: input.measuredAt.toISOString(),
    method: METHOD,
  };
}

/**
 * The exact bytes that get hashed.
 *
 * Keys in a fixed order and no incidental whitespace, so the same record hashes
 * the same on any machine. A reader that re-serialises the fetched document
 * with this function and gets a different hash has found a changed record,
 * which is the entire point of putting the hash on chain.
 */
export function canonicalise(attestation: Attestation): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(attestation).sort()) {
    ordered[key] = attestation[key as keyof Attestation];
  }
  return JSON.stringify(ordered);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
