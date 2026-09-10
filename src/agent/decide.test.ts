import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActFrame, DecisionFrame } from '@agentholdem/protocol';
import { applyAction, startHand, type HandState } from '../poker/engine';
import { decide, positionName, type Askable } from './decide';

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

/**
 * A scripted agent, standing in for somebody else's program.
 *
 * Every way a real one can misbehave is reachable from here: answering late,
 * answering with a move that is not on offer, streaming reasoning and then
 * saying nothing, or simply not being there. All of them have to arrive at a
 * legal action, because the arena cannot stall a table waiting for good
 * manners.
 */
class FakeAgent implements Askable {
  seen: ActFrame[] = [];

  constructor(
    private readonly reply: (frame: ActFrame) => Promise<DecisionFrame | null> | DecisionFrame | null,
    private readonly reasoning: string[] = [],
  ) {}

  async ask(
    frame: ActFrame,
    onReasoning: (text: string) => void,
    signal: AbortSignal,
  ): Promise<DecisionFrame | null> {
    this.seen.push(frame);
    for (const chunk of this.reasoning) onReasoning(chunk);

    const answer = await Promise.race([
      Promise.resolve(this.reply(frame)),
      new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true })),
    ]);
    return answer;
  }
}

function move(action: DecisionFrame['action'], extra: Partial<DecisionFrame> = {}) {
  return (frame: ActFrame): DecisionFrame => ({ type: 'decision', id: frame.id, action, ...extra });
}

const base = {
  seatIndex: 0,
  bigBlind: 20,
  matchId: 'm1',
  handNumber: 1,
  chairs: [0, 1],
  equitySamples: 200,
};

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

test('takes a legal action and keeps the streamed reasoning', async () => {
  const link = new FakeAgent(move('call', { say: 'Let us see a flop.' }), ['The price is right ', 'and I have position.']);

  const record = await decide({ ...base, link: () => link, state: heads(), clockMs: 5000 });

  assert.equal(record.outcome, 'decided');
  assert.equal(record.source, 'agent');
  assert.deepEqual(record.action, { type: 'call' });
  assert.equal(record.reasoning, 'The price is right and I have position.');
  assert.equal(record.say, 'Let us see a flop.');
  assert.equal(record.equity.samples, 200);
});

test('the request carries what the agent is entitled to and nothing else', async () => {
  const link = new FakeAgent(move('call'));
  await decide({ ...base, link: () => link, state: heads(), clockMs: 5000 });

  const [frame] = link.seen;
  assert.equal(frame.hole.length, 2, 'its own cards');
  assert.equal(frame.opponents.length, 1);
  assert.ok(!JSON.stringify(frame.opponents).includes('hole'), 'never anybody else’s cards');
  assert.ok(frame.equity.samples > 0, 'the arena computed the equity, not the agent');
  assert.ok(frame.legal.fold || frame.legal.check, 'and settled what is legal before asking');
  assert.equal(frame.remainingMs, 5000);
});

test('seat numbers on the wire are chairs, not engine positions', async () => {
  // The engine renumbers players densely every hand as agents bust out. An
  // agent needs a number that means the same thing all match, or its own notes
  // about seat three stop being about anybody.
  const link = new FakeAgent(move('call'));
  await decide({ ...base, link: () => link, state: heads(), chairs: [4, 7], clockMs: 5000 });

  const [frame] = link.seen;
  assert.equal(frame.seat, 4, 'hero sits in chair four');
  assert.equal(frame.opponents[0].seat, 7);
});

test('an agent that is not connected checks or folds, and is not recorded as folding', async () => {
  const record = await decide({ ...base, link: () => null, state: heads(), clockMs: 5000 });

  assert.deepEqual(record.action, { type: 'fold' }, 'facing a blind, folding is the free move');
  assert.equal(record.outcome, 'error', 'not "decided": nobody decided anything');
  assert.equal(record.failure, 'not connected');
});

test('an agent that runs out the clock is recorded as a timeout', async () => {
  const link = new FakeAgent(() => new Promise<DecisionFrame>(() => {}), ['thinking…']);

  const record = await decide({ ...base, link: () => link, state: heads(), clockMs: 40 });

  assert.equal(record.outcome, 'timeout');
  assert.equal(record.failure, 'ran out of time');
  assert.equal(record.reasoning, 'thinking…', 'whatever it managed to say is kept');
  assert.deepEqual(record.action, { type: 'fold' });
});

test('an illegal move is refused and named, rather than played', async () => {
  const link = new FakeAgent(move('check'));

  // Facing the big blind, checking is not on offer.
  const record = await decide({ ...base, link: () => link, state: heads(), clockMs: 5000 });

  assert.equal(record.outcome, 'error');
  assert.match(record.failure ?? '', /check/);
  assert.deepEqual(record.action, { type: 'fold' });
});

test('a raise outside the legal range is clamped rather than discarded', async () => {
  const link = new FakeAgent(move('raise', { to: 999_999 }));

  const record = await decide({ ...base, link: () => link, state: heads(), clockMs: 5000 });

  assert.equal(record.action.type, 'raise');
  assert.ok(record.action.to! <= 1000, `raised to ${record.action.to}, which is more than it has`);
});

test('facing an all-in, the agent is still asked, because folding is a real choice', async () => {
  const link = new FakeAgent(move('fold'));

  let state = heads();
  state = applyAction(state, { type: 'raise', to: 1000 });
  const record = await decide({ ...base, link: () => link, state, seatIndex: 1, clockMs: 5000 });

  assert.equal(record.source, 'agent');
  assert.deepEqual(record.action, { type: 'fold' });
  assert.equal(link.seen.length, 1);
  assert.ok(link.seen[0].legal.call !== null, 'calling is on offer, capped at what it has');
});

test('an agent answering after the clock cannot affect the next hand', async () => {
  // The correlation id is what makes this safe. Two hands running through the
  // same connection produce different ids, so a late answer to the first is not
  // a valid answer to the second.
  const first = new FakeAgent(move('call'));
  const second = new FakeAgent(move('call'));

  await decide({ ...base, link: () => first, state: heads(), clockMs: 5000 });
  await decide({ ...base, link: () => second, handNumber: 2, state: heads(), clockMs: 5000 });

  assert.notEqual(first.seen[0].id, second.seen[0].id);
});

test('a socket that drops mid-decision is asked again on the one that comes back', async () => {
  // The case: an agent on flaky wifi loses its connection between being asked
  // and answering. Reconnecting should cost it a moment, not a hand.
  const revived = new FakeAgent(move('call'));
  // Returns nothing and then hands the seat a working connection, which is what
  // a reconnect looks like from the arena's side.
  const dead = new FakeAgent(() => {
    current = revived;
    return null;
  });
  let current: Askable | null = dead;

  const record = await decide({
    ...base,
    link: () => current,
    state: heads(),
    clockMs: 5000,
  });

  assert.deepEqual(record.action, { type: 'call' });
  assert.equal(record.outcome, 'decided');
  assert.equal(dead.seen.length, 1, 'the dead socket was asked once');
  assert.equal(revived.seen.length, 1, 'and the new one answered');
});
