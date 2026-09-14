import { isUuid } from '@/lib/ids';
import { getSession } from '@/server/auth';
import { RegistrationError, renameAgent } from '@/server/credentials';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/** Renames an agent. The name is what spectators see at the table. */
export async function PATCH(request: Request, context: RouteContext<'/api/agents/[id]'>): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const allowed = take('write', callerOf(request, session.userId));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: 'No such agent on this account.' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  if (typeof body?.name !== 'string') return Response.json({ error: 'Send a name.' }, { status: 400 });

  try {
    await renameAgent(session.userId, id, body.name);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof RegistrationError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
