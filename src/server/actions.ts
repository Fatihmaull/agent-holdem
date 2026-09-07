import { and, eq, isNotNull, sql as raw } from 'drizzle-orm';
import { db } from '../db/client';
import { agents, depositIntents, ledgerEntries, redemptions, seats, users } from '../db/schema';
import { chipsToWei, packageById, quoteRedemption, tableById, weiToChips } from '../lib/economy';
import { checkInstructions } from '../lib/instructions';
import { PayoutUncertain, REQUIRED_CONFIRMATIONS, observeDeposit, payOut, vaultAddress } from './chain';
import { bytes32ToIntent, intentToBytes32 } from '../lib/intent';
import type { Session } from './auth';
import { tableRuntime } from './registry';
import { leaveSeat } from './store';

export class ActionError extends Error {}

export interface Account {
  address: string;
  chips: number;
  agent: {
    id: string;
    name: string;
    color: string;
    instructions: string;
    handsPlayed: number;
    handsWon: number;
    chipsWon: number;
    biggestPot: number;
  };
  seat: { tableId: string; seatIndex: number; stack: number } | null;
}

export async function account(session: Session): Promise<Account> {
  const [row] = await db
    .select({
      address: users.address,
      chips: users.chips,
      agentId: agents.id,
      name: agents.name,
      color: agents.color,
      instructions: agents.instructions,
      handsPlayed: agents.handsPlayed,
      handsWon: agents.handsWon,
      chipsWon: agents.chipsWon,
      biggestPot: agents.biggestPot,
    })
    .from(users)
    .innerJoin(agents, eq(agents.userId, users.id))
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!row) throw new ActionError('That account no longer exists.');

  const [seat] = await db
    .select({ tableId: seats.tableId, seatIndex: seats.seatIndex, stack: seats.stack })
    .from(seats)
    .where(eq(seats.agentId, row.agentId))
    .limit(1);

  return {
    address: row.address,
    chips: row.chips,
    agent: {
      id: row.agentId,
      name: row.name,
      color: row.color,
      instructions: row.instructions,
      handsPlayed: row.handsPlayed,
      handsWon: row.handsWon,
      chipsWon: row.chipsWon,
      biggestPot: row.biggestPot,
    },
    seat: seat ?? null,
  };
}

const MAX_NAME = 24;
const MAX_INSTRUCTIONS = 2000;

/**
 * Saving is also gated by the word budget, but only of the table the agent is
 * actually sitting at. Otherwise the budget would mean nothing: an owner could
 * take a seat at a ten-word table and immediately rewrite the field to a
 * hundred words, and the seat would keep playing under the longer text.
 */
export async function saveAgent(session: Session, input: { name: string; instructions: string }): Promise<void> {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  if (name.length < 2) throw new ActionError('Give your agent a name of at least two characters.');

  const instructions = input.instructions.slice(0, MAX_INSTRUCTIONS);

  await db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.userId, session.userId))
      .limit(1);
    if (!agent) throw new ActionError('That account has no agent.');

    const [seat] = await tx
      .select({ tableId: seats.tableId })
      .from(seats)
      .where(eq(seats.agentId, agent.id))
      .limit(1);

    if (seat) {
      const table = tableById(seat.tableId);
      const check = table ? checkInstructions(instructions, table.wordLimit) : null;
      if (check && !check.ok) {
        throw new ActionError(`${check.reason} Take the agent off that table to write more.`);
      }
    }

    await tx
      .update(agents)
      .set({ name, instructions, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
  });
}

/**
 * Seats an agent, moving the buy-in from the account balance to the seat.
 * The debit and the seat are one transaction, so chips can never exist in both
 * places or in neither.
 */
export async function joinTable(session: Session, tableId: string): Promise<{ seatIndex: number }> {
  const table = tableById(tableId);
  if (!table) throw new ActionError('That table does not exist.');

  const seatIndex = await db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id, instructions: agents.instructions })
      .from(agents)
      .where(eq(agents.userId, session.userId))
      .limit(1);
    if (!agent) throw new ActionError('That account has no agent.');

    const [alreadySeated] = await tx.select({ id: seats.id }).from(seats).where(eq(seats.agentId, agent.id)).limit(1);
    if (alreadySeated) throw new ActionError('Your agent is already at a table. Take it off that one first.');

    // The word budget is checked here, before any chips move. A seat is the
    // only thing the budget governs, so this is the one place it has to hold.
    const fit = checkInstructions(agent.instructions, table.wordLimit);
    if (!fit.ok) throw new ActionError(fit.reason);

    const taken = await tx.select({ seatIndex: seats.seatIndex }).from(seats).where(eq(seats.tableId, tableId));
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
  });

  await tableRuntime(tableId)?.refreshSeats();
  return { seatIndex };
}

