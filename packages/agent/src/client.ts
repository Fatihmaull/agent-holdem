import WebSocket from 'ws';
import {
  CLOSE,
  MAX_REASONING_BYTES,
  PROTOCOL_VERSION,
  parseServerFrame,
  type ActFrame,
  type ClientFrame,
  type ServerFrame,
} from '@pokertunity/protocol';
import type { Brain } from './brain';

/**
 * A reference agent.
 *
 * It does what any agent has to do and nothing more: connect, say hello, ask to
 * be queued, answer act frames before the clock runs out, and reconnect when
 * the socket drops. Everything about how it plays lives behind `Brain`, so this
 * file is the protocol and nothing else.
 *
 * Read it as documentation. An agent in another language that does these six
 * things is a first-class entrant with no special support needed from us.
 */

export interface AgentOptions {
  url: string;
  token: string;
  brain: Brain;
  /** Whether to ask for a game on connect, or sit connected and idle. */
  autoReady?: boolean;
  log?: (line: string) => void;
}

/** How long to wait before reconnecting, doubling to a ceiling. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** How often buffered reasoning is put on the wire. Eight frames a second reads as live. */
const REASONING_FLUSH_MS = 120;

export class Agent {
  private ws: WebSocket | null = null;
  private retryMs = RETRY_MIN_MS;
  private stopped = false;
  private name = 'agent';

  constructor(private readonly options: AgentOptions) {}

  private log(line: string): void {
    (this.options.log ?? console.log)(`[${this.name}] ${line}`);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close(1000, 'shutting down');
    this.ws = null;
  }

  private connect(): void {
    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    ws.on('open', () => {
      this.send({ type: 'hello', version: PROTOCOL_VERSION, token: this.options.token });
    });

    ws.on('message', (data) => {
      const frame = parseServerFrame(data.toString());
      if (frame) void this.receive(frame);
    });

    ws.on('close', (code, reason) => {
      this.ws = null;
      const why = reason.toString() || `code ${code}`;

      // A version mismatch or a bad token is not going to fix itself, so
      // hammering the arena would only add noise to somebody else's logs. Every
      // other close is worth retrying, because most of them are the network.
      if (code === CLOSE.VERSION || code === CLOSE.UNAUTHORIZED) {
        this.log(`refused: ${why}`);
        this.stopped = true;
        return;
      }

      if (this.stopped) return;
      this.log(`disconnected (${why}); retrying in ${Math.round(this.retryMs / 1000)}s`);
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    });

    ws.on('error', (error) => {
      // The close handler does the reconnecting. Logging here and then again on
      // close would double every network blip in the output.
      if (this.ws === null) return;
      this.log(`socket error: ${error.message}`);
    });
  }

  private send(frame: ClientFrame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private async receive(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case 'welcome':
        this.name = frame.name;
        this.retryMs = RETRY_MIN_MS;
        this.log(`connected with ${frame.chips} chips; a seat costs ${frame.seatCost}`);
        if (this.options.autoReady !== false) this.send({ type: 'ready' });
        return;

      case 'queued':
        this.log(frame.queued ? 'queued for a match' : `not queued: ${frame.reason ?? 'unknown'}`);
        return;

      case 'match-start':
        this.log(`seated in ${frame.matchId} at seat ${frame.seat} with ${frame.seats.length} agents`);
        return;

      case 'act':
        await this.act(frame);
        return;

      case 'hand-result':
        if (frame.net !== 0) {
          this.log(`hand ${frame.handNumber}: ${frame.net > 0 ? '+' : ''}${frame.net}, stack ${frame.stack}`);
        }
        return;

      case 'match-end': {
        const rating = frame.rating ? `, rating ${frame.rating.after.toFixed(1)}` : '';
        this.log(`match over: ${frame.place ?? '?'} of ${frame.entrants}, ${frame.finalStack} chips${rating}`);
        // Back into the queue. Sitting out after every match would mean an
        // agent plays once and then quietly stops, which looks like a bug.
        if (this.options.autoReady !== false) this.send({ type: 'ready' });
        return;
      }

      case 'error':
        this.log(`arena says: ${frame.message}`);
        return;
    }
  }

  /**
   * Answers one act frame.
   *
   * The clock is the arena's, and it is shorter than the arena's by a margin,
   * because an answer that arrives as the clock expires is an answer that
   * arrives too late. Anything that goes wrong is swallowed: the arena's own
   * fallback checks when checking is free and folds when it is not, which is a
   * better outcome than a crashed agent losing every remaining hand.
   */
  private async act(frame: ActFrame): Promise<void> {
    const clock = new AbortController();
    const budget = Math.max(1_000, frame.remainingMs - 2_000);
    const timer = setTimeout(() => clock.abort(), budget);

    let sent = 0;
    let buffered = '';
    let flushTimer: NodeJS.Timeout | null = null;

    // Coalesced rather than sent per chunk. A model streams tokens far faster
    // than anyone can read them, and forwarding each one as its own frame turns
    // a working agent into a flood. Batching costs the panel nothing: it is
    // still well under what reads as live.
    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!buffered) return;

      const text = buffered;
      buffered = '';
      // Kept under the arena's cap here rather than discovering it there, since
      // breaching it costs the connection and not just the hand.
      if (sent + Buffer.byteLength(text) > MAX_REASONING_BYTES) return;
      sent += Buffer.byteLength(text);
      this.send({ type: 'reasoning', id: frame.id, text });
    };

    const emit = (text: string) => {
      buffered += text;
      flushTimer ??= setTimeout(flush, REASONING_FLUSH_MS);
    };

    try {
      const decision = await this.options.brain.decide(frame, emit, clock.signal);
      flush();
      this.send({ type: 'decision', id: frame.id, ...decision });
    } catch (error) {
      this.log(`could not decide on hand ${frame.handNumber}: ${describe(error)}`);
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
