import 'dotenv/config';
import { db, sql } from '../db/client';
import { agents } from '../db/schema';
import { NotConfigured, publishRecord, registerIdentity } from '../server/erc8004';
import { enabledChains } from '../server/chains';
import { leaderboard } from '../server/metrics';

/**
 * Publishes the arena's records to ERC-8004.
 *
 * Run by an operator, never by the web server. Attesting signs transactions,
 * and the process serving pages deliberately holds no key at all, so this is
 * the only thing here that can write to a chain.
 *
 *   pnpm attest                     every agent with enough hands, on the default chain
 *   pnpm attest <chain-key>         the same, on a named chain
 *   pnpm attest <chain-key> <id>    one agent
 *
 * An agent with too few hands is skipped rather than published with a
 * confidence of zero. A registry full of scores that mean nothing is the exact
 * problem this integration exists to be better than.
 */

/** Below this the interval is so wide the score would be zero anyway. */
const MIN_HANDS = 200;

async function main(): Promise<void> {
  const chainKey = process.argv[2];
  const only = process.argv[3];

  const chains = enabledChains();
  const chain = chainKey ? chains.find((entry) => entry.key === chainKey) : chains[0];
  if (!chain) {
    throw new Error(`no such chain: ${chainKey}. Enabled: ${chains.map((entry) => entry.key).join(', ')}`);
  }

  const baseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'PUBLIC_BASE_URL is not set. The attestation URI has to be somewhere a reader can actually fetch it.',
    );
  }

  const owned = only ? [{ id: only }] : await db.select({ id: agents.id }).from(agents);

  const records = new Map((await leaderboard({ limit: 500 })).map((row) => [row.agentId, row]));

  console.log(`attesting on ${chain.name} as ${baseUrl}\n`);

  for (const agent of owned) {
    const record = records.get(agent.id);
    const hands = record?.rate.hands ?? 0;

    if (hands < MIN_HANDS) {
      console.log(`skip  ${record?.name ?? agent.id}: ${hands} hands, below ${MIN_HANDS}`);
      continue;
    }

    try {
      const identity = await registerIdentity(chain, agent.id, baseUrl);
      if (identity.txHash) console.log(`mint  ${record!.name}: agent ${identity.registryId} (${identity.txHash})`);

      const published = await publishRecord(chain, agent.id, baseUrl);
      console.log(
        `post  ${published.name}: ${published.attestation.winRateBb100} bb/100 over ${published.attestation.hands} hands, confidence ${published.attestation.confidence}`,
      );
      console.log(`      evidence ${published.evidenceHash}`);
    } catch (error) {
      // One agent that cannot be published does not stop the rest. A missing
      // registry address is worth saying once and plainly, since it is the
      // likeliest reason and it is a configuration problem, not a failure.
      if (error instanceof NotConfigured) {
        console.error(`stop  ${error.message}`);
        break;
      }
      console.error(`fail  ${record?.name ?? agent.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
