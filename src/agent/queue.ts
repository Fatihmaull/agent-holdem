import { ProviderUnavailable, RateLimited } from './provider';

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
  /** Consecutive failures, so a key that is simply broken backs off further each time. */
  strikes: number;
}

/** Raised when the day's request ceiling has been reached. */
export class SpendCeilingReached extends Error {}

/** How long a key that failed for a reason other than a rate limit sits out. */
const FAILURE_COOLDOWN_MS = 15_000;

/** The longest a repeatedly failing key is held out of rotation. */
const MAX_COOLDOWN_MS = 10 * 60_000;

export interface QueueMetrics {
  granted: number;
  succeeded: number;
  rateLimited: number;
  failed: number;
  /** Requests refused because the day's ceiling was reached. */
  refused: number;
  /** Keys currently sitting out a cooldown. */
  coolingDown: number;
  keys: number;
  spentToday: number;
  dailyCap: number | null;
}

export class ModelQueue {
  private readonly keys: KeyState[];
  private readonly capacity: number;
  private tokens: number;
  private lastRefill = Date.now();

  /**
   * A hard ceiling on requests per day.
   *
   * The token bucket bounds the rate; this bounds the bill. Without it, anybody
   * who can sign up and deploy agents can spend the operator's money at the
   * provider's full rate for as long as they like — the tables are autonomous,
   * so nobody has to stay and watch. Past the ceiling every seat falls back to
   * the documented behaviour (check when checking is free, fold otherwise),
   * which is a bad game rather than an unbounded invoice.
   */
  private readonly dailyCap: number | null;
  private spentToday = 0;
  private dayStartedAt: number;

  private metrics = { granted: 0, succeeded: 0, rateLimited: 0, failed: 0, refused: 0 };

  constructor(
    keys: readonly string[],
    requestsPerMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    dailyCap: number | null = null,
  ) {
    if (keys.length === 0) throw new Error('no model API keys configured');
    this.keys = keys.map((key) => ({ key, availableAt: 0, strikes: 0 }));
    this.capacity = Math.max(1, requestsPerMinute);
    this.tokens = this.capacity;
    this.lastRefill = now();
    this.dailyCap = dailyCap;
    this.dayStartedAt = now();
  }

  /** How many requests could start right now. */
  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** What the health check and the metrics endpoint report. */
  snapshot(): QueueMetrics {
    const now = this.now();
    return {
      ...this.metrics,
      coolingDown: this.keys.filter((state) => state.availableAt > now).length,
      keys: this.keys.length,
      spentToday: this.spentToday,
      dailyCap: this.dailyCap,
    };
  }

  async acquire(signal?: AbortSignal): Promise<LeasedKey> {
    while (true) {
      signal?.throwIfAborted();
      this.refill();
      this.rollDay();

      if (this.dailyCap !== null && this.spentToday >= this.dailyCap) {
        this.metrics.refused += 1;
        throw new SpendCeilingReached(
          `the daily model request ceiling of ${this.dailyCap} has been reached`,
        );
      }

      const now = this.now();
      const ready = this.keys.find((state) => state.availableAt <= now);

      if (this.tokens >= 1 && ready) {
        this.tokens -= 1;
        this.spentToday += 1;
        this.metrics.granted += 1;
        return {
          key: ready.key,
          release: () => {
            ready.strikes = 0;
          },
          cooldown: (ms) => {
            ready.strikes += 1;
            // Doubling per consecutive strike, so a key that is genuinely dead
            // stops being tried every few seconds for the life of the process.
            const backoff = Math.min(ms * 2 ** (ready.strikes - 1), MAX_COOLDOWN_MS);
            ready.availableAt = this.now() + backoff;
          },
        };
      }

      await this.sleep(this.waitFor(now, ready === undefined));
    }
  }

  /**
   * Runs `work` with a leased key, moving to another key when one fails.
   *
   * A rate limit and an unavailable provider are both reasons to try a
   * different key rather than to give up on the seat; anything else is not the
   * key's fault and is raised straight away, because retrying a bad prompt on
   * four keys just spends four times as much to get the same answer.
   */
  async run<T>(work: (key: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    // Every key gets one turn, with a floor of two so a single-key deployment
    // still retries a transient failure once.
    const attempts = Math.max(2, this.keys.length);
    let lastError: unknown = new RateLimited('rate limited on every attempt', 0);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const lease = await this.acquire(signal);
      try {
        const result = await work(lease.key);
        lease.release();
        this.metrics.succeeded += 1;
        return result;
      } catch (error) {
        // A shutdown is not a provider failure, and cooling a key down for it
        // would penalise a perfectly good key for our own deploy.
        if (signal?.aborted) {
          lease.release();
          throw error;
        }

        if (error instanceof RateLimited) {
          lease.cooldown(error.retryAfterMs);
          this.metrics.rateLimited += 1;
        } else if (error instanceof ProviderUnavailable) {
          lease.cooldown(error.retryAfterMs ?? FAILURE_COOLDOWN_MS);
          this.metrics.failed += 1;
        } else {
          lease.release();
          throw error;
        }
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

  /** A rolling twenty-four hours rather than a calendar day, so no timezone is involved. */
  private rollDay(): void {
    const now = this.now();
    if (now - this.dayStartedAt < 24 * 60 * 60_000) return;
    this.dayStartedAt = now;
    this.spentToday = 0;
  }

  /** Milliseconds to wait before the next attempt can possibly succeed. */
  private waitFor(now: number, everyKeyCoolingDown: boolean): number {
    const msPerToken = 60_000 / this.capacity;
    const tokenWait = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * msPerToken);
    const keyWait = everyKeyCoolingDown ? Math.min(...this.keys.map((state) => state.availableAt)) - now : 0;
    return Math.max(25, Math.min(Math.max(tokenWait, keyWait), 5_000));
  }
}

/**
 * One queue for the whole process, and it has to be the same one everywhere.
 *
 * Hung off globalThis for the reason the table registry is: a module-scoped
 * singleton is per module graph, so a `next dev` reload makes a second queue
 * and the rate limit quietly doubles — and a route handler asking for the
 * metrics gets a fresh queue that has never granted anything, which is how a
 * health check comes to report a model pool that is not the one dealing hands.
 */
const globalForQueue = globalThis as unknown as { __agentholdemQueue?: ModelQueue };

export function modelQueue(): ModelQueue {
  if (globalForQueue.__agentholdemQueue) return globalForQueue.__agentholdemQueue;
  const keys = (process.env.GEMINI_API_KEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  const rpm = Number(process.env.AGENT_RATE_LIMIT_RPM ?? 10);
  const cap = process.env.AGENT_DAILY_REQUEST_CAP;
  globalForQueue.__agentholdemQueue = new ModelQueue(
    keys.length ? keys : ['missing-key'],
    rpm,
    Date.now,
    (ms) => new Promise((r) => setTimeout(r, ms)),
    cap === undefined ? null : Number(cap),
  );
  return globalForQueue.__agentholdemQueue;
}
