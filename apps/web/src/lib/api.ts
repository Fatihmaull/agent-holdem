import type {
  AgentTurnLog,
  BankrollView,
  ChipTier,
  DeployResult,
  FeedEvent,
  HandHistoryEntry,
  LlmStatus,
  LobbyTableView,
  PromptTemplate,
  RoomMode,
  TableView,
} from '@agentholdem/shared';

export const API_BASE =
  process.env.NEXT_PUBLIC_ENGINE_HTTP ?? 'http://localhost:4000';

export const WS_URL = process.env.NEXT_PUBLIC_ENGINE_WS ?? 'ws://localhost:4000/ws';

export interface ArenaConfig {
  version: string;
  tiers: ChipTier[];
  rooms: RoomMode[];
  starterTemplates: { name: string; prompt: string; mode: string }[];
  llm: LlmStatus;
  chain: {
    chainId: number;
    rpcUrl: string;
    escrowAddress: string | null;
    settlementEnabled: boolean;
    arbiter: string | null;
  };
  table: { turnTimeoutMs: number; handsPerSession: number };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  config: () => request<ArenaConfig>('/api/config'),
  health: () => request<{ ok: boolean; version: string }>('/api/health'),
  lobby: () => request<{ tables: LobbyTableView[] }>('/api/lobby'),
  table: (id: string) => request<{ view: TableView; feed: FeedEvent[] }>(`/api/tables/${id}`),
  history: (id: string) =>
    request<{ hands: HandHistoryEntry[] }>(`/api/tables/${id}/history?limit=20`),
  turns: (id: string) => request<{ turns: AgentTurnLog[] }>(`/api/tables/${id}/turns?limit=60`),

  templates: (owner: string) =>
    request<{ templates: PromptTemplate[] }>(`/api/templates?owner=${owner}`),
  saveTemplate: (input: { owner: string; name: string; prompt: string; id?: string }) =>
    request<{ template: PromptTemplate }>('/api/templates', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteTemplate: (id: string, owner: string) =>
    request<{ ok: boolean }>(`/api/templates/${id}?owner=${owner}`, { method: 'DELETE' }),

  bankroll: (owner: string) => request<{ bankroll: BankrollView }>(`/api/bankroll/${owner}`),
  syncBankroll: (owner: string) =>
    request<{ bankroll: BankrollView }>('/api/bankroll/sync', {
      method: 'POST',
      body: JSON.stringify({ owner }),
    }),
  devCredit: (owner: string, chips: number) =>
    request<{ bankroll: BankrollView }>('/api/dev/credit', {
      method: 'POST',
      body: JSON.stringify({ owner, chips }),
    }),

  deploy: (input: {
    owner: string;
    agentName: string;
    prompt: string;
    templateId?: string;
    tableIds: string[];
  }) => request<DeployResult>('/api/deploy', { method: 'POST', body: JSON.stringify(input) }),
};
