import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sql } from '../db/client';
import { agents, ledgerEntries, seats, users } from '../db/schema';
import { OPPONENT_COLORS } from '../agent/colors';
import { TABLES, tableById } from '../lib/economy';

/**
 * Seats throwaway agents so a table can actually deal during development.
 *
 * These exist only here. The product itself has no house agents: real users
 * play real users, which is the rule this script is careful not to break. It
 * refuses to run against a production database.
 */

const CHARACTERS = [
  {
    name: 'Viridian',
    instructions:
      'Play tight and punish. Fold anything weak before the flop. When you do enter a pot, bet three quarters of it on every street and do not slow down for one raise.',
  },
  {
    name: 'Cinnabar',
    instructions:
      'Apply pressure constantly. Raise from late position with almost anything. Bluff the river whenever the board missed and your opponent has shown no strength.',
  },
  {
    name: 'Cerulean',
    instructions:
      'Follow the maths and nothing else. Call only when the price is below your equity. Never bluff. Never fold a hand that is getting the right price.',
  },
  {
    name: 'Marigold',
    instructions:
      'Trap. Check strong hands to let opponents bet into you, then raise the turn. Bet small with medium hands to keep weak ones in.',
  },
  {
    name: 'Amethyst',
    instructions:
      'Be unreadable. Vary your sizing at random. Occasionally shove with nothing. Fold hands you would normally play about one time in four.',
  },
  {
    name: 'Umber',
    instructions:
      'Survive first. Never risk more than a third of your stack in one hand unless you hold two pair or better. Fold to any all-in without the nuts.',
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-agents is a development tool and will not run in production');
  }

  const tableId = process.argv[2] ?? TABLES[4].id;
  const table = tableById(tableId);
  if (!table) throw new Error(`no such table: ${tableId}. Try one of: ${TABLES.map((t) => t.id).join(', ')}`);

  const count = Number(process.argv[3] ?? table.seats);
  const wanted = Math.min(count, table.seats, CHARACTERS.length);

  const existing = await db
    .select({ seatIndex: seats.seatIndex, color: agents.color, name: agents.name })
    .from(seats)
    .innerJoin(agents, eq(agents.id, seats.agentId))
    .where(eq(seats.tableId, tableId));

  const used = new Set(existing.map((row) => row.seatIndex));
  const takenColors = new Set(existing.map((row) => row.color));
  const takenNames = new Set(existing.map((row) => row.name));

  for (let i = 0; i < wanted; i++) {
    const open = Array.from({ length: table.seats }, (_, index) => index).find((index) => !used.has(index));
    if (open === undefined) break;
    used.add(open);

    const character = CHARACTERS.find((entry) => !takenNames.has(`${entry.name} (dev)`));
    if (!character) break;
    takenNames.add(`${character.name} (dev)`);

    const color = OPPONENT_COLORS.find((entry) => !takenColors.has(entry.id));
    if (!color) break;
    takenColors.add(color.id);
    const address = `0x${randomBytes(20).toString('hex')}`;
    const startingChips = table.buyIn * 4;

    await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ address, chips: startingChips }).returning({ id: users.id });

      await tx.insert(ledgerEntries).values({
        userId: user.id,
        delta: startingChips,
        balanceAfter: startingChips,
        reason: 'adjustment',
        reference: 'dev-seed',
      });

      const [agent] = await tx
        .insert(agents)
        .values({
          userId: user.id,
          name: `${character.name} (dev)`,
          color: color.id,
          instructions: character.instructions,
        })
        .returning({ id: agents.id });

      await tx
        .update(users)
        .set({ chips: startingChips - table.buyIn })
        .where(eq(users.id, user.id));

      await tx.insert(ledgerEntries).values({
        userId: user.id,
        delta: -table.buyIn,
        balanceAfter: startingChips - table.buyIn,
        reason: 'table-buy-in',
        reference: `${tableId}:${open}`,
      });

      await tx.insert(seats).values({ tableId, seatIndex: open, agentId: agent.id, stack: table.buyIn });
    });

    console.log(`seated ${character.name} (dev) at ${tableId} seat ${open}`);
  }

  await sql.end();
  console.log(`\nRestart the dev server, or wait a few seconds, and ${tableId} will start dealing.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
