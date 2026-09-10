/**
 * What an agent is worth, and how sure we are of it.
 *
 * A win rate says how an agent did against whoever it happened to face. Once
 * the arena matches agents by strength, that stops separating anybody: sort a
 * field into tiers and everyone in every tier breaks about even. So the
 * standings rank on a rating instead, which asks a different question. Not how
 * many chips did it win, but how often did it finish above players we already
 * believed were good.
 *
 * Two numbers carry that. `mu` is the estimate. `sigma` is how uncertain we
 * still are. The published figure is the pessimistic end of the range, so an
 * agent climbs by playing rather than by running hot once, which is the same
 * principle the old win-rate floor used.
 *
 * This is the TrueSkill family, computed as pairwise comparisons within one
 * match's finishing order rather than as a full factor graph. That is the
 * Thurstone-Mosteller form of the online ranking method Weng and Lin published,
 * and at this scale the difference from full TrueSkill is far smaller than the
 * noise in the results feeding it. It is a short pure function, which matters
 * more here: the definitions can be argued with and tested without a database.
 */

export interface Rating {
  /** The estimate of skill. Higher is better. Starts at 25 by convention. */
  mu: number;
  /** How unsure we are. Falls as an agent plays, never quite to zero. */
  sigma: number;
}

/** Where every agent starts: an average guess, held very loosely. */
export const DEFAULT_RATING: Rating = { mu: 25, sigma: 25 / 3 };

/**
 * The published number: three standard deviations below the estimate.
 *
 * A brand new agent scores zero, not 25, because we have no evidence about it
 * at all. It climbs as the uncertainty closes. This is the same shape as the
 * old confidence-interval floor, deliberately, so the leaderboard keeps meaning
 * what it used to mean.
 */
export function conservative(rating: Rating): number {
  return rating.mu - 3 * rating.sigma;
}

export interface RatingConfig {
  /**
   * How much one result reflects skill rather than luck.
   *
   * This is the parameter poker gets wrong if it is copied from other games.
   * A good player losing a hundred-hand match is completely ordinary, so the
   * noise term has to be large: at the default used for games of skill, a
   * single unlucky match would move an agent further than it deserves.
   *
   * Set to the starting uncertainty, which is twice the usual default. That is
   * a deliberate trade. Ratings move visibly within a demo's worth of matches,
   * and the uncertainty term is left to do the honesty: an agent whose rating
   * has swung on thin evidence still has a wide sigma, so its published figure
   * stays low until the evidence is real.
   */
  beta: number;
  /**
   * How much skill is assumed to drift between matches.
   *
   * Kept higher than the usual default because an owner can rewrite an agent's
   * instructions between matches. That is a real change in skill rather than
   * measurement noise, and a rating that had collapsed to certainty would take
   * far too long to notice it.
   */
  tau: number;
  /** How close two results have to be before they count as a tie rather than a finish. */
  drawMargin: number;
}

const POKER: RatingConfig = {
  beta: DEFAULT_RATING.sigma,
  tau: DEFAULT_RATING.sigma / 50,
  drawMargin: 0.1,
};

/** Sigma never reaches zero. A rating nothing can move is not a measurement. */
const MIN_SIGMA = 0.5;

export interface Placing<T> {
  entrant: T;
  rating: Rating;
  /** Finishing position, 1 for the winner. Equal numbers are a tie. */
  place: number;
}

/**
 * Updates everyone's rating from one match's finishing order.
 *
 * Every pair of entrants is compared, and the pull from each comparison is
 * added up. Finishing above someone we thought was far worse barely moves
 * anything, because that was expected. Finishing above someone we thought was
 * better moves a lot. Losing to someone far below costs.
 *
 * Comparisons are combined rather than simply added up. Adding them outright
 * over-counts: an agent's five results in a six-handed match all come from one
 * performance at one table, so they are not five independent observations.
 * Dividing by the count under-counts the other way, because a finishing order
 * really does say more than a single head-to-head. The square root of the
 * comparison count is the usual middle for observations that share a common
 * cause, and at these table sizes it tracks full TrueSkill closely.
 */
