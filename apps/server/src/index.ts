import { createServer } from 'node:http';
import type { Address, Hex } from 'viem';
import type { LlmStatus } from '@agentholdem/shared';
import { buildRouter } from './api/routes.js';
import { EscrowClient, OfflineSettlement } from './chain/escrow.js';
import { config } from './config.js';
import { Store } from './db/store.js';
import { AgentWorker } from './llm/agentWorker.js';
import { GeminiProvider, GroqProvider, type LlmProvider } from './llm/provider.js';
import { RoomManager } from './rooms/roomManager.js';
import { SpectatorHub } from './ws/hub.js';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

function buildProviders(): LlmProvider[] {
  const providers: LlmProvider[] = [];
  if (config.llm.groqApiKey) {
    providers.push(new GroqProvider(config.llm.groqApiKey, config.llm.groqModel));
  }
  if (config.llm.geminiApiKey) {
    providers.push(new GeminiProvider(config.llm.geminiApiKey, config.llm.geminiModel));
  }
  return providers;
}

async function main() {
  const store = new Store(config.dataDir);
  const providers = buildProviders();

  const worker = new AgentWorker({
    providers,
    turnTimeoutMs: config.llm.turnTimeoutMs,
    attemptTimeoutMs: config.llm.attemptTimeoutMs,
    useHeuristicFallback: config.llm.useHeuristicFallback,
    log,
  });

  const escrow =
    config.chain.escrowAddress && config.chain.rpcUrl
      ? new EscrowClient({
          rpcUrl: config.chain.rpcUrl,
          escrowAddress: config.chain.escrowAddress as Address,
          ...(config.chain.arbiterPrivateKey
            ? { arbiterPrivateKey: config.chain.arbiterPrivateKey as Hex }
            : {}),
          log,
        })
      : null;

  const settlement =
    config.chain.enabled && escrow ? escrow : new OfflineSettlement();

  const rooms = new RoomManager({
    worker,
    store,
    settlement,
    actionPaceMs: config.table.actionPaceMs,
    handPauseMs: config.table.handPauseMs,
    turnTimeoutMs: config.llm.turnTimeoutMs,
    handsPerSession: config.table.handsPerSession,
    log,
  });
  rooms.bootstrap();

  const llmStatus = (): LlmStatus => ({
    provider: providers[0]?.name ?? 'heuristic',
    model: providers[0]?.model ?? 'deterministic-policy',
    live: providers.length > 0,
    turnTimeoutMs: config.llm.turnTimeoutMs,
  });

  const router = buildRouter({ config, store, rooms, escrow, llmStatus });
  const server = createServer((req, res) => {
    void router.handle(req, res);
  });

  const hub = new SpectatorHub(server, rooms, llmStatus, config.version);

  server.listen(config.port, config.host, () => {
    log(`[server] AgentHoldem engine listening on http://${config.host}:${config.port}`);
    log(`[server] websocket: ws://${config.host}:${config.port}/ws`);
    log(
      providers.length > 0
        ? `[server] LLM: ${providers.map((p) => `${p.name}/${p.model}`).join(' → ')}`
        : '[server] LLM: no API key configured — running on the deterministic policy engine',
    );
    log(
      config.chain.enabled && escrow
        ? `[server] settlement: on-chain via ${config.chain.escrowAddress} (arbiter ${escrow.arbiterAddress})`
        : '[server] settlement: off-chain only (set CHAIN_SETTLEMENT_ENABLED=true to settle on BNB testnet)',
    );
    log(`[server] ${rooms.list().length} tables open across the three word-limit rooms`);
  });

  const shutdown = () => {
    log('[server] shutting down');
    rooms.shutdown();
    hub.close();
    store.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] fatal', err);
  process.exitCode = 1;
});