/**
 * Takes an agent off its table and returns the stack it is actually holding.
 *
 * The seat row carries the stack as it stood when the last hand was stored, so
 * paying it out while a hand is running would refund a buy-in the agent is
 * busy losing and mint the difference. A request that lands mid-hand is
 * therefore held by the table and settled the moment the hand is on record.
 */
export async function leaveTable(session: Session): Promise<{ pending: boolean }> {
  const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.userId, session.userId)).limit(1);
  if (!agent) throw new ActionError('That account has no agent.');

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
  const [intent] = await db
    .insert(depositIntents)
    .values({
      userId: session.userId,
      packageId: chosen.id,
      chips: chosen.chips,
      expectedWei: valueWei.toString(),
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
 * Credits a deposit after reading it back from the chain.
 *
 * Every check that matters happens here: the event came from our vault, the
 * payer is the signed-in wallet, the intent belongs to that same wallet, the
 * amount covers what the intent promised, and the transaction has enough
 * confirmations. The intent row is locked for the length of the transaction and
 * the credit only applies to a row that is still pending, so two requests
 * racing on the same hash cannot both pay out.
 */
export async function confirmDeposit(session: Session, txHash: string): Promise<DepositResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ActionError('That is not a transaction hash.');

  const observed = await observeDeposit(txHash as `0x${string}`);
  if (!observed) throw new ActionError('No deposit to this vault was found in that transaction.');

  if (observed.confirmations < REQUIRED_CONFIRMATIONS) {
    throw new ActionError(
      `Waiting for confirmations (${observed.confirmations} of ${REQUIRED_CONFIRMATIONS}). Try again shortly.`,
    );
  }

  if (observed.payer.toLowerCase() !== session.address.toLowerCase()) {
    throw new ActionError('That deposit was sent from a different wallet.');
  }

  const intentId = bytes32ToIntent(observed.intentId);

  return db.transaction(async (tx) => {
    // Locked for the length of the transaction. A second request for the same
    // hash waits here rather than reading a pending row that is about to be
    // credited out from under it.
    const [intent] = await tx
      .select()
      .from(depositIntents)
      .where(and(eq(depositIntents.id, intentId), eq(depositIntents.userId, session.userId)))
      .limit(1)
      .for('update');

    if (!intent) throw new ActionError('That deposit does not match any request from this account.');
    if (intent.status === 'credited') throw new ActionError('That deposit has already been credited.');

    if (observed.amountWei < BigInt(intent.expectedWei)) {
      throw new ActionError('That deposit was smaller than the package it was for.');
    }

    // Anything sent above the package price still buys chips at the same peg.
    const chips = Math.max(intent.chips, weiToChips(observed.amountWei));

    // The status is part of the condition, not just of the payload, so the
    // credit cannot apply twice even if the lock above is ever lost.
    const credited = await tx
      .update(depositIntents)
      .set({
        status: 'credited',
        txHash,
        blockNumber: Number(observed.blockNumber),
        chips,
        creditedAt: new Date(),
      })
      .where(and(eq(depositIntents.id, intentId), eq(depositIntents.status, 'pending')))
      .returning({ id: depositIntents.id });

    if (credited.length === 0) throw new ActionError('That deposit has already been credited.');

    const [updated] = await tx
      .update(users)
      .set({ chips: raw`${users.chips} + ${chips}` })
      .where(eq(users.id, session.userId))
      .returning({ chips: users.chips });

    await tx.insert(ledgerEntries).values({
      userId: session.userId,
      delta: chips,
      balanceAfter: updated.chips,
      reason: 'deposit',
      reference: txHash,
    });

    return { chips, balance: updated.chips };
  });
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
export async function redeem(session: Session, chips: number): Promise<RedemptionResult> {
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

  try {
    const txHash = await payOut(session.address as `0x${string}`, quote.netWei, intentToBytes32(record.id));
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

      throw new ActionError(
        'Your payout was sent but has not confirmed yet. Your chips stay spent until it settles, and it will not be sent twice.',
      );
    }

    // Nothing was paid, so the chips go back. The redemption stays on file as
    // failed rather than disappearing.
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
