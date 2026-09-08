'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { formatChips } from '@/lib/economy';
import { shortAddress } from '@/lib/wallet';
import { useAccount } from './account-context';
import { Cashier } from './cashier';
import { Button } from './ui';

const NAV = [
  { href: '/', label: 'Home', short: 'Home' },
  { href: '/tables', label: 'Tables', short: 'Tables' },
  { href: '/leaderboard', label: 'Leaderboard', short: 'Ranks' },
  { href: '/agent', label: 'Your agent', short: 'Agent' },
];

/**
 * The one persistent bar. It answers, left to right, the three questions a
 * player has on every screen: where am I, where else can I go, and how many
 * chips do I have.
 */
export function SiteHeader() {
  const { account, connecting, error, signIn, signOut, dismissError } = useAccount();
  const [cashierOpen, setCashierOpen] = useState(false);
  const pathname = usePathname();

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/90 backdrop-blur-md">
        <div className="mx-auto flex h-[var(--header-h)] w-full max-w-[84rem] items-center gap-2 px-4 sm:gap-6 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2 text-[0.9375rem] font-semibold text-ink">
            <Suit />
            <span className="hidden sm:inline">AgentHoldem</span>
          </Link>

          <nav aria-label="Main" className="scroll-x flex min-w-0 items-center gap-0.5">
            {NAV.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded-control px-2.5 py-1.5 text-[0.8125rem] font-medium whitespace-nowrap transition-colors sm:px-3 sm:text-sm ${
                    active ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'
                  }`}
                >
                  <span className="sm:hidden">{item.short}</span>
                  <span className="hidden sm:inline">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted lg:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              BNB Testnet
            </span>

            {account ? (
              <>
                <button
                  type="button"
                  onClick={() => setCashierOpen(true)}
                  aria-label={`Cashier. Balance ${formatChips(account.chips)} chips.`}
                  className="inline-flex h-9 items-center gap-2 rounded-control border border-line-strong bg-surface-2 pr-2 pl-3 text-sm transition-colors hover:bg-surface-3"
                >
                  <span className="mono text-ink tabular-nums">{formatChips(account.chips)}</span>
                  <span className="hidden text-xs text-faint sm:inline">chips</span>
                  <span className="rounded-[0.3125rem] bg-accent px-2 py-1 text-xs font-semibold text-accent-ink">
                    Buy
                  </span>
                </button>
                <WalletMenu address={account.address} onSignOut={() => void signOut()} />
              </>
            ) : (
              <Button tone="primary" onClick={() => void signIn()} disabled={connecting}>
                <span className="sm:hidden">{connecting ? 'Check wallet' : 'Connect'}</span>
                <span className="hidden sm:inline">{connecting ? 'Check your wallet' : 'Connect wallet'}</span>
              </Button>
            )}
          </div>
        </div>
      </header>

      {error ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
          <div className="entering pointer-events-auto flex max-w-[40rem] items-start gap-4 rounded-card border border-danger/40 bg-surface px-4 py-3 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]">
            <p className="text-sm text-ink">{error}</p>
            <button
              type="button"
              onClick={dismissError}
              className="shrink-0 text-sm font-medium text-muted transition-colors hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {cashierOpen ? <Cashier onClose={() => setCashierOpen(false)} /> : null}
    </>
  );
}

/**
 * The mark, drawn rather than set: a glyph dropped into a coloured rounded
 * square is the placeholder every generated interface ships with. A spade at
 * the size of a capital reads as a wordmark instead of as a stand-in.
 */
function Suit() {
  return (
    <svg viewBox="0 0 24 24" className="h-[1.15em] w-[1.15em] shrink-0 text-accent" fill="currentColor" aria-hidden>
      <path d="M12 2.2 5.6 9.1c-2 2.2-2.1 5.4-.2 7.2 1.7 1.6 4.4 1.4 6-.4l-1.1 5.5h3.4l-1.1-5.5c1.6 1.8 4.3 2 6 .4 1.9-1.8 1.8-5-.2-7.2L12 2.2Z" />
    </svg>
  );
}

function WalletMenu({ address, onSignOut }: { address: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // A menu that stays open after you have clicked elsewhere is a menu you have
  // to dismiss twice, so the document closes it and Escape does too.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="mono inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-[0.8125rem] text-muted transition-colors hover:text-ink"
      >
        <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
        <span className="hidden sm:inline">{shortAddress(address)}</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="entering absolute right-0 z-50 mt-2 w-60 rounded-card border border-line bg-surface p-1.5 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)]"
        >
          <div className="px-2.5 py-2">
            <p className="label text-faint">Wallet</p>
            <p className="mono mt-1 text-xs break-all text-muted">{address}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="w-full rounded-[0.375rem] px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface-2"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