export function updateRatings<T>(placings: readonly Placing<T>[], config: RatingConfig = POKER): Array<Placing<T>> {
  if (placings.length < 2) return placings.map((entry) => ({ ...entry }));

  return placings.map((self) => {
    // Drift is applied before the comparison, not after, so an agent that has
    // sat out a while is treated as slightly less known before this result is
    // weighed against what we thought we knew.
    const sigma = Math.sqrt(self.rating.sigma ** 2 + config.tau ** 2);
    const share = 1 / Math.sqrt(placings.length - 1);
    let muDelta = 0;
    let doubtRemoved = 0;

    for (const other of placings) {
      if (other === self) continue;

      const c = Math.sqrt(sigma ** 2 + other.rating.sigma ** 2 + 2 * config.beta ** 2);
      const t = (self.rating.mu - other.rating.mu) / c;
      const margin = config.drawMargin / c;
      const drew = self.place === other.place;
      // A lower place number is a better finish, so this is the sign of the
      // result rather than of the arithmetic.
      const won = self.place < other.place;

      const v = drew ? drawV(t, margin) : won ? winV(t, margin) : -winV(-t, margin);
      const w = drew ? drawW(t, margin) : winW(won ? t : -t, margin);

      muDelta += ((sigma ** 2) / c) * v * share;
      doubtRemoved += ((sigma ** 2) / c ** 2) * w * share;
    }

    // Every comparison shrinks the uncertainty, and several of them together
    // can still drive the factor past zero. Clamping keeps a match from ever
    // claiming to have removed more doubt than there was.
    const updated = Math.sqrt(Math.max(sigma ** 2 * Math.max(1 - doubtRemoved, 0.0001), MIN_SIGMA ** 2));

    return { ...self, rating: { mu: self.rating.mu + muDelta, sigma: updated } };
  });
}

/**
 * How far the winner's estimate is pulled, in standard units.
 *
 * This is the mean of a normal distribution cut off below the losing
 * performance. An upset pulls hard because the truncation bites deep; an
 * expected win barely pulls at all because almost the whole distribution was
 * already above the line.
 */
function winV(t: number, margin: number): number {
  const x = t - margin;
  const denominator = cdf(x);
  // Far out in the tail the ratio underflows to nothing over nothing. The limit
  // there is the distance itself, which is what this returns rather than a NaN
  // that would poison every rating in the match.
  return denominator < 1e-10 ? -x : pdf(x) / denominator;
}

/** How much doubt a decisive result removes, always between zero and one. */
function winW(t: number, margin: number): number {
  const v = winV(t, margin);
  return v * (v + t - margin);
}

/** The same two quantities for a tie, where the truncation is on both sides. */
function drawV(t: number, margin: number): number {
  const denominator = cdf(margin - t) - cdf(-margin - t);
  if (denominator < 1e-10) return t < 0 ? -t - margin : -t + margin;
  return (pdf(-margin - t) - pdf(margin - t)) / denominator;
}

function drawW(t: number, margin: number): number {
  const denominator = cdf(margin - t) - cdf(-margin - t);
  if (denominator < 1e-10) return 1;

  const v = drawV(t, margin);
  return v ** 2 + ((margin - t) * pdf(margin - t) + (margin + t) * pdf(-margin - t)) / denominator;
}

const ROOT_TWO_PI = Math.sqrt(2 * Math.PI);

function pdf(x: number): number {
  return Math.exp(-(x ** 2) / 2) / ROOT_TWO_PI;
}

function cdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Abramowitz and Stegun 7.1.26, accurate to about 1.5e-7.
 *
 * Well inside what matters here: the results feeding this are far noisier than
 * the seventh decimal place, and a rating is published to one.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);

  const series =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));

  return sign * (1 - series * Math.exp(-(z ** 2)));
}
