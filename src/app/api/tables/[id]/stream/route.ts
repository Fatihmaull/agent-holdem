import { account } from '@/server/actions';
import { getSession } from '@/server/auth';
import { tableRuntime } from '@/server/registry';
import type { ArenaEvent } from '@/server/view';

export const dynamic = 'force-dynamic';

/**
 * The arena feed. One direction only: spectators never send anything back, so
 * server-sent events fit exactly and cost nothing a socket would.
 *
 * Hole cards are redacted per viewer on the way out. Events that carry seat
 * state are replaced with a snapshot rendered for this specific viewer, so a
 * spectator's stream physically does not contain another agent's cards.
 */
export async function GET(request: Request, context: RouteContext<'/api/tables/[id]/stream'>): Promise<Response> {
  const { id } = await context.params;
  const runtime = tableRuntime(id);
  if (!runtime) return new Response('No such table.', { status: 404 });

  const session = await getSession();
  const viewerAgentId = session ? await account(session).then((row) => row.agent.id).catch(() => null) : null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;

      const write = (payload: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          open = false;
        }
      };

      const send = (event: ArenaEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
      const snapshot = () => send({ type: 'snapshot', table: runtime.view(viewerAgentId) });

      snapshot();

      const unsubscribe = runtime.bus.subscribe((event) => {
        // Anything carrying seat state is re-rendered for this viewer instead of
        // forwarded, which is what keeps the redaction on the server.
        if (event.type === 'seats' || event.type === 'hand-start' || event.type === 'snapshot') snapshot();
        else send(event);
      });

      const heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);

      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      request.signal.addEventListener('abort', close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Stops a reverse proxy from buffering the feed into uselessness.
      'x-accel-buffering': 'no',
    },
  });
}
