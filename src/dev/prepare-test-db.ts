/**
 * Creates the test database if it is missing, then brings it up to date.
 *
 * Run before the integration suite rather than from inside it: creating a
 * database cannot happen while connected to it, and every test file would
 * otherwise race the others to do the same work.
 */
import { TEST_DATABASE_URL, maintenanceUrl, testDatabaseName } from './db-test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

async function main(): Promise<void> {
  const name = testDatabaseName();

  const admin = postgres(maintenanceUrl(), { max: 1 });
  try {
    const [existing] = await admin`select 1 from pg_database where datname = ${name}`;
    // Identifiers cannot be parameterised, and this one comes from our own
    // connection string rather than from any request.
    if (!existing) await admin.unsafe(`create database "${name.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }

  const sql = postgres(TEST_DATABASE_URL, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  } finally {
    await sql.end();
  }

  console.log(`test database ready: ${name}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
