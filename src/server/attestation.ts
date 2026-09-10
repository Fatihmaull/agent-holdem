import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { attestations } from '../db/schema';
import { buildAttestation, type Attestation } from '../lib/erc8004';
import { leaderboard } from './metrics';

/**
 * Reading attestations, with nothing here that can sign one.
 *
 * Kept apart from the publishing code on purpose. The route that serves the
 * evidence document is reachable from the web, and the module that posts
 * attestations reads a private key: a route importing that module puts the
 * signing path one mistake away from a request handler, even though the running
 * server has no business ever using it. Publishing lives in `erc8004.ts` and
 * only `pnpm attest` imports it.
 */
/**
 * The document an attestation's hash refers to.
 *
 * Serves the attestation as published where there is one, so a reader
 * re-hashing it gets what is on chain, and the live figures where there is not.
 * A live document is explicitly marked unpublished: it is the same measurement,
 * but nothing has committed to it.
 */
export async function attestationFor(agentId: string): Promise<{ attestation: Attestation; published: boolean } | null> {
  const [latest] = await db
    .select({ evidence: attestations.evidence })
    .from(attestations)
    .where(eq(attestations.agentId, agentId))
    .orderBy(desc(attestations.createdAt))
    .limit(1);

  if (latest) return { attestation: latest.evidence as Attestation, published: true };

  const [record] = await leaderboard({ agentId, limit: 1 });
  if (!record) return null;

  return {
    attestation: buildAttestation({
      agentId,
      name: record.name,
      rating: { mu: record.ratingMu, sigma: record.ratingSigma },
      matches: record.matchesPlayed,
      wins: record.wins,
      hands: record.rate.hands,
      winRateBb100: record.rate.rate,
      earnings: record.earnings,
      measuredAt: new Date(),
    }),
    published: false,
  };
}
