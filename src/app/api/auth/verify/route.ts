import { headers } from 'next/headers';
import { signIn } from '@/server/auth';
import { callerOf, take, tooMany } from '@/server/rate-limit';

export async function POST(request: Request): Promise<Response> {
  // Signature checking is cheap but not free, and this is the one route that
  // will be found and hammered by anything scanning for wallet logins.
  const allowed = take('sign-in', callerOf(request, null));
  if (!allowed.ok) return tooMany(allowed.retryAfterMs);

  const body = (await request.json().catch(() => null)) as { message?: string; signature?: string } | null;
  if (!body?.message || !body?.signature) {
    return Response.json({ error: 'Send the signed message and its signature.' }, { status: 400 });
  }

  const headerList = await headers();
  const host = headerList.get('host') ?? 'localhost:3000';

  const result = await signIn(body.message, body.signature, host);
  if (!result.ok) return Response.json({ error: result.error }, { status: 401 });

  return Response.json({ address: result.session!.address });
}
