import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCard } from './cards';
import { CATEGORY, categoryOf, evaluate } from './evaluate';

const hand = (notation: string) => notation.split(' ').map(parseCard);
const score = (notation: string) => evaluate(hand(notation));

test('categorises each made hand from seven cards', () => {
  const cases: Array<[string, number]> = [
    ['As Ks Qs Js Ts 2c 3d', CATEGORY.STRAIGHT_FLUSH],
    ['5s 4s 3s 2s As Kc Qd', CATEGORY.STRAIGHT_FLUSH],
    ['9c 9d 9h 9s Kc 2d 3h', CATEGORY.QUADS],
    ['9c 9d 9h Kc Kd 2h 3s', CATEGORY.FULL_HOUSE],
    ['9c 9d 9h Kc Kd Ks 2h', CATEGORY.FULL_HOUSE],
    ['Ah Kh 9h 5h 2h 3c 4d', CATEGORY.FLUSH],
    ['9c 8d 7h 6s 5c Ad Kh', CATEGORY.STRAIGHT],
    ['Ac 2d 3h 4s 5c Kd Qh', CATEGORY.STRAIGHT],
    ['9c 9d 9h Kc Qd 2h 3s', CATEGORY.TRIPS],
    ['9c 9d Kc Kd 2h 3s 4c', CATEGORY.TWO_PAIR],
    ['9c 9d Kc Qd 2h 3s 5c', CATEGORY.PAIR],
    ['Ac Kd 9h 5s 3c 2d 7h', CATEGORY.HIGH_CARD],
  ];

  for (const [notation, expected] of cases) {
    assert.equal(categoryOf(score(notation)), expected, notation);
  }
});

test('ranks categories against each other', () => {
  const ascending = [
    'Ac Kd 9h 5s 3c 2d 7h',
    '9c 9d Kc Qd 2h 3s 5c',
    '9c 9d Kc Kd 2h 3s 4c',
    '9c 9d 9h Kc Qd 2h 3s',
    '9c 8d 7h 6s 5c Ad Kh',
    'Ah Kh 9h 5h 2h 3c 4d',
    '9c 9d 9h Kc Kd 2h 3s',
    '9c 9d 9h 9s Kc 2d 3h',
    'As Ks Qs Js Ts 2c 3d',
  ];

  for (let i = 1; i < ascending.length; i++) {
    assert.ok(score(ascending[i]) > score(ascending[i - 1]), `${ascending[i]} > ${ascending[i - 1]}`);
  }
});

test('the wheel is the weakest straight', () => {
  assert.ok(score('6c 5d 4h 3s 2c Kd Qh') > score('Ac 2d 3h 4s 5c Kd Qh'));
});

test('breaks ties on kickers', () => {
  assert.ok(score('Ac Ad Kh 9s 3c 2d 4h') > score('Ac Ad Qh 9s 3c 2d 4h'));
  assert.ok(score('Ac Ad Kh Ks 3c 2d 4h') > score('Ac Ad Qh Qs 3c 2d 4h'));
  assert.equal(score('Ac Ad Kh 9s 3c 2d 4h'), score('Ah As Kd 9c 3h 2s 4c'));
});

test('a flush uses its five highest cards', () => {
  assert.ok(score('Ah Kh 9h 5h 2h 3h 4c') > score('Kh Qh 9h 5h 2h 3h 4c'));
  assert.equal(categoryOf(score('Ah Kh 9h 5h 2h 3h 4c')), CATEGORY.FLUSH);
});

test('two trips play as a full house of the higher trips', () => {
  const twoTrips = score('9c 9d 9h Kc Kd Ks 2h');
  const straight = score('9c 8d 7h 6s 5c Ad Kh');
  assert.ok(twoTrips > straight);
  assert.ok(twoTrips > score('9c 9d 9h Qc Qd 2h 3s'));
});

test('scores five-card hands too', () => {
  assert.equal(categoryOf(evaluate(hand('As Ks Qs Js Ts'))), CATEGORY.STRAIGHT_FLUSH);
  assert.equal(categoryOf(evaluate(hand('Ac Kd 9h 5s 3c'))), CATEGORY.HIGH_CARD);
});
