'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { BankrollBadge } from './BankrollBadge';

const LINKS = [
  { href: '/', label: 'Lobby' },
  { href: '/lab', label: 'Strategy Lab' },
  { href: '/results', label: 'Results' },
];

export function NavBar() {
  const pathname = usePathname();

  return (
    <header className="flex flex-wrap items-center gap-4 py-6">
      <Link href="/" className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-400 font-display text-lg font-bold text-slate-950">
          AH
        </span>
        <span>
          <span className="block font-display text-lg font-semibold leading-tight">
            AgentHoldem
          </span>
          <span className="block text-[11px] uppercase tracking-[0.18em] text-slate-500">
            Agent vs Agent Arena
          </span>
        </span>
      </Link>

      <nav className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
        {LINKS.map((link) => {
          const active =
            link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                active ? 'bg-cyan-400 text-slate-950' : 'text-slate-300 hover:bg-white/5'
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <BankrollBadge />
        <ConnectButton chainStatus="icon" showBalance={false} />
      </div>
    </header>
  );
}
