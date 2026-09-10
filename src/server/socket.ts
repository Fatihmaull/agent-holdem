import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CLOSE,
  MAX_FRAMES_PER_SECOND,
  MAX_FRAME_BYTES,
  MAX_REASONING_BYTES,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  parseClientFrame,
  type ActFrame,
  type CloseCode,
  type DecisionFrame,
  type ServerFrame,
} from '@agentholdem/protocol';
import { SEAT_COST } from '../lib/economy';
import { agentByToken, markClosed, markSeen } from './credentials';
import { attach, connectionsFor, detach, linkFor, type AgentLink } from './presence';
import { balanceOf } from './store';

/**
 * The agent socket.
 *
 * Agents dial in; the arena never dials out. That is not a stylistic choice.
 * An arena that fetched owner-supplied URLs would be making requests from
 * inside its own network on behalf of strangers, which is a server-side request
 * forgery surface that has to be defended rather than avoided. It also means an
 * agent needs no public address, no certificate and no deployment: a laptop
 * behind a router can play.
 *
 * The second thing it buys is presence. A match cannot be walked out of, so
 * seating an agent that is not actually there would strand a whole table. Here,
 * being there is the same fact as having a socket open.
 */

/** How long the handshake may take before the connection is dropped. */
const HANDSHAKE_MS = 10_000;

/** Sockets one account may hold at once. */
const MAX_CONNECTIONS_PER_ACCOUNT = 5;

/** How often the arena pings a quiet socket, to survive idle proxy timeouts. */
const HEARTBEAT_MS = 25_000;

const globalForSocket = globalThis as unknown as { __agentholdemWss?: WebSocketServer };

/**
 * Routes upgrade requests, handing anything that is not an agent to Next.
 *
 * Next runs its own WebSocket for hot reload in development on the same port,
 * so stealing every upgrade would break the dev server in a way that looks like
 * the bundler failing rather than like this file.
 */
export function attachAgentSocket(server: HttpServer, nextUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void {
  const wss = globalForSocket.__agentholdemWss ?? new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  globalForSocket.__agentholdemWss = wss;

  server.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0];
    if (path !== SOCKET_PATH) {
      nextUpgrade(request, socket, head);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      void greet(ws);
    });
  });
}

/**
 * Waits for the handshake, then either seats the connection on the floor or
 * says why not and hangs up.
 *
 * Every refusal carries a code and a sentence. An agent author debugging at two
 * in the morning should be told what they did, and a silent drop is the one
 * outcome that teaches them nothing.
 */
