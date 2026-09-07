import { ActionError, deployAgents } from '@/server/actions';
import { getSession } from '@/server/auth';

/** One piece of writing, several tables, one request. */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; instructions?: unknown; tableIds?: unknown }
    | null;
  if (typeof body?.name !== 'string' || typeof body?.instructions !== 'string') {
    return Response.json({ error: 'Send a name and the instructions to deploy.' }, { status: 400 });
  }
  if (!Array.isArray(body.tableIds) || body.tableIds.some((id) => typeof id !== 'string')) {
    return Response.json({ error: 'Send the tables to deploy to.' }, { status: 400 });
  }

  try {
    return Response.json(
      await deployAgents(session, {
        name: body.name,
        instructions: body.instructions,
        tableIds: body.tableIds as string[],
      }),
    );
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
