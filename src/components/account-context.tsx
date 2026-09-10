'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { connect, currentAddress, signMessage, WalletError } from '@/lib/wallet';
import { useChain } from './chain-context';

interface AccountAgent {
  id: string;
  name: string;
  color: string;
  instructions: string;
  handsPlayed: number;
  handsWon: number;
  chipsWon: number;
  biggestPot: number;
  /** The published rating, which is what the standings sort on. */
  rating: number;
  matchesPlayed: number;
}

interface AccountState {
  address: string;
  chips: number;
  agent: AccountAgent;
  /** The match it is playing in right now, or null while it waits for one. */
  seat: { matchId: string; seatIndex: number; stack: number } | null;
  /** Whether its owner has it switched on. Off means it queues for nothing. */
  playing: boolean;
}

interface AccountContextValue {
  account: AccountState | null;
  loading: boolean;
  connecting: boolean;
  error: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  dismissError(): void;
}

const Context = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const { chain } = useChain();
  const [account, setAccount] = useState<AccountState | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/account', { cache: 'no-store' });
    const body = (await response.json()) as { session: unknown; account?: AccountState };
    setAccount(body.session && body.account ? body.account : null);
    setLoading(false);
  }, []);

  // The session lives on the server, so it is read once on mount and applied in
  // a callback rather than assigned while the effect body runs.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/account', { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ session: unknown; account?: AccountState }>)
      .then((body) => {
        if (cancelled) return;
        setAccount(body.session && body.account ? body.account : null);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      // Signing in puts the wallet on the network the server will name in the
      // message, so the two do not disagree on the first transaction.
      if (!chain) throw new Error('Still loading the available networks. Try again in a moment.');
      const address = (await currentAddress()) ?? (await connect(chain));

      const nonceResponse = await fetch(`/api/auth/nonce?address=${address}`, { cache: 'no-store' });
      const nonceBody = (await nonceResponse.json()) as { message?: string; error?: string };
      if (!nonceResponse.ok || !nonceBody.message) throw new Error(nonceBody.error ?? 'Could not start sign-in.');

      // Signed exactly as the server wrote it. Nothing here edits the message,
      // so the domain, chain and nonce checked on verify are the ones signed.
      const message = nonceBody.message;
      const signature = await signMessage(address, message);

      const verify = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });

      if (!verify.ok) {
        const body = (await verify.json()) as { error?: string };
        throw new Error(body.error ?? 'Sign-in failed.');
      }

      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setConnecting(false);
    }
  }, [refresh, chain]);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAccount(null);
  }, []);

  const value = useMemo<AccountContextValue>(
    () => ({
      account,
      loading,
      connecting,
      error,
      signIn,
      signOut,
      refresh,
      dismissError: () => setError(null),
    }),
    [account, loading, connecting, error, signIn, signOut, refresh],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAccount(): AccountContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('useAccount must be used inside AccountProvider');
  return value;
}

function describe(cause: unknown): string {
  if (cause instanceof WalletError) return cause.message;
  const code = (cause as { code?: number })?.code;
  if (code === 4001) return 'Sign-in cancelled.';
  if (cause instanceof Error) return cause.message;
  return 'Something went wrong connecting your wallet.';
}
