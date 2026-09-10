/**
 * A ceiling on how often one account can ask for the expensive things.
 *
 * Two routes here do real work on someone else's behalf. Confirming a deposit
 * makes two calls to a chain RPC against a transaction hash the caller chose,
 * and starting one writes a row. Neither is dangerous once, and both are a way
 * to spend this deployment's RPC quota or fill its tables from a single
 * signed-in account.
 *
 * Held in memory, which means per instance. That is worth being clear about: it
 * is a brake on ordinary abuse, not a defence against a determined attacker
 * spreading requests across instances. The reason it is still the right shape
 * is that the alternative, a counter in Postgres, adds a write to the path of
 * every request in order to make a limit slightly harder to walk around.
 */

interface Bucket {
  /** Requests still available right now. Refills continuously, not in steps. */
  tokens: number;
  lastRefill: number;
}

interface Limit {
  /** Requests allowed per minute, sustained. */
  perMinute: number;
  /** How many may arrive at once before the rate starts to bite. */
  burst: number;
}

/**
 * The limits, by what the route actually costs.
 *
 * Deposits are slow and rare in real use, so their allowance is small. Sign-in
 * is bounded loosely: a person retrying a wallet prompt is normal, and locking
 * them out of their own account is worse than the nonces they waste.
 */
export const LIMITS = {
  'deposit-confirm': { perMinute: 10, burst: 5 },
  'deposit-start': { perMinute: 10, burst: 5 },
  'sign-in': { perMinute: 30, burst: 10 },
  seat: { perMinute: 20, burst: 6 },
  write: { perMinute: 30, burst: 10 },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

const buckets = new Map<string, Bucket>();

/** Long enough that a bucket at full tokens carries no information worth keeping. */
const IDLE_MS = 10 * 60_000;
let lastSweep = Date.now();

/**
 * Spends one request against a caller's allowance.
 *
 * Returns how long to wait when there is nothing left, so the caller can say so
 * in a `Retry-After` rather than only refusing.
 */
export function take(name: LimitName, who: string): { ok: true } | { ok: false; retryAfterMs: number } {
  const limit = LIMITS[name];
  const key = `${name}:${who}`;
  const now = Date.now();

  sweep(now);

  const bucket = buckets.get(key) ?? { tokens: limit.burst, lastRefill: now };
  const refilled = ((now - bucket.lastRefill) / 60_000) * limit.perMinute;
  bucket.tokens = Math.min(limit.burst, bucket.tokens + refilled);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return { ok: false, retryAfterMs: Math.ceil(((1 - bucket.tokens) / limit.perMinute) * 60_000) };
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return { ok: true };
}

/**
 * A refusal shaped the way the rest of the API refuses things.
 *
 * `Retry-After` is in whole seconds because that is what the header means, and
 * rounding up is the honest direction: a client that waits the number it was
 * given should succeed.
 */
export function tooMany(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return Response.json(
    { error: `Too many requests. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.` },
    { status: 429, headers: { 'retry-after': String(seconds) } },
  );
}

/**
 * Who to count this against.
 *
 * An account where there is one, because that is the thing being limited and it
 * survives a change of address. Signed-out callers fall back to the forwarded
 * client address, which is spoofable but is still the only handle there is, and
 * the routes that accept them are the cheap ones.
 */
export function callerOf(request: Request, userId: string | null): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return `ip:${forwarded || 'unknown'}`;
}

/** Drops buckets nobody has touched, so a long-running process does not grow one per caller forever. */
function sweep(now: number): void {
  if (now - lastSweep < IDLE_MS) return;
  lastSweep = now;

  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > IDLE_MS) buckets.delete(key);
  }
}
