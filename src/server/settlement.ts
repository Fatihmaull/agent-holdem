import { and, eq, isNull, sql as raw } from 'drizzle-orm';
import { db } from '../db/client';
import { ledgerEntries, redemptions, users } from '../db/schema';
import { intentToBytes32 } from '../lib/intent';
import { redemptionSettled } from './chain';
import { logger } from './log';

/**
 * Settling redemptions that neither succeeded nor failed.
 *
 * `redeem` resolves almost everything by itself: a payout the chain refused
 * returns the chips, a payout that confirmed spends them. What it cannot decide
 * is a payout that was broadcast and then went quiet — the transaction may be
 * mined a minute later, so returning the chips could pay the same redemption
 * twice, and writing it off could rob the player. Those rows stay `pending` and
 * this is what a person uses to close them.
 *
 * The vault is the authority. It refuses to pay a redemption id twice, so
 * `redemptionPaid` turns "we do not know" into a fact — which is why the only
 * resolution applied automatically is the one the contract has already decided.
 */

export type SettlementVerdict =
  /** The vault paid it. The chips were correctly spent; the row was just never updated. */
  | 'paid'
  /** Broadcast, and the vault has not paid it. It may still be in the mempool. */
  | 'in-flight'
  /** Nothing was ever broadcast: the process died between the debit and the send. */
  | 'never-sent'
  /** The chain could not be reached, so nothing is known and nothing is done. */
  | 'unknown';

export interface StuckRedemption {
  id: string;
  address: string;
  chips: number;
  netWei: string;
  txHash: string | null;
  createdAt: Date;
  verdict: SettlementVerdict;
}

export type SettledCheck = (redemptionId: `0x${string}`) => Promise<boolean>;

/** Every redemption still waiting on a decision, with what the chain says about it. */
export async function stuckRedemptions(settled: SettledCheck = redemptionSettled): Promise<StuckRedemption[]> {
  const rows = await db
    .select({
      id: redemptions.id,
      chips: redemptions.chips,
      netWei: redemptions.netWei,
      txHash: redemptions.txHash,
      createdAt: redemptions.createdAt,
      address: users.address,
    })
    .from(redemptions)
    .innerJoin(users, eq(users.id, redemptions.userId))
    .where(eq(redemptions.status, 'pending'))
    .orderBy(redemptions.createdAt);

  const out: StuckRedemption[] = [];
  for (const row of rows) {
    let verdict: SettlementVerdict;
    try {
      verdict = (await settled(intentToBytes32(row.id)))
        ? 'paid'
        : row.txHash
          ? 'in-flight'
          : 'never-sent';
    } catch {
      verdict = 'unknown';
    }
    out.push({ ...row, verdict });
  }
  return out;
}

/**
 * Marks as sent every redemption the vault has already paid.
 *
 * Safe to run unattended: it only writes down what the contract has already
 * done, and it moves no chips — the chips were spent when the redemption was
 * created, which was correct, because the money did leave the treasury.
 */
export async function settlePaid(settled: SettledCheck = redemptionSettled): Promise<string[]> {
  const closed: string[] = [];
  for (const row of await stuckRedemptions(settled)) {
    if (row.verdict !== 'paid') continue;

    const [updated] = await db
      .update(redemptions)
      .set({ status: 'sent', sentAt: new Date() })
      .where(and(eq(redemptions.id, row.id), eq(redemptions.status, 'pending')))
      .returning({ id: redemptions.id });

    if (updated) {
      closed.push(row.id);
      logger.info('redemption.settled', { redemptionId: row.id, chips: row.chips, verdict: 'paid' });
    }
  }
  return closed;
}

export class SettlementRefused extends Error {}

/**
 * Returns the chips for a redemption that was never paid.
 *
 * Deliberately not automatic. "The vault has not paid it" and "the vault will
 * never pay it" are different statements, and only a person looking at the
 * transaction can tell them apart. The chain is asked once more here anyway, so
 * a stale listing cannot be used to refund something that has since landed.
 */
export async function refundRedemption(
  redemptionId: string,
  settled: SettledCheck = redemptionSettled,
): Promise<{ chips: number; balance: number }> {
  if (await settled(intentToBytes32(redemptionId))) {
    throw new SettlementRefused(
      'the vault has paid this redemption; refunding it would give the player their chips and their tBNB',
    );
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: redemptions.id, userId: redemptions.userId, chips: redemptions.chips })
      .from(redemptions)
      .where(and(eq(redemptions.id, redemptionId), eq(redemptions.status, 'pending')))
      .limit(1)
      .for('update');

    if (!row) throw new SettlementRefused('no redemption is pending under that id');

    const [failed] = await tx
      .update(redemptions)
      .set({ status: 'failed' })
      .where(and(eq(redemptions.id, redemptionId), eq(redemptions.status, 'pending')))
      .returning({ id: redemptions.id });
    if (!failed) throw new SettlementRefused('that redemption was settled by somebody else just now');

    const [refunded] = await tx
      .update(users)
      .set({ chips: raw`${users.chips} + ${row.chips}` })
      .where(eq(users.id, row.userId))
      .returning({ chips: users.chips });

    await tx.insert(ledgerEntries).values({
      userId: row.userId,
      delta: row.chips,
      balanceAfter: refunded.chips,
      reason: 'adjustment',
      reference: `refund:${row.id}`,
    });

    logger.info('redemption.refunded', { redemptionId: row.id, chips: row.chips, balance: refunded.chips });
    return { chips: row.chips, balance: refunded.chips };
  });
}

/** Redemptions that were debited but never broadcast, which is always a bug worth seeing. */
export async function neverSentCount(): Promise<number> {
  const [row] = await db
    .select({ total: raw<number>`count(*)::int` })
    .from(redemptions)
    .where(and(eq(redemptions.status, 'pending'), isNull(redemptions.txHash)));
  return row?.total ?? 0;
}
