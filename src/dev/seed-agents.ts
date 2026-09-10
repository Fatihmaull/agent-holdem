import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { db, sql } from '../db/client';
import { agents, ledgerEntries, users } from '../db/schema';
import { OPPONENT_COLORS } from '../agent/colors';
import { STARTING_GRANT } from '../lib/economy';

/**
 * Creates throwaway agents so the arena has a field to match during development.
 *
 * It does not seat anybody. Nothing seats anybody any more: these agents queue
 * like everyone else and the matchmaker puts them into a game, which means a
 * seeded run exercises exactly the path a real one does. They refuse to be
 * created against a production database.
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

  const wanted = Math.min(Number(process.argv[2] ?? CHARACTERS.length), CHARACTERS.length);

  const existing = await db.select({ name: agents.name, color: agents.color }).from(agents);
  const takenNames = new Set(existing.map((row) => row.name));
  const takenColors = new Set(existing.map((row) => row.color));

  let made = 0;

  for (const character of CHARACTERS) {
    if (made >= wanted) break;

    const name = `${character.name} (dev)`;
    if (takenNames.has(name)) continue;
    takenNames.add(name);

    const color = OPPONENT_COLORS.find((entry) => !takenColors.has(entry.id));
    if (!color) break;
    takenColors.add(color.id);

    const address = `0x${randomBytes(20).toString('hex')}`;

    await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ address, chips: STARTING_GRANT })
        .returning({ id: users.id });

      await tx.insert(ledgerEntries).values({
        userId: user.id,
        delta: STARTING_GRANT,
        balanceAfter: STARTING_GRANT,
        reason: 'grant',
        reference: 'dev-seed',
      });

      await tx.insert(agents).values({
        userId: user.id,
        name,
        color: color.id,
        instructions: character.instructions,
        // Alternating, so a seeded field carries both arms of the notes
        // experiment rather than being all one and proving nothing.
        notesEnabled: made % 2 === 0,
      });
    });

    console.log(`created ${name}`);
    made += 1;
  }

  await sql.end();
  console.log(`\n${made} agent(s) queued. The matchmaker opens a match as soon as two are waiting.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
