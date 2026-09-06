import { randomUUID } from 'node:crypto';
import {
  ROOM_MODE_BY_KEY,
  validatePromptForMode,
  type DeployRequest,
  type DeployResult,
  type LobbyTableView,
  type RoomModeKey,
  type TableConfig,
  type TableFormat,
} from '@agentholdem/shared';
import type { AgentWorker } from '../llm/agentWorker.js';
import type { Store } from '../db/store.js';
import { TableRunner, type SeatedAgent } from './table.js';

export interface SettlementResult {
  txHash: string | null;
  onChain: boolean;
  error?: string;
}

export interface SettlementSink {
  settle(
    tableId: string,
    payouts: { owner: string; chips: number }[],
  ): Promise<SettlementResult>;
}

export interface RoomManagerOptions {
  worker: AgentWorker;
  store: Store;
  settlement: SettlementSink;
  actionPaceMs: number;
  handPauseMs: number;
  turnTimeoutMs: number;
  handsPerSession: number;
  /** Grace period before a half-empty table fills itself and starts. */
  startDelayMs?: number;
  /** Seats house agents so a solo manager still gets a real game. */
  houseAgentsEnabled?: boolean;
  log?: (line: string) => void;
}

interface TableBlueprint {
  mode: RoomModeKey;
  format: TableFormat;
  name: string;
  buyInChips: number;
  smallBlind: number;
  bigBlind: number;
}

/**
 * The default catalogue: every word-limit room in both formats, with buy-ins
 * that line up with the chip tiers (a $1 Starter pack seats you at a Micro
 * table; a $10 Grinder pack covers a three-table batch deploy).
 */
const BLUEPRINTS: readonly TableBlueprint[] = [
  { mode: 'micro', format: 'heads-up', name: 'Micro Duel', buyInChips: 100, smallBlind: 1, bigBlind: 2 },
  { mode: 'micro', format: 'multi', name: 'Micro Melee', buyInChips: 100, smallBlind: 1, bigBlind: 2 },
  { mode: 'tactical', format: 'heads-up', name: 'Tactical Duel', buyInChips: 250, smallBlind: 2, bigBlind: 5 },
  { mode: 'tactical', format: 'multi', name: 'Tactical Table', buyInChips: 250, smallBlind: 2, bigBlind: 5 },
  { mode: 'deep', format: 'heads-up', name: 'Deep Duel', buyInChips: 500, smallBlind: 5, bigBlind: 10 },
  { mode: 'deep', format: 'multi', name: 'Deep Strategy Arena', buyInChips: 1_000, smallBlind: 10, bigBlind: 20 },
] as const;

const HOUSE_OWNER = 'house';

/**
 * House agents keep the arena playable for a solo manager.
 *
 * Each persona carries a micro-legal brief and a longer one; the table picks
 * the longest brief that fits its word budget, so a Deep Strategy table gets
 * genuinely different opposition from a Micro-Prompt table rather than the
 * same ten words padded out.
 */
interface HousePersona {
  name: string;
  short: string;
  long: string;
}

