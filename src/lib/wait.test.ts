import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { wait } from './wait';

test('a wait that runs out leaves nothing behind on the signal', async () => {
  // One signal lives as long as a match, and every beat of every hand waits on
  // it. A listener left behind per wait is thousands of them by the last hand.
  const stopping = new AbortController();

  for (let i = 0; i < 50; i++) await wait(1, stopping.signal);

  assert.equal(getEventListeners(stopping.signal, 'abort').length, 0);
});

test('stopping ends a wait early, and cleans up after itself too', async () => {
  const stopping = new AbortController();
  const started = Date.now();

  const waiting = wait(10_000, stopping.signal);
  stopping.abort();
  await waiting;

  assert.ok(Date.now() - started < 1_000);
  assert.equal(getEventListeners(stopping.signal, 'abort').length, 0);
});

test('a wait on a signal that has already fired does not wait at all', async () => {
  // An aborted signal never fires again, so a listener added to one would sit
  // there while the timer ran its full length.
  const stopping = new AbortController();
  stopping.abort();
  const started = Date.now();

  await wait(10_000, stopping.signal);

  assert.ok(Date.now() - started < 1_000);
});
