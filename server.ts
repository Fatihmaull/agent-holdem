import { createServer } from 'node:http';
import next from 'next';
import { CLOSE } from '@agentholdem/protocol';

/**
 * The entrypoint, replacing `next start`.
 *
 * Next has no way to accept a WebSocket, and agents dial in over one, so the
 * HTTP server has to be ours. Everything that shares state lives in this one
 * process on purpose: the dealer holds match state in memory, the agent sockets
 * feed it, and the spectator stream reads it. Splitting any of the three apart
 * would mean a message bus between them for no gain, since a Postgres advisory
 * lock already guarantees only one process deals.
 *
 * This file is not compiled by Next, so it runs through tsx rather than the
 * bundler and cannot use anything Next would have transformed for it.
 */

const port = Number(process.env.PORT ?? 3000);
const dev = process.env.NODE_ENV !== 'production';

async function main(): Promise<void> {
  const app = next({ dev });
  await app.prepare();

  // Both handlers are fetched after prepare, not before. `getUpgradeHandler`
  // throws otherwise, because the server it delegates to does not exist yet.
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  // Imported after `prepare`, because these modules read environment the Next
  // config loads, and because nothing should start dealing before the server
  // that spectators watch it on is able to answer.
  const { attachAgentSocket } = await import('./src/server/socket');
  const { bootEngine } = await import('./src/server/lifecycle');
  const { closeAll } = await import('./src/server/presence');

  attachAgentSocket(server, (request, socket, head) => {
    // Everything that is not an agent goes to Next, which runs its own socket
    // for hot reload in development. Taking every upgrade would break the dev
    // server in a way that looks like the bundler failing rather than like us.
    void upgrade(request, socket, head);
  });

  server.listen(port, () => {
    console.log(`[server] listening on :${port} (${dev ? 'development' : 'production'})`);
  });

  bootEngine();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // Told rather than dropped. An agent that is hung up on with a reason
      // reconnects; one whose socket silently dies waits for a timeout first.
      closeAll(CLOSE.GOING_AWAY, 'The arena is restarting. Reconnect in a moment.');
      server.close(() => process.exit(0));
      // A spectator stream never ends on its own, so a clean close would wait
      // for one that is not coming.
      setTimeout(() => process.exit(0), 3_000).unref();
    });
  }
}

void main().catch((error) => {
  console.error('[server] failed to start', error);
  process.exit(1);
});
