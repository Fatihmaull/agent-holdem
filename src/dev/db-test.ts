/**
 * A real database for tests that need one.
 *
 * Every test in `*.test.ts` is pure and runs anywhere. The money lives in
 * `actions.ts` and `deposits.ts`, though, and neither is meaningfully testable
 * without a database: `FOR UPDATE`, a unique index and a conditional update are
 * the things doing the work, and a fake would only re-implement whatever the
 * code already believes. So these run against Postgres, in `*.itest.ts`, under
 * their own command — a contributor without Docker is not blocked from
 * `pnpm test`.
 *
 * The connection is redirected to a separate database before anything can read
 * it. Import order is the mechanism, as in `test-env.ts`: import this first and
 * it is evaluated before the client that reads the value, so a test can never
 * point itself at the database somebody is developing against.
 */
import 'dotenv/config';

export const TEST_DATABASE_URL = resolveTestUrl();

function resolveTestUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and run docker compose up -d.');
  }

  const url = new URL(base);
  const name = url.pathname.replace(/^\//, '') || 'agentholdem';
  if (name.endsWith('_test')) return base;
  url.pathname = `/${name}_test`;
  return url.toString();
}

/** The database the tests must never touch, for the safety check below. */
const developmentUrl = process.env.DATABASE_URL;

process.env.DATABASE_URL = TEST_DATABASE_URL;
// The engine deals hands for the life of a process. A test run has no business
// starting one, least of all against the database it is about to truncate.
process.env.AGENTHOLDEM_DISABLE_ENGINE = '1';
process.env.SESSION_SECRET ||= 'test-secret-not-used-for-anything-real';

/** Connection string of the server the test database lives on, for maintenance. */
export function maintenanceUrl(): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = '/postgres';
  return url.toString();
}

export function testDatabaseName(): string {
  return new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
}

/**
 * Refuses to run against anything but the test database.
 *
 * `reset` truncates every table. Getting this wrong once, against the database
 * somebody has a dev server pointed at, is worse than any test it enables.
 */
function assertTestDatabase(): void {
  if (developmentUrl && TEST_DATABASE_URL === developmentUrl && !testDatabaseName().endsWith('_test')) {
    throw new Error(
      `refusing to run destructive tests against ${testDatabaseName()}: point TEST_DATABASE_URL at a database whose name ends in _test`,
    );
  }
}

/**
 * Empties every table.
 *
 * Truncate rather than a transaction per test: the code under test opens its
 * own transactions and takes row locks, and wrapping that in an outer
 * transaction would change the very behaviour being tested.
 */
export async function resetDatabase(): Promise<void> {
  assertTestDatabase();
  const { sql } = await import('../db/client');
  await sql.unsafe(
    'truncate table users, hands, chain_cursors restart identity cascade',
  );
}

export async function closeDatabase(): Promise<void> {
  const { sql } = await import('../db/client');
  await sql.end();
}

let addressCounter = 0;

/** A signed-in account with a balance, which is what most of these start from. */
export async function makeAccount(chips = 0): Promise<{ userId: string; address: string }> {
  const { db } = await import('../db/client');
  const { users } = await import('../db/schema');

  // Twenty hex characters is not a real address, but nothing here parses one;
  // it only has to be unique and lowercase, like every address we store.
  const address = `0x${(++addressCounter).toString(16).padStart(40, '0')}`;
  const [user] = await db.insert(users).values({ address, chips }).returning({ id: users.id });
  return { userId: user.id, address };
}
