import { getSession, type Session } from './auth';
import { RULES, type RuleName, callerAddress, consume } from './rate-limit';
import { logger } from './log';

/**
 * The one thing every write route does before anything else.
 *
 * Session and rate limit together, in that order, because the account is the
 * identity the limit is really about. Bundling them is what stops a new route
 * from quietly shipping without a limit: there is no way to get a session
 * without passing through here, and no reason to reach for `getSession`
 * directly in a route that writes.
 */

export type Guarded = { ok: true; session: Session } | { ok: false; response: Response };

/** Requires a signed-in account, and counts the request against it and its IP. */
export async function guard(request: Request, rule: RuleName): Promise<Guarded> {
  const session = await getSession();
  if (!session) {
    return { ok: false, response: Response.json({ error: 'Connect your wallet first.' }, { status: 401 }) };
  }

  const refused = refuse(request, rule, session.userId);
  return refused ? { ok: false, response: refused } : { ok: true, session };
}

/** For routes with no account yet — signing in — where the IP is all there is. */
export function guardAnonymous(request: Request, rule: RuleName): Response | null {
  return refuse(request, rule, null);
}

function refuse(request: Request, rule: RuleName, userId: string | null): Response | null {
  const limit = RULES[rule];
  const address = callerAddress(request);

  // Both, because they defend against different things. The account limit
  // stops one signed-in person hammering the cashier; the address limit stops
  // somebody minting wallets to get a fresh allowance each time — wallets are
  // free, so a per-account limit alone is barely a limit at all.
  const checks: Array<{ scope: string; identity: string }> = [{ scope: `${rule}:ip`, identity: address }];
  if (userId) checks.push({ scope: `${rule}:account`, identity: userId });

  for (const check of checks) {
    const verdict = consume(check.scope, check.identity, limit);
    if (verdict.ok) continue;

    const seconds = Math.ceil(verdict.retryAfterMs / 1000);
    logger.warn('rate-limit.refused', { rule, scope: check.scope, userId, retryAfterMs: verdict.retryAfterMs });

    // 429 with a number, not a hang and not a silent drop. Somebody hitting
    // this is usually a script with a bug, and telling it when to come back is
    // the difference between a pause and a retry storm.
    return Response.json(
      {
        error: `That is more than this account is allowed to do at once. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
        retryAfterMs: verdict.retryAfterMs,
      },
      { status: 429, headers: { 'retry-after': String(seconds) } },
    );
  }

  return null;
}
