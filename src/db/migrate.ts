import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql } from './client';

async function main(): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
  await sql.end();
  console.log('migrations applied');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
