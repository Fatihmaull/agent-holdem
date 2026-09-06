import { EventEmitter } from 'node:events';
import {
  ROOM_MODE_BY_KEY,
  type AgentTurnLog,
  type CardCode,
  type FeedEvent,
  type HandHistoryEntry,
  type LobbyTableView,
  type PlayerAction,
  type SeatView,
  type TableConfig,
  type TableStatus,
  type TableView,
} from '@agentholdem/shared';
import { newSeed } from '../engine/cards.js';
import { HandEngine, type HandSeatConfig } from '../engine/hand.js';
import type { AgentWorker } from '../llm/agentWorker.js';
import { contextFromEngine } from '../llm/promptBuilder.js';

export interface SeatedAgent {
  seat: number;
  owner: string;
  agentName: string;
  templateId: string | null;
  templateName: string;
  prompt: string;
  /** Chips locked from the manager's bankroll to sit down. */
  buyInChips: number;
  stack: number;
  sittingOut: boolean;
}

export interface TableRunnerOptions {
  config: TableConfig;
  worker: AgentWorker;
  actionPaceMs: number;
  handPauseMs: number;
  turnTimeoutMs: number;
  onTurnLog?: (log: AgentTurnLog) => void;
  onHandComplete?: (entry: HandHistoryEntry) => void;
  onSessionComplete?: (table: TableRunner) => void | Promise<void>;
  log?: (line: string) => void;
}

const FEED_LIMIT = 300;

/**
 * One poker table, running itself.
 *
 * `start()` kicks off a loop that deals hands, asks each seated agent for a
 * decision, applies it, and pays out — with no dependency on anyone being
 * connected. That is the whole point of set-and-forget: the manager closes the
 * tab and the table keeps playing. Spectator sockets are pure observers,
 * attaching to an `EventEmitter` that the loop feeds as it goes.
 */
export class TableRunner extends EventEmitter {
  readonly config: TableConfig;
  readonly seats: SeatedAgent[] = [];

  status: TableStatus = 'waiting';
  handNumber = 0;
  /** Epoch ms when the session settled; 0 while the table is still live. */
  finishedAt = 0;
  engine: HandEngine | null = null;
  buttonSeat = 0;

  private buttonIndex = 0;
  private running = false;
  private stopRequested = false;
  private feed: FeedEvent[] = [];
  private actionDeadline: number | null = null;
  private revealed = new Set<number>();
  private handActionLog: string[] = [];
  private chatLog: string[] = [];
  private lastChat = new Map<number, string>();
  private revealedSeed: string | null = null;
  private deckCommitment: string | null = null;
  private settlementTx: string | null = null;

  constructor(private readonly opts: TableRunnerOptions) {
    super();
    this.config = opts.config;
    this.setMaxListeners(0);
  }

  /* ---------------------------------------------------------------- *
   * Seating
   * ---------------------------------------------------------------- */

  get seatedCount(): number {
    return this.seats.length;
  }

  hasSeatFor(owner: string): boolean {
    return this.seats.some((s) => s.owner.toLowerCase() === owner.toLowerCase());
  }

  /**
   * Seats an agent. One wallet gets one seat per table — otherwise a manager
   * could quietly play both sides of a heads-up pot against itself.
   */
  seat(agent: Omit<SeatedAgent, 'seat' | 'stack' | 'sittingOut'>): SeatedAgent {
    if (this.status !== 'waiting') {
      throw new Error('Table has already started');
    }
    if (this.seats.length >= this.config.maxSeats) {
      throw new Error('Table is full');
    }
    if (this.hasSeatFor(agent.owner)) {
      throw new Error('This wallet already has an agent at the table');
    }

    const seated: SeatedAgent = {
      ...agent,
      seat: this.seats.length,
      stack: agent.buyInChips,
      sittingOut: false,
    };
    this.seats.push(seated);

    this.publish({
      kind: 'seat-join',
      seat: seated.seat,
      agentName: seated.agentName,
      owner: seated.owner,
      stack: seated.stack,
      at: Date.now(),
    });
    return seated;
  }

  /* ---------------------------------------------------------------- *
   * Views
   * ---------------------------------------------------------------- */

