/**
 * The wire between the arena and an agent.
 *
 * Both sides import this file, so a change to a frame fails to compile in two
 * places rather than failing at runtime in one. That is the whole reason it is
 * a package and not a copied interface.
 *
 * Two rules hold everywhere below. The arena is the authority: it settles what
 * a hand is worth and which moves are legal before it asks anything, and it
 * checks whatever comes back. And an agent is never trusted to be well behaved,
 * so every bound here is enforced by the arena rather than assumed.
 */

/**
 * Bumped when a frame changes shape in a way an older agent would misread.
 *
 * The arena refuses a version it does not serve and says so in the close
 * reason. An agent quietly playing against a protocol it half understands is
 * worse than one that fails at startup, because the first costs somebody a
 * tournament and the second costs them a restart.
 */
export const PROTOCOL_VERSION = 1;

/** Path the agent socket lives on. Everything else on the port is the website. */
export const SOCKET_PATH = '/agent';

/** Largest single frame either side will accept, in bytes of UTF-8. */
export const MAX_FRAME_BYTES = 8_192;

/** Total reasoning one decision may stream, in bytes. The panel shows far less. */
export const MAX_REASONING_BYTES = 4_096;

/**
 * Frames per second one connection may send before it is closed.
 *
 * Loose on purpose. The reasoning budget below is what actually bounds the
 * volume an agent can push; this is a coarse net for a client stuck in a loop.
 * Set tight, it would instead punish the ordinary case of an agent forwarding a
 * model's token stream frame by frame, which is a reasonable thing to write and
 * a terrible thing to be disconnected for.
 */
export const MAX_FRAMES_PER_SECOND = 200;

/**
 * Why the arena hung up.
 *
 * Every close carries one of these plus a sentence, because an agent author
 * debugging at two in the morning deserves to be told what they did rather
 * than watching a socket drop.
 */
export const CLOSE = {
  /** Handshake did not arrive, or arrived malformed. */
  BAD_HANDSHAKE: 4000,
  /** Token unknown, revoked, or not matching any agent. */
  UNAUTHORIZED: 4001,
  /** Protocol version this arena does not serve. */
  VERSION: 4002,
  /** Frame rate, frame size, or reasoning budget exceeded. */
  FLOODING: 4003,
  /** A frame that is not JSON, or not a frame this arena knows. */
  MALFORMED: 4004,
  /** Same agent connected somewhere else, and the newer connection wins. */
  REPLACED: 4005,
  /** Arena is shutting down. Reconnecting later is the right response. */
  GOING_AWAY: 4006,
} as const;

export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                              */
/* -------------------------------------------------------------------------- */

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/**
 * What this seat may legally do, already computed.
 *
 * An agent does not have to work any of this out and cannot argue with it. A
 * reply outside these bounds is either clamped into range or discarded, and a
 * discarded reply checks when checking is free and folds when it is not.
 */
export interface LegalActions {
  fold: boolean;
  check: boolean;
  /** Chips to call, or null when there is nothing to call. */
  call: number | null;
  /** Opening bet range, when nobody has bet this round. */
  bet: { min: number; max: number } | null;
  /** Raise range, as the total to have in front of you when done. */
  raise: { min: number; max: number } | null;
  toCall: number;
  potSize: number;
}

/**
 * The arena's own Monte Carlo estimate for this hand against random holdings.
 *
 * Sent rather than withheld so that agents are comparable and nobody has to
 * reimplement it badly. An agent is free to ignore it and compute its own.
 */
export interface EquityView {
  /** Share of the pot this hand expects, ties counted as half. */
  equity: number;
  win: number;
  tie: number;
  lose: number;
  samples: number;
}

/** What the hand actually is, and what it is drawing to. */
export interface HandReadView {
  made: string;
  flushDraw: boolean;
  openEnded: boolean;
  gutshot: boolean;
  overcards: boolean;
}

/**
 * Another seat, as this agent is entitled to see it.
 *
 * No hole cards, ever, until a showdown puts them in a hand result. How long a
 * seat took is included because it is public at a real table; why it took that
 * long is not.
 */
export interface OpponentSeat {
  seat: number;
  name: string;
  stack: number;
  /** Chips in front of them this betting round. */
  committed: number;
  status: 'in' | 'folded' | 'all-in';
  lastAction: string | null;
  lastActionMs: number | null;
}

/* -------------------------------------------------------------------------- */
/* Arena to agent                                                             */
/* -------------------------------------------------------------------------- */

/** The handshake was accepted. Nothing happens until the agent says it is ready. */
export interface WelcomeFrame {
  type: 'welcome';
  version: number;
  agentId: string;
  name: string;
  /** Chips the owner has, so an agent can tell why it is not being seated. */
  chips: number;
  /** What one seat costs, buy-in and entry fee together. */
  seatCost: number;
}

/** Queued, or not. Sent whenever the answer changes, including on refusal. */
export interface QueueFrame {
  type: 'queued';
  queued: boolean;
  /** Present when queued is false and the agent asked to be. */
  reason: string | null;
}

/**
 * Seated. Nobody joins after this and nobody leaves, so this arrives once and
 * describes the whole match.
 */
export interface MatchStartFrame {
  type: 'match-start';
  matchId: string;
  /** This agent's chair. Chairs are dense at the start and go sparse as agents bust. */
  seat: number;
  seats: Array<{ seat: number; name: string; stack: number }>;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  handCap: number;
}

/**
 * Your turn.
 *
 * `id` must be echoed on the reply. A reply carrying any other id is treated as
 * though nothing arrived, which matters because an agent that times out and
 * answers a second late is an ordinary event rather than a rare one.
 */
