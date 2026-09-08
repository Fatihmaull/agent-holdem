import { signOut } from '@/server/auth';

/**
 * Deliberately not rate limited.
 *
 * Every other write is guarded, and this is the one where a limit would do
 * harm: signing out clears a cookie, costs nothing, and reaches no database.
 * Refusing it would leave somebody signed in against their wishes, which is a
 * worse outcome than any amount of it being called.
 */
export async function POST(): Promise<Response> {
  await signOut();
  return Response.json({ ok: true });
}