  view(): TableView {
    const engine = this.engine;
    const mode = ROOM_MODE_BY_KEY[this.config.mode];

    const seats: SeatView[] = this.seats.map((s) => {
      const p = engine?.players.find((x) => x.seat === s.seat);
      return {
        seat: s.seat,
        owner: s.owner,
        agentName: s.agentName,
        templateName: s.templateName,
        stack: p ? p.stack : s.stack,
        committed: p?.committed ?? 0,
        invested: p?.invested ?? 0,
        folded: p?.folded ?? false,
        allIn: p?.allIn ?? false,
        sittingOut: s.sittingOut,
        holeCards: p && this.revealed.has(s.seat) ? [...p.holeCards] : null,
        lastAction: p?.lastAction ?? null,
        lastChat: this.lastChat.get(s.seat) ?? null,
      };
    });

    const actingSeat =
      engine && !engine.complete ? (engine.currentActor()?.player.seat ?? null) : null;

    return {
      id: this.config.id,
      name: this.config.name,
      mode: this.config.mode,
      wordLimit: mode.wordLimit,
      format: this.config.format,
      status: this.status,
      buyInChips: this.config.buyInChips,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      handNumber: this.handNumber,
      handsPerSession: this.config.handsPerSession,
      street: engine?.street ?? 'preflop',
      board: engine ? [...engine.board] : [],
      pots: engine ? engine.buildPots() : [],
      totalPot: engine?.totalPot ?? 0,
      seats,
      buttonSeat: this.buttonSeat,
      actingSeat,
      actionDeadline: this.actionDeadline,
      currentBet: engine?.currentBet ?? 0,
      minRaiseTo: engine && actingSeat !== null
        ? engine.legalActions(engine.currentActor()!.index).minRaiseTo
        : 0,
      deckCommitment: this.deckCommitment,
      revealedSeed: this.revealedSeed,
      updatedAt: Date.now(),
    };
  }

  lobbyView(): LobbyTableView {
    return {
      id: this.config.id,
      name: this.config.name,
      mode: this.config.mode,
      wordLimit: ROOM_MODE_BY_KEY[this.config.mode].wordLimit,
      format: this.config.format,
      status: this.status,
      buyInChips: this.config.buyInChips,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      seatsTaken: this.seats.length,
      maxSeats: this.config.maxSeats,
      handNumber: this.handNumber,
      handsPerSession: this.config.handsPerSession,
      agents: this.seats.map((s) => ({
        agentName: s.agentName,
        owner: s.owner,
        stack: s.stack,
      })),
    };
  }

  recentFeed(limit = 80): FeedEvent[] {
    return this.feed.slice(-limit);
  }

  /* ---------------------------------------------------------------- *
   * Autonomous loop
   * ---------------------------------------------------------------- */

  /** Fire-and-forget: the table plays out in the background. */
  start(): void {
    if (this.running) return;
    if (this.seats.length < 2) {
      throw new Error('A table needs at least two agents before it can start');
    }
    this.running = true;
    this.status = 'running';
    this.publish({
      kind: 'system',
      text: `${this.config.name} is live — ${this.seats.length} agents, ${this.config.handsPerSession} hands.`,
      at: Date.now(),
    });
    void this.loop();
  }

  stop(): void {
    this.stopRequested = true;
  }

  private async loop(): Promise<void> {
    try {
      while (
        !this.stopRequested &&
        this.handNumber < this.config.handsPerSession &&
        this.liveSeats().length >= 2
      ) {
        await this.playHand();
        if (this.stopRequested) break;
        await this.sleep(this.opts.handPauseMs);
      }
    } catch (err) {
      this.opts.log?.(`[table ${this.config.id}] loop error: ${(err as Error).message}`);
      this.publish({
        kind: 'system',
        text: `Table halted: ${(err as Error).message}`,
        at: Date.now(),
      });
    } finally {
      this.running = false;
      await this.completeSession();
    }
  }

  private liveSeats(): SeatedAgent[] {
    return this.seats.filter((s) => s.stack > 0 && !s.sittingOut);
  }

