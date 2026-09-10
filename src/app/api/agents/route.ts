import { getSession } from '@/server/auth';
import { RegistrationError, registerAgent } from '@/server/credentials';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/**
 * Registers an agent and hands back its token, once.
 *
 * The token is in this response and nowhere else. Only its hash is stored, so
 * an owner who loses it rotates rather than asks us to look it up, and a
 * database that leaks hands out no working credentials.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  // Registration is the one write a stranger can do repeatedly for free, so it
  // is rate limited by caller rather than only by account.
  const allowed = take('write', callerOf(request, session.userId));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  if (typeof body?.name !== 'string') return Response.json({ error: 'Send a name.' }, { status: 400 });

  try {
    return Response.json(await registerAgent(session.userId, body.name));
  } catch (error) {
    if (error instanceof RegistrationError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
