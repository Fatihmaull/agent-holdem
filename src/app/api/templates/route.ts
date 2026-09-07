import { ActionError, listTemplates, saveTemplate } from '@/server/actions';
import { getSession } from '@/server/auth';

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });
  return Response.json({ templates: await listTemplates(session) });
}

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { id?: unknown; name?: unknown; body?: unknown }
    | null;
  if (typeof body?.name !== 'string' || typeof body?.body !== 'string') {
    return Response.json({ error: 'Send a name and the text to save.' }, { status: 400 });
  }
  if (body.id !== undefined && typeof body.id !== 'string') {
    return Response.json({ error: 'That draft reference is not valid.' }, { status: 400 });
  }

  try {
    const template = await saveTemplate(session, {
      ...(body.id ? { id: body.id } : {}),
      name: body.name,
      body: body.body,
    });
    return Response.json({ template });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
