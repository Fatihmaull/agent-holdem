import type { ArenaEvent } from './view';

type Listener = (event: ArenaEvent) => void;

/**
 * One broadcast channel per table. Spectators subscribe over server-sent
 * events; the table publishes and never waits for them.
 *
 * Nothing is buffered here. A spectator arriving mid-hand is caught up by the
 * stream route rendering a fresh `runtime.view(viewer)` snapshot, which is what
 * keeps redaction per-viewer; a shared replay log would hold seat state nobody
 * had redacted yet.
 */
export class TableBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: ArenaEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never stop a hand.
      }
    }
  }
}
