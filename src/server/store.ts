import { and, desc, eq, isNotNull, max, sql as raw } from 'drizzle-orm';
import { db } from '../db/client';
import { agents, decisions, hands, ledgerEntries, seats, users } from '../db/schema';
import type { HandEvent, HandState } from '../poker/engine';
import type { DecisionRecord } from '../agent/decide';

export interface SeatedAgent {
  seatIndex: number;
  agentId: string;
  name: string;
  color: string;
  instructions: string;
  stack: number;
}

export async function loadSeats(tableId: string): Promise<SeatedAgent[]> {
  const rows = await db
    .select({
      seatIndex: seats.seatIndex,
      agentId: agents.id,
      name: agents.name,
      color: agents.color,
      instructions: agents.instructions,
      stack: seats.stack,
    })
    .from(seats)
    .innerJoin(agents, eq(agents.id, seats.agentId))
    .where(eq(seats.tableId, tableId))
    .orderBy(seats.seatIndex);

  return rows;
}

export async function saveStacks(tableId: string, stacks: Array<{ seatIndex: number; stack: number }>): Promise<void> {
  if (stacks.length === 0) return;
  await db.transaction(async (tx) => {
    for (const { seatIndex, stack } of stacks) {
      await tx
        .update(seats)
        .set({ stack })
        .where(and(eq(seats.tableId, tableId), eq(seats.seatIndex, seatIndex)));
    }
  });
}

/**
 * Frees a seat and returns the agent's remaining stack to its owner's balance.
 * Called when an agent busts or leaves, so chips never vanish into a dead seat.
 */
export async function leaveSeat(tableId: string, seatIndex: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ agentId: seats.agentId, stack: seats.stack, userId: agents.userId })
      .from(seats)
      .innerJoin(agents, eq(agents.id, seats.agentId))
      .where(and(eq(seats.tableId, tableId), eq(seats.seatIndex, seatIndex)))
      .limit(1);

    if (!row) return;

    await tx.delete(seats).where(and(eq(seats.tableId, tableId), eq(seats.seatIndex, seatIndex)));

    if (row.stack > 0) {
      const [updated] = await tx
        .update(users)
        .set({ chips: raw`${users.chips} + ${row.stack}` })
        .where(eq(users.id, row.userId))
        .returning({ chips: users.chips });

      await tx.insert(ledgerEntries).values({
        userId: row.userId,
        delta: row.stack,
        balanceAfter: updated.chips,
        reason: 'table-cash-out',
        reference: `${tableId}:${seatIndex}`,
      });
    }
  });
}

/**
 * Highest hand number this table has already stored. Numbering continues from
 * here after a restart; starting again from one collides with what is on disk
 * and every hand afterwards fails to save.
 */
export async function lastHandNumber(tableId: string): Promise<number> {
  const [row] = await db
    .select({ highest: max(hands.handNumber) })
    .from(hands)
    .where(eq(hands.tableId, tableId));
  return row?.highest ?? 0;
}

export interface PersistedHand {
  tableId: string;
  handNumber: number;
  seed: number;
  state: HandState;
  lineup: Array<{ seatIndex: number; agentId: string; name: string; startingStack: number }>;
  startedAt: Date;
  decisions: Array<{ seatIndex: number; agentId: string; record: DecisionRecord; street: string }>;
}

/** Stores a finished hand whole, so it can be replayed exactly from its seed. */
export async function saveHand(hand: PersistedHand): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(hands)
      .values({
        tableId: hand.tableId,
        handNumber: hand.handNumber,
        seed: hand.seed,
        button: hand.state.button,
        lineup: hand.lineup,
        board: hand.state.board,
        pots: hand.state.pots,
        events: hand.state.events satisfies HandEvent[],
        startedAt: hand.startedAt,
        endedAt: new Date(),
      })
      .returning({ id: hands.id });

    if (hand.decisions.length > 0) {
      await tx.insert(decisions).values(
        hand.decisions.map((entry) => ({
          handId: row.id,
          agentId: entry.agentId,
          seatIndex: entry.seatIndex,
          street: entry.street,
          equity: entry.record.equity.equity,
          handRead: entry.record.read,
          reasoning: entry.record.reasoning,
          say: entry.record.say,
          action: entry.record.action.type,
          // `to` is only set for a bet or a raise. A call's size comes from the
          // hand's own action event, so it is read back from there rather than
          // stored as nothing.
          amount: entry.record.action.to ?? calledAmount(hand.state, entry.seatIndex, entry.record.action.type),
          elapsedMs: entry.record.elapsedMs,
          outcome: entry.record.outcome,
        })),
      );
    }

    return row.id;
  });
}

/** What a seat actually put in for a given action, taken from the hand's events. */
function calledAmount(state: HandState, seatIndex: number, action: string): number {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const event = state.events[i];
    if (event.type === 'action' && event.seat === seatIndex && event.action === action) return event.amount;
  }
  return 0;
}

export interface HandOutcome {
  agentId: string;
  won: boolean;
  net: number;
  potSize: number;
}

export async function recordResults(outcomes: HandOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;
  await db.transaction(async (tx) => {
    for (const outcome of outcomes) {
      await tx
        .update(agents)
        .set({
          handsPlayed: raw`${agents.handsPlayed} + 1`,
          handsWon: raw`${agents.handsWon} + ${outcome.won ? 1 : 0}`,
          chipsWon: raw`${agents.chipsWon} + ${outcome.net}`,
          biggestPot: raw`GREATEST(${agents.biggestPot}, ${outcome.won ? outcome.potSize : 0})`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, outcome.agentId));
    }
  });
}

/** The most recently completed hand anywhere, for the landing page replay. */
export async function latestHand(): Promise<{
  id: string;
  tableId: string;
  handNumber: number;
  lineup: unknown;
  events: unknown;
  board: unknown;
} | null> {
  const [row] = await db
    .select({
      id: hands.id,
      tableId: hands.tableId,
      handNumber: hands.handNumber,
      lineup: hands.lineup,
      events: hands.events,
      board: hands.board,
    })
    .from(hands)
    .where(isNotNull(hands.endedAt))
    .orderBy(desc(hands.endedAt))
    .limit(1);

  return row ?? null;
}

export async function decisionsForHand(handId: string) {
  return db.select().from(decisions).where(eq(decisions.handId, handId)).orderBy(decisions.id);
}
