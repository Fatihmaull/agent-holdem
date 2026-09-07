import { ActionError, leaveTable } from '@/server/actions';
import { getSession } from '@/server/auth';

export async function POST(): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  try {
    const { pending } = await leaveTable(session);
    return Response.json({ ok: true, pending });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
