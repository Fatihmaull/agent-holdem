import { ActionError, joinTable } from '@/server/actions';
import { getSession } from '@/server/auth';

export async function POST(_request: Request, context: RouteContext<'/api/tables/[id]/join'>): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const { id } = await context.params;
  try {
    return Response.json(await joinTable(session, id));
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
