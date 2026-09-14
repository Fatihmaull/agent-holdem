import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedDeck } from '../poker/cards';
import { startHand } from '../poker/engine';
import { shuffledDeck } from './deck';

const TWO_SEATS = [
  { agentId: 'a', stack: 2000 },
  { agentId: 'b', stack: 2000 },
];

function deal(deck: number[]) {
  return startHand({ handId: 'h', seats: TWO_SEATS, button: 0, smallBlind: 10, bigBlind: 20, deck });
}

test('a shuffled deck is every card exactly once', () => {
  for (let i = 0; i < 200; i++) assert.doesNotThrow(() => checkedDeck(shuffledDeck()));
});

test('no two shuffled decks come out the same', () => {
  // With 52! orders, a repeat inside fifty draws means the shuffle is not
  // drawing from anything at all.
  const orders = new Set(Array.from({ length: 50 }, () => shuffledDeck().join(',')));
  assert.equal(orders.size, 50);
});

test('a hand is dealt from the deck it is given, off the end', () => {
  const deck = shuffledDeck();
  const state = deal(deck);

  assert.deepEqual(state.seats[0].hole, [deck[51], deck[50]]);
  assert.deepEqual(state.seats[1].hole, [deck[49], deck[48]]);
  assert.equal(deck.length, 52, 'and the deck passed in is left whole, so it can be stored as dealt');
});

test('a deck that repeats or drops a card is refused rather than dealt', () => {
  const repeated = shuffledDeck();
  repeated[0] = repeated[1];

  assert.throws(() => deal(repeated), /every card exactly once/);
  assert.throws(() => deal(shuffledDeck().slice(1)), /every card exactly once/);
});
