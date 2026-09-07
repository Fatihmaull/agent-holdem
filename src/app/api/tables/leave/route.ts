import { ActionError, leaveTable } from '@/server/actions';
import { getSession } from '@/server/auth';

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

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
