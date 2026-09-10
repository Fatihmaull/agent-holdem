import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { db, sql } from '../db/client';
import { ledgerEntries, users } from '../db/schema';
import { registerAgent } from '../server/credentials';
import { STARTING_GRANT } from '../lib/economy';

/**
 * Creates accounts and agents, and writes the field file that runs them.
 *
 * One account per agent, on purpose. The matchmaker refuses to seat two agents
 * with the same owner at one table, because an owner who sees both sets of hole
 * cards can have one fold every pot the other contests until the chips are
 * wherever they want them. So a field sharing an account could never form a
 * match at all.
 *
 * The arithmetic that follows from that: N accounts can put at most N agents in
 * one match, so running N+1 agents leaves one permanently free. A stranger who
 * connects is then seated against the spare within seconds rather than waiting
 * out somebody else's match, which at a hundred hands is over an hour.
 *
 * Addresses here are random rather than real wallets, which is why this refuses
 * to run against production: nobody can ever sign in to these accounts.
 */

const CHARACTERS = [
  {
    name: 'Viridian',
    strategy:
      'Play tight and punish. Fold anything weak before the flop. When you do enter a pot, bet three quarters of it on every street and do not slow down for one raise.',
  },
  {
    name: 'Cinnabar',
    strategy:
      'Apply pressure constantly. Raise from late position with almost anything. Bluff the river whenever the board missed and your opponent has shown no strength.',
  },
  {
    name: 'Cerulean',
    strategy:
      'Follow the maths and nothing else. Call only when the price is below your equity. Never bluff. Never fold a hand that is getting the right price.',
  },
  {
    name: 'Marigold',
    strategy:
      'Trap. Check strong hands to let opponents bet into you, then raise the turn. Bet small with medium hands to keep weak ones in.',
  },
  {
    name: 'Amethyst',
    strategy:
      'Be unreadable. Vary your sizing at random. Occasionally shove with nothing. Fold hands you would normally play about one time in four.',
  },
  {
    name: 'Umber',
    strategy:
      'Survive first. Never risk more than a third of your stack in one hand unless you hold two pair or better. Fold to any all-in without the nuts.',
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-agents is a development tool and will not run in production');
  }

  const wanted = Math.min(Number(process.argv[2] ?? CHARACTERS.length), CHARACTERS.length);
  const modelSeats = Number(process.env.SEED_MODEL_AGENTS ?? 0);
  const out = process.argv[3] ?? 'field.json';

  const field: Array<{ token: string; brain: 'model' | 'heuristic'; strategy?: string; name: string }> = [];

  for (const [index, character] of CHARACTERS.slice(0, wanted).entries()) {
    const address = `0x${randomBytes(20).toString('hex')}`;

    const userId = await db.transaction(async (tx) => {
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

      return user.id;
    });

    const name = `${character.name} (dev)`;
    const { token } = await registerAgent(userId, name);

    const brain = index < modelSeats ? 'model' : 'heuristic';
    field.push(brain === 'model' ? { name, token, brain, strategy: character.strategy } : { name, token, brain });

    console.log(`created ${name} (${brain})`);
  }

  writeFileSync(out, `${JSON.stringify(field, null, 2)}\n`);
  await sql.end();

  console.log(`\nwrote ${field.length} agents to ${out}`);
  console.log('run them with:');
  console.log(`  AGENT_FIELD=${out} pnpm --filter @agentholdem/agent field`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
