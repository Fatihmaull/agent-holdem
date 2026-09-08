import { ActionError, startDeposit } from '@/server/actions';
import { guard } from '@/server/guard';

export async function POST(request: Request): Promise<Response> {
  const guarded = await guard(request, 'cashier');
  if (!guarded.ok) return guarded.response;
  const { session } = guarded;

  const body = (await request.json().catch(() => null)) as { packageId?: string } | null;
  if (!body?.packageId) return Response.json({ error: 'Choose a package.' }, { status: 400 });

  try {
    return Response.json(await startDeposit(session, body.packageId));
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: error instanceof Error ? error.message : 'Cashier unavailable.' }, { status: 500 });
  }
}