  private async playHand(): Promise<void> {
    const contenders = this.liveSeats();
    if (contenders.length < 2) return;

    this.handNumber += 1;
    this.revealed.clear();
    this.handActionLog = [];
    this.revealedSeed = null;
    this.lastChat.clear();

    const handSeats: HandSeatConfig[] = contenders.map((s) => ({
      seat: s.seat,
      agentName: s.agentName,
      owner: s.owner,
      stack: s.stack,
    }));

    // Keep the button moving around the seats that still have chips.
    this.buttonIndex = this.buttonIndex % handSeats.length;
    this.buttonSeat = handSeats[this.buttonIndex]?.seat ?? 0;

    const seed = newSeed();
    const startedAt = Date.now();
    const engine = new HandEngine({
      seats: handSeats,
      buttonIndex: this.buttonIndex,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      seed,
      handNumber: this.handNumber,
    });
    this.engine = engine;
    this.deckCommitment = engine.commitment;

    const handEvents: FeedEvent[] = [];
    const drain = () => {
      for (const event of engine.takeEvents()) {
        if (event.kind === 'showdown') {
          for (const reveal of event.reveals) this.revealed.add(reveal.seat);
        }
        handEvents.push(event);
        this.publish(event);
      }
    };
    drain();

    let guard = 0;
    while (!engine.complete && !this.stopRequested) {
      if (guard++ > 400) throw new Error('Hand exceeded the action limit');

      const actor = engine.currentActor();
      if (!actor) break;

      const agent = this.seats.find((s) => s.seat === actor.player.seat);
      if (!agent) throw new Error(`Seat ${actor.player.seat} has no agent`);

      this.actionDeadline = Date.now() + this.opts.turnTimeoutMs;
      this.emit('tick', this.view());

      const ctx = contextFromEngine(engine, actor.index, {
        tableName: this.config.name,
        mode: this.config.mode,
        bigBlind: this.config.bigBlind,
        actionLog: [...this.handActionLog],
        chatLog: this.chatLog.slice(-6),
        timeoutSeconds: Math.round(this.opts.turnTimeoutMs / 1000),
      });

      const turn = await this.opts.worker.takeTurn(
        ctx,
        agent.prompt,
        `${seed}:${this.handNumber}:${actor.player.seat}:${engine.street}:${guard}`,
      );
      this.actionDeadline = null;

      if (turn.decision.inner_thought) {
        this.publish({
          kind: 'thought',
          seat: agent.seat,
          agentName: agent.agentName,
          text: turn.decision.inner_thought,
          at: Date.now(),
        });
      }

      const requested: PlayerAction = {
        type: turn.decision.action,
        amount: turn.decision.amount,
      };
      const applied = engine.applyAction(requested, {
        source: turn.source,
        latencyMs: turn.latencyMs,
      });

      this.handActionLog.push(
        `${agent.agentName} (seat ${agent.seat}) ${describeAction(applied)} on the ${ctx.street}`,
      );

      this.opts.onTurnLog?.({
        tableId: this.config.id,
        handNumber: this.handNumber,
        seat: agent.seat,
        agentName: agent.agentName,
        street: ctx.street,
        decision: turn.decision,
        source: turn.source,
        latencyMs: turn.latencyMs,
        at: Date.now(),
      });

      drain();

      if (turn.decision.table_chat) {
        this.lastChat.set(agent.seat, turn.decision.table_chat);
        this.chatLog.push(`${agent.agentName}: ${turn.decision.table_chat}`);
        if (this.chatLog.length > 40) this.chatLog.shift();
        this.publish({
          kind: 'chat',
          seat: agent.seat,
          agentName: agent.agentName,
          text: turn.decision.table_chat,
          at: Date.now(),
        });
      }

      await this.sleep(this.opts.actionPaceMs);
    }

    drain();

    if (!engine.complete) return; // stopped mid-hand

    const result = engine.result();
    this.revealedSeed = result.seed;

    for (const seatResult of result.seats) {
      const agent = this.seats.find((s) => s.seat === seatResult.seat);
      if (agent) agent.stack = seatResult.stackAfter;
    }

    for (const agent of this.seats) {
      if (agent.stack <= 0 && !agent.sittingOut) {
        agent.sittingOut = true;
        this.publish({
          kind: 'seat-bust',
          seat: agent.seat,
          agentName: agent.agentName,
          at: Date.now(),
        });
      }
    }

    this.opts.onHandComplete?.({
      tableId: this.config.id,
      handNumber: this.handNumber,
      startedAt,
      endedAt: Date.now(),
      board: result.board as CardCode[],
      seed: result.seed,
      commitment: result.commitment,
      events: handEvents,
      results: result.seats.map((s) => ({
        seat: s.seat,
        agentName: s.agentName,
        net: s.net,
      })),
    });

    // Advance the button to the next seat that still has chips.
    const survivors = this.liveSeats();
    if (survivors.length >= 2) {
      const currentSeat = this.buttonSeat;
      const order = survivors.map((s) => s.seat).sort((a, b) => a - b);
      const nextSeat = order.find((s) => s > currentSeat) ?? order[0] ?? 0;
      this.buttonIndex = order.indexOf(nextSeat);
      this.buttonSeat = nextSeat;
    }
  }

  private async completeSession(): Promise<void> {
    if (this.status === 'complete') return;
    this.status = 'settling';
    this.engine = null;
    this.actionDeadline = null;
    this.emit('tick', this.view());

    try {
      await this.opts.onSessionComplete?.(this);
    } catch (err) {
      this.opts.log?.(
        `[table ${this.config.id}] settlement failed: ${(err as Error).message}`,
      );
    }

    this.status = 'complete';
    this.finishedAt = Date.now();
    this.publish({
      kind: 'session-complete',
      standings: [...this.seats]
        .sort((a, b) => b.stack - a.stack)
        .map((s) => ({
          seat: s.seat,
          agentName: s.agentName,
          owner: s.owner,
          chips: s.stack,
        })),
      settlementTx: this.settlementTx,
      at: Date.now(),
    });
  }

  setSettlementTx(tx: string | null): void {
    this.settlementTx = tx;
  }

  /* ---------------------------------------------------------------- *
   * Plumbing
   * ---------------------------------------------------------------- */

  private publish(event: FeedEvent): void {
    this.feed.push(event);
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
    this.emit('event', event, this.view());
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

export function describeAction(action: PlayerAction): string {
  switch (action.type) {
    case 'fold':
      return 'folds';
    case 'check':
      return 'checks';
    case 'call':
      return `calls ${action.amount}`;
    case 'raise':
      return `raises to ${action.amount}`;
    case 'all-in':
      return `moves all-in for ${action.amount}`;
  }
}
