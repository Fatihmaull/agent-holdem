import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byWinRateFloor, winRate } from './stats';

test('the rate is the per-hand average expressed per hundred hands', () => {
  assert.equal(winRate(1000, 0.05, 8).rate, 5);
  assert.equal(winRate(1000, -0.12, 8).rate, -12);
});

test('the floor sits below the rate and closes on it as hands pile up', () => {
  const thin = winRate(100, 0.05, 8);
  const thick = winRate(100_000, 0.05, 8);

  assert.ok(thin.floor !== null && thick.floor !== null);
  assert.ok(thin.floor < thin.rate, 'the published number is never the optimistic one');
  assert.ok(thick.floor > thin.floor, 'more hands, less doubt');

  // Worth reading as a fact about poker rather than about this function. At a
  // realistic spread of eight big blinds a hand, a hundred hands says almost
  // nothing, and even a hundred thousand still leaves several big blinds per
  // hundred of doubt, which is the size of a real edge.
  assert.ok(thin.rate - thin.floor > 100, 'a hundred hands is not a measurement');
  assert.ok(thick.rate - thick.floor < 6, 'a hundred thousand hands narrows it to about five');
});

test('a hot run over few hands does not outrank a proven one', () => {
  const lucky = winRate(40, 1.5, 8); // 150 bb/100 over forty hands
  const proven = winRate(50_000, 0.06, 8); // 6 bb/100 over fifty thousand

  assert.ok(lucky.rate > proven.rate, 'the raw rate does favour the lucky agent');
  assert.ok(lucky.floor !== null && proven.floor !== null);
  assert.ok(proven.floor > lucky.floor, 'the ranked number does not');
});

test('too few hands has no interval, and no interval sorts last', () => {
  assert.equal(winRate(1, 0.5, 8).floor, null);
  assert.equal(winRate(0, 0, 0).floor, null);
  // A sample with no spread has not been tested by anything.
  assert.equal(winRate(500, 0.05, 0).floor, null);

  const measured = winRate(1000, -0.5, 8);
  const unmeasured = winRate(1, 5, 0);

  assert.ok([unmeasured, measured].sort(byWinRateFloor)[0] === measured, 'a losing record still beats no record');
});

test('among agents with no interval, the one that has played more comes first', () => {
  const few = winRate(1, 0, 0);
  const fewer = winRate(0, 0, 0);

  assert.ok([fewer, few].sort(byWinRateFloor)[0] === few);
});
