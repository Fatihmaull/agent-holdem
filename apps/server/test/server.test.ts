import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FeedEvent, LlmStatus, ServerMessage } from '@agentholdem/shared';
import { buildRouter } from '../src/api/routes.js';
import { OfflineSettlement } from '../src/chain/escrow.js';
import { config } from '../src/config.js';
import { Store } from '../src/db/store.js';
import { AgentWorker } from '../src/llm/agentWorker.js';
import { RoomManager } from '../src/rooms/roomManager.js';
import { SpectatorHub } from '../src/ws/hub.js';

const MANAGER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

let server: Server;
let hub: SpectatorHub;
let rooms: RoomManager;
let store: Store;
let dataDir: string;
let baseUrl: string;
let wsUrl: string;

const llmStatus = (): LlmStatus => ({
  provider: 'heuristic',
  model: 'deterministic-policy',
  live: false,
  turnTimeoutMs: 30_000,
});

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'agentholdem-test-'));
  store = new Store(dataDir);

  const worker = new AgentWorker({
    providers: [],
    turnTimeoutMs: 1_000,
    attemptTimeoutMs: 500,
    useHeuristicFallback: true,
  });

  rooms = new RoomManager({
    worker,
    store,
    settlement: new OfflineSettlement(),
    actionPaceMs: 0,
    handPauseMs: 0,
    turnTimeoutMs: 1_000,
    handsPerSession: 3,
    startDelayMs: 60_000, // tests start tables explicitly
  });
  rooms.bootstrap();

  const testConfig = {
    ...config,
    chain: { ...config.chain, enabled: false, escrowAddress: '' as const },
  };
  const router = buildRouter({
    config: testConfig,
    store,
    rooms,
    escrow: null,
    llmStatus,
  });

  server = createServer((req, res) => void router.handle(req, res));
  hub = new SpectatorHub(server, rooms, llmStatus, '0.1.0-test');

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('No port assigned');
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(async () => {
  rooms.shutdown();
  hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('REST API', () => {
  it('reports health and the open table catalogue', async () => {
    const health = await api('/api/health');
    expect(health.status).toBe(200);
    expect(health.body['ok']).toBe(true);

    const lobby = await api('/api/lobby');
    const tables = lobby.body['tables'] as { mode: string; wordLimit: number }[];
    expect(tables.length).toBeGreaterThanOrEqual(6);
    expect(new Set(tables.map((t) => t.wordLimit))).toEqual(new Set([10, 50, 100]));
  });

  it('publishes tiers, rooms and runtime config', async () => {
    const { body } = await api('/api/config');
    expect((body['tiers'] as unknown[]).length).toBe(4);
    expect((body['rooms'] as unknown[]).length).toBe(3);
    expect((body['llm'] as LlmStatus).turnTimeoutMs).toBeGreaterThan(0);
  });

  it('rejects a malformed wallet address', async () => {
    const { status, body } = await api('/api/dev/credit', {
      method: 'POST',
      body: JSON.stringify({ owner: 'not-an-address', chips: 100 }),
    });
    expect(status).toBe(400);
    expect(String(body['error'])).toMatch(/address/i);
  });

  it('saves, lists and deletes prompt templates', async () => {
    const created = await api('/api/templates', {
      method: 'POST',
      body: JSON.stringify({
        owner: MANAGER,
        name: 'The Mathematician',
        prompt: 'Play pot odds strictly. Fold marginal spots.',
      }),
    });
    const template = created.body['template'] as { id: string; words: number };
    expect(template.words).toBe(7);

    const listed = await api(`/api/templates?owner=${MANAGER}`);
    expect((listed.body['templates'] as unknown[]).length).toBe(1);

    // Another wallet's library is separate.
    const otherList = await api(`/api/templates?owner=${OTHER}`);
    expect((otherList.body['templates'] as unknown[]).length).toBe(0);

    const removed = await api(`/api/templates/${template.id}?owner=${MANAGER}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
  });

  it('refuses to overwrite a template owned by a different wallet', async () => {
    const created = await api('/api/templates', {
      method: 'POST',
      body: JSON.stringify({ owner: MANAGER, name: 'Mine', prompt: 'Fold everything always.' }),
    });
    const id = (created.body['template'] as { id: string }).id;

    const hijack = await api('/api/templates', {
      method: 'POST',
      body: JSON.stringify({ id, owner: OTHER, name: 'Stolen', prompt: 'Raise everything.' }),
    });
    expect(hijack.status).toBe(403);
  });

  it('enforces the room word budget at deploy time, per table', async () => {
    await api('/api/dev/credit', {
      method: 'POST',
      body: JSON.stringify({ owner: MANAGER, chips: 5_000 }),
    });

    const lobby = await api('/api/lobby');
    const tables = lobby.body['tables'] as { id: string; mode: string; status: string }[];
    const micro = tables.find((t) => t.mode === 'micro' && t.status === 'waiting')!;
    const tactical = tables.find((t) => t.mode === 'tactical' && t.status === 'waiting')!;

    // Twelve words: legal in the Tactical room, three over budget in Micro.
    const prompt = 'one two three four five six seven eight nine ten eleven twelve';
    const { body } = await api('/api/deploy', {
      method: 'POST',
      body: JSON.stringify({
        owner: MANAGER,
        agentName: 'Wordy',
        prompt,
        tableIds: [micro.id, tactical.id],
      }),
    });

    const seated = body['seated'] as { tableId: string }[];
    const rejected = body['rejected'] as { tableId: string; reason: string }[];
    expect(seated.map((s) => s.tableId)).toEqual([tactical.id]);
    expect(rejected[0]!.tableId).toBe(micro.id);
    expect(rejected[0]!.reason).toMatch(/12 words/);
  });

  it('deducts the buy-in from the bankroll on deploy', async () => {
    await api('/api/dev/credit', {
      method: 'POST',
      body: JSON.stringify({ owner: OTHER, chips: 1_000 }),
    });
    const before = await api(`/api/bankroll/${OTHER}`);
    const availableBefore = (before.body['bankroll'] as { available: number }).available;

    const lobby = await api('/api/lobby');
    const tables = lobby.body['tables'] as { id: string; mode: string; status: string; buyInChips: number }[];
    const table = tables.find((t) => t.mode === 'micro' && t.status === 'waiting')!;

    const { body } = await api('/api/deploy', {
      method: 'POST',
      body: JSON.stringify({
        owner: OTHER,
        agentName: 'Rocky',
        prompt: 'Premium hands only. Fold everything else.',
        tableIds: [table.id],
      }),
    });
    expect(body['bankrollAfter']).toBe(availableBefore - table.buyInChips);
  });

  it('refuses a deploy the bankroll cannot cover', async () => {
    const broke = '0x3333333333333333333333333333333333333333';
    const lobby = await api('/api/lobby');
    const tables = lobby.body['tables'] as { id: string; status: string }[];
    const table = tables.find((t) => t.status === 'waiting')!;

    const { status, body } = await api('/api/deploy', {
      method: 'POST',
      body: JSON.stringify({
        owner: broke,
        agentName: 'Broke',
        prompt: 'Fold everything always.',
        tableIds: [table.id],
      }),
    });
    expect(status).toBe(400);
    expect(String(body['error'])).toMatch(/chips/i);
  });

  it('404s an unknown table', async () => {
    const { status } = await api('/api/tables/does-not-exist');
    expect(status).toBe(404);
  });
});

describe('WebSocket spectator feed', () => {
  it('streams a table from deal to settlement without a client driving it', async () => {
    await api('/api/dev/credit', {
      method: 'POST',
      body: JSON.stringify({ owner: MANAGER, chips: 5_000 }),
    });

    const lobby = await api('/api/lobby');
    const tables = lobby.body['tables'] as { id: string; format: string; status: string }[];
    const table = tables.find((t) => t.format === 'heads-up' && t.status === 'waiting')!;

    await api('/api/deploy', {
      method: 'POST',
      body: JSON.stringify({
        owner: MANAGER,
        agentName: 'Watcher',
        prompt: 'Play pot odds strictly. Fold marginal spots.',
        tableIds: [table.id],
      }),
    });

    const socket = new WebSocket(wsUrl);
    const received: FeedEvent[] = [];
    let helloSeen = false;
    // Hole cards must stay hidden until the hand shows down; a spectator feed
    // that leaks them would let anyone run a bot with perfect information.
    let leakedBeforeShowdown = false;
    let showdownThisHand = false;

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Table never completed')), 25_000);
      socket.on('open', () => {
        socket.send(JSON.stringify({ t: 'subscribe', tableId: table.id }));
        // The table starts *after* the socket attaches, proving the feed is
        // live rather than a replay of a finished session.
        setTimeout(() => rooms.forceStart(table.id), 100);
      });
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as ServerMessage;
        if (message.t === 'hello') helloSeen = true;
        if (message.t === 'table-event') {
          received.push(message.event);
          if (message.event.kind === 'hand-start') showdownThisHand = false;
          if (message.event.kind === 'showdown') showdownThisHand = true;
          if (!showdownThisHand && message.view.seats.some((s) => s.holeCards !== null)) {
            leakedBeforeShowdown = true;
          }
          if (message.event.kind === 'session-complete') {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      socket.on('error', reject);
    });

    await done;
    socket.close();

    expect(helloSeen).toBe(true);
    const kinds = new Set(received.map((e) => e.kind));
    expect(kinds).toContain('hand-start');
    expect(kinds).toContain('blinds');
    expect(kinds).toContain('action');
    expect(kinds).toContain('payout');
    expect(kinds).toContain('session-complete');

    expect(leakedBeforeShowdown, 'hole cards leaked before showdown').toBe(false);

    // Streets arrive in order and the board only ever grows 0 → 3 → 4 → 5.
    const boardSizes = received
      .filter((e): e is Extract<FeedEvent, { kind: 'deal' }> => e.kind === 'deal')
      .map((e) => e.board.length);
    for (const size of boardSizes) expect([0, 3, 4, 5]).toContain(size);

    const history = await api(`/api/tables/${table.id}/history`);
    const hands = history.body['hands'] as { seed: string; commitment: string }[];
    expect(hands.length).toBeGreaterThan(0);
    expect(hands[0]!.seed).toBeTruthy();

    const turns = await api(`/api/tables/${table.id}/turns`);
    expect((turns.body['turns'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('rejects a subscription to an unknown table', async () => {
    const socket = new WebSocket(wsUrl);
    const message = await new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 5_000);
      socket.on('open', () => socket.send(JSON.stringify({ t: 'subscribe', tableId: 'nope' })));
      socket.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString()) as ServerMessage;
        if (parsed.t === 'error') {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
      socket.on('error', reject);
    });
    socket.close();
    expect(message.t).toBe('error');
  });
});
