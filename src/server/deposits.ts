import { and, asc, count, eq, isNotNull, lt, min, sql, sql as raw } from 'drizzle-orm';
import { db } from '../db/client';
import { chainCursors, depositIntents, ledgerEntries, users } from '../db/schema';
import { weiToChips } from '../lib/economy';
import { bytes32ToIntent, intentToBytes32 } from '../lib/intent';
import {
  REQUIRED_CONFIRMATIONS,
  headBlock,
  intentConsumed,
  observeDeposit,
  scanDeposits,
  vaultConfigured,
  type ObservedDeposit,
} from './chain';
import { logger } from './log';

/**
 * The chain, as the sweep needs it.
 *
 * Named as a port rather than imported directly so the sweep can be driven over
 * a real database with a scripted chain. The behaviour worth testing here — a
 * cursor that only advances over blocks it finished, a credit that refuses to
 * apply twice, an intent that is never written off while the vault says it was
 * paid — is all in the ordering, and none of it is observable against a live
 * testnet within a test.
 */
export interface DepositChain {
  configured(): boolean;
  head(): Promise<bigint>;
  scan(from: bigint, to: bigint): Promise<ObservedDeposit[]>;
  observe(txHash: `0x${string}`): Promise<ObservedDeposit | null>;
  consumed(intentId: `0x${string}`): Promise<boolean>;
}

const bscTestnet: DepositChain = {
  configured: vaultConfigured,
  head: headBlock,
  scan: scanDeposits,
  observe: observeDeposit,
  consumed: intentConsumed,
};

/**
 * Crediting deposits without anyone watching.
 *
 * The browser path is a convenience: it gets a player their chips seconds after
 * they pay, while they are still looking at the screen. It is not the record.
 * A player who pays and closes the tab has spent real value, and the only thing
 * that can still find their money is the chain itself — so the same event the
 * browser reports is also read back here, from a log scan that runs whether or
 * not anybody is connected.
 *
 * Everything in this file is written to be run twice. A sweep that dies halfway
 * re-reads the blocks it did not finish, and every credit is conditioned on the
 * intent still being pending, so a repeat is a no-op rather than a second
 * payment.
 */

const CURSOR = 'deposits';

/** Blocks per `getLogs` call. Public RPCs cap the range, and 2000 is under every cap we have met. */
const SCAN_CHUNK = BigInt(process.env.DEPOSIT_SCAN_CHUNK ?? 2_000);

/** How far back a first-ever scan reaches when no intent says where to start. */
const SEED_LOOKBACK = BigInt(process.env.DEPOSIT_SEED_LOOKBACK_BLOCKS ?? 20_000);

/** An intent nobody paid for is written off after this long. */
const INTENT_TTL_MS = Number(process.env.DEPOSIT_INTENT_TTL_MS ?? 24 * 60 * 60 * 1000);

/** Gap before a noted transaction hash is chased directly rather than waited for. */
const HASH_RETRY_AFTER_MS = 90_000;

/** Stuck intents chased by hash in one sweep, so a wedged row cannot flood the RPC. */
const HASH_RETRY_BATCH = 20;

export type CreditOutcome =
  | { status: 'credited'; intentId: string; chips: number; balance: number }
  | { status: 'already-credited'; intentId: string }
  | { status: 'unconfirmed'; confirmations: bigint }
  /** Decided and refused: the deposit does not match the intent it names. */
  | { status: 'rejected'; reason: string }
  /** Another intent already holds this transaction hash. Needs a person. */
  | { status: 'conflict'; intentId: string };

/**
 * Credits one observed deposit.
 *
 * Session-free on purpose: the checks that matter are all between the event and
 * the intent it names, never between the event and whoever happens to be asking.
 * The payer has to be the account that requested the intent, the amount has to
 * cover what was promised, and the row has to still be pending. `expectUserId`
 * only sharpens the error for a signed-in caller; it is not what makes this safe.
 */