const HOUSE_PERSONAS: readonly HousePersona[] = [
  {
    name: 'The Mathematician',
    short: 'Play pot odds strictly. Fold marginal spots.',
    long:
      'You are a pure equity calculator. Compute pot odds before every decision and call only ' +
      'when your equity exceeds the price. Value bet two-thirds pot with the best hand, check ' +
      'back marginal holdings, and fold without ego when the maths says fold. Never bluff more ' +
      'than a quarter of the time, and never chase a draw without the odds to justify it.',
  },
  {
    name: 'Aggressive Bully',
    short: 'Relentless pressure. Raise weakness, never limp.',
    long:
      'You attack relentlessly. Open-raise every pot you enter, three-bet light against passive ' +
      'opponents, and fire continuation bets on nearly every flop. Punish checks with big sizing. ' +
      'Back off only against a genuine re-raise from a player who has shown down strength. Your ' +
      'table talk is loud and dismissive.',
  },
  {
    name: 'Trap Master',
    short: 'Slow-play monsters. Check-raise turns hard.',
    long:
      'You are patient and deceptive. Flat call with sets and top two pair on wet boards, then ' +
      'check-raise the turn hard. Fold speculative hands to real aggression. Talk humbly so ' +
      'opponents read you as passive, then punish them when they over-commit. Never bluff more ' +
      'than one street.',
  },
  {
    name: 'The Rock',
    short: 'Premium hands only. Fold everything else.',
    long:
      'You play an extremely tight range: big pairs, big aces, nothing else. When you enter a ' +
      'pot you raise, and you continue only while you hold the best of it. You fold to sustained ' +
      'aggression without hesitation and you never bluff. Patience is your entire edge.',
  },
  {
    name: 'Chaos Agent',
    short: 'Bluff often. Raise unpredictably. Represent everything.',
    long:
      'You are deliberately unreadable. Mix limps, min-raises and overbets with no discernible ' +
      'pattern. Bluff at least a third of the time, semi-bluff every draw, and occasionally shove ' +
      'with air on scary boards. Trash talk constantly to keep opponents off balance.',
  },
  {
    name: 'Position Shark',
    short: 'Attack in position. Fold out of position.',
    long:
      'Position dictates everything you do. In position you raise wide, float flops and take pots ' +
      'away on the turn. Out of position you play a tight, straightforward game and give up ' +
      'cheaply. Never bloat a pot out of position without a very strong hand.',
  },
] as const;

/** Small stable hash, used to spread house personas across tables. */
function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** The longest brief that fits the room's word budget. */
function houseBriefFor(persona: HousePersona, mode: RoomModeKey): string | null {
  if (validatePromptForMode(persona.long, mode).ok) return persona.long;
  if (validatePromptForMode(persona.short, mode).ok) return persona.short;
  return null;
}

export class RoomManager {
  private readonly tables = new Map<string, TableRunner>();
  private readonly startTimers = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<(table: TableRunner) => void>();
  private tableCounter = 0;
  /** How many finished tables stay visible in the lobby for review. */
  private readonly completedRetention = 8;

  constructor(private readonly opts: RoomManagerOptions) {}

  /** Creates one open table per blueprint. */
  bootstrap(): void {
    for (const blueprint of BLUEPRINTS) this.openTable(blueprint);
  }

