import { and, desc, eq, isNotNull, sql as raw } from 'drizzle-orm';
import { db } from '../db/client';
import { agents, depositIntents, ledgerEntries, promptTemplates, redemptions, seats, users } from '../db/schema';
import { TABLES, chipsToWei, packageById, quoteRedemption, tableById } from '../lib/economy';
import { assignColor } from '../agent/colors';
import { checkInstructions } from '../lib/instructions';
import { PayoutUncertain, REQUIRED_CONFIRMATIONS, headBlock, observeDeposit, payOut, vaultAddress } from './chain';
import { creditDeposit } from './deposits';
import { logger } from './log';
import { intentToBytes32 } from '../lib/intent';
import type { Session } from './auth';
import { tableRuntime } from './registry';
import { leaveSeat } from './store';

export class ActionError extends Error {}

/**
 * The transaction handle drizzle hands a `db.transaction` callback. Named here
 * so helpers can be shared between a standalone action and a step inside a
 * batch without either of them reaching for the pool directly.
 */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface AccountAgent {
  id: string;
  name: string;
  color: string;
  instructions: string;
  handsPlayed: number;
  handsWon: number;
  chipsWon: number;
  biggestPot: number;
  /** Where this agent is sitting, if it is. At most one table each. */
  seat: { tableId: string; seatIndex: number; stack: number } | null;
}

export interface Account {
  address: string;
  chips: number;
  /**
   * Oldest first, so the list an owner sees does not reshuffle when one of
   * them wins a pot.
   */
  agents: AccountAgent[];
}

export async function account(session: Session): Promise<Account> {
  const [user] = await db
    .select({ address: users.address, chips: users.chips })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) throw new ActionError('That account no longer exists.');

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      color: agents.color,
      instructions: agents.instructions,
      handsPlayed: agents.handsPlayed,
      handsWon: agents.handsWon,
      chipsWon: agents.chipsWon,
      biggestPot: agents.biggestPot,
      seatTableId: seats.tableId,
      seatIndex: seats.seatIndex,
      seatStack: seats.stack,
    })
    .from(agents)
    .leftJoin(seats, eq(seats.agentId, agents.id))
    .where(eq(agents.userId, session.userId))
    .orderBy(agents.createdAt);

  return {
    address: user.address,
    chips: user.chips,
    agents: rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      instructions: row.instructions,
      handsPlayed: row.handsPlayed,
      handsWon: row.handsWon,
      chipsWon: row.chipsWon,
      biggestPot: row.biggestPot,
      seat:
        row.seatTableId !== null && row.seatIndex !== null && row.seatStack !== null
          ? { tableId: row.seatTableId, seatIndex: row.seatIndex, stack: row.seatStack }
          : null,
    })),
  };
}

const MAX_NAME = 24;
const MAX_INSTRUCTIONS = 2000;

/**
 * One account may own several agents, capped at the number of tables, since a
 * seventh could never be seated anywhere anyway.
 */
const MAX_AGENTS = TABLES.length;

/** Resolves one of the caller's agents, refusing anything they do not own. */
async function ownedAgent(tx: Transaction, session: Session, agentId: string) {
  const [agent] = await tx
    .select({ id: agents.id, instructions: agents.instructions })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, session.userId)))
    .limit(1);
  if (!agent) throw new ActionError('That agent is not yours.');
  return agent;
}

export async function createAgent(
  session: Session,
  input: { name: string; instructions?: string },
): Promise<{ id: string }> {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  if (name.length < 2) throw new ActionError('Give your agent a name of at least two characters.');

  return db.transaction(async (tx) => {
    const mine = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.userId, session.userId));
    if (mine.length >= MAX_AGENTS) {
      throw new ActionError(`You can keep ${MAX_AGENTS} agents, one for each table. Retire one first.`);
    }

    const taken = await tx.select({ color: agents.color }).from(agents);
    const [created] = await tx
      .insert(agents)
      .values({
        userId: session.userId,
        name,
        color: assignColor(taken.map((row) => row.color)).id,
        instructions: (input.instructions ?? '').slice(0, MAX_INSTRUCTIONS),
      })
      .returning({ id: agents.id });
    if (!created) throw new ActionError('Could not create that agent.');
    return { id: created.id };
  });
}

