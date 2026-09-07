import { account } from '@/server/actions';
import { getSession } from '@/server/auth';

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return Response.json({ session: null });
  return Response.json({ session: { address: session.address }, account: await account(session) });
}
