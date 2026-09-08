import '../dev/db-test';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql as raw } from 'drizzle-orm';
import { closeDatabase, makeAccount, resetDatabase } from '../dev/db-test';
import { db } from '../db/client';
import { chainCursors, depositIntents, ledgerEntries, users } from '../db/schema';
import { chipsToWei } from '../lib/economy';
import { intentToBytes32 } from '../lib/intent';
import { creditDeposit, sweepDeposits, type DepositChain } from './deposits';
import { REQUIRED_CONFIRMATIONS, type ObservedDeposit } from './chain';

/**
 * The deposit path, against a real database.
 *
 * What is being tested is not arithmetic — it is what happens when the same
 * event arrives twice, when a scan dies halfway, and when an intent is about to
 * be written off over the top of money that is already on chain. All three are
 * properties of the database and of the order operations run in, so none of
 * them would survive being tested against a fake.
 */

beforeEach(resetDatabase);
after(closeDatabase);

const block = 1_000n;

async function makeIntent(
  userId: string,
  chips: number,
  overrides: Partial<{ txHash: string; createdAt: Date; startBlock: number }> = {},
): Promise<string> {
  const [intent] = await db
    .insert(depositIntents)
    .values({
      userId,
      packageId: 'starter',
      chips,
      expectedWei: chipsToWei(chips).toString(),
      startBlock: overrides.startBlock ?? Number(block),
      ...(overrides.txHash ? { txHash: overrides.txHash } : {}),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    })
    .returning({ id: depositIntents.id });
  return intent.id;
}

function observed(
  intentId: string,
  payer: string,
  chips: number,
  over: Partial<ObservedDeposit> = {},
): ObservedDeposit {
  return {
    payer: payer as `0x${string}`,
    intentId: intentToBytes32(intentId),
    amountWei: chipsToWei(chips),
    blockNumber: block,
    confirmations: REQUIRED_CONFIRMATIONS,
    txHash: `0x${'a'.repeat(64)}`,
    ...over,
  };
}

async function balanceOf(userId: string): Promise<number> {
  const [row] = await db.select({ chips: users.chips }).from(users).where(eq(users.id, userId));
  return row.chips;
}

async function statusOf(intentId: string): Promise<string> {
  const [row] = await db
    .select({ status: depositIntents.status })
    .from(depositIntents)
    .where(eq(depositIntents.id, intentId));
  return row.status;
}

/** A chain that returns exactly what a test says it should. */
function scriptedChain(script: Partial<DepositChain> & { head?: () => Promise<bigint> } = {}): DepositChain {
  return {
    configured: () => true,
    head: script.head ?? (async () => block + REQUIRED_CONFIRMATIONS),
    scan: script.scan ?? (async () => []),
    observe: script.observe ?? (async () => null),
    consumed: script.consumed ?? (async () => false),
  };
}

test('a confirmed deposit credits chips and leaves a ledger entry that reconciles', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000);

  assert.equal(await balanceOf(account.userId), 0);

  const outcome = await creditDeposit(observed(intentId, account.address, 10_000));

  assert.equal(outcome.status, 'credited');
  if (outcome.status !== 'credited') return;
  assert.equal(outcome.chips, 10_000);
  assert.equal(outcome.balance, 10_000);
  assert.equal(await balanceOf(account.userId), 10_000);
  assert.equal(await statusOf(intentId), 'credited');

  const entries = await db
    .select({ delta: ledgerEntries.delta, balanceAfter: ledgerEntries.balanceAfter, reason: ledgerEntries.reason })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, account.userId));

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { delta: 10_000, balanceAfter: 10_000, reason: 'deposit' });
});

test('the same transaction submitted twice credits once', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000);
  const deposit = observed(intentId, account.address, 10_000);

  const first = await creditDeposit(deposit);
  const second = await creditDeposit(deposit);

  assert.equal(first.status, 'credited');
  assert.equal(second.status, 'already-credited');
  assert.equal(await balanceOf(account.userId), 10_000);

  const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, account.userId));
  assert.equal(entries.length, 1, 'a replay must not write a second ledger entry');
});

test('two callers racing on one deposit credit it once between them', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000);
  const deposit = observed(intentId, account.address, 10_000);

  // The row lock is the thing under test: without it both reads see a pending
  // intent and both go on to add chips.
  const outcomes = await Promise.all([creditDeposit(deposit), creditDeposit(deposit)]);

  const credited = outcomes.filter((outcome) => outcome.status === 'credited');
  assert.equal(credited.length, 1);
  assert.equal(await balanceOf(account.userId), 10_000);
});

test('a deposit from a different wallet is refused', async () => {
  const account = await makeAccount(0);
  const stranger = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000);

  const outcome = await creditDeposit(observed(intentId, stranger.address, 10_000));

  assert.equal(outcome.status, 'rejected');
  assert.equal(await balanceOf(account.userId), 0);
  assert.equal(await statusOf(intentId), 'pending');
});

test('a deposit smaller than the package buys nothing', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000);

  const outcome = await creditDeposit(observed(intentId, account.address, 9_999));

  assert.equal(outcome.status, 'rejected');
  assert.equal(await balanceOf(account.userId), 0);
});

