'use client';

import { encodeFunctionData, numberToHex } from 'viem';
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

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 97);

const BNB_TESTNET = {
  chainId: numberToHex(97),
  chainName: 'BNB Smart Chain Testnet',
  nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
  rpcUrls: ['https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
  blockExplorerUrls: ['https://testnet.bscscan.com'],
};

function wallet(): Eip1193Provider {
  const injected = typeof window === 'undefined' ? undefined : window.ethereum;
  if (!injected) throw new WalletError('No wallet found. Install MetaMask or another browser wallet to continue.');
  return injected;
}

function hasWallet(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ethereum);
}

export async function connect(): Promise<string> {
  const accounts = (await wallet().request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0];
  if (!address) throw new WalletError('Your wallet returned no account.');
  await ensureChain();
  return address;
}

export async function currentAddress(): Promise<string | null> {
  if (!hasWallet()) return null;
  const accounts = (await wallet().request({ method: 'eth_accounts' })) as string[];
  return accounts[0] ?? null;
}

/** Moves the wallet to BNB testnet, adding the network if it does not know it. */
async function ensureChain(): Promise<void> {
  const target = numberToHex(CHAIN_ID);
  const current = (await wallet().request({ method: 'eth_chainId' })) as string;
  if (current?.toLowerCase() === target.toLowerCase()) return;

  try {
    await wallet().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902) throw error;
    await wallet().request({ method: 'wallet_addEthereumChain', params: [BNB_TESTNET] });
  }
}

export async function signMessage(address: string, message: string): Promise<string> {
  return (await wallet().request({ method: 'personal_sign', params: [message, address] })) as string;
}

/** Sends the buy-in to the vault with the intent the server issued. */
export async function sendDeposit(options: {
  from: string;
  vault: `0x${string}`;
  intentId: `0x${string}`;
  valueWei: string;
}): Promise<string> {
  await ensureChain();

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
