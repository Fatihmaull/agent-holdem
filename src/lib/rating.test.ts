import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RATING, conservative, updateRatings, type Placing, type Rating } from './rating';

const fresh = (): Rating => ({ ...DEFAULT_RATING });

/** A six-handed match where the given places are handed out in seat order. */
function match(places: number[], ratings?: Rating[]): Array<Placing<number>> {
  return updateRatings(
    places.map((place, seat) => ({ entrant: seat, rating: ratings?.[seat] ?? fresh(), place })),
  );
}

test('an agent nobody has seen publishes nothing', () => {
  // Not 25. We have no evidence about it at all, and the published number is
  // the pessimistic end of what we know.
  assert.equal(conservative(DEFAULT_RATING), 0);
});

test('finishing order is the order of the ratings that come out', () => {
  const after = match([1, 2, 3, 4, 5, 6]);
  const mus = after.map((entry) => entry.rating.mu);

  for (let i = 1; i < mus.length; i++) {
    assert.ok(mus[i - 1] > mus[i], `place ${i} should rate above place ${i + 1}`);
  }
  assert.ok(mus[0] > DEFAULT_RATING.mu, 'the winner gained');
  assert.ok(mus[5] < DEFAULT_RATING.mu, 'last place lost');
});

test('one match moves an estimate without pretending to settle it', () => {
  const [winner] = match([1, 2, 3, 4, 5, 6]);

  // The guard against the version of this that summed every comparison
  // outright: it moved a newcomer twice as far and cut its doubt in half, off
  // one table's worth of evidence.
  assert.ok(winner.rating.mu > 30 && winner.rating.mu < 36, `winner reached ${winner.rating.mu.toFixed(1)}`);
  assert.ok(winner.rating.sigma > 6 && winner.rating.sigma < 7.5, `sigma fell to ${winner.rating.sigma.toFixed(2)}`);
  assert.ok(winner.rating.sigma < DEFAULT_RATING.sigma, 'but it did fall');
});

test('beating somebody good is worth more than beating somebody bad', () => {
  const strong: Rating = { mu: 40, sigma: 2 };
  const weak: Rating = { mu: 10, sigma: 2 };
  const hero = fresh();

  const [overStrong] = updateRatings([
    { entrant: 'hero', rating: hero, place: 1 },
    { entrant: 'other', rating: strong, place: 2 },
  ]);
  const [overWeak] = updateRatings([
    { entrant: 'hero', rating: hero, place: 1 },
    { entrant: 'other', rating: weak, place: 2 },
  ]);

  assert.ok(
    overStrong.rating.mu - hero.mu > overWeak.rating.mu - hero.mu,
    'an upset has to pay more than the result everyone expected',
  );
  assert.ok(overWeak.rating.mu > hero.mu, 'though beating a weak player still counts for something');
});

test('losing to somebody far below costs more than losing to somebody above', () => {
  const strong: Rating = { mu: 40, sigma: 2 };
  const weak: Rating = { mu: 10, sigma: 2 };
  const hero = fresh();

  const [underStrong] = updateRatings([
    { entrant: 'hero', rating: hero, place: 2 },
    { entrant: 'other', rating: strong, place: 1 },
  ]);
  const [underWeak] = updateRatings([
    { entrant: 'hero', rating: hero, place: 2 },
    { entrant: 'other', rating: weak, place: 1 },
  ]);

  assert.ok(underWeak.rating.mu < underStrong.rating.mu, 'the surprising loss is the expensive one');
});

test('a tie pulls two estimates toward each other', () => {
  const ahead: Rating = { mu: 35, sigma: 4 };
  const behind: Rating = { mu: 15, sigma: 4 };

  const [a, b] = updateRatings([
    { entrant: 'ahead', rating: ahead, place: 1 },
    { entrant: 'behind', rating: behind, place: 1 },
  ]);

  assert.ok(a.rating.mu < ahead.mu, 'the favourite drops for only drawing');
  assert.ok(b.rating.mu > behind.mu, 'the underdog gains for holding on');
  assert.ok(a.rating.mu > b.rating.mu, 'but one draw does not make them equal');
});

test('doubt shrinks with play and never reaches zero', () => {
  let ratings = Array.from({ length: 6 }, fresh);

  for (let round = 0; round < 400; round++) {
    ratings = match([1, 2, 3, 4, 5, 6], ratings).map((entry) => entry.rating);
  }

  for (const rating of ratings) {
    assert.ok(rating.sigma >= 0.5, `sigma bottomed at ${rating.sigma}`);
    assert.ok(Number.isFinite(rating.mu) && Number.isFinite(rating.sigma));
  }
  // Drift keeps a floor under it on purpose: an owner can rewrite an agent
  // between matches, and a rating that had collapsed to certainty would take
  // far too long to notice.
  assert.ok(ratings[0].sigma > 0.5, 'and it settles above the floor rather than on it');
});

test('a better agent separates from the field over a season of matches', () => {
  // Deterministic rather than random, so this test cannot flake. The hero
  // cycles through a genuinely better set of finishes, and the places left over
  // rotate through the field so no seat gets a standing head start.
  const HERO_FINISHES = [1, 1, 2, 3, 3];
  let hero = fresh();
  let field = Array.from({ length: 5 }, fresh);

  for (let m = 0; m < 60; m++) {
    const heroPlace = HERO_FINISHES[m % HERO_FINISHES.length];
    const others = [1, 2, 3, 4, 5, 6].filter((place) => place !== heroPlace);
    const after = updateRatings([
      { entrant: 'hero', rating: hero, place: heroPlace },
      ...field.map((rating, i) => ({ entrant: `f${i}`, rating, place: others[(i + m) % others.length] })),
    ]);

    hero = after[0].rating;
    field = after.slice(1).map((entry) => entry.rating);
  }

  const best = Math.max(...field.map(conservative));
  assert.ok(conservative(hero) > best, 'the agent that actually won more ends up on top');
  assert.ok(hero.sigma < 3, `and we are reasonably sure of it: sigma ${hero.sigma.toFixed(2)}`);
});

test('a mismatch far outside the model does not produce nonsense', () => {
  // The tail is where the truncated-normal ratio underflows. A NaN here would
  // spread to every agent in the match and then to the leaderboard.
  const after = updateRatings([
    { entrant: 'nobody', rating: { mu: -200, sigma: 0.5 }, place: 1 },
    { entrant: 'everybody', rating: { mu: 200, sigma: 0.5 }, place: 2 },
  ]);

  for (const entry of after) {
    assert.ok(Number.isFinite(entry.rating.mu), `mu was ${entry.rating.mu}`);
    assert.ok(Number.isFinite(entry.rating.sigma), `sigma was ${entry.rating.sigma}`);
    assert.ok(entry.rating.sigma > 0);
  }
  assert.ok(after[0].rating.mu > -200, 'the enormous upset moved the winner up');
});

test('a match nobody else turned up to changes nothing', () => {
  const alone = updateRatings([{ entrant: 'solo', rating: fresh(), place: 1 }]);

  assert.deepEqual(alone[0].rating, DEFAULT_RATING);
  assert.deepEqual(updateRatings([]), []);
});
