'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatChips } from '@/lib/format';
import { CashierModal } from './CashierModal';

/** Bankroll pill in the navigation; opens the cashier. */
export function BankrollBadge() {
  const { address } = useAccount();
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['bankroll', address],
    queryFn: () => api.bankroll(address as string),
    enabled: Boolean(address),
    refetchInterval: 10_000,
  });

  const bankroll = data?.bankroll;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!address}
        className="btn-ghost !px-3.5 disabled:opacity-40"
        title={address ? 'Open the cashier' : 'Connect a wallet first'}
      >
        <span className="text-amber-300">◉</span>
        <span className="tabular-nums">
          {bankroll ? formatChips(bankroll.available) : '—'}
        </span>
        <span className="hidden text-slate-400 sm:inline">chips</span>
        {bankroll && bankroll.locked > 0 ? (
          <span className="hidden text-xs text-slate-500 sm:inline">
            +{formatChips(bankroll.locked)} in play
          </span>
        ) : null}
      </button>

      {open ? <CashierModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}