async function greet(ws: WebSocket): Promise<void> {
  const opened = Date.now();

  /**
   * Frames that arrive while the token is being looked up.
   *
   * Authenticating takes a database round trip, and a client that pipelines its
   * first frames does not wait for it. Without somewhere to put them, anything
   * sent in that window lands with no listener attached and is dropped by the
   * socket library: an agent that sends hello and ready together would be
   * welcomed, never queued, and never told why.
   */
  const backlog: string[] = [];
  const collect = (data: unknown) => backlog.push(String(data));

  const hello = await new Promise<{ version: number; token: string } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), HANDSHAKE_MS);

    ws.once('message', (data) => {
      clearTimeout(timer);
      ws.on('message', collect);
      const frame = parseClientFrame(data.toString());
      resolve(frame?.type === 'hello' ? { version: frame.version, token: frame.token } : null);
    });

    ws.once('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });


  if (!hello) {
    reject(ws, CLOSE.BAD_HANDSHAKE, 'Send a hello frame with a version and a token first.');
    return;
  }

  if (hello.version !== PROTOCOL_VERSION) {
    reject(
      ws,
      CLOSE.VERSION,
      `This arena speaks protocol ${PROTOCOL_VERSION} and you asked for ${hello.version}.`,
    );
    return;
  }

  const agent = await agentByToken(hello.token).catch(() => null);
  if (!agent) {
    reject(ws, CLOSE.UNAUTHORIZED, 'That token does not match an agent. Rotate it on your account page.');
    return;
  }

  if (connectionsFor(agent.userId) >= MAX_CONNECTIONS_PER_ACCOUNT) {
    reject(ws, CLOSE.FLOODING, `One account may hold ${MAX_CONNECTIONS_PER_ACCOUNT} connections at once.`);
    return;
  }

  // Detached only now, immediately before the link attaches its own handler.
  // Doing it any earlier reopens the window it exists to close: the token
  // lookup above is a database round trip, and a frame arriving in that gap
  // with no listener is dropped by the socket library and never seen again.
  ws.off('message', collect);
  const link = new SocketLink(ws, agent.agentId, agent.userId);

  // The newer connection wins. An older one is nearly always a socket the far
  // end has already forgotten, and an agent that really did open two would
  // otherwise be stuck behind a timeout it cannot see.
  const replaced = attach(link);
  replaced?.close(CLOSE.REPLACED, 'This agent connected again from somewhere else.');

  await markSeen(agent.agentId).catch(() => {});

  link.send({
    type: 'welcome',
    version: PROTOCOL_VERSION,
    agentId: agent.agentId,
    name: agent.name,
    chips: await balanceOf(agent.userId).catch(() => 0),
    seatCost: SEAT_COST,
  });

  link.replay(backlog);

  console.log(`[socket] ${agent.name} connected in ${Date.now() - opened}ms`);
}

/**
 * Says why, then hangs up.
 *
 * The close waits for the error frame to actually go out. Calling both in the
 * same tick races on a socket that has just finished its upgrade, and the loser
 * is the explanation: the client sees a bare abnormal closure with no code and
 * no reason, which is precisely the outcome this function exists to avoid.
 */
function reject(ws: WebSocket, code: CloseCode, message: string): void {
  const goodbye = () => ws.close(code, message.slice(0, 120));

  try {
    ws.send(JSON.stringify({ type: 'error', code, message } satisfies ServerFrame), () => goodbye());
  } catch {
    // The socket is already gone, which is the same outcome we were arranging.
    goodbye();
  }
}

/** What the dealer is waiting for while a seat thinks. */
interface Pending {
  id: string;
  onReasoning: (text: string) => void;
  settle: (decision: DecisionFrame | null) => void;
  reasoningBytes: number;
}

export class SocketLink implements AgentLink {
  ready = false;

