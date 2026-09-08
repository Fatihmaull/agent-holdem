import { ActionError, joinTable } from '@/server/actions';
import { guard } from '@/server/guard';

export async function POST(request: Request, context: RouteContext<'/api/tables/[id]/join'>): Promise<Response> {
  const guarded = await guard(request, 'seat');
  if (!guarded.ok) return guarded.response;
  const { session } = guarded;

  const body = (await request.json().catch(() => null)) as { agentId?: unknown } | null;
  if (typeof body?.agentId !== 'string') {
    return Response.json({ error: 'Say which agent should take the seat.' }, { status: 400 });
  }

  const { id } = await context.params;
  try {
    return Response.json(await joinTable(session, id, body.agentId));
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
