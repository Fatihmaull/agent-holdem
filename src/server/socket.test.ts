import { test } from 'node:test';
import assert from 'node:assert/strict';
// Must come before anything that reaches the database module. Nothing here runs
// a query, but that module refuses to load without a connection string.
import '../dev/test-env';
import type { WebSocket } from 'ws';
import { CLOSE, MAX_FRAMES_PER_SECOND, MAX_REASONING_BYTES, type ActFrame } from '@agentholdem/protocol';
import { SocketLink } from './socket';

/**
 * A socket that records rather than transmits.
 *
 * The paths worth testing here are the ones a well-behaved agent never reaches:
 * a reply to a hand that has moved on, a flood, an agent that streams forever.
 * None of them can be produced on demand from a real agent, and all of them are
 * what will actually happen once the arena is public.
 */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  private handlers = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, handler: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closedWith ??= { code, reason };
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  ping(): void {}

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) (handler as (...a: unknown[]) => void)(...args);
  }

  /** What an agent would put on the wire. */
  receive(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function linked(): { ws: FakeSocket; link: SocketLink } {
  const ws = new FakeSocket();
  return { ws, link: new SocketLink(ws as unknown as WebSocket, 'agent-1', 'owner-1') };
}

const ACT: ActFrame = {
  type: 'act',
  id: 'match:1:0:4',
  matchId: 'match',
  handNumber: 1,
  street: 'flop',
  seat: 0,
  button: 1,
  position: 'button',
  hole: ['As', 'Kd'],
  board: ['2c', '7h', 'Ts'],
  stack: 1800,
  committed: 0,
  potSize: 120,
  legal: { fold: true, check: false, call: 60, bet: null, raise: { min: 180, max: 1800 }, toCall: 60, potSize: 120 },
  equity: { equity: 0.42, win: 420, tie: 0, lose: 580, samples: 1000 },
  read: { made: 'ace high', flushDraw: false, openEnded: false, gutshot: false, overcards: true },
  opponents: [],
  remainingMs: 30_000,
};

test('connecting is not the same as asking for a game', () => {
  const { ws, link } = linked();

  assert.equal(link.ready, false, 'an agent debugging against a live arena is not entered into a tournament');

  ws.receive({ type: 'ready' });
  assert.equal(link.ready, true);

  ws.receive({ type: 'stop' });
  assert.equal(link.ready, false);
});

test('a decision for the hand in flight is the one that counts', async () => {
  const { ws, link } = linked();

  const answer = link.ask(ACT, () => {}, new AbortController().signal);
  ws.receive({ type: 'decision', id: ACT.id, action: 'call' });

  assert.deepEqual(await answer, { type: 'decision', id: ACT.id, action: 'call' });
});

test('a decision carrying the wrong id is ignored, not applied', async () => {
  // The case this exists for: an agent times out on hand four, the arena moves
  // on, and its answer lands during hand five. Without the correlation check it
  // would be a legal-looking move made from a position that no longer exists.
  const { ws, link } = linked();
  const clock = new AbortController();

  const answer = link.ask(ACT, () => {}, clock.signal);
  ws.receive({ type: 'decision', id: 'some:other:hand', action: 'raise', to: 1800 });

  clock.abort();
  assert.equal(await answer, null, 'the stale answer settled nothing');
});

test('reasoning reaches the panel only while its own hand is live', async () => {
  const { ws, link } = linked();
  const seen: string[] = [];
  const clock = new AbortController();

  const answer = link.ask(ACT, (text) => seen.push(text), clock.signal);
  ws.receive({ type: 'reasoning', id: ACT.id, text: 'Pot odds are fine. ' });
  ws.receive({ type: 'reasoning', id: 'stale', text: 'Last hand’s thinking.' });
  ws.receive({ type: 'decision', id: ACT.id, action: 'call' });

  await answer;
  assert.deepEqual(seen, ['Pot odds are fine. ']);
  clock.abort();
});

test('an agent that streams forever loses the connection, not the arena', async () => {
  const { ws, link } = linked();
  const clock = new AbortController();

  const answer = link.ask(ACT, () => {}, clock.signal);
  for (let i = 0; i < 20; i++) {
    ws.receive({ type: 'reasoning', id: ACT.id, text: 'x'.repeat(512) });
  }

  assert.equal(ws.closedWith?.code, CLOSE.FLOODING);
  assert.match(ws.closedWith!.reason, new RegExp(String(MAX_REASONING_BYTES)));
  assert.equal(await answer, null, 'the hand settles as nothing rather than stalling');
});

test('a frame flood is closed with a reason rather than dropped silently', () => {
  const { ws } = linked();

  for (let i = 0; i < MAX_FRAMES_PER_SECOND + 5; i++) ws.receive({ type: 'ping' });

  assert.equal(ws.closedWith?.code, CLOSE.FLOODING);
  // An agent author at two in the morning deserves to be told what they did.
  assert.match(ws.closedWith!.reason, /a second/);
});

test('a frame that is not a frame closes the connection', () => {
  const { ws } = linked();

  ws.emit('message', Buffer.from('not json at all'));

  assert.equal(ws.closedWith?.code, CLOSE.MALFORMED);
});

test('a socket that vanishes mid-hand settles the hand rather than hanging it', async () => {
  const { ws, link } = linked();

  const answer = link.ask(ACT, () => {}, new AbortController().signal);
  ws.close(1006, 'connection lost');

  assert.equal(await answer, null);
  assert.equal(link.ready, false, 'and it stops being queued for the next match');
});

test('asking again abandons whatever the last question was waiting for', async () => {
  const { link } = linked();
  const clock = new AbortController();

  const first = link.ask(ACT, () => {}, clock.signal);
  const second = link.ask({ ...ACT, id: 'match:1:0:9' }, () => {}, clock.signal);

  assert.equal(await first, null, 'or a slow agent leaks one promise per decision, forever');
  clock.abort();
  assert.equal(await second, null);
});
