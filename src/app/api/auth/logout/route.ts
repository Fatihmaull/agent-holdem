import { signOut } from '@/server/auth';

export async function POST(): Promise<Response> {
  await signOut();
  return Response.json({ ok: true });
}
