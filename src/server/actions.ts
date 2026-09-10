import { and, eq, inArray, isNotNull, sql as raw } from 'drizzle-orm';
import { db } from '../db/client';
import { agents, depositIntents, ledgerEntries, seats, users } from '../db/schema';
import { conservative } from '../lib/rating';
import { chipsToWei, packageById, weiToChips } from '../lib/economy';
import { chainById } from '../lib/chains';
import { REQUIRED_CONFIRMATIONS, observeDeposit } from './chain';
import { UnknownChain, requireChain, vaultAddress, type DeployedChain } from './chains';
import { bytes32ToIntent, intentToBytes32 } from '../lib/intent';
import type { Session } from './auth';
import { setSeeking } from './store';

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
    /** The published rating, which is what the standings sort on. */
    rating: number;
    matchesPlayed: number;
  };
  /** The match it is sitting in right now, or null while it waits for one. */
  seat: { matchId: string; seatIndex: number; stack: number } | null;
  /** Whether its owner has it switched on. Off means it queues for nothing. */
  playing: boolean;
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
      seeking: agents.seeking,
      ratingMu: agents.ratingMu,
      ratingSigma: agents.ratingSigma,
      matchesPlayed: agents.matchesPlayed,
    })
    .from(users)
    .innerJoin(agents, eq(agents.userId, users.id))
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!row) throw new ActionError('That account no longer exists.');

  const [seat] = await db
    .select({ matchId: seats.matchId, seatIndex: seats.seatIndex, stack: seats.stack })
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
      rating: conservative({ mu: row.ratingMu, sigma: row.ratingSigma }),
      matchesPlayed: row.matchesPlayed,
    },
    seat: seat ?? null,
    playing: row.seeking,
  };
}

/**
 * Switches an agent on or off.
 *
 * The only lever an owner has over where their agent plays, now that the arena
 * decides that. Off means it stops queueing once its current match ends: a
 * match cannot be walked out of, so this never interrupts one in progress.
 */
export async function setPlaying(session: Session, playing: boolean): Promise<{ playing: boolean }> {
  const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.userId, session.userId)).limit(1);
  if (!agent) throw new ActionError('That account has no agent.');

  await setSeeking(agent.id, playing);
  return { playing };
}

const MAX_NAME = 24;
const MAX_INSTRUCTIONS = 2000;

export async function saveAgent(session: Session, input: { name: string; instructions: string }): Promise<void> {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  if (name.length < 2) throw new ActionError('Give your agent a name of at least two characters.');

  await db
    .update(agents)
    .set({ name, instructions: input.instructions.slice(0, MAX_INSTRUCTIONS), updatedAt: new Date() })
    .where(eq(agents.userId, session.userId));
}

/**
 * The chain a request asked to settle on.
 *
 * Every money path resolves the key itself rather than accepting a chain object
 * from the caller, so an unknown or disabled network fails as a bad request
 * instead of reaching the chain layer.
 */
function chainFor(key: string): DeployedChain {
  try {
    return requireChain(key);
  } catch (error) {
    if (error instanceof UnknownChain) throw new ActionError(error.message);
    throw error;
  }
}

export interface DepositQuote {
  intentId: string;
  bytes32: `0x${string}`;
  chips: number;
  valueWei: string;
  vault: `0x${string}`;
  chainKey: string;
  chainId: number;
}

