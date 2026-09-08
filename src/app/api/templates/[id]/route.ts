import { ActionError, deleteTemplate } from '@/server/actions';
import { guard } from '@/server/guard';

export async function DELETE(request: Request, context: RouteContext<'/api/templates/[id]'>): Promise<Response> {
  const guarded = await guard(request, 'write');
  if (!guarded.ok) return guarded.response;
  const { session } = guarded;

  const { id } = await context.params;
  try {
    await deleteTemplate(session, id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