export async function creditDeposit(
  observed: ObservedDeposit,
  expectUserId?: string,
): Promise<CreditOutcome> {
  if (observed.confirmations < REQUIRED_CONFIRMATIONS) {
    return { status: 'unconfirmed', confirmations: observed.confirmations };
  }

  let intentId: string;
  try {
    intentId = bytes32ToIntent(observed.intentId);
  } catch {
    return { status: 'rejected', reason: 'That deposit does not carry a deposit request we issued.' };
  }

  try {
    return await db.transaction(async (tx) => {
      // Locked for the length of the transaction. A second caller for the same
      // deposit waits here rather than reading a pending row that is about to
      // be credited out from under it.
      const [intent] = await tx
        .select({
          id: depositIntents.id,
          userId: depositIntents.userId,
          chips: depositIntents.chips,
          expectedWei: depositIntents.expectedWei,
          status: depositIntents.status,
          address: users.address,
        })
        .from(depositIntents)
        .innerJoin(users, eq(users.id, depositIntents.userId))
        .where(eq(depositIntents.id, intentId))
        .limit(1)
        .for('update', { of: depositIntents });

      if (!intent) {
        return { status: 'rejected', reason: 'That deposit does not match any request we issued.' } as const;
      }
      if (expectUserId && intent.userId !== expectUserId) {
        return { status: 'rejected', reason: 'That deposit does not match any request from this account.' } as const;
      }
      if (intent.status === 'credited') return { status: 'already-credited', intentId } as const;

      if (observed.payer.toLowerCase() !== intent.address.toLowerCase()) {
        return { status: 'rejected', reason: 'That deposit was sent from a different wallet.' } as const;
      }
      if (observed.amountWei < BigInt(intent.expectedWei)) {
        return { status: 'rejected', reason: 'That deposit was smaller than the package it was for.' } as const;
      }

      // Anything sent above the package price still buys chips at the same peg.
      const chips = Math.max(intent.chips, weiToChips(observed.amountWei));

      // The status is part of the condition, not just of the payload, so the
      // credit cannot apply twice even if the lock above is ever lost.
      const credited = await tx
        .update(depositIntents)
        .set({
          status: 'credited',
          txHash: observed.txHash,
          blockNumber: Number(observed.blockNumber),
          chips,
          creditedAt: new Date(),
        })
        .where(and(eq(depositIntents.id, intentId), eq(depositIntents.status, 'pending')))
        .returning({ id: depositIntents.id });

      if (credited.length === 0) return { status: 'already-credited', intentId } as const;

      const [updated] = await tx
        .update(users)
        .set({ chips: raw`${users.chips} + ${chips}` })
        .where(eq(users.id, intent.userId))
        .returning({ chips: users.chips });

      await tx.insert(ledgerEntries).values({
        userId: intent.userId,
        delta: chips,
        balanceAfter: updated.chips,
        reason: 'deposit',
        reference: observed.txHash,
      });

      return { status: 'credited', intentId, chips, balance: updated.chips } as const;
    });
  } catch (error) {
    // One transaction can carry deposits for two different intents, and only
    // one of them can hold the hash. That is a real deposit we cannot credit
    // automatically, so it stays pending for a person rather than being lost
    // or wedging the scan behind it.
    if (isUniqueViolation(error)) return { status: 'conflict', intentId };
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export interface SweepReport {
  scannedTo: bigint | null;
  credited: number;
  conflicts: number;
  expired: number;
  recovered: number;
}

const EMPTY_SWEEP: SweepReport = { scannedTo: null, credited: 0, conflicts: 0, expired: 0, recovered: 0 };

/**
 * One pass over everything the chain owes us.
 *
 * Reads forward from the stored cursor, chases intents whose transaction was
 * reported but never appeared in a scanned range, and writes off requests
 * nobody ever paid for. Safe to call as often as you like and safe to
 * interrupt: the cursor only moves past blocks that were fully handled.
 */
export async function sweepDeposits(chain: DepositChain = bscTestnet): Promise<SweepReport> {
  if (!chain.configured()) return EMPTY_SWEEP;

  const head = await chain.head();
  // A log is only worth reading once it can no longer be reorganised away.
  const safeTo = head - (REQUIRED_CONFIRMATIONS - 1n);
  if (safeTo < 0n) return EMPTY_SWEEP;

  const report: SweepReport = { ...EMPTY_SWEEP };
  let from = await scanStart(head);

  while (from <= safeTo) {
    const to = from + SCAN_CHUNK - 1n > safeTo ? safeTo : from + SCAN_CHUNK - 1n;
    const found = await chain.scan(from, to);

    for (const deposit of found) {
      // Anything inside a scanned range is already past the confirmation
      // depth, so `safeTo` is what enforces REQUIRED_CONFIRMATIONS here.
      const outcome = await creditDeposit(deposit);
      if (outcome.status === 'credited') {
        report.credited += 1;
        logger.info('deposit.credited', {
          intentId: outcome.intentId,
          chips: outcome.chips,
          txHash: deposit.txHash,
          source: 'watcher',
        });
      } else if (outcome.status === 'conflict') {
        report.conflicts += 1;
        logger.error('deposit.conflict', {
          intentId: outcome.intentId,
          txHash: deposit.txHash,
          detail: 'another intent already holds this transaction hash; settle it by hand',
        });
      } else if (outcome.status === 'rejected') {
        logger.warn('deposit.rejected', { txHash: deposit.txHash, reason: outcome.reason });
      }
    }

    // Only now, with every log in this range decided, is it safe to forget it.
    await saveCursor(to);
    report.scannedTo = to;
    from = to + 1n;
  }

  report.recovered = await chaseNotedHashes(chain);
  report.expired = await expireStaleIntents(chain);
  return report;
}

/**
 * Where the next scan begins.
 *
 * The stored cursor if there is one. Otherwise the earliest block a deposit
 * anyone is still owed could possibly be in, because starting after it would
 * walk straight past money that has already been paid. With nothing pending
 * there is nothing to find, so a first run starts at the tip rather than
 * grinding through history to prove it.
 *
 * The work this can imply is bounded by how long an intent stays pending, not
 * by a block count: anything older than the TTL is written off, and writing off
 * asks the chain first. A guessed look back is only for intents issued while
 * the RPC was unreachable, which are the ones whose height we never learned.
 */
async function scanStart(head: bigint): Promise<bigint> {
  const [cursor] = await db
    .select({ blockNumber: chainCursors.blockNumber })
    .from(chainCursors)
    .where(eq(chainCursors.name, CURSOR))
    .limit(1);
  if (cursor) return BigInt(cursor.blockNumber) + 1n;

  const [summary] = await db
    .select({
      pending: count(),
      earliest: min(depositIntents.startBlock),
      unknown: count(sql`case when ${depositIntents.startBlock} is null then 1 end`),
    })
    .from(depositIntents)
    .where(eq(depositIntents.status, 'pending'));

  if (!summary || summary.pending === 0) return head;

  const lookback = head > SEED_LOOKBACK ? head - SEED_LOOKBACK : 0n;
  const candidates: bigint[] = [];
  if (summary.earliest !== null) candidates.push(BigInt(summary.earliest));
  // An intent whose height we never recorded could be anywhere, so the guess
  // has to be in the running whenever one exists.
  if (summary.unknown > 0) candidates.push(lookback);

  return candidates.length > 0 ? candidates.reduce((a, b) => (a < b ? a : b)) : lookback;
}

async function saveCursor(blockNumber: bigint): Promise<void> {
  await db
    .insert(chainCursors)
    .values({ name: CURSOR, blockNumber: Number(blockNumber) })
    .onConflictDoUpdate({
      target: chainCursors.name,
      set: { blockNumber: Number(blockNumber), updatedAt: new Date() },
    });
}

/**
 * Deposits whose transaction hash we were told about but never saw in a scan.
 *
 * Happens when a deposit landed before this watcher first ran, or in whatever
 * range a provider quietly truncated. The hash is enough to fetch the receipt
 * directly, so these are recoverable without a person.
 */
async function chaseNotedHashes(chain: DepositChain): Promise<number> {
  const stuck = await db
    .select({ id: depositIntents.id, txHash: depositIntents.txHash })
    .from(depositIntents)
    .where(
      and(
        eq(depositIntents.status, 'pending'),
        isNotNull(depositIntents.txHash),
        lt(depositIntents.createdAt, new Date(Date.now() - HASH_RETRY_AFTER_MS)),
      ),
    )
    .orderBy(asc(depositIntents.createdAt))
    .limit(HASH_RETRY_BATCH);

  let recovered = 0;
  for (const intent of stuck) {
    if (!intent.txHash) continue;
    try {
      const observed = await chain.observe(intent.txHash as `0x${string}`);
      if (!observed) continue;
      const outcome = await creditDeposit(observed);
      if (outcome.status === 'credited') {
        recovered += 1;
        logger.info('deposit.credited', {
          intentId: outcome.intentId,
          chips: outcome.chips,
          txHash: intent.txHash,
          source: 'hash-retry',
        });
      }
    } catch (error) {
      // One unreadable receipt must not stop the others.
      logger.warn('deposit.retry-failed', { intentId: intent.id, error: describe(error) });
    }
  }
  return recovered;
}

/**
 * Writes off requests nobody paid for.
 *
 * The chain is asked before anything is written off. The vault refuses to reuse
 * an intent id, so if it says the id was consumed then somebody's money is on
 * chain against this row, and the row stays open for a person to settle rather
 * than being closed over the top of a real deposit.
 */
async function expireStaleIntents(chain: DepositChain): Promise<number> {
  const stale = await db
    .select({ id: depositIntents.id })
    .from(depositIntents)
    .where(
      and(eq(depositIntents.status, 'pending'), lt(depositIntents.createdAt, new Date(Date.now() - INTENT_TTL_MS))),
    )
    .limit(100);

  let expired = 0;
  for (const intent of stale) {
    let consumed: boolean;
    try {
      consumed = await chain.consumed(intentToBytes32(intent.id));
    } catch (error) {
      // Not knowing is a reason to leave it alone.
      logger.warn('deposit.expiry-check-failed', { intentId: intent.id, error: describe(error) });
      continue;
    }

    if (consumed) {
      logger.error('deposit.paid-but-uncredited', {
        intentId: intent.id,
        detail: 'the vault consumed this intent but no credit was written; settle it by hand',
      });
      continue;
    }

    const [row] = await db
      .update(depositIntents)
      .set({ status: 'expired' })
      .where(and(eq(depositIntents.id, intent.id), eq(depositIntents.status, 'pending')))
      .returning({ id: depositIntents.id });
    if (row) expired += 1;
  }
  return expired;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
}

/**
 * Runs the sweep on a timer for the life of the process.
 *
 * Deliberately a plain interval rather than a subscription: a dropped websocket
 * that silently stops delivering logs looks exactly like a quiet chain, and
 * this is the code path that a player's money depends on.
 */
export class DepositWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastSweepAt: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly intervalMs = Number(process.env.DEPOSIT_SWEEP_INTERVAL_MS ?? 20_000)) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Do not hold the process open on this alone; the tables are what keep it alive.
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** What the health check reports about deposits. */
  status(): { lastSweepAt: number | null; lastError: string | null; watching: boolean } {
    return { lastSweepAt: this.lastSweepAt, lastError: this.lastError, watching: this.timer !== null };
  }

  private async tick(): Promise<void> {
    // Sweeps must not overlap: two scans from the same cursor would read the
    // same logs twice and race each other to credit them.
    if (this.running) return;
    this.running = true;
    try {
      const report = await sweepDeposits();
      this.lastSweepAt = Date.now();
      this.lastError = null;
      if (report.credited || report.expired || report.conflicts || report.recovered) {
        logger.info('deposit.sweep', {
          credited: report.credited,
          recovered: report.recovered,
          expired: report.expired,
          conflicts: report.conflicts,
          scannedTo: report.scannedTo === null ? null : Number(report.scannedTo),
        });
      }
    } catch (error) {
      this.lastError = describe(error);
      logger.error('deposit.sweep-failed', { error: this.lastError });
    } finally {
      this.running = false;
    }
  }
}
