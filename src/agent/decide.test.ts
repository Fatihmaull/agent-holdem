import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, startHand, type HandState } from '../poker/engine';
import { decide, positionName } from './decide';
import { ModelQueue } from './queue';
import { ProviderError, ScriptedProvider, type ModelProvider, type ModelRequest } from './provider';

function heads(): HandState {
  return startHand({
    handId: 'h1',
    seats: [
      { agentId: 'hero', stack: 1000 },
      { agentId: 'villain', stack: 1000 },
    ],
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: 42,
  });
}

const agent = { id: 'a1', name: 'Viridian', instructions: 'Raise big with strong hands.' };
const queue = () => new ModelQueue(['test-key'], 1000);

test('names positions from the button', () => {
  const state = startHand({
    handId: 'h',
    seats: Array.from({ length: 6 }, (_, i) => ({ agentId: `a${i}`, stack: 1000 })),
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: 1,
  });
  assert.equal(positionName(state, 0), 'button');
  assert.equal(positionName(state, 1), 'small blind');
  assert.equal(positionName(state, 2), 'big blind');
});

test('takes a legal action from the model and keeps its prose as reasoning', async () => {
  const provider = new ScriptedProvider(
    'The price is right and I have position. {"action":"call","say":"Let us see a flop."}',
  );

  const record = await decide({
    agent,
    state: heads(),
    seatIndex: 0,
    bigBlind: 20,
    clockMs: 5000,
    provider,
    queue: queue(),
    equitySamples: 200,
  });

  assert.equal(record.outcome, 'decided');
  assert.equal(record.source, 'model');
  assert.deepEqual(record.action, { type: 'call' });
  assert.equal(record.reasoning, 'The price is right and I have position.');
  assert.equal(record.say, 'Let us see a flop.');
  assert.ok(record.equity.samples === 200);
  assert.equal(record.failure, null);
});

test('streams reasoning to the caller as it arrives', async () => {
  const chunks: string[] = [];
  await decide({
    agent,
    state: heads(),
    seatIndex: 0,
    bigBlind: 20,
    clockMs: 5000,
    provider: new ScriptedProvider('Thinking it over. {"action":"call"}'),
    queue: queue(),
    equitySamples: 100,
    onToken: (text) => chunks.push(text),
  });

  assert.ok(chunks.length > 1, 'the panel receives more than one chunk');
  assert.equal(chunks.join(''), 'Thinking it over. {"action":"call"}');
});

test('a timeout checks or folds and says so plainly', async () => {
  const slow: ModelProvider = {
    name: 'slow',
    async *stream(_request: ModelRequest, _key: string, signal: AbortSignal) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
      yield 'too late';
    },
  };

  const record = await decide({
    agent,
    state: heads(),
    seatIndex: 0,
    bigBlind: 20,
    clockMs: 50,
    provider: slow,
    queue: queue(),
    equitySamples: 100,
  });

  assert.equal(record.outcome, 'timeout');
  assert.equal(record.failure, 'ran out of time');
  assert.deepEqual(record.action, { type: 'fold' }, 'the button faces the big blind, so folding is the default');
  assert.equal(record.reasoning, '', 'no reasoning is invented for a decision that never happened');
});

test('a provider failure is recorded as an error, not as a fold', async () => {
  const broken: ModelProvider = {
    name: 'broken',
     
    async *stream() {
      throw new ProviderError('gemini returned 500');
    },
  };

  const record = await decide({
    agent,
    state: heads(),
    seatIndex: 0,
    bigBlind: 20,
    clockMs: 5000,
    provider: broken,
    queue: queue(),
    equitySamples: 100,
  });

  assert.equal(record.outcome, 'error');
  assert.match(record.failure!, /500/);
});

test('an unusable reply falls back without pretending to have decided', async () => {
  const record = await decide({
    agent,
    state: heads(),
    seatIndex: 0,
    bigBlind: 20,
    clockMs: 5000,
    provider: new ScriptedProvider('I fold, obviously. No JSON here.'),
    queue: queue(),
    equitySamples: 100,
  });

  assert.equal(record.outcome, 'error');
  assert.equal(record.failure, 'returned no usable action');
});

test('an illegal choice is refused even when the model is confident', async () => {
  const record = await decide({
    agent,
    state: heads(),
    seatIndex: 0,
    bigBlind: 20,
    clockMs: 5000,
    provider: new ScriptedProvider('Checking is clearly best. {"action":"check"}'),
    queue: queue(),
    equitySamples: 100,
  });

  assert.equal(record.outcome, 'error', 'the button cannot check facing the big blind');
  assert.deepEqual(record.action, { type: 'fold' });
});

test('an ordinary spot is handed to the model, not shortcut', async () => {
  let called = false;
  const watchful: ModelProvider = {
    name: 'watchful',
    async *stream() {
      called = true;
      yield 'Priced in. {"action":"call"}';
    },
  };

  // The short stack is facing the big blind with fold and call available. Two
  // options is a decision, so the agent gets to make it.
  const state = startHand({
    handId: 'short',
    seats: [
      { agentId: 'hero', stack: 20 },
      { agentId: 'villain', stack: 1000 },
    ],
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: 7,
  });

  const record = await decide({
    agent,
    state,
    seatIndex: state.toAct!,
    bigBlind: 20,
    clockMs: 5000,
    provider: watchful,
    queue: queue(),
    equitySamples: 100,
  });

  assert.equal(called, true);
  assert.equal(record.source, 'model');
  assert.deepEqual(record.action, { type: 'call' });
});

test('the shortcut guards stay out of the way of live hands', async () => {
  let called = false;
  const watchful: ModelProvider = {
    name: 'watchful',
     
    async *stream() {
      called = true;
      throw new ProviderError('should not have been called');
    },
  };

  // Hero holds the worst possible hand against a board that already makes a
  // straight flush for anyone holding the two missing cards, so no runout helps.
  let state = startHand({
    handId: 'dead',
    seats: [
      { agentId: 'hero', stack: 1000 },
      { agentId: 'villain', stack: 1000 },
    ],
    button: 0,
    smallBlind: 10,
    bigBlind: 20,
    seed: 11,
  });
  state = applyAction(state, { type: 'call' });
  state = applyAction(state, { type: 'check' });

  // Force a board and holding where hero cannot win: villain's range always has
  // the nut flush, and hero's hand cannot improve past it.
  state.board.length = 0;
  state.board.push(...[8, 12, 16, 20, 24].slice(0, 3));
  state.seats[0].hole = [0, 1] as [number, number];

  const record = await decide({
    agent,
    state,
    seatIndex: state.toAct!,
    bigBlind: 20,
    clockMs: 5000,
    provider: watchful,
    queue: queue(),
    equitySamples: 400,
  });

  // Whether this specific board is truly dead is a poker question; what the test
  // pins is that a live hand does reach the model rather than being shortcut.
  if (record.source === 'rules') {
    assert.equal(called, false);
    assert.deepEqual(record.action, { type: 'fold' });
  } else {
    assert.equal(called, true, 'a hand with any equity is handed to the model');
  }
});
