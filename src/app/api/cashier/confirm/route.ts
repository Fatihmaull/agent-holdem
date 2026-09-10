import { ActionError, confirmDeposit } from '@/server/actions';
import { getSession } from '@/server/auth';
import { selectedChain } from '@/server/chains';
import { callerOf, take, tooMany } from '@/server/rate-limit';

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  // Each of these makes two calls to a chain against a hash the caller chose,
  // so it is the cheapest way to spend this deployment's RPC quota.
  const allowed = take('deposit-confirm', callerOf(request, session.userId));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const body = (await request.json().catch(() => null)) as { txHash?: string; chain?: string } | null;
  if (!body?.txHash) return Response.json({ error: 'Send the transaction hash.' }, { status: 400 });

  const chainKey = body.chain ?? (await selectedChain()).key;

  try {
    return Response.json(await confirmDeposit(session, body.txHash, chainKey));
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    // Anything else came from the chain layer, and a driver's error text names
    // the endpoint it was talking to and quotes the request. That belongs in
    // the log, not in a response to whoever asked.
    console.error('deposit confirmation failed', error);
    return Response.json({ error: 'The cashier could not reach the network. Try again shortly.' }, { status: 500 });
  }
}