/**
 * Saving is gated by the word budget, but only of the table this agent is
 * actually sitting at. Otherwise the budget would mean nothing: an owner could
 * take a seat at a ten-word table and immediately rewrite the field to a
 * hundred words, and the seat would keep playing under the longer text.
 */
export async function saveAgent(
  session: Session,
  agentId: string,
  input: { name: string; instructions: string },
): Promise<void> {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  if (name.length < 2) throw new ActionError('Give your agent a name of at least two characters.');

  const instructions = input.instructions.slice(0, MAX_INSTRUCTIONS);

  await db.transaction(async (tx) => {
    const agent = await ownedAgent(tx, session, agentId);

    const [seat] = await tx
      .select({ tableId: seats.tableId })
      .from(seats)
      .where(eq(seats.agentId, agent.id))
      .limit(1);

    if (seat) {
      const table = tableById(seat.tableId);
      const check = table ? checkInstructions(instructions, table.wordLimit) : null;
      if (check && !check.ok) {
        throw new ActionError(`${check.reason} Take this agent off that table to write more.`);
      }
    }

    await tx
      .update(agents)
      .set({ name, instructions, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
  });
}

/** Retires an agent. Refuses while it is seated, so no stack is orphaned. */
export async function deleteAgent(session: Session, agentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const agent = await ownedAgent(tx, session, agentId);

    const [seat] = await tx.select({ id: seats.id }).from(seats).where(eq(seats.agentId, agent.id)).limit(1);
    if (seat) throw new ActionError('Take this agent off its table before retiring it.');

    const mine = await tx.select({ id: agents.id }).from(agents).where(eq(agents.userId, session.userId));
    if (mine.length <= 1) throw new ActionError('An account keeps at least one agent.');

    await tx.delete(agents).where(eq(agents.id, agent.id));
  });
}

/**
 * Saved instruction drafts.
 *
 * A drawer, not a second agent: saving one changes nothing about how the agent
 * is playing right now. The point is that a ten-word table and a hundred-word
 * table want different writing, and moving between them should not mean
 * rewriting from memory.
 */
const MAX_TEMPLATES = 20;
const MAX_TEMPLATE_NAME = 40;

export interface SavedTemplate {
  id: string;
  name: string;
  body: string;
  updatedAt: string;
}

export async function listTemplates(session: Session): Promise<SavedTemplate[]> {
  const rows = await db
    .select({
      id: promptTemplates.id,
      name: promptTemplates.name,
      body: promptTemplates.body,
      updatedAt: promptTemplates.updatedAt,
    })
    .from(promptTemplates)
    .where(eq(promptTemplates.userId, session.userId))
    .orderBy(desc(promptTemplates.updatedAt));

  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

export async function saveTemplate(
  session: Session,
  input: { id?: string; name: string; body: string },
): Promise<SavedTemplate> {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, MAX_TEMPLATE_NAME);
  if (name.length < 1) throw new ActionError('Give the draft a name so you can find it again.');
  const body = input.body.slice(0, MAX_INSTRUCTIONS);

  return db.transaction(async (tx) => {
    if (input.id) {
      const [updated] = await tx
        .update(promptTemplates)
        .set({ name, body, updatedAt: new Date() })
        .where(and(eq(promptTemplates.id, input.id), eq(promptTemplates.userId, session.userId)))
        .returning();
      if (!updated) throw new ActionError('That draft no longer exists.');
      return { id: updated.id, name: updated.name, body: updated.body, updatedAt: updated.updatedAt.toISOString() };
    }

    const existing = await tx
      .select({ id: promptTemplates.id, name: promptTemplates.name })
      .from(promptTemplates)
      .where(eq(promptTemplates.userId, session.userId));

    // Refusing a duplicate name rather than overwriting: a draft an owner
    // spent time on should not disappear because they reused a name.
    if (existing.some((row) => row.name === name)) {
      throw new ActionError(`You already have a draft called “${name}”. Pick another name, or open that one and update it.`);
    }
    if (existing.length >= MAX_TEMPLATES) {
      throw new ActionError(`You can keep ${MAX_TEMPLATES} drafts. Delete one to make room.`);
    }

    const [created] = await tx
      .insert(promptTemplates)
      .values({ userId: session.userId, name, body })
      .returning();
    if (!created) throw new ActionError('Could not save that draft.');
    return { id: created.id, name: created.name, body: created.body, updatedAt: created.updatedAt.toISOString() };
  });
}

