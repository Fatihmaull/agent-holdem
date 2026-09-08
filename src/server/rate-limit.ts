/**
 * Per-account and per-IP limits on everything that writes.
 *
 * Eighteen routes had none. The tables are autonomous and signing up costs
 * nothing, so the loop that actually hurts is not a flood of traffic — it is
 * one script signing up, deploying, leaving, and going round again, spending
 * the operator's model budget and churning the table roster while nobody is
 * watching. Every limit here is sized against that, not against a benchmark.
 *
 * ## In memory, on purpose
 *
 * Table state already lives in exactly one process — that is a load-bearing
 * invariant of this codebase, written down in `CLAUDE.md` — so a counter in
 * that process is exactly as authoritative as the tables it protects. The day
 * that changes, this has to move to the database or to Redis along with
 * everything else, and `docs/DECISIONS.md` is where that gets decided.
 */

export interface Rule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

/**
 * What each kind of request is allowed.
 *
 * Sized by what the request costs us rather than by how it feels. Anything
 * that spends chips or creates an agent is scarce; reading is not limited at
 * all, because a read costs a query and the interface polls.
 */
export const RULES = {
  /** Signing in. Unauthenticated, so this one is per-IP and does the real work. */
  auth: { limit: 20, windowMs: 60_000 },
  /** Creating, renaming and retiring agents; saving drafts. */
  write: { limit: 40, windowMs: 60_000 },
  /**
   * Taking and leaving seats. Each one moves chips and wakes a table, and a
   * join/leave loop is the cheapest way to make the engine do work for free.
   */
  seat: { limit: 12, windowMs: 60_000 },
  /** The cashier. Every one of these touches the chain or the treasury. */
  cashier: { limit: 10, windowMs: 60_000 },
} as const satisfies Record<string, Rule>;

export type RuleName = keyof typeof RULES;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * A token bucket rather than a fixed window: a fixed window lets somebody
 * spend the whole allowance in the last second of one window and the whole of
 * the next in the first second of the following one, which is twice the limit
 * back to back and exactly the burst these rules exist to stop.
 */
const buckets = new Map<string, Bucket>();

/** Beyond this many tracked keys, the idle ones are dropped early. */
const MAX_BUCKETS = 50_000;

export interface Verdict {
  ok: boolean;
  /** How long until one more request would be allowed. Zero when it is. */
  retryAfterMs: number;
}

export function consume(
  scope: string,
  identity: string,
  rule: Rule,
  now: () => number = Date.now,
): Verdict {
  const key = `${scope}:${identity}`;
  const at = now();
  const bucket = buckets.get(key) ?? { tokens: rule.limit, updatedAt: at };

  const refilled = Math.min(rule.limit, bucket.tokens + ((at - bucket.updatedAt) / rule.windowMs) * rule.limit);

  if (refilled < 1) {
    // Not spent, so a caller who is already over the limit does not push their
    // own recovery further away by retrying.
    buckets.set(key, { tokens: refilled, updatedAt: at });
    return { ok: false, retryAfterMs: Math.ceil(((1 - refilled) * rule.windowMs) / rule.limit) };
  }

  buckets.set(key, { tokens: refilled - 1, updatedAt: at });
  if (buckets.size > MAX_BUCKETS) prune(at);
  return { ok: true, retryAfterMs: 0 };
}

/**
 * Forgets anyone whose allowance has fully refilled.
 *
 * A full bucket is indistinguishable from never having been seen, so dropping
 * it changes nothing and is what keeps this from growing with every address
 * that ever visited.
 */
function prune(at: number): void {
  for (const [key, bucket] of buckets) {
    // The widest window in use, so one pass is safe for every rule.
    if (at - bucket.updatedAt > 5 * 60_000) buckets.delete(key);
  }
}

/** Only for tests: the counters are process-wide and shared between them. */
export function resetLimits(): void {
  buckets.clear();
}

/**
 * Who to count this request against.
 *
 * `x-forwarded-for` is only as trustworthy as whatever set it, so this is
 * correct behind our own proxy and forgeable if the app is ever exposed
 * directly. The account limit is the one that matters for anything signed in;
 * the address is the backstop for sign-in itself, which has no account yet.
 */
export function callerAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}
