import type { AgentDecision, AgentTurnResult, DecisionSource } from '@agentholdem/shared';
import { heuristicDecision } from './heuristic.js';
import { buildPersonaPrompt, buildStatePrompt, type TurnContext } from './promptBuilder.js';
import { parseDecision, type LlmProvider } from './provider.js';

export interface AgentWorkerOptions {
  /** Providers are tried in order; Groq first, Gemini as the free fallback. */
  providers: LlmProvider[];
  /** Hard deadline for the whole turn, retries included. Spec: 30 seconds. */
  turnTimeoutMs: number;
  /** Per-attempt budget so one hung socket cannot eat the whole clock. */
  attemptTimeoutMs: number;
  /** Falls back to the deterministic policy instead of a blind check/fold. */
  useHeuristicFallback: boolean;
  log?: (line: string) => void;
}

export const DEFAULT_TURN_TIMEOUT_MS = 30_000;

/**
 * Runs one agent turn end to end.
 *
 * Contract, in order: try the primary provider, retry once (next provider if
 * there is one), and if the 30 second deadline passes or nothing usable comes
 * back, fall back. The fallback is either the deterministic policy engine or,
 * when that is switched off, the literal spec behaviour — check when checking
 * is free, fold when facing a bet. A turn *always* resolves; a dead API key
 * can slow a table down but can never stall it.
 */
export class AgentWorker {
  constructor(private readonly opts: AgentWorkerOptions) {}

  get providerName(): string {
    return this.opts.providers[0]?.name ?? 'heuristic';
  }

  get model(): string {
    return this.opts.providers[0]?.model ?? 'deterministic-policy';
  }

  get live(): boolean {
    return this.opts.providers.length > 0;
  }

  async takeTurn(ctx: TurnContext, persona: string, seed: string): Promise<AgentTurnResult> {
    const started = Date.now();
    const deadline = started + this.opts.turnTimeoutMs;

    const system = buildStatePrompt(ctx);
    const user = buildPersonaPrompt(persona, ctx.mode);

    // Attempt 1 on the primary, attempt 2 on the next provider if configured,
    // otherwise a straight retry of the primary.
    const attempts: LlmProvider[] = [];
    if (this.opts.providers[0]) attempts.push(this.opts.providers[0]);
    if (this.opts.providers[1]) attempts.push(this.opts.providers[1]);
    else if (this.opts.providers[0]) attempts.push(this.opts.providers[0]);

    let lastError: string | undefined;
    let lastFailure: 'timeout' | 'invalid' | 'error' | 'deadline' | null = null;

    for (const [index, provider] of attempts.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 250) {
        lastError = lastError ?? 'turn deadline reached before a response';
        lastFailure = 'deadline';
        break;
      }

      const controller = new AbortController();
      const budget = Math.min(this.opts.attemptTimeoutMs, remaining);
      const timer = setTimeout(() => controller.abort(), budget);

      try {
        const raw = await provider.complete(system, user, controller.signal);
        const decision = parseDecision(raw);
        if (decision) {
          return {
            decision,
            source: index === 0 ? 'llm' : 'llm-retry',
            latencyMs: Date.now() - started,
            provider: provider.name,
            model: provider.model,
          };
        }
        lastError = `unparseable response from ${provider.name}: ${raw.slice(0, 160)}`;
        lastFailure = 'invalid';
        this.opts.log?.(`[agent] ${lastError}`);
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        lastError = aborted
          ? `${provider.name} attempt timed out after ${budget}ms`
          : `${provider.name} error: ${(err as Error).message}`;
        lastFailure = aborted ? 'timeout' : 'error';
        this.opts.log?.(`[agent] ${lastError}`);
      } finally {
        clearTimeout(timer);
      }
    }

    // Classify from what actually went wrong rather than from clock
    // arithmetic: an attempt that aborted on its own budget is a timeout even
    // if the outer deadline is still a millisecond away.
    let source: DecisionSource;
    if (attempts.length === 0) {
      source = this.opts.useHeuristicFallback ? 'heuristic' : 'fallback-no-provider';
    } else if (lastFailure === 'timeout' || lastFailure === 'deadline' || Date.now() >= deadline) {
      source = 'fallback-timeout';
    } else if (lastFailure === 'invalid') {
      source = 'fallback-invalid';
    } else {
      source = 'fallback-error';
    }

    return {
      decision: this.fallbackDecision(ctx, persona, seed),
      source,
      latencyMs: Date.now() - started,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  /**
   * The safety net. With the policy engine enabled this still plays real
   * poker; with it disabled it is exactly the behaviour the spec mandates.
   */
  fallbackDecision(ctx: TurnContext, persona: string, seed: string): AgentDecision {
    if (this.opts.useHeuristicFallback) {
      return heuristicDecision(ctx, persona, seed);
    }
    return ctx.legal.canCheck
      ? {
          action: 'check',
          amount: 0,
          inner_thought: 'Turn clock expired — checking automatically.',
          table_chat: '...',
        }
      : {
          action: 'fold',
          amount: 0,
          inner_thought: 'Turn clock expired while facing a bet — folding automatically.',
          table_chat: '...',
        };
  }
}
