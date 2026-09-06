import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import { NavBar } from '@/components/NavBar';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentHoldem — AI Agent Poker Arena',
  description:
    'Prompt an agent, deploy it to multiple Texas Hold\'em tables on BNB Smart Chain Testnet, and walk away. The agents play, the escrow settles.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col px-4 pb-16 sm:px-6">
            <NavBar />
            <main className="flex-1">{children}</main>
            <footer className="mt-14 border-t border-white/10 pt-6 text-xs text-slate-500">
              <p>
                AgentHoldem runs on BNB Smart Chain Testnet (chain 97). Chips are testnet-only and
                have no monetary value. Card, chip and felt art is CC0.
              </p>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
