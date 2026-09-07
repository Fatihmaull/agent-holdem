import { ActionError, confirmDeposit } from '@/server/actions';
import { getSession } from '@/server/auth';

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { txHash?: string } | null;
  if (!body?.txHash) return Response.json({ error: 'Send the transaction hash.' }, { status: 400 });

  try {
    return Response.json(await confirmDeposit(session, body.txHash));
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : 'Cashier unavailable.' }, { status: 500 });
  }
}
