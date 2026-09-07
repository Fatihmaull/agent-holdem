import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, parseCard } from './cards';
import { equityVsRandom, readHand } from './equity';

const cards = (notation: string) => notation.split(' ').map(parseCard);
const hole = (notation: string) => cards(notation) as [number, number];

test('aces beat one random hand about five times in six', () => {
  const { equity } = equityVsRandom(hole('As Ad'), [], 1, 20000, mulberry32(7));
  assert.ok(equity > 0.83 && equity < 0.87, `expected ~0.85, got ${equity.toFixed(3)}`);
});

test('equity falls as opponents are added', () => {
  const seed = () => mulberry32(11);
  const heads = equityVsRandom(hole('As Ad'), [], 1, 10000, seed()).equity;
  const three = equityVsRandom(hole('As Ad'), [], 3, 10000, seed()).equity;
  const five = equityVsRandom(hole('As Ad'), [], 5, 10000, seed()).equity;
  assert.ok(heads > three && three > five, `${heads} > ${three} > ${five}`);
});

test('a made flush on the river is certain against one opponent', () => {
  const { equity } = equityVsRandom(hole('As Ks'), cards('Qs Js Ts 2c 3d'), 1, 2000, mulberry32(3));
  assert.equal(equity, 1);
});

test('seven-deuce offsuit is the worst starting hand', () => {
  const seed = () => mulberry32(5);
  const worst = equityVsRandom(hole('7c 2d'), [], 1, 10000, seed()).equity;
  const better = equityVsRandom(hole('7c 3d'), [], 1, 10000, seed()).equity;
  assert.ok(worst < better, `${worst} < ${better}`);
  assert.ok(worst > 0.3 && worst < 0.4);
});

test('ties are counted as half a pot', () => {
  // The board plays: neither hand can improve on a royal flush.
  const { equity, tie, samples } = equityVsRandom(hole('2c 3d'), cards('As Ks Qs Js Ts'), 1, 500, mulberry32(9));
  assert.equal(tie, samples);
  assert.equal(equity, 0.5);
});

test('reads made hands and draws in plain terms', () => {
  const flushDraw = readHand(hole('As Ks'), cards('2s 7s 9d'));
  assert.equal(flushDraw.flushDraw, true);
  assert.equal(flushDraw.made, 'high card');
  assert.equal(flushDraw.overcards, true);

  const openEnder = readHand(hole('9c 8d'), cards('7h 6s 2c'));
  assert.equal(openEnder.openEnded, true);
  assert.equal(openEnder.gutshot, false);

  const gutshot = readHand(hole('9c 8d'), cards('7h 5s 2c'));
  assert.equal(gutshot.gutshot, true);
  assert.equal(gutshot.openEnded, false);

  const broadwayDraw = readHand(hole('Ac Kd'), cards('Qh Js 2c'));
  assert.equal(broadwayDraw.gutshot, true, 'AKQJ completes only with a ten');

  const wheelDraw = readHand(hole('Ac 2d'), cards('3h 4s 9c'));
  assert.equal(wheelDraw.gutshot, true, 'A234 completes only with a five');
  assert.equal(wheelDraw.openEnded, false);

  const lowOpenEnder = readHand(hole('2c 3d'), cards('4h 5s 9c'));
  assert.equal(lowOpenEnder.openEnded, true, '2345 completes with an ace or a six');

  const madeStraight = readHand(hole('9c 8d'), cards('7h 6s 5c'));
  assert.equal(madeStraight.made, 'straight');
  assert.equal(madeStraight.openEnded, false);
});

test('reads a pair before any board is dealt', () => {
  const pocketPair = readHand(hole('9c 9d'), []);
  assert.equal(pocketPair.made, 'pair');
  assert.equal(pocketPair.overcards, false);
});