export async function deleteTemplate(session: Session, id: string): Promise<void> {
  const [removed] = await db
    .delete(promptTemplates)
    .where(and(eq(promptTemplates.id, id), eq(promptTemplates.userId, session.userId)))
    .returning({ id: promptTemplates.id });
  if (!removed) throw new ActionError('That draft no longer exists.');
}

/**
 * Seats one agent, moving the buy-in from the account balance to the seat.
 * The debit and the seat are one transaction, so chips can never exist in both
 * places or in neither.
 */
export async function joinTable(
  session: Session,
  tableId: string,
  agentId: string,
): Promise<{ seatIndex: number }> {
  const seatIndex = await db.transaction(async (tx) => seatOne(tx, session, tableId, agentId));
  await tableRuntime(tableId)?.refreshSeats();
  return { seatIndex };
}

/**
 * Seats an agent inside an existing transaction.
 *
 * Takes a row lock on the account first. Two concurrent joins would otherwise
 * each read "no seat of mine at this table", pick different open chairs, and
 * both succeed — which is how one wallet ends up playing itself. Locking the
 * account serialises everything that spends its chips or claims a chair.
 */
async function seatOne(
  tx: Transaction,
  session: Session,
  tableId: string,
  agentId: string,
): Promise<number> {
  const table = tableById(tableId);
  if (!table) throw new ActionError('That table does not exist.');

  await tx.select({ id: users.id }).from(users).where(eq(users.id, session.userId)).for('update');

  const agent = await ownedAgent(tx, session, agentId);

  const [alreadySeated] = await tx.select({ id: seats.id }).from(seats).where(eq(seats.agentId, agent.id)).limit(1);
  if (alreadySeated) throw new ActionError('That agent is already at a table. Take it off that one first.');

  // The word budget is checked before any chips move, since a seat is the only
  // thing the budget governs.
  const fit = checkInstructions(agent.instructions, table.wordLimit);
  if (!fit.ok) throw new ActionError(fit.reason);

  const taken = await tx
    .select({ seatIndex: seats.seatIndex, ownerId: agents.userId })
    .from(seats)
    .innerJoin(agents, eq(agents.id, seats.agentId))
    .where(eq(seats.tableId, tableId));

  // One wallet, one chair at any given table. Two of your own agents in the
  // same hand would be playing both sides of it, and the spectator feed hides
  // hole cards per agent rather than per account.
  if (taken.some((row) => row.ownerId === session.userId)) {
    throw new ActionError('One of your agents is already at this table. A wallet takes one seat per table.');
  }

  const used = new Set(taken.map((row) => row.seatIndex));
  const open = Array.from({ length: table.seats }, (_, i) => i).find((i) => !used.has(i));
  if (open === undefined) throw new ActionError('That table is full.');

  const [debited] = await tx
    .update(users)
    .set({ chips: raw`${users.chips} - ${table.buyIn}` })
    .where(and(eq(users.id, session.userId), raw`${users.chips} >= ${table.buyIn}`))
    .returning({ chips: users.chips });

  if (!debited) throw new ActionError('Not enough chips for that buy-in. Visit the cashier.');

  await tx.insert(ledgerEntries).values({
    userId: session.userId,
    delta: -table.buyIn,
    balanceAfter: debited.chips,
    reason: 'table-buy-in',
    reference: `${tableId}:${open}`,
  });

  await tx.insert(seats).values({ tableId, seatIndex: open, agentId: agent.id, stack: table.buyIn });
  return open;
}