test('overpaying buys chips at the same peg rather than being kept', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000);

  const outcome = await creditDeposit(observed(intentId, account.address, 12_500));

  assert.equal(outcome.status, 'credited');
  assert.equal(await balanceOf(account.userId), 12_500);
});

test('nothing is credited before the confirmation depth', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000);

  const outcome = await creditDeposit(
    observed(intentId, account.address, 10_000, { confirmations: REQUIRED_CONFIRMATIONS - 1n }),
  );

  assert.equal(outcome.status, 'unconfirmed');
  assert.equal(await balanceOf(account.userId), 0);
  assert.equal(await statusOf(intentId), 'pending');
});

test('a deposit naming an intent we never issued is refused, not credited to anyone', async () => {
  const account = await makeAccount(0);
  const outcome = await creditDeposit(observed('00000000-0000-4000-8000-000000000000', account.address, 10_000));

  assert.equal(outcome.status, 'rejected');
  assert.equal(await balanceOf(account.userId), 0);
});

test('the sweep credits a deposit nobody was watching, and records how far it read', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000);

  const report = await sweepDeposits(
    scriptedChain({
      head: async () => 1_100n,
      scan: async (from, to) =>
        from <= block && block <= to ? [observed(intentId, account.address, 10_000)] : [],
    }),
  );

  assert.equal(report.credited, 1);
  assert.equal(await balanceOf(account.userId), 10_000);

  const [cursor] = await db.select().from(chainCursors).where(eq(chainCursors.name, 'deposits'));
  assert.ok(cursor, 'the sweep must remember where it got to');
  // Only up to the confirmation depth: reading a block that can still be
  // reorganised away would credit a deposit that may not survive.
  assert.equal(cursor.blockNumber, Number(1_100n - (REQUIRED_CONFIRMATIONS - 1n)));
});

test('a sweep that dies halfway does not remember blocks it never read', async () => {
  const account = await makeAccount(0);
  await makeIntent(account.userId, 10_000);

  await assert.rejects(
    sweepDeposits(
      scriptedChain({
        head: async () => 50_000n,
        scan: async () => {
          throw new Error('rpc fell over');
        },
      }),
    ),
    /rpc fell over/,
  );

  const cursors = await db.select().from(chainCursors);
  assert.equal(cursors.length, 0, 'a failed scan must leave the cursor where it was');
});

test('the sweep starts from the oldest thing still owed rather than from the head', async () => {
  const account = await makeAccount(0);
  // Paid for long ago, at a height well behind the chain tip.
  const intentId = await makeIntent(account.userId, 10_000, { startBlock: 10 });

  let askedFrom: bigint | null = null;
  await sweepDeposits(
    scriptedChain({
      head: async () => 12n,
      scan: async (from, to) => {
        askedFrom ??= from;
        return from <= 10n && 10n <= to ? [observed(intentId, account.address, 10_000, { blockNumber: 10n })] : [];
      },
    }),
  );

  assert.equal(askedFrom, 10n);
  assert.equal(await balanceOf(account.userId), 10_000);
});

test('a transaction hash we were told about is chased even if no scan covered it', async () => {
  const account = await makeAccount(0);
  const txHash = `0x${'b'.repeat(64)}`;
  const intentId = await makeIntent(account.userId, 10_000, {
    txHash,
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  });

  const report = await sweepDeposits(
    scriptedChain({
      head: async () => 1_100n,
      observe: async (hash) =>
        hash === txHash ? observed(intentId, account.address, 10_000, { txHash: hash }) : null,
    }),
  );

  assert.equal(report.recovered, 1);
  assert.equal(await balanceOf(account.userId), 10_000);
});

test('an intent nobody ever paid for is written off', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000, {
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
  });

  const report = await sweepDeposits(scriptedChain({ head: async () => 1_100n, consumed: async () => false }));

  assert.equal(report.expired, 1);
  assert.equal(await statusOf(intentId), 'expired');
  assert.equal(await balanceOf(account.userId), 0);
});

test('an intent the vault says was paid is never written off', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000, {
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
  });

  // The vault refuses to reuse an intent id, so this is the chain saying real
  // money is sitting against a row we were about to close.
  const report = await sweepDeposits(scriptedChain({ head: async () => 1_100n, consumed: async () => true }));

  assert.equal(report.expired, 0);
  assert.equal(await statusOf(intentId), 'pending', 'a paid deposit must stay open for a person to settle');
});

test('an unreadable chain leaves stale intents alone rather than guessing', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000, {
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
  });

  const report = await sweepDeposits(
    scriptedChain({
      head: async () => 1_100n,
      consumed: async () => {
        throw new Error('rpc unavailable');
      },
    }),
  );

  assert.equal(report.expired, 0);
  assert.equal(await statusOf(intentId), 'pending');
});

test('a credited deposit is not expired later, however old it gets', async () => {
  const account = await makeAccount(0);
  const intentId = await makeIntent(account.userId, 10_000);
  await creditDeposit(observed(intentId, account.address, 10_000));
  await db
    .update(depositIntents)
    .set({ createdAt: raw`now() - interval '48 hours'` })
    .where(eq(depositIntents.id, intentId));

  await sweepDeposits(scriptedChain({ head: async () => 1_100n, consumed: async () => false }));

  assert.equal(await statusOf(intentId), 'credited');
  assert.equal(await balanceOf(account.userId), 10_000);
});
