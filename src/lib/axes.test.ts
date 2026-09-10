import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type AxisDecision, type AxisResult, bbPer100, computeAxes, loosenessOf, stints } from './axes';

const decision = (over: Partial<AxisDecision> = {}): AxisDecision => ({
  handId: 'h1',
  agentId: 'me',
  street: 'flop',
  action: 'call',
  equity: 0.5,
  ...over,
});

const result = (over: Partial<AxisResult> = {}): AxisResult => ({
  handId: 'h1',
  agentId: 'me',
  matchId: 'low-01',
  bigBlind: 20,
  net: 0,
  opponentRating: 0,
  showdown: false,
  ...over,
});

const many = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i));

const empty = {
  agentId: 'me',
  decisions: [] as AxisDecision[],
  results: [] as AxisResult[],
  looseness: new Map<string, number>(),
  opponentsByHand: new Map<string, string[]>(),
  weakOpponentRating: null,
    fieldVersusWeak: null,
};

test('every axis is null until there is enough to measure', () => {
  assert.deepEqual(computeAxes(empty), {
    reading: null,
    deception: null,
    adaptation: null,
    exploitation: null,
  });
});

test('looseness counts paying to play, not being made to post', () => {
  assert.equal(
    loosenessOf([
      decision({ street: 'preflop', action: 'call' }),
      decision({ street: 'preflop', action: 'fold' }),
      decision({ street: 'preflop', action: 'raise' }),
      decision({ street: 'preflop', action: 'fold' }),
      // A later street says nothing about entering a pot.
      decision({ street: 'river', action: 'call' }),
    ]),
    0.5,
  );
  assert.equal(loosenessOf([]), null);
});

test('a bluff that got called and won at showdown does not count as deception', () => {
  const bluffs = many(20, (i) => decision({ handId: `h${i}`, action: 'bet', equity: 0.1 }));

  // Every one was called and won by luck. Persuasion had nothing to do with it.
  const shown = many(20, (i) => result({ handId: `h${i}`, net: 500, showdown: true }));
  assert.equal(computeAxes({ ...empty, decisions: bluffs, results: shown }).deception, 0);

  // The same bets, taken down without a showdown.
  const folded = many(20, (i) => result({ handId: `h${i}`, net: 500, showdown: false }));
  assert.equal(computeAxes({ ...empty, decisions: bluffs, results: folded }).deception, 1);
});

test('a strong hand bet for value is not a bluff', () => {
  const value = many(20, (i) => decision({ handId: `h${i}`, action: 'bet', equity: 0.9 }));
  const won = many(20, (i) => result({ handId: `h${i}`, net: 500 }));

  assert.equal(computeAxes({ ...empty, decisions: value, results: won }).deception, null);
});

test('reading is positive when the agent calls more against loose tables', () => {
  const results = many(120, (i) => result({ handId: `h${i}` }));
  const opponentsByHand = new Map(results.map((row, i) => [row.handId, [i < 60 ? 'fish' : 'rock']]));
  const looseness = new Map([
    ['fish', 0.8],
    ['rock', 0.1],
  ]);

  // Against the loose half it always continues; against the tight half it folds
  // most of the time. That is a read being acted on.
  const decisions = results.flatMap((row, i) =>
    i < 60 ? [decision({ handId: row.handId, action: 'call' })] : [decision({ handId: row.handId, action: 'fold' })],
  );

  const axes = computeAxes({ ...empty, results, decisions, opponentsByHand, looseness });
  assert.ok(axes.reading !== null && axes.reading > 0.9, 'continues against loose opponents, folds to tight ones');
});

test('reading is near zero for an agent that ignores who it is playing', () => {
  const results = many(120, (i) => result({ handId: `h${i}` }));
  const opponentsByHand = new Map(results.map((row, i) => [row.handId, [i < 60 ? 'fish' : 'rock']]));
  const looseness = new Map([
    ['fish', 0.8],
    ['rock', 0.1],
  ]);
  // The same behaviour whoever is sitting there.
  const decisions = results.flatMap((row, i) => [
    decision({ handId: row.handId, action: i % 2 === 0 ? 'call' : 'fold' }),
  ]);

  const axes = computeAxes({ ...empty, results, decisions, opponentsByHand, looseness });
  assert.ok(axes.reading !== null && Math.abs(axes.reading) < 0.1);
});

test('a stint ends when the agent changes tables', () => {
  const runs = stints([
    result({ matchId: 'low-01' }),
    result({ matchId: 'low-01' }),
    result({ matchId: 'mid-02' }),
    result({ matchId: 'low-01' }),
  ]);

  assert.deepEqual(
    runs.map((run) => run.length),
    [2, 1, 1],
    'returning to a table later is a new stint, not a continuation',
  );
});

test('adaptation is positive when the second half of each stint goes better', () => {
  const stint = (table: string) => [
    ...many(20, () => result({ matchId: table, net: -20 })),
    ...many(20, () => result({ matchId: table, net: 40 })),
  ];

  const axes = computeAxes({ ...empty, results: [...stint('low-01'), ...stint('mid-01'), ...stint('low-02')] });
  assert.ok(axes.adaptation !== null && axes.adaptation > 0);
});

test('exploitation measures the gap to the field, not the raw win rate', () => {
  // Weak now means rated weak, rather than scripted to be weak. Ten is below
  // the threshold of twenty, so every one of these counts.
  const versusWeak = many(60, () => result({ net: 20, bigBlind: 20, opponentRating: 10 }));
  assert.equal(bbPer100(versusWeak), 100);

  const ahead = computeAxes({
    ...empty,
    results: versusWeak,
    weakOpponentRating: 20,
    fieldVersusWeak: 40,
  });
  const behind = computeAxes({
    ...empty,
    results: versusWeak,
    weakOpponentRating: 20,
    fieldVersusWeak: 160,
  });

  assert.equal(ahead.exploitation, 60, 'punishing weak players harder than everyone else does');
  assert.equal(behind.exploitation, -60, 'winning, but finding less there than the field does');
});

test('hands against strong opposition do not count toward exploitation', () => {
  // Above the threshold, so these say nothing about exploiting weakness however
  // well they went.
  const versusStrong = many(60, () => result({ net: 20, opponentRating: 35 }));

  assert.equal(
    computeAxes({ ...empty, results: versusStrong, weakOpponentRating: 20, fieldVersusWeak: 0 }).exploitation,
    null,
  );
});

test('exploitation says nothing until the field has been measured', () => {
  const hands = many(60, () => result({ net: 20, opponentRating: 5 }));

  // No threshold means no agent has a rating worth comparing against yet, which
  // is different from an agent that exploits nobody.
  assert.equal(computeAxes({ ...empty, results: hands, weakOpponentRating: null, fieldVersusWeak: 0 }).exploitation, null);
  assert.equal(computeAxes({ ...empty, results: hands, weakOpponentRating: 20, fieldVersusWeak: null }).exploitation, null);
});