export interface DeployResult {
  seated: { tableId: string; agentId: string; agentName: string; seatIndex: number }[];
  skipped: { tableId: string; reason: string }[];
}

/**
 * Sits one piece of writing down at several tables at once.
 *
 * Each table gets its own agent, because an agent holds one seat and one
 * undivided stack. They share the text, not the chips or the record. A table
 * that cannot be joined is reported and the rest still go down, so a single
 * full table does not cost the whole deployment.
 */
export async function deployAgents(
  session: Session,
  input: { name: string; instructions: string; tableIds: string[] },
): Promise<DeployResult> {
  const baseName = input.name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  if (baseName.length < 2) throw new ActionError('Give the agents a name of at least two characters.');

  const wanted = [...new Set(input.tableIds)];
  if (wanted.length === 0) throw new ActionError('Choose at least one table.');

  const seated: DeployResult['seated'] = [];
  const skipped: DeployResult['skipped'] = [];

  // One transaction per table rather than one for all of them: a batch is a
  // convenience, not an all-or-nothing bet, and an owner would rather have two
  // of three seats than none.
  for (const tableId of wanted) {
    try {
      const outcome = await db.transaction(async (tx) => {
        const table = tableById(tableId);
        if (!table) throw new ActionError('That table does not exist.');

        const mine = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.userId, session.userId));
        if (mine.length >= MAX_AGENTS) {
          throw new ActionError(`You can keep ${MAX_AGENTS} agents, one for each table.`);
        }

        const taken = await tx.select({ color: agents.color }).from(agents);
        const name = `${baseName} ${table.number}`.slice(0, MAX_NAME);
        const [created] = await tx
          .insert(agents)
          .values({
            userId: session.userId,
            name,
            color: assignColor(taken.map((row) => row.color)).id,
            instructions: input.instructions.slice(0, MAX_INSTRUCTIONS),
          })
          .returning({ id: agents.id, name: agents.name });
        if (!created) throw new ActionError('Could not create an agent for that table.');

        const seatIndex = await seatOne(tx, session, tableId, created.id);
        return { agentId: created.id, agentName: created.name, seatIndex };
      });

      seated.push({ tableId, ...outcome });
      await tableRuntime(tableId)?.refreshSeats();
    } catch (error) {
      if (error instanceof ActionError) skipped.push({ tableId, reason: error.message });
      else throw error;
    }
  }

  if (seated.length === 0 && skipped.length > 0) {
    throw new ActionError(skipped[0]?.reason ?? 'Could not seat anywhere.');
  }
  return { seated, skipped };
}

/**
 * Takes one agent off its table and returns the stack it is actually holding.
 *
 * The seat row carries the stack as it stood when the last hand was stored, so
 * paying it out while a hand is running would refund a buy-in the agent is
 * busy losing and mint the difference. A request that lands mid-hand is
 * therefore held by the table and settled the moment the hand is on record.
 */
export async function leaveTable(session: Session, agentId: string): Promise<{ pending: boolean }> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, session.userId)))
    .limit(1);
  if (!agent) throw new ActionError('That agent is not yours.');

  const [seat] = await db
    .select({ tableId: seats.tableId, seatIndex: seats.seatIndex })
    .from(seats)
    .where(eq(seats.agentId, agent.id))
    .limit(1);
  if (!seat) return { pending: false };

  const runtime = tableRuntime(seat.tableId);
  if (!runtime) {
    // No table is running this id, so nothing can be mid-hand and the stack on
    // the row is final.
    await leaveSeat(seat.tableId, seat.seatIndex);
    return { pending: false };
  }

  const outcome = await runtime.requestLeave(agent.id, seat.seatIndex);
  return { pending: outcome === 'queued' };
}

export interface DepositQuote {
  intentId: string;
  bytes32: `0x${string}`;
  chips: number;
  valueWei: string;
  vault: `0x${string}`;
}

