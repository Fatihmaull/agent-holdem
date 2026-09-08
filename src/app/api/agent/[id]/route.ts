import { ActionError, deleteAgent, saveAgent } from '@/server/actions';
import { guard } from '@/server/guard';

export async function POST(request: Request, context: RouteContext<'/api/agent/[id]'>): Promise<Response> {
  const guarded = await guard(request, 'write');
  if (!guarded.ok) return guarded.response;
  const { session } = guarded;

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

export async function DELETE(request: Request, context: RouteContext<'/api/agent/[id]'>): Promise<Response> {
  const guarded = await guard(request, 'write');
  if (!guarded.ok) return guarded.response;
  const { session } = guarded;

  const { id } = await context.params;
  try {
    await deleteAgent(session, id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
