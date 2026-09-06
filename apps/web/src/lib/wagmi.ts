'use client';

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { bscTestnet } from 'wagmi/chains';
import { http } from 'wagmi';

/**
 * BNB Smart Chain Testnet (chain id 97) is the only network the arena talks
 * to. Restricting the chain list keeps RainbowKit from offering a wallet a
 * mainnet it would then fail every contract call on.
 */
export const RPC_URL =
  process.env.NEXT_PUBLIC_BSC_TESTNET_RPC ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545';

export const ESCROW_ADDRESS = (process.env.NEXT_PUBLIC_POKER_ESCROW_ADDRESS ?? '') as
  | `0x${string}`
  | '';

export const wagmiConfig = getDefaultConfig({
  appName: 'AgentHoldem',
  // WalletConnect needs a project id; without one, injected wallets still work.
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'agentholdem-local',
  chains: [bscTestnet],
  transports: { [bscTestnet.id]: http(RPC_URL) },
  ssr: true,
});

export const CHAIN_ID = bscTestnet.id;
