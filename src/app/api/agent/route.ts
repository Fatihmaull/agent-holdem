import { ActionError, createAgent } from '@/server/actions';
import { guard } from '@/server/guard';

/** Creates another agent for this account. */
export async function POST(request: Request): Promise<Response> {
  const guarded = await guard(request, 'write');
  if (!guarded.ok) return guarded.response;
  const { session } = guarded;

  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; instructions?: unknown }
    | null;
  if (typeof body?.name !== 'string') {
    return Response.json({ error: 'Send a name for the agent.' }, { status: 400 });
  }
  if (body.instructions !== undefined && typeof body.instructions !== 'string') {
    return Response.json({ error: 'Instructions must be text.' }, { status: 400 });
  }

  try {
    const created = await createAgent(session, {
      name: body.name,
      ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
    });
    return Response.json(created);
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
