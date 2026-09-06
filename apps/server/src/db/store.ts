import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentTurnLog,
  BankrollView,
  HandHistoryEntry,
  PromptTemplate,
} from '@agentholdem/shared';

export interface TableSettlement {
  tableId: string;
  settledAt: number;
  standings: { seat: number; agentName: string; owner: string; chips: number; buyIn: number }[];
  txHash: string | null;
  onChain: boolean;
  error?: string;
}

interface Snapshot {
  templates: PromptTemplate[];
  bankrolls: Record<string, { available: number; locked: number; updatedAt: number }>;
  histories: HandHistoryEntry[];
  turnLogs: AgentTurnLog[];
  settlements: TableSettlement[];
}

const EMPTY: Snapshot = {
  templates: [],
  bankrolls: {},
  histories: [],
  turnLogs: [],
  settlements: [],
};

/**
 * A small durable store.
 *
 * Everything the arena needs to survive a restart is a few thousand rows, so
 * this is an in-memory snapshot flushed atomically to JSON rather than a
 * database dependency a reviewer has to install before the demo runs. Writes
 * go to a temp file and are renamed into place, so a crash mid-flush leaves
 * the previous good snapshot intact.
 */
export class Store {
  private data: Snapshot = structuredClone(EMPTY);
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly file: string;

  /** Rolling caps: this is a hackathon arena, not an archive. */
  private readonly maxHistories = 500;
  private readonly maxTurnLogs = 5_000;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'agentholdem.json');
    mkdirSync(dir, { recursive: true });
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Snapshot>;
      this.data = { ...structuredClone(EMPTY), ...parsed };
    } catch {
      this.data = structuredClone(EMPTY);
    }
  }

  /** Debounced so a busy table does not rewrite the file on every action. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 500);
    this.flushTimer.unref?.();
  }

  flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /* ----------------------------- templates ----------------------------- */

  listTemplates(owner?: string): PromptTemplate[] {
    const all = this.data.templates;
    return owner ? all.filter((t) => sameAddress(t.ownerAddress, owner)) : [...all];
  }

  getTemplate(id: string): PromptTemplate | undefined {
    return this.data.templates.find((t) => t.id === id);
  }

  upsertTemplate(template: PromptTemplate): PromptTemplate {
    const index = this.data.templates.findIndex((t) => t.id === template.id);
    if (index >= 0) this.data.templates[index] = template;
    else this.data.templates.push(template);
    this.scheduleFlush();
    return template;
  }

  deleteTemplate(id: string, owner: string): boolean {
    const index = this.data.templates.findIndex(
      (t) => t.id === id && sameAddress(t.ownerAddress, owner),
    );
    if (index < 0) return false;
    this.data.templates.splice(index, 1);
    this.scheduleFlush();
    return true;
  }

  /* ----------------------------- bankrolls ----------------------------- */

  bankroll(owner: string): BankrollView {
    const key = owner.toLowerCase();
    const row = this.data.bankrolls[key] ?? { available: 0, locked: 0, updatedAt: Date.now() };
    return { owner: key, available: row.available, locked: row.locked, onChain: null, updatedAt: row.updatedAt };
  }

  /**
   * Mirrors the on-chain balance into the off-chain ledger.
   *
   * The contract stays authoritative; this cache is what lets the lobby show a
   * balance without an RPC round trip per render, and what lets a table run
   * when the chain is not configured at all.
   */
  setBankroll(owner: string, available: number, locked?: number): BankrollView {
    const key = owner.toLowerCase();
    const previous = this.data.bankrolls[key];
    this.data.bankrolls[key] = {
      available: Math.max(0, Math.floor(available)),
      locked: Math.max(0, Math.floor(locked ?? previous?.locked ?? 0)),
      updatedAt: Date.now(),
    };
    this.scheduleFlush();
    return this.bankroll(key);
  }

  /** Moves chips from available to locked. Returns false if underfunded. */
  lockChips(owner: string, chips: number): boolean {
    const key = owner.toLowerCase();
    const row = this.data.bankrolls[key];
    if (!row || row.available < chips) return false;
    row.available -= chips;
    row.locked += chips;
    row.updatedAt = Date.now();
    this.scheduleFlush();
    return true;
  }

  /** Releases a locked stake and credits whatever the agent came back with. */
  releaseChips(owner: string, staked: number, returned: number): void {
    const key = owner.toLowerCase();
    const row = this.data.bankrolls[key] ?? { available: 0, locked: 0, updatedAt: Date.now() };
    row.locked = Math.max(0, row.locked - staked);
    row.available += Math.max(0, Math.floor(returned));
    row.updatedAt = Date.now();
    this.data.bankrolls[key] = row;
    this.scheduleFlush();
  }

  /* ------------------------------ history ------------------------------ */

  recordHand(entry: HandHistoryEntry): void {
    this.data.histories.push(entry);
    if (this.data.histories.length > this.maxHistories) {
      this.data.histories.splice(0, this.data.histories.length - this.maxHistories);
    }
    this.scheduleFlush();
  }

  handHistory(tableId?: string, limit = 50): HandHistoryEntry[] {
    const rows = tableId
      ? this.data.histories.filter((h) => h.tableId === tableId)
      : this.data.histories;
    return rows.slice(-limit).reverse();
  }

  recordTurn(log: AgentTurnLog): void {
    this.data.turnLogs.push(log);
    if (this.data.turnLogs.length > this.maxTurnLogs) {
      this.data.turnLogs.splice(0, this.data.turnLogs.length - this.maxTurnLogs);
    }
    this.scheduleFlush();
  }

  turnLogs(tableId?: string, limit = 200): AgentTurnLog[] {
    const rows = tableId
      ? this.data.turnLogs.filter((t) => t.tableId === tableId)
      : this.data.turnLogs;
    return rows.slice(-limit).reverse();
  }

  recordSettlement(settlement: TableSettlement): void {
    this.data.settlements.push(settlement);
    this.scheduleFlush();
  }

  settlements(limit = 50): TableSettlement[] {
    return this.data.settlements.slice(-limit).reverse();
  }
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
