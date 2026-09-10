import { RateLimited } from './provider';

/**
 * One token bucket for every model request the server makes, sized to the
 * provider's requests-per-minute allowance. Tables share it, so three busy
 * tables slow down together instead of one starving the others.
 *
 * Keys are pooled for failover and for holding more than one paid key. They are
 * not a way to multiply a free tier: limits are enforced per project, and
 * spreading load across projects to get around them breaks the provider's terms.
 */
export interface LeasedKey {
  key: string;
  /** Call when the request finishes so the key returns to rotation. */
  release(): void;
  /** Call instead of release when the provider rate-limited this key. */
  cooldown(ms: number): void;
}

interface KeyState {
  key: string;
  /** Epoch milliseconds before which this key must not be used again. */
  availableAt: number;
}

export class ModelQueue {
  private readonly keys: KeyState[];
  private readonly capacity: number;
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    keys: readonly string[],
    requestsPerMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (keys.length === 0) throw new Error('no model API keys configured');
    this.keys = keys.map((key) => ({ key, availableAt: 0 }));
    this.capacity = Math.max(1, requestsPerMinute);
    this.tokens = this.capacity;
    this.lastRefill = now();
  }

  /** How many requests could start right now. */
  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  async acquire(signal?: AbortSignal): Promise<LeasedKey> {
    while (true) {
      signal?.throwIfAborted();
      this.refill();

      const now = this.now();
      const ready = this.keys.find((state) => state.availableAt <= now);

      if (this.tokens >= 1 && ready) {
        this.tokens -= 1;
        return {
          key: ready.key,
          release: () => {},
          cooldown: (ms) => {
            ready.availableAt = this.now() + ms;
          },
        };
      }

      await this.sleep(this.waitFor(now, ready === undefined));
    }
  }

  /** Runs `work` with a leased key, retrying once through the queue on a 429. */
  async run<T>(work: (key: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: unknown = new RateLimited('rate limited on every attempt', 0);

    for (let attempt = 0; attempt < 2; attempt++) {
      const lease = await this.acquire(signal);
      try {
        const result = await work(lease.key);
        lease.release();
        return result;
      } catch (error) {
        if (!(error instanceof RateLimited)) {
          lease.release();
          throw error;
        }
        lease.cooldown(error.retryAfterMs);
        lastError = error;
      }
    }

    throw lastError;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 60_000) * this.capacity);
    this.lastRefill = now;
  }

  /** Milliseconds to wait before the next attempt can possibly succeed. */
  private waitFor(now: number, everyKeyCoolingDown: boolean): number {
    const msPerToken = 60_000 / this.capacity;
    const tokenWait = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * msPerToken);
    const keyWait = everyKeyCoolingDown ? Math.min(...this.keys.map((state) => state.availableAt)) - now : 0;
    return Math.max(25, Math.min(Math.max(tokenWait, keyWait), 5_000));
  }
}

let shared: ModelQueue | null = null;

export function modelQueue(): ModelQueue {
  if (shared) return shared;

  const keys = (process.env.GEMINI_API_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  // A provider that needs a key and has none used to be handed a placeholder,
  // which meant every decision came back rejected and was recorded against the
  // agent as its own error. A misconfigured deployment would have quietly
  // produced a full leaderboard of agents that never got to play.
  if (keys.length === 0 && (process.env.AGENT_PROVIDER ?? 'gemini') !== 'heuristic') {
    throw new Error(
      'GEMINI_API_KEYS is not set. Set it, or run with AGENT_PROVIDER=heuristic, which needs no key.',
    );
  }

  const rpm = Number(process.env.AGENT_RATE_LIMIT_RPM ?? 10);
  shared = new ModelQueue(keys.length ? keys : ['no-key-needed'], rpm);
  return shared;
}
