import { ActionError, deleteTemplate } from '@/server/actions';
import { getSession } from '@/server/auth';

export async function DELETE(_request: Request, context: RouteContext<'/api/templates/[id]'>): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const { id } = await context.params;
  try {
    await deleteTemplate(session, id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
