/**
 * Runs once when the server starts. The match engine is a long-lived loop, not
 * a request handler, so this is where it is brought up.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.AGENTHOLDEM_DISABLE_ENGINE === '1') return;

  const { bootEngine } = await import('./server/lifecycle');
  bootEngine();
}
