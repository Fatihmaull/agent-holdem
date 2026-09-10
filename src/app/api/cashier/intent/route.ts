import { ActionError, startDeposit } from '@/server/actions';
import { getSession } from '@/server/auth';
import { selectedChain } from '@/server/chains';
import { callerOf, take, tooMany } from '@/server/rate-limit';

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  // Every call writes an intent row, and nothing else ever deletes one.
  const allowed = take('deposit-start', callerOf(request, session.userId));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const body = (await request.json().catch(() => null)) as { packageId?: string; chain?: string } | null;
  if (!body?.packageId) return Response.json({ error: 'Choose a package.' }, { status: 400 });

  const chainKey = body.chain ?? (await selectedChain()).key;

  try {
    return Response.json(await startDeposit(session, body.packageId, chainKey));
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    console.error('deposit intent failed', error);
    return Response.json({ error: 'The cashier is unavailable. Try again shortly.' }, { status: 500 });
  }
}
