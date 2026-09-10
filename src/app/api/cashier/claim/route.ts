import { ActionError, claimChips } from '@/server/actions';
import { getSession } from '@/server/auth';
import { callerOf, take, tooMany } from '@/server/rate-limit';

/** The daily chip claim. Once a day per account, enforced in the transaction. */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ error: 'Connect your wallet first.' }, { status: 401 });

  const allowed = take('write', callerOf(request, session.userId));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  try {
    return Response.json(await claimChips(session));
  } catch (error) {
    if (error instanceof ActionError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
