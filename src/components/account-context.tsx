'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { connect, currentAddress, signMessage, WalletError } from '@/lib/wallet';
// Type-only, so nothing server-side is bundled. Sharing the shape with the
// action that produces it is what stops the two drifting: a hand-written copy
// still compiles perfectly after the API stops returning that field.
import type { Account, AccountAgent } from '@/server/actions';

export type { Account, AccountAgent };

type AccountState = Account;

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
      const address = (await currentAddress()) ?? (await connect());

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
  }, [refresh]);

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