export async function startDeposit(session: Session, packageId: string): Promise<DepositQuote> {
  const chosen = packageById(packageId);
  if (!chosen) throw new ActionError('That package does not exist.');

  const valueWei = chipsToWei(chosen.chips);

  // Where the watcher should start looking for this deposit. Best-effort: an
  // unreachable RPC must not stop somebody buying chips, and a running watcher
  // is already scanning forward from its own cursor regardless.
  let startBlock: number | null = null;
  try {
    startBlock = Number(await headBlock());
  } catch (error) {
    logger.warn('deposit.start-block-unavailable', { error: error instanceof Error ? error.message : 'unknown' });
  }

  const [intent] = await db
    .insert(depositIntents)
    .values({
      userId: session.userId,
      packageId: chosen.id,
      chips: chosen.chips,
      expectedWei: valueWei.toString(),
      startBlock,
    })
    .returning({ id: depositIntents.id });

  return {
    intentId: intent.id,
    bytes32: intentToBytes32(intent.id),
    chips: chosen.chips,
    valueWei: valueWei.toString(),
    vault: vaultAddress(),
  };
}

export interface DepositResult {
  chips: number;
  balance: number;
}

/**
 * Notes the transaction a deposit was paid with, before it has confirmed.
 *
 * Without this a player who closes the tab while waiting has no way back to
 * their money: the intent is spent on chain and the row here has nothing
 * pointing at it. Writing the hash the moment the wallet returns it makes the
 * deposit recoverable, by the player on their next visit or by an operator.
 */
export async function noteDepositTx(session: Session, intentId: string, txHash: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ActionError('That is not a transaction hash.');

  await db
    .update(depositIntents)
    .set({ txHash })
    .where(
      and(
        eq(depositIntents.id, intentId),
        eq(depositIntents.userId, session.userId),
        eq(depositIntents.status, 'pending'),
      ),
    );
}

/** Deposits this account has paid for but not yet had credited. */
export async function unsettledDeposits(session: Session): Promise<Array<{ intentId: string; txHash: string }>> {
  const rows = await db
    .select({ intentId: depositIntents.id, txHash: depositIntents.txHash })
    .from(depositIntents)
    .where(
      and(
        eq(depositIntents.userId, session.userId),
        eq(depositIntents.status, 'pending'),
        isNotNull(depositIntents.txHash),
      ),
    )
    .orderBy(depositIntents.createdAt);

  return rows.map((row) => ({ intentId: row.intentId, txHash: row.txHash! }));
}

/**
 * Credits a deposit for the player who is watching it land.
 *
 * The checks live in `creditDeposit`, which the background watcher uses too, so
 * this path can never be more or less permissive than the one that runs when
 * nobody is looking. All this adds is the impatience of a person at a screen:
 * it reads the receipt by hash immediately rather than waiting for the next
 * sweep, and it turns the outcome into a sentence.
 */
export async function confirmDeposit(session: Session, txHash: string): Promise<DepositResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ActionError('That is not a transaction hash.');

  const observed = await observeDeposit(txHash as `0x${string}`);
  if (!observed) throw new ActionError('No deposit to this vault was found in that transaction.');

  const outcome = await creditDeposit(observed, session.userId);

  switch (outcome.status) {
    case 'credited':
      logger.info('deposit.credited', {
        intentId: outcome.intentId,
        chips: outcome.chips,
        txHash,
        source: 'browser',
      });
      return { chips: outcome.chips, balance: outcome.balance };

    case 'unconfirmed':
      throw new ActionError(
        `Waiting for confirmations (${outcome.confirmations} of ${REQUIRED_CONFIRMATIONS}). Your chips are safe — they will arrive on their own.`,
      );

    case 'already-credited':
      throw new ActionError('That deposit has already been credited.');

    case 'conflict':
      // Two deposits in one transaction. Real money, and only a person can
      // decide which row it belongs to, so say so rather than inventing chips.
      throw new ActionError(
        'That transaction carries more than one deposit, so it needs to be settled by hand. Nothing is lost — keep the transaction hash.',
      );

    default:
      throw new ActionError(outcome.reason);
  }
}

