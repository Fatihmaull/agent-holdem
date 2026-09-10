'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { PublicChain } from '@/lib/chains';
import { ensureChain, hasWallet } from '@/lib/wallet';

/**
 * Which network the player is on, for the whole interface.
 *
 * The list comes from the server rather than from a constant here, so this
 * build runs against whatever chains the deployment enabled. Until it arrives
 * the active chain is null and anything that would move money stays disabled,
 * which is better than guessing a network and sending a deposit to it.
 */

interface ChainContextValue {
  chains: PublicChain[];
  chain: PublicChain | null;
  loading: boolean;
  switching: boolean;
  switchChain(key: string): Promise<void>;
}

const Context = createContext<ChainContextValue | null>(null);

interface ChainsResponse {
  chains: PublicChain[];
  active: string;
}

export function ChainProvider({ children }: { children: React.ReactNode }) {
  const [chains, setChains] = useState<PublicChain[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/chains', { cache: 'no-store' })
      .then((response) => response.json() as Promise<ChainsResponse>)
      .then((body) => {
        if (cancelled) return;
        setChains(body.chains ?? []);
        setActive(body.active ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const switchChain = useCallback(
    async (key: string) => {
      const target = chains.find((entry) => entry.key === key);
      if (!target || key === active) return;

      setSwitching(true);
      try {
        const response = await fetch('/api/chains', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chain: key }),
        });
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          throw new Error(body.error ?? 'That network is unavailable.');
        }
        setActive(key);

        // The wallet is moved too, but its refusal is not a failure: watching a
        // table needs no wallet, and the next transaction asks again anyway.
        if (hasWallet()) await ensureChain(target).catch(() => {});
      } finally {
        setSwitching(false);
      }
    },
    [chains, active],
  );

  const value = useMemo<ChainContextValue>(() => {
    const current = chains.find((entry) => entry.key === active) ?? null;
    return { chains, chain: current, loading, switching, switchChain };
  }, [chains, active, loading, switching, switchChain]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useChain(): ChainContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useChain must be used inside ChainProvider');
  return value;
}
