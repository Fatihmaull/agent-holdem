'use client';

import { encodeFunctionData, numberToHex } from 'viem';
import type { ChainInfo } from '@/lib/chains';
import { chipVaultAbi } from '@/server/vault-abi';

/**
 * Talks to whatever injected wallet the browser has, over EIP-1193 directly.
 * Nothing here holds a key or signs anything itself.
 */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export class WalletError extends Error {}

function wallet(): Eip1193Provider {
  const injected = typeof window === 'undefined' ? undefined : window.ethereum;
  if (!injected) throw new WalletError('No wallet found. Install MetaMask or another browser wallet to continue.');
  return injected;
}

/** Whether the browser has an injected wallet at all. */
export function hasWallet(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ethereum);
}

export async function connect(chain: ChainInfo): Promise<string> {
  const accounts = (await wallet().request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0];
  if (!address) throw new WalletError('Your wallet returned no account.');
  await ensureChain(chain);
  return address;
}

export async function currentAddress(): Promise<string | null> {
  if (!hasWallet()) return null;
  const accounts = (await wallet().request({ method: 'eth_accounts' })) as string[];
  return accounts[0] ?? null;
}

/**
 * Moves the wallet to a network, describing it first if the wallet has never
 * heard of it. The description comes from the chain registry, so a network the
 * wallet does not ship with is added rather than refused.
 */
export async function ensureChain(chain: ChainInfo): Promise<void> {
  const target = numberToHex(chain.id);
  const current = (await wallet().request({ method: 'eth_chainId' })) as string;
  if (current?.toLowerCase() === target.toLowerCase()) return;

  try {
    await wallet().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902) throw error;
    await wallet().request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: target,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [chain.defaultRpcUrl],
          blockExplorerUrls: [chain.explorer.url],
        },
      ],
    });
  }
}

export async function signMessage(address: string, message: string): Promise<string> {
  return (await wallet().request({ method: 'personal_sign', params: [message, address] })) as string;
}

/** Sends the buy-in to the vault with the intent the server issued. */
export async function sendDeposit(options: {
  from: string;
  chain: ChainInfo;
  vault: `0x${string}`;
  intentId: `0x${string}`;
  valueWei: string;
}): Promise<string> {
  await ensureChain(options.chain);

  const data = encodeFunctionData({
    abi: chipVaultAbi,
    functionName: 'deposit',
    args: [options.intentId],
  });

  return (await wallet().request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: options.from,
        to: options.vault,
        value: numberToHex(BigInt(options.valueWei)),
        data,
      },
    ],
  })) as string;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
