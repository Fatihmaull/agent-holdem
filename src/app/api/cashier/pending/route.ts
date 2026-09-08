import { noteDepositTx, unsettledDeposits } from '@/server/actions';
import { ActionError } from '@/server/actions';
import { getSession } from '@/server/auth';
import { guard } from '@/server/guard';

/**
 * Deposits that were paid but never credited.
 *
 * The cashier asks for these when it opens so a player who closed the tab
 * mid-confirmation is picked back up rather than left to find their money gone.
 */
export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ deposits: [] });
  return Response.json({ deposits: await unsettledDeposits(session) });
}

/** Records the transaction a deposit was paid with, before it has confirmed. */
export async function POST(request: Request): Promise<Response> {
  const guarded = await guard(request, 'cashier');
  if (!guarded.ok) return guarded.response;
  const { session } = guarded;

  const body = (await request.json().catch(() => null)) as { intentId?: string; txHash?: string } | null;
  if (!body?.intentId || !body?.txHash) {
    return Response.json({ error: 'Send the deposit and its transaction hash.' }, { status: 400 });
  }

  try {
    await noteDepositTx(session, body.intentId, body.txHash);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
