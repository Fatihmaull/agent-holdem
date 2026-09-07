import { ActionError, deleteAgent, saveAgent } from '@/server/actions';
import { getSession } from '@/server/auth';

export async function POST(request: Request, context: RouteContext<'/api/agent/[id]'>): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { name?: unknown; instructions?: unknown } | null;
  if (typeof body?.name !== 'string' || typeof body?.instructions !== 'string') {
    return Response.json({ error: 'Send a name and instructions.' }, { status: 400 });
  }

  const { id } = await context.params;
  try {
    await saveAgent(session, id, { name: body.name, instructions: body.instructions });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

export async function DELETE(_request: Request, context: RouteContext<'/api/agent/[id]'>): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const { id } = await context.params;
  try {
    await deleteAgent(session, id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
