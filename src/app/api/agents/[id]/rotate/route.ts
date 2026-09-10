import { getSession } from '@/server/auth';
import { RegistrationError, rotateToken } from '@/server/credentials';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * Issues a new token and invalidates the old one.
 *
 * A token lives in a config file and config files reach public repositories, so
 * this is routine maintenance rather than incident response. A socket already
 * open on the old token keeps playing until it drops, because cutting an agent
 * off mid-hand would cost its owner a match to close a hole already closed.
 */
export async function POST(request: Request, context: RouteContext<'/api/agents/[id]/rotate'>): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const allowed = take('write', callerOf(request, session.userId));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const { id } = await context.params;

  try {
    return Response.json({ token: await rotateToken(session.userId, id) });
  } catch (error) {
    if (error instanceof RegistrationError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
