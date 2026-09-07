import { headers } from 'next/headers';
import { signIn } from '@/server/auth';

export async function POST(request: Request): Promise<Response> {
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
