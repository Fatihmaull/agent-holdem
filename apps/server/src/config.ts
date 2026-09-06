import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '../../.env') });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export const config = {
  port: num('PORT', 4000),
  host: process.env['HOST'] ?? '0.0.0.0',
  corsOrigin: process.env['CORS_ORIGIN'] ?? '*',

  llm: {
    groqApiKey: process.env['GROQ_API_KEY'] ?? '',
    groqModel: process.env['GROQ_MODEL'] ?? 'llama-3.3-70b-versatile',
    geminiApiKey: process.env['GEMINI_API_KEY'] ?? '',
    geminiModel: process.env['GEMINI_MODEL'] ?? 'gemini-1.5-flash',
    /** Spec mandate: 30 seconds per turn, retries included. */
    turnTimeoutMs: num('TURN_TIMEOUT_MS', 30_000),
    attemptTimeoutMs: num('LLM_ATTEMPT_TIMEOUT_MS', 12_000),
    /**
     * When no key is configured the arena still plays, driven by the
     * deterministic policy engine, so the project is demoable offline.
     */
    useHeuristicFallback: bool('USE_HEURISTIC_FALLBACK', true),
  },

  table: {
    /** Wall-clock pause between actions so spectators can follow the hand. */
    actionPaceMs: num('ACTION_PACE_MS', 900),
    handPauseMs: num('HAND_PAUSE_MS', 2_500),
    /** Hands played before a table settles and pays out. */
    handsPerSession: num('HANDS_PER_SESSION', 12),
  },

  chain: {
    rpcUrl: process.env['BSC_TESTNET_RPC'] ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    chainId: num('CHAIN_ID', 97),
    escrowAddress: (process.env['POKER_ESCROW_ADDRESS'] ?? '') as `0x${string}` | '',
    arbiterPrivateKey: (process.env['ARBITER_PRIVATE_KEY'] ?? '') as `0x${string}` | '',
    /**
     * Off-chain play still works with no chain configured; settlement is then
     * recorded locally and flagged as unsettled rather than silently claimed.
     */
    enabled: bool('CHAIN_SETTLEMENT_ENABLED', false),
  },

  dataDir: process.env['DATA_DIR'] ?? resolve(process.cwd(), 'data'),
  version: '0.1.0',
} as const;

export type AppConfig = typeof config;
