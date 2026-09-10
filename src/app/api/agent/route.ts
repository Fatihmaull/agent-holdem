import { ActionError, saveAgent } from '@/server/actions';
import { getSession } from '@/server/auth';
import { callerOf, take, tooMany } from '@/server/rate-limit';

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const allowed = take('write', callerOf(request, session.userId));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const body = (await request.json().catch(() => null)) as { name?: string; instructions?: string } | null;
  if (typeof body?.name !== 'string' || typeof body?.instructions !== 'string') {
    return Response.json({ error: 'Send a name and instructions.' }, { status: 400 });
  }

  try {
    await saveAgent(session, { name: body.name, instructions: body.instructions });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
