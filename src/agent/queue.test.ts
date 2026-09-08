import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelQueue, SpendCeilingReached } from './queue';
import { ProviderError, ProviderUnavailable, RateLimited } from './provider';

/**
 * The queue is what stands between one bad API key and six dead tables.
 *
 * Two things are being pinned down. A key that fails has to leave rotation so
 * the next request tries a different one, rather than every seat in the
 * building queueing behind the same broken credential. And the whole pool has
 * to have a ceiling, because the tables play by themselves: nobody has to stay
 * and watch for the bill to keep growing.
 */

/** A queue whose clock the test owns, so nothing here waits on real time. */
function queueOf(keys: string[], rpm = 600, dailyCap: number | null = null) {
  let now = 0;
  const queue = new ModelQueue(
    keys,
    rpm,
    () => now,
    async (ms) => {
      now += ms;
    },
    dailyCap,
  );
  return { queue, advance: (ms: number) => (now += ms), at: () => now };
}

test('a rate-limited key steps aside and the next one is used', async () => {
  const { queue } = queueOf(['first', 'second']);
  const tried: string[] = [];

  const result = await queue.run(async (key) => {
    tried.push(key);
    if (key === 'first') throw new RateLimited('slow down', 1_000);
    return 'answered';
  });

  assert.equal(result, 'answered');
  assert.deepEqual(tried, ['first', 'second']);
});

test('a key the provider refuses steps aside too', async () => {
  const { queue } = queueOf(['bad', 'good']);
  const tried: string[] = [];

  const result = await queue.run(async (key) => {
    tried.push(key);
    if (key === 'bad') throw new ProviderUnavailable('gemini refused this key (403)', 60_000);
    return 'answered';
  });

  assert.equal(result, 'answered');
  assert.deepEqual(tried, ['bad', 'good']);
});

test('a cooled-down key is not offered again while it is sitting out', async () => {
  const { queue, advance } = queueOf(['first', 'second']);

  await queue.run(async (key) => {
    if (key === 'first') throw new ProviderUnavailable('down', 60_000);
    return 'ok';
  });

  const next: string[] = [];
  await queue.run(async (key) => {
    next.push(key);
    return 'ok';
  });
  assert.deepEqual(next, ['second'], 'the failed key is still out');

  advance(120_000);
  const later: string[] = [];
  await queue.run(async (key) => {
    later.push(key);
    return 'ok';
  });
  assert.deepEqual(later, ['first'], 'and comes back once its cooldown has passed');
});

test('a reply that came back and was unusable does not burn the other keys', async () => {
  const { queue } = queueOf(['first', 'second', 'third']);
  let calls = 0;

  await assert.rejects(
    queue.run(async () => {
      calls += 1;
      // The provider answered. Asking three more keys the same question spends
      // three times as much to be told the same thing.
      throw new ProviderError('gemini returned no text');
    }),
    ProviderError,
  );

  assert.equal(calls, 1);
});

test('a key that keeps failing sits out for longer each time', async () => {
  const { queue, advance } = queueOf(['only']);

  await assert.rejects(
    queue.run(async () => {
      throw new ProviderUnavailable('down', 1_000);
    }),
  );

  // Two strikes on the single key: 1s then 2s. A minute later it is back.
  const after = queue.snapshot();
  assert.equal(after.failed, 2);
  assert.equal(after.coolingDown, 1);

  advance(60_000);
  assert.equal(queue.snapshot().coolingDown, 0);
});

test('a successful request clears a key’s record', async () => {
  const { queue, advance } = queueOf(['only']);

  await assert.rejects(queue.run(async () => {
    throw new ProviderUnavailable('blip', 1_000);
  }));

  advance(60_000);
  await queue.run(async () => 'ok');

  // Without the reset the next failure would back off from where the old
  // strikes left it, and a key that has been fine for a week would be
  // punished for a bad afternoon.
  const before = queue.snapshot().coolingDown;
  assert.equal(before, 0);
});

test('the daily ceiling refuses requests rather than spending past it', async () => {
  const { queue } = queueOf(['only'], 600, 3);

  for (let i = 0; i < 3; i++) await queue.run(async () => 'ok');

  await assert.rejects(queue.run(async () => 'ok'), SpendCeilingReached);
  assert.equal(queue.snapshot().spentToday, 3);
  assert.equal(queue.snapshot().refused, 1);
});

test('the ceiling counts every attempt, including the ones that failed', async () => {
  const { queue } = queueOf(['first', 'second'], 600, 2);

  // A failed request still cost money. Counting only successes would let a
  // failing provider run up an unbounded bill.
  await assert.rejects(
    queue.run(async () => {
      throw new ProviderUnavailable('down', 100);
    }),
  );

  await assert.rejects(queue.run(async () => 'ok'), SpendCeilingReached);
});

test('the ceiling rolls over after a day', async () => {
  const { queue, advance } = queueOf(['only'], 600, 1);

  await queue.run(async () => 'ok');
  await assert.rejects(queue.run(async () => 'ok'), SpendCeilingReached);

  advance(24 * 60 * 60_000 + 1);
  assert.equal(await queue.run(async () => 'ok'), 'ok');
  assert.equal(queue.snapshot().spentToday, 1);
});

test('no ceiling is configured by default', async () => {
  const { queue } = queueOf(['only']);
  for (let i = 0; i < 50; i++) await queue.run(async () => 'ok');
  assert.equal(queue.snapshot().dailyCap, null);
});

test('a shutdown mid-request does not punish the key', async () => {
  const { queue } = queueOf(['first', 'second']);
  const controller = new AbortController();

  await assert.rejects(
    queue.run(async () => {
      controller.abort();
      throw new ProviderUnavailable('aborted', 60_000);
    }, controller.signal),
  );

  // Our own deploy is not the key's fault.
  assert.equal(queue.snapshot().coolingDown, 0);
  assert.equal(queue.snapshot().failed, 0);
});

test('the rate limit still holds when every key is healthy', async () => {
  const { queue } = queueOf(['a', 'b'], 2);
  assert.equal(queue.available, 2);

  await queue.run(async () => 'ok');
  await queue.run(async () => 'ok');

  assert.equal(queue.available, 0, 'the bucket is spent even though a second key is free');
});