  onLobbyChange(listener: (table: TableRunner) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(table: TableRunner): void {
    for (const listener of this.listeners) listener(table);
  }

  /**
   * Drops finished tables once enough newer ones exist.
   *
   * Every completed session spawns a replacement, so without a retention
   * bound a long-running arena grows an unbounded lobby of dead tables.
   */
  private pruneCompleted(): void {
    const completed = this.list()
      .filter((t) => t.status === 'complete')
      .sort((a, b) => a.finishedAt - b.finishedAt);
    const excess = completed.length - this.completedRetention;
    for (let i = 0; i < excess; i++) {
      const table = completed[i];
      if (table) this.tables.delete(table.config.id);
    }
  }

  private openTable(blueprint: TableBlueprint): TableRunner {
    this.tableCounter += 1;
    const config: TableConfig = {
      id: `${blueprint.mode}-${blueprint.format}-${this.tableCounter}`,
      name: `${blueprint.name} #${this.tableCounter}`,
      mode: blueprint.mode,
      format: blueprint.format,
      maxSeats: blueprint.format === 'heads-up' ? 2 : 6,
      buyInChips: blueprint.buyInChips,
      smallBlind: blueprint.smallBlind,
      bigBlind: blueprint.bigBlind,
      handsPerSession: this.opts.handsPerSession,
    };

    const table = new TableRunner({
      config,
      worker: this.opts.worker,
      actionPaceMs: this.opts.actionPaceMs,
      handPauseMs: this.opts.handPauseMs,
      turnTimeoutMs: this.opts.turnTimeoutMs,
      log: this.opts.log,
      onTurnLog: (log) => this.opts.store.recordTurn(log),
      onHandComplete: (entry) => this.opts.store.recordHand(entry),
      onSessionComplete: (t) => this.settleTable(t, blueprint),
    });

    table.on('event', () => this.notify(table));
    this.tables.set(config.id, table);
    this.notify(table);
    return table;
  }

  /* ---------------------------------------------------------------- *
   * Lobby / lookup
   * ---------------------------------------------------------------- */

  list(): TableRunner[] {
    return [...this.tables.values()];
  }

  lobby(): LobbyTableView[] {
    return this.list()
      .filter((t) => t.status !== 'complete' || t.handNumber > 0)
      .sort((a, b) => {
        const order = { running: 0, waiting: 1, settling: 2, complete: 3 } as const;
        const byStatus = order[a.status] - order[b.status];
        return byStatus !== 0 ? byStatus : a.config.id.localeCompare(b.config.id);
      })
      .map((t) => t.lobbyView());
  }

  get(id: string): TableRunner | undefined {
    return this.tables.get(id);
  }

  /* ---------------------------------------------------------------- *
   * Batch deployment
   * ---------------------------------------------------------------- */

  /**
   * Seats one persona at up to N tables in a single call.
   *
   * Each table is validated independently — a prompt that is legal in the
   * Tactical room but three words too long for the Micro room is seated at
   * one and rejected at the other, with the reason returned rather than the
   * whole batch failing.
   */
  deploy(request: DeployRequest): DeployResult {
    const owner = request.owner.toLowerCase();
    const seated: DeployResult['seated'] = [];
    const rejected: DeployResult['rejected'] = [];

    for (const tableId of request.tableIds) {
      const table = this.tables.get(tableId);
      if (!table) {
        rejected.push({ tableId, reason: 'Table not found' });
        continue;
      }
      if (table.status !== 'waiting') {
        rejected.push({ tableId, reason: 'Table has already started' });
        continue;
      }
      if (table.seatedCount >= table.config.maxSeats) {
        rejected.push({ tableId, reason: 'Table is full' });
        continue;
      }
      if (table.hasSeatFor(owner)) {
        rejected.push({ tableId, reason: 'You already have an agent at this table' });
        continue;
      }

      const check = validatePromptForMode(request.prompt, table.config.mode);
      if (!check.ok) {
        rejected.push({ tableId, reason: check.reason });
        continue;
      }

      if (!this.opts.store.lockChips(owner, table.config.buyInChips)) {
        rejected.push({
          tableId,
          reason: `Not enough chips: this table costs ${table.config.buyInChips}`,
        });
        continue;
      }

      try {
        const agent = table.seat({
          owner,
          agentName: request.agentName,
          templateId: request.templateId ?? null,
          templateName: request.agentName,
          prompt: request.prompt,
          buyInChips: table.config.buyInChips,
        });
        seated.push({ tableId, seat: agent.seat, buyInChips: table.config.buyInChips });
        this.scheduleStart(table);
      } catch (err) {
        // Seating failed after the chips were locked; give them straight back.
        this.opts.store.releaseChips(owner, table.config.buyInChips, table.config.buyInChips);
        rejected.push({ tableId, reason: (err as Error).message });
      }
    }

    const bankroll = this.opts.store.bankroll(owner);
    return { seated, rejected, bankrollAfter: bankroll.available };
  }

  /* ---------------------------------------------------------------- *
   * Starting
   * ---------------------------------------------------------------- */

  private scheduleStart(table: TableRunner): void {
    if (table.status !== 'waiting') return;

    // A full table has nothing to wait for.
    if (table.seatedCount >= table.config.maxSeats) {
      this.clearStartTimer(table.config.id);
      this.launch(table);
      return;
    }

    if (this.startTimers.has(table.config.id)) return;
    const delay = this.opts.startDelayMs ?? 20_000;
    const timer = setTimeout(() => {
      this.startTimers.delete(table.config.id);
      this.launch(table);
    }, delay);
    timer.unref?.();
    this.startTimers.set(table.config.id, timer);
  }

  private clearStartTimer(id: string): void {
    const timer = this.startTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.startTimers.delete(id);
    }
  }

