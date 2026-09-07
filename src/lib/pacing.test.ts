import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACT_CLOCK_MS, PACE_FLOOR_MS, PACE_SPREAD_MS, pacingFloor } from './pacing';

test('a decision on top of the price is held longest', () => {
  const agonising = pacingFloor(0.34, 0.34);
  assert.equal(agonising, PACE_FLOOR_MS + PACE_SPREAD_MS);
});

test('a decision far from the price clears quickly', () => {
  const trivial = pacingFloor(0.95, 0.2);
  assert.equal(trivial, PACE_FLOOR_MS, 'nothing to agonise over');
});

test('holding time rises as the decision gets closer', () => {
  const wide = pacingFloor(0.7, 0.3);
  const near = pacingFloor(0.4, 0.3);
  const onIt = pacingFloor(0.31, 0.3);
  assert.ok(onIt > near && near > wide, `${onIt} > ${near} > ${wide}`);
});

test('with nothing to call, the reference is a coin flip', () => {
  assert.equal(pacingFloor(0.5, null), PACE_FLOOR_MS + PACE_SPREAD_MS);
  assert.equal(pacingFloor(0.5, 0.5), pacingFloor(0.5, null));
});

test('never holds longer than the act clock', () => {
  for (let equity = 0; equity <= 1; equity += 0.05) {
    for (const odds of [null, 0, 0.25, 0.5, 0.75, 1]) {
      const floor = pacingFloor(equity, odds);
      assert.ok(floor >= PACE_FLOOR_MS && floor < ACT_CLOCK_MS, `equity=${equity} odds=${odds} floor=${floor}`);
    }
  }
});