export async function startDeposit(session: Session, packageId: string, chainKey: string): Promise<DepositQuote> {
  const chosen = packageById(packageId);
  if (!chosen) throw new ActionError('That package does not exist.');

  const chain = chainFor(chainKey);

  // Resolved before the row is written. An intent against a chain with no vault
  // is an intent the player can never pay, so it is refused rather than stored.
  let vault: `0x${string}`;
  try {
    vault = vaultAddress(chain);
  } catch {
    throw new ActionError(`Chips cannot be bought on ${chain.name} yet. Switch networks to buy in.`);
  }

  const valueWei = chipsToWei(chosen.chips);
  const [intent] = await db
    .insert(depositIntents)
    .values({
      userId: session.userId,
      chainId: chain.id,
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
    vault,
    chainKey: chain.key,
    chainId: chain.id,
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
  if (!/^[0-9a-f-]{36}$/i.test(intentId)) throw new ActionError('That is not a deposit.');

  try {
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
  } catch {
    // A hash is unique per chain, so writing one that is already on another
    // intent fails here. That is a client repeating itself, not a fault: the
    // hash is already on record against the intent that actually paid it, and
    // that is the row confirmation will find.
  }
}

/**
 * Deposits this account has paid for but not yet had credited.
 *
 * The chain comes back with each one. A player who bought on one network and
 * returned on another must still be finished on the network they paid.
 */
export async function unsettledDeposits(
  session: Session,
): Promise<Array<{ intentId: string; txHash: string; chainKey: string }>> {
  const rows = await db
    .select({ intentId: depositIntents.id, txHash: depositIntents.txHash, chainId: depositIntents.chainId })
    .from(depositIntents)
    .where(
      and(
        eq(depositIntents.userId, session.userId),
        eq(depositIntents.status, 'pending'),
        isNotNull(depositIntents.txHash),
      ),
    )
    .orderBy(depositIntents.createdAt);

  return rows
    .map((row) => ({ intentId: row.intentId, txHash: row.txHash!, chainKey: chainById(row.chainId)?.key }))
    .filter((row): row is { intentId: string; txHash: string; chainKey: string } => row.chainKey !== undefined);
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
 *
 * A transaction may carry more than one deposit, so the first one still owed to
 * this account is the one credited. Calling again finishes the next, which is
 * how a client that made several in one call gets all of them.
 */
export async function confirmDeposit(session: Session, txHash: string, chainKey: string): Promise<DepositResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ActionError('That is not a transaction hash.');

  const chain = chainFor(chainKey);

  const deposits = await observeDeposit(chain, txHash as `0x${string}`);
  if (deposits.length === 0) {
    throw new ActionError(`No deposit to the ${chain.shortName} vault was found in that transaction.`);
  }

  if (deposits[0].confirmations < REQUIRED_CONFIRMATIONS) {
    throw new ActionError(
      `Waiting for confirmations (${deposits[0].confirmations} of ${REQUIRED_CONFIRMATIONS}). Try again shortly.`,
    );
  }

  const mine = deposits.filter((row) => row.payer.toLowerCase() === session.address.toLowerCase());
  if (mine.length === 0) throw new ActionError('That deposit was sent from a different wallet.');

  // An identifier the vault accepted need not be one of ours: anyone can call
  // deposit with a bytes32 of their own invention. One that does not decode is
  // simply not a deposit this arena issued.
  const candidates = mine.flatMap((row) => {
    try {
      return [{ ...row, intentId: bytes32ToIntent(row.intentId) }];
    } catch {
      return [];
    }
  });
  if (candidates.length === 0) throw new ActionError('That deposit does not match any request from this account.');

  const pending = await db
    .select({ id: depositIntents.id })
    .from(depositIntents)
    .where(
      and(
        eq(depositIntents.userId, session.userId),
        eq(depositIntents.status, 'pending'),
        inArray(
          depositIntents.id,
          candidates.map((row) => row.intentId),
        ),
      ),
    );

  const observed = candidates.find((row) => pending.some((intent) => intent.id === row.intentId)) ?? candidates[0];
  const intentId = observed.intentId;

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

    // The vault check above proves the log came from a vault of ours; this
    // proves it came from the one the intent was issued against. Without it an
    // intent could be paid on a cheaper chain than the one it was priced on.
    if (intent.chainId !== chain.id) {
      const paid = chainById(intent.chainId);
      throw new ActionError(`That deposit belongs to ${paid?.name ?? `chain ${intent.chainId}`}. Switch networks to finish it.`);
    }

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