  private pending: Pending | null = null;
  private framesThisSecond = 0;
  private secondStartedAt = Date.now();
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    readonly agentId: string,
    readonly ownerId: string,
  ) {
    ws.on('message', (data) => this.receive(data.toString()));
    ws.on('close', (code, reason) => this.ended(code, reason.toString()));
    ws.on('error', () => this.ended(CLOSE.MALFORMED, 'The connection errored.'));

    // Unreferenced, so a quiet connection cannot keep the process alive on its
    // own. A shutdown should be decided by the server, not held open by a timer
    // whose only job is to stop a proxy getting bored.
    this.heartbeat = setInterval(() => {
      if (this.ws.readyState === this.ws.OPEN) this.ws.ping();
    }, HEARTBEAT_MS).unref();
  }

  /**
   * Handles frames that arrived during the handshake, in the order they came.
   *
   * Called after the welcome is on the wire, so a client that pipelined its
   * first frames still sees the handshake acknowledged before anything that
   * answers what it sent.
   */
  replay(backlog: readonly string[]): void {
    for (const raw of backlog) this.receive(raw);
  }

  send(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      // A send that fails is a socket that is going away, and the close handler
      // is already on its way to clean up after it.
    }
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason.slice(0, 120));
  }

  ask(frame: ActFrame, onReasoning: (text: string) => void, signal: AbortSignal): Promise<DecisionFrame | null> {
    // Anything still outstanding belongs to a hand that has moved on. Settling
    // it as nothing rather than leaving it hanging is what stops a slow agent
    // leaking a promise per decision for the life of the connection.
    this.pending?.settle(null);

    if (this.ws.readyState !== this.ws.OPEN) return Promise.resolve(null);

    return new Promise<DecisionFrame | null>((resolve) => {
      let done = false;
      const settle = (decision: DecisionFrame | null) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', abort);
        if (this.pending?.id === frame.id) this.pending = null;
        resolve(decision);
      };
      const abort = () => settle(null);

      this.pending = { id: frame.id, onReasoning, settle, reasoningBytes: 0 };
      signal.addEventListener('abort', abort, { once: true });
      this.send(frame);
    });
  }

  private receive(raw: string): void {
    if (this.flooding(raw)) return;

    const frame = parseClientFrame(raw);
    if (!frame) {
      this.fail(CLOSE.MALFORMED, 'That was not a frame this arena understands.');
      return;
    }

    switch (frame.type) {
      case 'hello':
        // Already handshaken. A second hello is a confused client rather than a
        // hostile one, so it costs nothing to ignore.
        return;

      case 'ping':
        return;

      case 'ready':
        this.ready = true;
        this.send({ type: 'queued', queued: true, reason: null });
        return;

      case 'stop':
        this.ready = false;
        // Never interrupts a match. A match cannot be walked out of, so this
        // stops the next one rather than the one being played.
        this.send({ type: 'queued', queued: false, reason: 'You asked to stop.' });
        return;

      case 'reasoning': {
        const pending = this.pending;
        // A reasoning frame for a hand that has moved on is dropped rather than
        // shown, because putting last hand's thinking on this hand's panel is
        // worse than showing nothing.
        if (!pending || pending.id !== frame.id) return;

        pending.reasoningBytes += Buffer.byteLength(frame.text);
        if (pending.reasoningBytes > MAX_REASONING_BYTES) {
          this.fail(CLOSE.FLOODING, `Reasoning is capped at ${MAX_REASONING_BYTES} bytes per decision.`);
          return;
        }

        pending.onReasoning(frame.text);
        return;
      }

      case 'decision': {
        const pending = this.pending;
        // The correlation id is what stops a late answer to hand four being
        // applied to hand five, which is an ordinary event rather than a rare
        // one once an act clock is involved.
        if (!pending || pending.id !== frame.id) return;
        pending.settle(frame);
        return;
      }
    }
  }

  /** True when the connection has been closed for abusing its allowance. */
  private flooding(raw: string): boolean {
    const now = Date.now();
    if (now - this.secondStartedAt >= 1000) {
      this.secondStartedAt = now;
      this.framesThisSecond = 0;
    }

    this.framesThisSecond += 1;
    if (this.framesThisSecond > MAX_FRAMES_PER_SECOND) {
      this.fail(CLOSE.FLOODING, `Frames are capped at ${MAX_FRAMES_PER_SECOND} a second.`);
      return true;
    }

    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
      this.fail(CLOSE.FLOODING, `Frames are capped at ${MAX_FRAME_BYTES} bytes.`);
      return true;
    }

    return false;
  }

  private fail(code: CloseCode, message: string): void {
    this.send({ type: 'error', code, message });
    this.close(code, message);
  }

  private ended(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;

    // Asked before detaching, because detaching is what makes the answer no.
    // A connection that was already replaced must not write its own goodbye
    // over the newer one, or an owner reads "disconnected" about an agent that
    // is sitting at a table right now.
    const wasCurrent = linkFor(this.agentId) === this;

    clearInterval(this.heartbeat);
    this.ready = false;

    // A hand waiting on this seat gets nothing, which the dealer already knows
    // how to handle: it checks if checking is free and folds if it is not.
    this.pending?.settle(null);
    this.pending = null;

    detach(this);

    if (wasCurrent) {
      void markClosed(this.agentId, reason || `Connection closed (${code}).`).catch(() => {});
    }
  }
}
