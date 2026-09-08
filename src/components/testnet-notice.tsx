'use client';

import { useSyncExternalStore } from 'react';
import { FAUCET_URL, TESTNET_LINE } from '@/lib/network';

const KEY = 'agentholdem:testnet-notice-dismissed';

/**
 * Whether this browser has already dismissed the notice.
 *
 * `localStorage` is an external store, and reading one during render or poking
 * it from an effect is how a component ends up re-rendering itself in a loop.
 * `useSyncExternalStore` is the shape React provides for exactly this, and it
 * also handles the server: the server snapshot says "dismissed", so the notice
 * is absent from the markup and appears once the browser has been asked,
 * rather than being rendered and then yanked away from somebody who dismissed
 * it last week.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isDismissed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    // Private browsing, or storage turned off. Showing it is the safe way to
    // be wrong: the notice is the part that matters, not the dismissal.
    return false;
  }
}

function dismiss(): void {
  try {
    window.localStorage.setItem(KEY, '1');
  } catch {
    // Not being able to remember the dismissal is not worth an error. It
    // reappears next visit, which is a smaller problem than a broken page.
  }
  for (const listener of listeners) listener();
}

/**
 * The one thing a visitor has to know before they touch anything, and the one
 * link without which they cannot do anything at all.
 *
 * Above the header rather than inside a page, because "testnet, not real
 * money" belongs on every screen and not only on the one somebody happened to
 * land on. Dismissible, because a bar that cannot be closed is a bar people
 * learn to look past — and the same sentence stays in the cashier and in the
 * questions on the home page, where it is load-bearing rather than ambient.
 */
export function TestnetNotice() {
  const dismissed = useSyncExternalStore(subscribe, isDismissed, () => true);
  if (dismissed) return null;

  return (
    <div className="border-b border-line bg-surface-2">
      <div className="mx-auto flex w-full max-w-[84rem] flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 text-[0.8125rem] sm:px-6">
        <p className="min-w-0 text-muted">
          <span className="font-medium text-ink">{TESTNET_LINE}</span>{' '}
          <a
            href={FAUCET_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent underline underline-offset-2 hover:no-underline"
          >
            Get free tBNB
          </a>
        </p>
        <button
          type="button"
          onClick={dismiss}
          className="ml-auto shrink-0 font-medium text-faint transition-colors hover:text-ink"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
