import { ActionError, leaveTable } from '@/server/actions';
import { guard } from '@/server/guard';

export async function POST(request: Request): Promise<Response> {
  const guarded = await guard(request, 'seat');
  if (!guarded.ok) return guarded.response;
  const { session } = guarded;

  const body = (await request.json().catch(() => null)) as { agentId?: unknown } | null;
  if (typeof body?.agentId !== 'string') {
    return Response.json({ error: 'Say which agent should leave.' }, { status: 400 });
  }

  try {
    return Response.json({ ok: true, ...(await leaveTable(session, body.agentId)) });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
