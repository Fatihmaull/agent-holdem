import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { db, sql } from '../db/client';
import { agents } from '../db/schema';
import { registerAgent } from '../server/credentials';

/**
 * Adds one more agent to an account that already has one.
 *
 * The matchmaker refuses to seat two agents of the same owner together, so this
 * agent can never join the match its stablemate is in. That is the point: with
 * N accounts a match holds at most N agents, and the extra one stays queued and
 * free for whoever turns up next.
 */
async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('give it the field file to append to');

  const [first] = await db.select({ userId: agents.userId }).from(agents).limit(1);
  if (!first) throw new Error('seed some agents first');

  const { token } = await registerAgent(first.userId, 'Spare (dev)');
  const field = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
  field.push({ name: 'Spare (dev)', token, brain: 'heuristic' });
  writeFileSync(path, `${JSON.stringify(field, null, 2)}\n`);

  console.log('added a spare on an account that already had an agent');
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
