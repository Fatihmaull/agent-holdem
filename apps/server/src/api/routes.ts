import { randomUUID } from 'node:crypto';
import {
  CHIP_TIERS,
  ROOM_MODES,
  STARTER_TEMPLATES,
  countWords,
  validatePromptForMode,
  type DeployRequest,
  type LlmStatus,
  type PromptTemplate,
} from '@agentholdem/shared';
import type { Address } from 'viem';
import type { AppConfig } from '../config.js';
import type { Store } from '../db/store.js';
import type { RoomManager } from '../rooms/roomManager.js';
import type { EscrowClient } from '../chain/escrow.js';
import { HttpError, Router, requireAddress, requireString, optionalString } from './http.js';

export interface ApiDeps {
  config: AppConfig;
  store: Store;
  rooms: RoomManager;
  escrow: EscrowClient | null;
  llmStatus: () => LlmStatus;
}

export function buildRouter(deps: ApiDeps): Router {
  const { config, store, rooms, escrow } = deps;
  const router = new Router(config.corsOrigin);

  router.get('/api/health', () => ({
    ok: true,
    version: config.version,
    uptimeSeconds: Math.round(process.uptime()),
    tables: rooms.list().length,
  }));

  /** Everything the client needs to render the cashier and the lobby filters. */
  router.get('/api/config', () => ({
    version: config.version,
    tiers: CHIP_TIERS,
    rooms: ROOM_MODES,
    starterTemplates: STARTER_TEMPLATES,
    llm: deps.llmStatus(),
    chain: {
      chainId: config.chain.chainId,
      rpcUrl: config.chain.rpcUrl,
      escrowAddress: config.chain.escrowAddress || null,
      settlementEnabled: config.chain.enabled && Boolean(escrow),
      arbiter: escrow?.arbiterAddress ?? null,
    },
    table: {
      turnTimeoutMs: config.llm.turnTimeoutMs,
      handsPerSession: config.table.handsPerSession,
    },
  }));

  /* ------------------------------ lobby ------------------------------ */

  router.get('/api/lobby', () => ({ tables: rooms.lobby() }));

  router.get('/api/tables/:id', ({ params }) => {
    const table = rooms.get(params['id'] as string);
    if (!table) throw new HttpError(404, 'Table not found');
    return { view: table.view(), feed: table.recentFeed(120) };
  });

  router.get('/api/tables/:id/history', ({ params, query }) => ({
    hands: store.handHistory(params['id'] as string, clampLimit(query.get('limit'), 25)),
  }));

  router.get('/api/tables/:id/turns', ({ params, query }) => ({
    turns: store.turnLogs(params['id'] as string, clampLimit(query.get('limit'), 100)),
  }));

  router.get('/api/settlements', ({ query }) => ({
    settlements: store.settlements(clampLimit(query.get('limit'), 25)),
  }));

  /* ---------------------------- templates ---------------------------- */

  router.get('/api/templates', ({ query }) => {
    const owner = query.get('owner');
    return { templates: store.listTemplates(owner ? requireAddress(owner) : undefined) };
  });

  router.post('/api/templates', ({ body }) => {
    const owner = requireAddress(requireString(body, 'owner'));
    const name = requireString(body, 'name');
    const prompt = requireString(body, 'prompt');
    const id = optionalString(body, 'id');

    // A template is stored once and deployed to rooms with different budgets,
    // so it is checked against the most permissive room here and against the
    // specific room's budget again at deploy time.
    const widest = validatePromptForMode(prompt, 'deep');
    if (!widest.ok) throw new HttpError(400, widest.reason);

    const now = Date.now();
    const existing = id ? store.getTemplate(id) : undefined;
    if (existing && existing.ownerAddress.toLowerCase() !== owner) {
      throw new HttpError(403, 'That template belongs to another wallet');
    }

    const template: PromptTemplate = {
      id: existing?.id ?? id ?? randomUUID(),
      ownerAddress: owner,
      name: name.slice(0, 60),
      prompt,
      words: countWords(prompt),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.stats ? { stats: existing.stats } : {}),
    };
    return { template: store.upsertTemplate(template) };
  });

  router.delete('/api/templates/:id', ({ params, query }) => {
    const owner = requireAddress(query.get('owner') ?? '');
    const removed = store.deleteTemplate(params['id'] as string, owner);
    if (!removed) throw new HttpError(404, 'Template not found for this wallet');
    return { ok: true };
  });

  /* ---------------------------- bankroll ----------------------------- */

  router.get('/api/bankroll/:owner', async ({ params }) => {
    const owner = requireAddress(params['owner'] as string);
    return { bankroll: await syncBankroll(owner) };
  });

  /**
   * Pulls the authoritative balance from the contract into the off-chain
   * ledger. The client calls this after a `buyChips` transaction confirms.
   */
  router.post('/api/bankroll/sync', async ({ body }) => {
    const owner = requireAddress(requireString(body, 'owner'));
    return { bankroll: await syncBankroll(owner, true) };
  });

  /**
   * Development faucet. Only reachable when chain settlement is off, i.e.
   * when there is no real contract to buy chips from, so it cannot be used
   * to conjure chips that the escrow is supposed to be backing.
   */
  router.post('/api/dev/credit', ({ body }) => {
    if (config.chain.enabled) {
      throw new HttpError(403, 'Disabled: buy chips through the escrow contract');
    }
    const owner = requireAddress(requireString(body, 'owner'));
    const chips = Number((body as Record<string, unknown>)['chips'] ?? 1_000);
    if (!Number.isFinite(chips) || chips <= 0 || chips > 100_000) {
      throw new HttpError(400, 'chips must be between 1 and 100000');
    }
    const current = store.bankroll(owner);
    return { bankroll: store.setBankroll(owner, current.available + Math.floor(chips)) };
  });

  /* ----------------------------- deploy ------------------------------ */

  /**
   * Batch deployment: one persona, several tables, then close the tab.
   */
  router.post('/api/deploy', async ({ body }) => {
    const owner = requireAddress(requireString(body, 'owner'));
    const agentName = requireString(body, 'agentName').slice(0, 40);
    const templateId = optionalString(body, 'templateId');

    let prompt = optionalString(body, 'prompt');
    if (!prompt && templateId) {
      const template = store.getTemplate(templateId);
      if (!template) throw new HttpError(404, 'Template not found');
      prompt = template.prompt;
    }
    if (!prompt) throw new HttpError(400, 'Provide either prompt or templateId');

    const tableIds = (body as Record<string, unknown>)['tableIds'];
    if (!Array.isArray(tableIds) || tableIds.length === 0) {
      throw new HttpError(400, 'tableIds must be a non-empty array');
    }
    if (tableIds.length > 12) {
      throw new HttpError(400, 'A single deploy is limited to 12 tables');
    }

    // Chips live on chain; refresh the mirror before spending against it.
    await syncBankroll(owner);

    const request: DeployRequest = {
      owner,
      agentName,
      prompt,
      tableIds: tableIds.map(String),
      ...(templateId ? { templateId } : {}),
    };
    const result = rooms.deploy(request);
    if (result.seated.length === 0 && result.rejected.length > 0) {
      // Nothing was seated: surface the first reason as the error so the UI
      // does not have to dig through the array to tell the user why.
      throw new HttpError(400, result.rejected[0]!.reason);
    }
    return result;
  });

  async function syncBankroll(owner: string, force = false) {
    const local = store.bankroll(owner);
    if (!escrow || !config.chain.escrowAddress) return local;

    // The chain is the source of truth for *available* chips; locked chips
    // are the stakes this server has seated and only it knows about.
    try {
      const onChain = await escrow.chipBalance(owner as Address);
      const available = Number(onChain);
      if (force || available !== local.available) {
        const updated = store.setBankroll(owner, available, local.locked);
        return { ...updated, onChain: onChain.toString() };
      }
      return { ...local, onChain: onChain.toString() };
    } catch {
      return local;
    }
  }

  return router;
}

function clampLimit(raw: string | null, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(200, Math.floor(parsed));
}