  /**
   * Starts a table, topping it up with house agents if it is short.
   *
   * Without this a manager who deploys alone at 3am watches a table sit at
   * one seat forever, which is the opposite of set-and-forget. House agents
   * are clearly attributed to `house` so nobody mistakes them for players.
   */
  private launch(table: TableRunner): void {
    if (table.status !== 'waiting') return;

    if (this.opts.houseAgentsEnabled !== false) {
      const target = table.config.format === 'heads-up' ? 2 : Math.min(4, table.config.maxSeats);
      // Rotate the starting point per table so consecutive tables do not all
      // draw the same opponents. Derived from the table id rather than a
      // counter, because every table is created before any of them launches.
      const offset = hashString(table.config.id) % HOUSE_PERSONAS.length;
      for (let i = 0; i < HOUSE_PERSONAS.length && table.seatedCount < target; i++) {
        const persona = HOUSE_PERSONAS[(offset + i) % HOUSE_PERSONAS.length];
        if (!persona) continue;
        const brief = houseBriefFor(persona, table.config.mode);
        if (!brief) continue;
        try {
          table.seat({
            owner: `${HOUSE_OWNER}-${table.config.id}-${i}`,
            agentName: `${persona.name} (house)`,
            templateId: null,
            templateName: persona.name,
            prompt: brief,
            buyInChips: table.config.buyInChips,
          });
        } catch {
          break;
        }
      }
    }

    if (table.seatedCount < 2) {
      this.opts.log?.(`[rooms] ${table.config.id} still short of players; waiting.`);
      this.scheduleStart(table);
      return;
    }

    table.start();
    this.notify(table);
  }

  /** Test/simulation hook: start a table immediately, house agents included. */
  forceStart(tableId: string): void {
    const table = this.tables.get(tableId);
    if (!table) throw new Error(`No table ${tableId}`);
    this.clearStartTimer(tableId);
    this.launch(table);
  }

  /* ---------------------------------------------------------------- *
   * Settlement
   * ---------------------------------------------------------------- */

  private async settleTable(table: TableRunner, blueprint: TableBlueprint): Promise<void> {
    const humanSeats = table.seats.filter((s) => !s.owner.startsWith(HOUSE_OWNER));

    // Off-chain ledger first: every manager gets their locked stake released
    // and their final stack credited, whatever the chain does next.
    for (const seat of humanSeats) {
      this.opts.store.releaseChips(seat.owner, seat.buyInChips, seat.stack);
    }

    let result: SettlementResult = { txHash: null, onChain: false };
    if (humanSeats.length > 0) {
      result = await this.opts.settlement.settle(
        table.config.id,
        humanSeats.map((s) => ({ owner: s.owner, chips: s.stack })),
      );
    }
    table.setSettlementTx(result.txHash);

    this.opts.store.recordSettlement({
      tableId: table.config.id,
      settledAt: Date.now(),
      standings: table.seats.map((s: SeatedAgent) => ({
        seat: s.seat,
        agentName: s.agentName,
        owner: s.owner,
        chips: s.stack,
        buyIn: s.buyInChips,
      })),
      txHash: result.txHash,
      onChain: result.onChain,
      ...(result.error ? { error: result.error } : {}),
    });

    // Keep the lobby stocked: a finished table is replaced by a fresh one.
    this.openTable(blueprint);
    this.pruneCompleted();
    this.notify(table);
  }

  shutdown(): void {
    for (const timer of this.startTimers.values()) clearTimeout(timer);
    this.startTimers.clear();
    for (const table of this.tables.values()) table.stop();
  }

  /** Convenience used by the REST layer when creating ad-hoc templates. */
  static newId(): string {
    return randomUUID();
  }

  static wordLimitFor(mode: RoomModeKey): number {
    return ROOM_MODE_BY_KEY[mode].wordLimit;
  }
}
