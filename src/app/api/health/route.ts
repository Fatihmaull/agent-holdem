import { desc, isNotNull, sql as raw } from 'drizzle-orm';
import { db } from '@/db/client';
import { hands, seats } from '@/db/schema';
import { dealing } from '@/server/engine-lock';
import { allMatches } from '@/server/registry';

/**
 * Whether this deployment is actually running a poker room.
 *
 * A process that answers requests is not the same as a room that deals, and the
 * two fail separately: the engine can be stalled, or this can be the second
 * instance that correctly is not dealing at all. So the answer says which
 * process this is and when a hand was last finished, rather than "ok".
 *
 * Never cached. A cached health check reports the health of a moment that has
 * passed.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const engine = dealing();

  try {
    const [latest] = await db
      .select({ finishedAt: hands.endedAt })
      .from(hands)
      .where(isNotNull(hands.endedAt))
      .orderBy(desc(hands.endedAt))
      .limit(1);

    const [occupied] = await db.select({ count: raw<number>`count(*)::int` }).from(seats);

    const lastHandAt = latest?.finishedAt ?? null;
    const idleSeconds = lastHandAt === null ? null : Math.round((Date.now() - lastHandAt.getTime()) / 1000);

    return Response.json({
      // A page-serving instance is healthy without dealing. Only the process
      // holding the engine is judged on whether hands are being played.
      ok: true,
      dealing: engine,
      matches: engine ? allMatches().length : 0,
      seated: occupied?.count ?? 0,
      lastHandAt: lastHandAt?.toISOString() ?? null,
      idleSeconds,
    });
  } catch (error) {
    // The database is the one dependency nothing works without, so failing to
    // reach it is the one thing that makes this instance unhealthy.
    return Response.json(
      { ok: false, dealing: engine, error: error instanceof Error ? error.message : 'database unreachable' },
      { status: 503 },
    );
  }
}
