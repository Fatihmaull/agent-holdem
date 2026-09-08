import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { ledgerEntries, seats, users } from '../db/schema';

/**
 * Proof that we have neither invented nor lost a chip.
 *
 * The ledger is the record and `users.chips` is a cache of it, so the two
 * drifting apart is the first sign of a bug that costs somebody money. Checked
 * by a script rather than by eye, because the arithmetic is exactly the kind
 * nobody notices being wrong.
 *
 * ## What is actually true
 *
 * The obvious statement — "balances plus stacks equals the ledger" — is false,
 * and believing it would make this script cry wolf on every healthy table. Two
 * things break it. Winning a pot moves chips between two seats and writes no
 * ledger entry, because nothing entered or left an account. And a buy-in writes
 * a negative delta while the chips are still very much in existence, sitting on
 * a table: the ledger records chips crossing the boundary of an *account*, not
 * chips ceasing to exist.
 *
 * So the checks below are the statements that do hold:
 *
 * 1. Every chip in a balance is explained by the ledger. `users.chips` starts
 *    at zero and every write to it writes its own delta in the same
 *    transaction, so the sum of an account's deltas is its balance, exactly —
 *    and the same holds across every account at once.
 * 2. For each account, `users.chips` also equals the running balance on its
 *    most recent entry. This catches a delta that was written correctly against
 *    a balance that was not.
 * 3. For each table, the stacks in front of the seats equal what has been
 *    bought in less what has been cashed out. Hands move chips between seats
 *    and never across the felt's edge, so a table's total only changes when
 *    somebody sits down or stands up.
 *
 * Together those pin down every chip: one and two say the balances are honest,
 * three says the tables are, and nothing else holds a chip.
 */

export interface Drift {
  scope: string;
  expected: number;
  actual: number;
  detail: string;
}

export interface ReconcileReport {
  accounts: number;
  /** Chips sitting in account balances. */
  balances: number;
  /** Chips sitting in front of a seat. */
  stacks: number;
  /** Sum of every ledger delta, which is what the balances should add up to. */
  ledger: number;
  /**
   * Chips that have ever entered or left existence: deposits in, redemptions
   * out, corrections either way. Buying into a table is not issuance — those
   * chips were already somebody's.
   */
  issued: number;
  /** Every chip that exists anywhere. The number an operator actually wants. */
  inCirculation: number;
  drifts: Drift[];
}

export async function reconcile(): Promise<ReconcileReport> {
  const [totals] = await db
    .select({
      accounts: sql<number>`(select count(*)::int from ${users})`,
      balances: sql<number>`(select coalesce(sum(${users.chips}), 0)::int from ${users})`,
      stacks: sql<number>`(select coalesce(sum(${seats.stack}), 0)::int from ${seats})`,
      ledger: sql<number>`(select coalesce(sum(${ledgerEntries.delta}), 0)::int from ${ledgerEntries})`,
      issued: sql<number>`(select coalesce(sum(${ledgerEntries.delta}), 0)::int from ${ledgerEntries} where ${ledgerEntries.reason} in ('deposit', 'redemption', 'adjustment'))`,
    })
    .from(sql`(select 1) as one`);

  const drifts: Drift[] = [];
  const inCirculation = totals.balances + totals.stacks;

  // 1 · Every chip that exists was issued. Deposits are the only way a chip is
  // created and redemptions the only way one is destroyed, so anything held
  // beyond that difference came from nowhere — including a stack sitting at a
  // table that nobody bought into.
  if (inCirculation !== totals.issued) {
    drifts.push({
      scope: 'system',
      expected: totals.issued,
      actual: inCirculation,
      detail: `${totals.balances} in balances and ${totals.stacks} on tables, against ${totals.issued} ever issued`,
    });
  }

  // 2 · Every chip in a balance is explained by that account's ledger.
  if (totals.balances !== totals.ledger) {
    drifts.push({
      scope: 'system',
      expected: totals.ledger,
      actual: totals.balances,
      detail: 'account balances do not add up to the sum of every ledger entry',
    });
  }

  drifts.push(...(await accountDrifts()));
  drifts.push(...(await tableDrifts()));

  return { ...totals, inCirculation, drifts };
}

/** Every account whose balance disagrees with its own ledger. */
async function accountDrifts(): Promise<Drift[]> {
  const accounts = await db
    .select({ id: users.id, address: users.address, chips: users.chips })
    .from(users)
    .orderBy(users.createdAt);

  // Summed deltas and the most recent running total, in one pass each. Written
  // as plain SQL rather than as correlated subqueries because `distinct on` is
  // the only concise way to ask for "the latest row per account".
  const summed = await db
    .select({ userId: ledgerEntries.userId, total: sql<number>`sum(${ledgerEntries.delta})::int` })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.userId);

  const latest = await db.execute<{ user_id: string; balance_after: number }>(
    sql`select distinct on (user_id) user_id, balance_after from ${ledgerEntries} order by user_id, id desc`,
  );

  const totals = new Map(summed.map((row) => [row.userId, row.total]));
  const running = new Map([...latest].map((row) => [row.user_id, Number(row.balance_after)]));

  const drifts: Drift[] = [];
  for (const account of accounts) {
    const total = totals.get(account.id) ?? 0;
    if (account.chips !== total) {
      drifts.push({
        scope: `account ${account.address}`,
        expected: total,
        actual: account.chips,
        detail: 'the balance does not equal the sum of this account\u2019s ledger entries',
      });
    }

    const last = running.get(account.id);
    if (last !== undefined && last !== account.chips) {
      drifts.push({
        scope: `account ${account.address}`,
        expected: last,
        actual: account.chips,
        detail: 'the balance does not match the running total on the most recent ledger entry',
      });
    }
  }
  return drifts;
}

/**
 * Every table holding a different number of chips than was carried onto it.
 *
 * Buy-ins and cash-outs both reference `tableId:seatIndex`, so what a table is
 * owed can be read straight off the ledger without trusting the seats.
 */
async function tableDrifts(): Promise<Drift[]> {
  const carried = await db
    .select({
      tableId: sql<string>`split_part(${ledgerEntries.reference}, ':', 1)`,
      // Buy-ins are negative deltas leaving an account and cash-outs positive
      // ones returning, so a table holds the negation of the two together.
      net: sql<number>`(-sum(${ledgerEntries.delta}))::int`,
    })
    .from(ledgerEntries)
    .where(sql`${ledgerEntries.reason} in ('table-buy-in', 'table-cash-out')`)
    .groupBy(sql`split_part(${ledgerEntries.reference}, ':', 1)`);

  const seated = await db
    .select({ tableId: seats.tableId, stack: sql<number>`coalesce(sum(${seats.stack}), 0)::int` })
    .from(seats)
    .groupBy(seats.tableId);

  const onTable = new Map(seated.map((row) => [row.tableId, row.stack]));
  const drifts: Drift[] = [];

  for (const row of carried) {
    const actual = onTable.get(row.tableId) ?? 0;
    onTable.delete(row.tableId);
    if (actual !== row.net) {
      drifts.push({
        scope: `table ${row.tableId}`,
        expected: row.net,
        actual,
        detail: 'the stacks at this table do not equal what was bought in less what was cashed out',
      });
    }
  }

  // A table with stacks on it but no buy-ins on the ledger is chips from nowhere.
  for (const [tableId, stack] of onTable) {
    if (stack === 0) continue;
    drifts.push({
      scope: `table ${tableId}`,
      expected: 0,
      actual: stack,
      detail: 'there are stacks at this table but no buy-in was ever recorded for it',
    });
  }

  return drifts;
}
