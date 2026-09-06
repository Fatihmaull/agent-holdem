import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  ClientMessage,
  FeedEvent,
  LlmStatus,
  ServerMessage,
  TableView,
} from '@agentholdem/shared';
import type { RoomManager } from '../rooms/roomManager.js';
import type { TableRunner } from '../rooms/table.js';

interface Subscriber {
  socket: WebSocket;
  tables: Set<string>;
  lobby: boolean;
  alive: boolean;
}

/**
 * Spectator fan-out.
 *
 * Sockets are strictly observers: nothing a client sends can influence a
 * hand. That is what makes closing the browser safe — the table's loop has no
 * idea whether anyone is watching, and reconnecting just replays the current
 * snapshot plus the recent feed.
 */
export class SpectatorHub {
  private readonly wss: WebSocketServer;
  private readonly subscribers = new Map<WebSocket, Subscriber>();
  private readonly detachers: (() => void)[] = [];
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    server: Server,
    private readonly rooms: RoomManager,
    private readonly llmStatus: () => LlmStatus,
    private readonly version: string,
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket) => this.onConnection(socket));

    this.detachers.push(
      this.rooms.onLobbyChange(() => this.broadcastLobby()),
    );

    for (const table of this.rooms.list()) this.attach(table);

    // A table created after a session completes needs wiring too.
    this.detachers.push(
      this.rooms.onLobbyChange((table) => this.attach(table)),
    );

    this.heartbeat = setInterval(() => this.ping(), 30_000);
    this.heartbeat.unref?.();
  }

  private readonly attached = new WeakSet<TableRunner>();

  private attach(table: TableRunner): void {
    if (this.attached.has(table)) return;
    this.attached.add(table);

    const onEvent = (event: FeedEvent, view: TableView) => {
      this.broadcastTableEvent(table.config.id, view, event);
    };
    const onTick = (view: TableView) => {
      this.broadcastTable(table.config.id, view);
    };
    table.on('event', onEvent);
    table.on('tick', onTick);
    this.detachers.push(() => {
      table.off('event', onEvent);
      table.off('tick', onTick);
    });
  }

  private onConnection(socket: WebSocket): void {
    const subscriber: Subscriber = {
      socket,
      tables: new Set(),
      lobby: false,
      alive: true,
    };
    this.subscribers.set(socket, subscriber);

    this.sendTo(socket, {
      t: 'hello',
      serverTime: Date.now(),
      version: this.version,
      llm: this.llmStatus(),
    });

    socket.on('pong', () => {
      subscriber.alive = true;
    });

    socket.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        this.sendTo(socket, { t: 'error', message: 'Malformed message' });
        return;
      }
      this.handle(subscriber, message);
    });

    socket.on('close', () => this.subscribers.delete(socket));
    socket.on('error', () => this.subscribers.delete(socket));
  }

  private handle(subscriber: Subscriber, message: ClientMessage): void {
    switch (message.t) {
      case 'subscribe': {
        const table = this.rooms.get(message.tableId);
        if (!table) {
          this.sendTo(subscriber.socket, { t: 'error', message: 'Unknown table' });
          return;
        }
        subscriber.tables.add(message.tableId);
        this.sendTo(subscriber.socket, {
          t: 'table',
          view: table.view(),
          feed: table.recentFeed(120),
        });
        break;
      }
      case 'unsubscribe':
        subscriber.tables.delete(message.tableId);
        break;
      case 'watch-lobby':
        subscriber.lobby = true;
        this.sendTo(subscriber.socket, { t: 'lobby', tables: this.rooms.lobby() });
        break;
      case 'unwatch-lobby':
        subscriber.lobby = false;
        break;
      case 'ping':
        this.sendTo(subscriber.socket, { t: 'pong', ts: message.ts });
        break;
      default:
        this.sendTo(subscriber.socket, { t: 'error', message: 'Unsupported message' });
    }
  }

  private broadcastTableEvent(tableId: string, view: TableView, event: FeedEvent): void {
    const payload: ServerMessage = { t: 'table-event', tableId, view, event };
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.tables.has(tableId)) this.sendTo(subscriber.socket, payload);
    }
  }

  private broadcastTable(tableId: string, view: TableView): void {
    const payload: ServerMessage = { t: 'table', view, feed: [] };
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.tables.has(tableId)) this.sendTo(subscriber.socket, payload);
    }
  }

  private lobbyTimer: NodeJS.Timeout | null = null;

  /** Coalesced: a busy six-table arena would otherwise spam the lobby view. */
  private broadcastLobby(): void {
    if (this.lobbyTimer) return;
    this.lobbyTimer = setTimeout(() => {
      this.lobbyTimer = null;
      const payload: ServerMessage = { t: 'lobby', tables: this.rooms.lobby() };
      for (const subscriber of this.subscribers.values()) {
        if (subscriber.lobby) this.sendTo(subscriber.socket, payload);
      }
    }, 400);
    this.lobbyTimer.unref?.();
  }

  private sendTo(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private ping(): void {
    for (const subscriber of this.subscribers.values()) {
      if (!subscriber.alive) {
        subscriber.socket.terminate();
        this.subscribers.delete(subscriber.socket);
        continue;
      }
      subscriber.alive = false;
      subscriber.socket.ping();
    }
  }

  get connectionCount(): number {
    return this.subscribers.size;
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const detach of this.detachers) detach();
    this.wss.close();
  }
}