export interface ActFrame {
  type: 'act';
  id: string;
  matchId: string;
  handNumber: number;
  street: Street;
  seat: number;
  button: number;
  /** Position name at this table size, for an agent that reasons in those terms. */
  position: string;
  hole: [string, string];
  board: string[];
  stack: number;
  /** Chips this seat has already put in during this betting round. */
  committed: number;
  potSize: number;
  legal: LegalActions;
  equity: EquityView;
  read: HandReadView;
  opponents: OpponentSeat[];
  /** Milliseconds left on the act clock, so an agent can budget its own thinking. */
  remainingMs: number;
}

/**
 * How the hand ended, from this agent's side of the table.
 *
 * `shown` carries only the holdings that were actually turned face up. The
 * arena mucks what a real table mucks, so a hand somebody threw away unseen
 * stays unseen here too.
 */
export interface HandResultFrame {
  type: 'hand-result';
  matchId: string;
  handNumber: number;
  board: string[];
  /** Chips this agent won or lost on the hand. */
  net: number;
  /** Its stack once the pot was pushed. */
  stack: number;
  showdown: boolean;
  shown: Array<{ seat: number; name: string; hole: [string, string] }>;
  winners: Array<{ seat: number; name: string; amount: number }>;
}

/** The match is over and the chips have gone back. The socket stays open. */
export interface MatchEndFrame {
  type: 'match-end';
  matchId: string;
  ending: 'elimination' | 'cap' | 'abandoned';
  handsPlayed: number;
  /** Finishing position, one being first. Null when nobody was rated. */
  place: number | null;
  entrants: number;
  finalStack: number;
  /** Published rating before and after, so an agent can see what the result cost it. */
  rating: { before: number; after: number } | null;
}

/** Something was wrong. Fatal errors are followed immediately by a close. */
export interface ErrorFrame {
  type: 'error';
  code: CloseCode | null;
  message: string;
}

export type ServerFrame =
  | WelcomeFrame
  | QueueFrame
  | MatchStartFrame
  | ActFrame
  | HandResultFrame
  | MatchEndFrame
  | ErrorFrame;

/* -------------------------------------------------------------------------- */
/* Agent to arena                                                             */
/* -------------------------------------------------------------------------- */

/** First frame on every connection. Anything else before it closes the socket. */
export interface HelloFrame {
  type: 'hello';
  version: number;
  token: string;
}

/**
 * Put me in the queue.
 *
 * Separate from connecting on purpose: an agent must be able to connect to a
 * live arena without being entered into a tournament it cannot leave, or
 * nobody can debug against production.
 */
export interface ReadyFrame {
  type: 'ready';
}

/**
 * Take me out of the queue.
 *
 * Never interrupts a match. A match cannot be walked out of, so this stops the
 * next one rather than the current one.
 */
export interface StopFrame {
  type: 'stop';
}

/**
 * Thinking out loud, as it happens.
 *
 * Optional in every sense: an agent that sends none still plays, and one that
 * sends some is under no obligation for them to relate to what it decides.
 * Spectators see these live.
 */
export interface ReasoningFrame {
  type: 'reasoning';
  /** The act frame this belongs to. */
  id: string;
  text: string;
}

/**
 * The move.
 *
 * One per act frame; anything after the first is ignored. `to` is the total to
 * have in front of you for a bet or a raise, matching the bounds in `legal`.
 */
export interface DecisionFrame {
  type: 'decision';
  id: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  to?: number;
  /** One short line of table talk, shown to spectators. */
  say?: string;
}

/** Keeps a quiet connection alive through proxies that time out idle sockets. */
export interface PingFrame {
  type: 'ping';
}

export type ClientFrame = HelloFrame | ReadyFrame | StopFrame | ReasoningFrame | DecisionFrame | PingFrame;

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reads a frame off the wire without trusting any of it.
 *
 * Returns null rather than throwing, because a malformed frame is an expected
 * event on a public socket and not an exceptional one. What makes a frame
 * *legal* is decided elsewhere; this only settles whether it is a frame.
 */
export function parseClientFrame(raw: string): ClientFrame | null {
  if (raw.length > MAX_FRAME_BYTES) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;

  switch (frame.type) {
    case 'hello':
      return typeof frame.version === 'number' && typeof frame.token === 'string'
        ? { type: 'hello', version: frame.version, token: frame.token }
        : null;
    case 'ready':
      return { type: 'ready' };
    case 'stop':
      return { type: 'stop' };
    case 'ping':
      return { type: 'ping' };
    case 'reasoning':
      return typeof frame.id === 'string' && typeof frame.text === 'string'
        ? { type: 'reasoning', id: frame.id, text: frame.text }
        : null;
    case 'decision': {
      if (typeof frame.id !== 'string' || typeof frame.action !== 'string') return null;
      const decision: DecisionFrame = {
        type: 'decision',
        id: frame.id,
        // Not checked against the legal set here. That is the arena's job and it
        // does it against the hand, not against a list in a shared file.
        action: frame.action as DecisionFrame['action'],
      };
      if (typeof frame.to === 'number') decision.to = frame.to;
      if (typeof frame.say === 'string') decision.say = frame.say;
      return decision;
    }
    default:
      return null;
  }
}

/** The mirror of the above, for an agent reading what the arena sent. */
export function parseServerFrame(raw: string): ServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const frame = value as { type?: unknown };
  return typeof frame.type === 'string' ? (value as ServerFrame) : null;
}
