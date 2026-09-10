import '../dev/test-env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, callerOf, take } from './rate-limit';

/** A caller nobody else in this file shares, so the buckets cannot interfere. */
function someone(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2)}`;
}

test('a burst is allowed and then the door closes', () => {
  const who = someone('burst');
  const { burst } = LIMITS['deposit-confirm'];

  for (let i = 0; i < burst; i++) {
    assert.equal(take('deposit-confirm', who).ok, true, `request ${i + 1} of the burst`);
  }

  const refused = take('deposit-confirm', who);
  assert.equal(refused.ok, false, 'the one after the burst is refused');
  assert.ok(refused.ok === false && refused.retryAfterMs > 0, 'and it says how long to wait');
});

test('one caller running out does not close the door on anybody else', () => {
  const noisy = someone('noisy');
  const quiet = someone('quiet');

  for (let i = 0; i < LIMITS.seat.burst + 5; i++) take('seat', noisy);

  assert.equal(take('seat', noisy).ok, false);
  assert.equal(take('seat', quiet).ok, true, 'a limit is per caller, not a global tap');
});

test('limits are counted per route, not shared across them', () => {
  const who = someone('routes');
  for (let i = 0; i < LIMITS['deposit-start'].burst; i++) take('deposit-start', who);

  assert.equal(take('deposit-start', who).ok, false);
  assert.equal(take('seat', who).ok, true, 'spending one allowance does not spend another');
});

test('an account is counted as itself, and a stranger by address', () => {
  const request = new Request('https://example.test/', {
    headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18' },
  });

  assert.equal(callerOf(request, 'user-1'), 'user:user-1', 'an account outlives its address');
  assert.equal(callerOf(request, null), 'ip:203.0.113.7', 'the client, not the proxies behind it');
  assert.equal(callerOf(new Request('https://example.test/'), null), 'ip:unknown');
});

test('the wait it quotes is long enough to actually succeed', async () => {
  const who = someone('refill');
  for (let i = 0; i < LIMITS.write.burst; i++) take('write', who);

  const refused = take('write', who);
  assert.equal(refused.ok, false);
  if (refused.ok) return;

  await new Promise((resolve) => setTimeout(resolve, refused.retryAfterMs + 25));
  assert.equal(take('write', who).ok, true, 'waiting the quoted time is enough');
});
