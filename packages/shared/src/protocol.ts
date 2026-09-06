import type { AgentDecision, DecisionSource } from './agent.js';
import type { CardCode, HandRank, PlayerAction, Street } from './poker.js';
import type { RoomModeKey, TableFormat } from './rooms.js';

/* ------------------------------------------------------------------ *
 * Public (spectator-safe) views
 * ------------------------------------------------------------------ */

export type TableStatus = 'waiting' | 'running' | 'settling' | 'complete';

export interface SeatView {
  seat: number;
  /** Wallet that deployed this agent. */
  owner: string;
  agentName: string;
  templateName: string;
  /** Chips in front of the seat. */
  stack: number;
  /** Chips committed on the current street. */
  committed: number;
  /** Chips committed across the whole hand. */
  invested: number;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  /**
   * Hole cards are withheld until showdown — an agent that could read its
   * opponent's cards off the spectator feed would not be playing poker.
   */
  holeCards: readonly CardCode[] | null;
  lastAction: PlayerAction | null;
  lastChat: string | null;
}

export interface PotView {
  amount: number;
  /** Seats still eligible to win this pot. */
  eligible: readonly number[];
}

export interface TableView {
  id: string;
  name: string;
  mode: RoomModeKey;
  wordLimit: number;
  format: TableFormat;
  status: TableStatus;
  buyInChips: number;
  smallBlind: number;
  bigBlind: number;
  handNumber: number;
  handsPerSession: number;
  street: Street;
  board: readonly CardCode[];
  pots: readonly PotView[];
  totalPot: number;
  seats: readonly SeatView[];
  buttonSeat: number;
  actingSeat: number | null;
  /** Epoch ms after which the acting seat is auto check/folded. */
  actionDeadline: number | null;
  /** Amount a caller must match on the current street. */
  currentBet: number;
  minRaiseTo: number;
  /** SHA-256 of the shuffle seed, published before the hand is dealt. */
  deckCommitment: string | null;
  /** Revealed after the hand so anyone can verify the shuffle. */
  revealedSeed: string | null;
  updatedAt: number;
}

export interface LobbyTableView {
  id: string;
  name: string;
  mode: RoomModeKey;
  wordLimit: number;
  format: TableFormat;
  status: TableStatus;
  buyInChips: number;
  smallBlind: number;
  bigBlind: number;
  seatsTaken: number;
  maxSeats: number;
  handNumber: number;
  handsPerSession: number;
  agents: readonly { agentName: string; owner: string; stack: number }[];
}

/* ------------------------------------------------------------------ *
 * Feed events — the spectator arena's live narrative
 * ------------------------------------------------------------------ */

export type FeedEvent =
  | { kind: 'hand-start'; handNumber: number; button: number; commitment: string; at: number }
  | { kind: 'blinds'; postings: readonly { seat: number; amount: number; label: 'sb' | 'bb' }[]; at: number }
  | { kind: 'deal'; street: Street; board: readonly CardCode[]; at: number }
  | {
      kind: 'action';
      seat: number;
      agentName: string;
      action: PlayerAction;
      street: Street;
      potAfter: number;
      source: DecisionSource;
      latencyMs: number;
      at: number;
    }
  | { kind: 'thought'; seat: number; agentName: string; text: string; at: number }
  | { kind: 'chat'; seat: number; agentName: string; text: string; at: number }
  | {
      kind: 'showdown';
      reveals: readonly { seat: number; cards: readonly CardCode[]; rank: HandRank | null }[];
      at: number;
    }
  | {
      kind: 'payout';
      awards: readonly { seat: number; agentName: string; amount: number; potIndex: number }[];
      seed: string;
      at: number;
    }
  | { kind: 'seat-join'; seat: number; agentName: string; owner: string; stack: number; at: number }
  | { kind: 'seat-bust'; seat: number; agentName: string; at: number }
  | {
      kind: 'session-complete';
      standings: readonly { seat: number; agentName: string; owner: string; chips: number }[];
      settlementTx: string | null;
      at: number;
    }
  | { kind: 'system'; text: string; at: number };

/* ------------------------------------------------------------------ *
 * WebSocket wire protocol
 * ------------------------------------------------------------------ */

export type ClientMessage =
  | { t: 'subscribe'; tableId: string }
  | { t: 'unsubscribe'; tableId: string }
  | { t: 'watch-lobby' }
  | { t: 'unwatch-lobby' }
  | { t: 'ping'; ts: number };

export type ServerMessage =
  | { t: 'hello'; serverTime: number; version: string; llm: LlmStatus }
  | { t: 'lobby'; tables: readonly LobbyTableView[] }
  | { t: 'table'; view: TableView; feed: readonly FeedEvent[] }
  | { t: 'table-event'; tableId: string; view: TableView; event: FeedEvent }
  | { t: 'pong'; ts: number }
  | { t: 'error'; message: string };

export interface LlmStatus {
  provider: 'groq' | 'gemini' | 'heuristic';
  model: string;
  /** False when no API key is configured; the arena then runs on the
   *  deterministic policy engine so a demo still works offline. */
  live: boolean;
  turnTimeoutMs: number;
}

/* ------------------------------------------------------------------ *
 * REST DTOs
 * ------------------------------------------------------------------ */

export interface DeployRequest {
  owner: string;
  templateId?: string;
  agentName: string;
  prompt: string;
  /** One deploy call can seat the same persona at several tables at once. */
  tableIds: string[];
}

export interface DeployResult {
  seated: { tableId: string; seat: number; buyInChips: number }[];
  rejected: { tableId: string; reason: string }[];
  bankrollAfter: number;
}

export interface BankrollView {
  owner: string;
  /** Off-chain mirror of `userChipBalance` plus locked table stakes. */
  available: number;
  locked: number;
  onChain: string | null;
  updatedAt: number;
}

export interface HandHistoryEntry {
  tableId: string;
  handNumber: number;
  startedAt: number;
  endedAt: number;
  board: readonly CardCode[];
  seed: string;
  commitment: string;
  events: readonly FeedEvent[];
  results: readonly { seat: number; agentName: string; net: number }[];
}

export interface AgentTurnLog {
  tableId: string;
  handNumber: number;
  seat: number;
  agentName: string;
  street: Street;
  decision: AgentDecision;
  source: DecisionSource;
  latencyMs: number;
  at: number;
}
