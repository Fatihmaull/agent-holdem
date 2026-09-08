import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import '../dev/test-env';
import { RULES, consume, resetLimits } from './rate-limit';

/**
 * Two different worries, both about limits that are easy to lose.
 *
 * The first is arithmetic: a limit that refills wrongly either locks people
 * out or does not limit anything.
 *
 * The second is a structural test rather than a behavioural one, which is
 * unusual and deliberate. Rate limiting is not a feature anyone will notice
 * missing from a new route — everything works, only faster than it should —
 * so the only reliable moment to catch it is when the route is added. This
 * fails then, by name.
 */

const ROUTES = join(import.meta.dirname, '..', 'app', 'api');

/** Routes allowed to write without a guard, each with its reason. */
const EXEMPT: Record<string, string> = {
  'auth/logout/route.ts': 'signing out costs nothing and must never be refused',
};

function routeFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const name = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) return routeFiles(full, name);
    return entry === 'route.ts' ? [name] : [];
  });
}

test('every route that writes goes through the guard', () => {
  const unguarded: string[] = [];

  for (const name of routeFiles(ROUTES)) {
    const source = readFileSync(join(ROUTES, name), 'utf8');
    const writes = /export async function (POST|PUT|PATCH|DELETE)\b/.test(source);
    if (!writes) continue;
    if (name in EXEMPT) continue;
    if (/\bguard(Anonymous)?\(/.test(source)) continue;
    unguarded.push(name);
  }

  assert.deepEqual(
    unguarded,
    [],
    `these routes write without a rate limit. Use guard() from @/server/guard, or add them to EXEMPT with a reason:\n  ${unguarded.join('\n  ')}`,
  );
});

test('an exemption has to say why it is one', () => {
  for (const [route, reason] of Object.entries(EXEMPT)) {
    assert.ok(reason.length > 20, `${route} is exempt without a real reason`);
  }
});

test('an allowance is spent down and refuses once it is gone', () => {
  resetLimits();
  const rule = { limit: 3, windowMs: 1_000 };
  const now = 0;

  for (let i = 0; i < 3; i++) {
    assert.equal(consume('test', 'someone', rule, () => now).ok, true, `request ${i + 1} is within the allowance`);
  }

  const refused = consume('test', 'someone', rule, () => now);
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfterMs > 0, 'a refusal says when to come back');
});

test('an allowance refills over the window rather than all at once', () => {
  resetLimits();
  const rule = { limit: 4, windowMs: 1_000 };
  let now = 0;
  for (let i = 0; i < 4; i++) consume('refill', 'someone', rule, () => now);
  assert.equal(consume('refill', 'someone', rule, () => now).ok, false);

  // A quarter of the window buys back exactly one request. A fixed window
  // would hand back all four here, which is the burst these rules exist to
  // stop: the whole allowance at the end of one window and the whole of the
  // next at the start of the following one.
  now = 250;
  assert.equal(consume('refill', 'someone', rule, () => now).ok, true);
  assert.equal(consume('refill', 'someone', rule, () => now).ok, false);
});

test('retrying while refused does not push recovery further away', () => {
  resetLimits();
  const rule = { limit: 1, windowMs: 1_000 };
  let now = 0;
  consume('retry', 'someone', rule, () => now);

  const first = consume('retry', 'someone', rule, () => now);
  now = 100;
  const second = consume('retry', 'someone', rule, () => now);

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.ok(second.retryAfterMs < first.retryAfterMs, 'the wait shrinks as time passes, however often you ask');
});

test('one caller running out does not refuse anybody else', () => {
  resetLimits();
  const rule = { limit: 2, windowMs: 1_000 };
  const now = () => 0;

  consume('shared', 'noisy', rule, now);
  consume('shared', 'noisy', rule, now);
  assert.equal(consume('shared', 'noisy', rule, now).ok, false);

  assert.equal(consume('shared', 'quiet', rule, now).ok, true);
});

test('scopes do not share an allowance', () => {
  resetLimits();
  const rule = { limit: 1, windowMs: 1_000 };
  const now = () => 0;

  assert.equal(consume('cashier:account', 'someone', rule, now).ok, true);
  assert.equal(consume('cashier:account', 'someone', rule, now).ok, false);
  // The same person on a different kind of request is not affected: spending
  // the cashier's allowance must not stop them renaming an agent.
  assert.equal(consume('write:account', 'someone', rule, now).ok, true);
});

test('every rule allows enough for ordinary use and not much more', () => {
  for (const [name, rule] of Object.entries(RULES)) {
    assert.ok(rule.limit >= 10, `${name} allows only ${rule.limit}, which ordinary use would hit`);
    assert.ok(rule.limit <= 100, `${name} allows ${rule.limit}, which is not much of a limit`);
    assert.ok(rule.windowMs > 0);
  }
});
