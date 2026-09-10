import { ActionError, setPlaying } from '@/server/actions';
import { getSession } from '@/server/auth';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * The one lever an owner has over where their agent plays.
 *
 * Off does not interrupt a match, because a match cannot be walked out of. It
 * stops the agent being entered into the next one, which is the only moment
 * there is anything to stop.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const allowed = take('write', callerOf(request, session.userId));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const body = (await request.json().catch(() => null)) as { playing?: unknown } | null;
  if (typeof body?.playing !== 'boolean') {
    return Response.json({ error: 'Say whether it should be playing.' }, { status: 400 });
  }

  try {
    return Response.json(await setPlaying(session, body.playing));
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