export interface RedemptionResult {
  chips: number;
  netWei: string;
  feeWei: string;
  txHash: string;
  balance: number;
}

/**
 * Redeems chips for tBNB, less the operator's fee.
 *
 * Chips are debited before anything is sent, so a payout can never exceed the
 * balance that authorised it. The redemption id is passed to the contract,
 * which refuses to pay the same one twice.
 */
export type PayOut = (
  recipient: `0x${string}`,
  netWei: bigint,
  redemptionId: `0x${string}`,
) => Promise<`0x${string}`>;

export async function redeem(session: Session, chips: number, pay: PayOut = payOut): Promise<RedemptionResult> {
  if (!Number.isInteger(chips) || chips <= 0) throw new ActionError('Enter a whole number of chips.');

  const quote = quoteRedemption(chips);

  const record = await db.transaction(async (tx) => {
    const [debited] = await tx
      .update(users)
      .set({ chips: raw`${users.chips} - ${chips}` })
      .where(and(eq(users.id, session.userId), raw`${users.chips} >= ${chips}`))
      .returning({ chips: users.chips });

    if (!debited) throw new ActionError('You do not have that many chips.');

    const [created] = await tx
      .insert(redemptions)
      .values({
        userId: session.userId,
        chips,
        grossWei: quote.grossWei.toString(),
        feeWei: quote.feeWei.toString(),
        netWei: quote.netWei.toString(),
      })
      .returning({ id: redemptions.id });

    await tx.insert(ledgerEntries).values({
      userId: session.userId,
      delta: -chips,
      balanceAfter: debited.chips,
      reason: 'redemption',
      reference: created.id,
    });

    return { id: created.id, balance: debited.chips };
  });

  logger.info('redemption.debited', { redemptionId: record.id, chips, netWei: quote.netWei.toString() });

  try {
    const txHash = await pay(session.address as `0x${string}`, quote.netWei, intentToBytes32(record.id));
    await db
      .update(redemptions)
      .set({ status: 'sent', txHash, sentAt: new Date() })
      .where(eq(redemptions.id, record.id));

    return {
      chips,
      netWei: quote.netWei.toString(),
      feeWei: quote.feeWei.toString(),
      txHash,
      balance: record.balance,
    };
  } catch (error) {
    // Broadcast but unresolved. The transaction may still be mined, so
    // returning the chips here would pay the same redemption twice. The row
    // keeps its hash and stays pending for an operator to settle.
    if (error instanceof PayoutUncertain) {
      await db
        .update(redemptions)
        .set({ txHash: error.txHash })
        .where(eq(redemptions.id, record.id));

      // The one case a person has to settle. `pnpm redemptions` lists these and
      // docs/RUNBOOK.md says how to decide; both key off exactly this event.
      logger.error('redemption.uncertain', {
        redemptionId: record.id,
        txHash: error.txHash,
        chips,
        detail: 'broadcast but unconfirmed; chips stay spent until a person settles it',
      });

      throw new ActionError(
        'Your payout was sent but has not confirmed yet. Your chips stay spent until it settles, and it will not be sent twice.',
      );
    }

    // Nothing was paid, so the chips go back. The redemption stays on file as
    // failed rather than disappearing.
    logger.warn('redemption.failed', {
      redemptionId: record.id,
      chips,
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });

    await db.transaction(async (tx) => {
      await tx.update(redemptions).set({ status: 'failed' }).where(eq(redemptions.id, record.id));
      const [refunded] = await tx
        .update(users)
        .set({ chips: raw`${users.chips} + ${chips}` })
        .where(eq(users.id, session.userId))
        .returning({ chips: users.chips });
      await tx.insert(ledgerEntries).values({
        userId: session.userId,
        delta: chips,
        balanceAfter: refunded.chips,
        reason: 'adjustment',
        reference: `refund:${record.id}`,
      });
    });

    throw new ActionError(
      `The payout did not go through, so your chips were returned. ${error instanceof Error ? error.message.slice(0, 120) : ''}`,
    );
  }
}
