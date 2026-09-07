import { ActionError, startDeposit } from '@/server/actions';
import { getSession } from '@/server/auth';

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { packageId?: string } | null;
  if (!body?.packageId) return Response.json({ error: 'Choose a package.' }, { status: 400 });

  try {
    return Response.json(await startDeposit(session, body.packageId));
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : 'Cashier unavailable.' }, { status: 500 });
  }
}
