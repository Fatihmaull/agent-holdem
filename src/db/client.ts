import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and start Postgres with docker compose up -d.');
}

/**
 * The app runs as one long-lived process, so a single pool is shared for the
 * life of the server. `next dev` reloads modules, so the pool is cached on
 * globalThis to avoid opening a new one on every hot reload.
 */
const globalForDb = globalThis as unknown as { __agentholdemSql?: ReturnType<typeof postgres> };

const sql = globalForDb.__agentholdemSql ?? postgres(connectionString, { max: 10 });
if (process.env.NODE_ENV !== 'production') globalForDb.__agentholdemSql = sql;

export const db = drizzle(sql, { schema });
export { sql };
