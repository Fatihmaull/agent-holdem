/**
 * Every chain this deployment can settle on.
 *
 * Nothing above this file names a network. Screens, wallet prompts, deploy
 * scripts and explorer links all read from these entries, so adding a chain is
 * adding a row here plus two environment variables, and no code that knows what
 * a chip is has to change.
 *
 * This module is pure and shared by both halves of the app. Which of these
 * chains are actually switched on, and where their vaults live, is environment
 * and belongs in `src/server/chains.ts`.
 */

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export interface ChainInfo {
  /** Stable identifier used in URLs, cookies and environment variable names. */
  key: string;
  /** EIP-155 chain id. */
  id: number;
  /** Full name, as a wallet should show it when adding the network. */
  name: string;
  /** What the interface calls it where there is no room for the full name. */
  shortName: string;
  nativeCurrency: NativeCurrency;
  /** Public endpoint, used when the environment does not override it. */
  defaultRpcUrl: string;
  explorer: { name: string; url: string };
  /** Where a player with an empty wallet goes. Every entry here is a testnet. */
  faucetUrl: string;
  /**
   * Notional dollars per native token, for the Cashier's price hints only.
   * Test tokens have no market, so a chain without a plausible reference price
   * leaves this unset and the interface shows no dollar figure rather than a
   * made-up one.
   */
  notionalUsd?: number;
  testnet: boolean;
}

export const CHAINS: ChainInfo[] = [
  {
    key: 'bnb-testnet',
    id: 97,
    name: 'BNB Smart Chain Testnet',
    shortName: 'BNB Testnet',
    nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
    defaultRpcUrl: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    explorer: { name: 'BscScan', url: 'https://testnet.bscscan.com' },
    faucetUrl: 'https://testnet.bnbchain.org/faucet-smart',
    notionalUsd: 600,
    testnet: true,
  },
  {
    key: 'arbitrum-sepolia',
    id: 421614,
    name: 'Arbitrum Sepolia',
    shortName: 'Arbitrum Sepolia',
    nativeCurrency: { name: 'Arbitrum Sepolia Ether', symbol: 'ETH', decimals: 18 },
    defaultRpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorer: { name: 'Arbiscan', url: 'https://sepolia.arbiscan.io' },
    faucetUrl: 'https://www.alchemy.com/faucets/arbitrum-sepolia',
    notionalUsd: 3000,
    testnet: true,
  },
  {
    key: 'monad-testnet',
    id: 10143,
    name: 'Monad Testnet',
    shortName: 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    defaultRpcUrl: 'https://testnet-rpc.monad.xyz',
    explorer: { name: 'Monad Explorer', url: 'https://testnet.monadexplorer.com' },
    faucetUrl: 'https://faucet.monad.xyz',
    testnet: true,
  },
];

/**
 * A chain as the browser is told about it: the registry entry plus where the
 * vault lives, which is public by nature. The server's own RPC endpoint is
 * deliberately not part of this.
 */
export interface PublicChain extends ChainInfo {
  vault: `0x${string}` | null;
}

export function chainByKey(key: string): ChainInfo | undefined {
  return CHAINS.find((chain) => chain.key === key);
}

export function chainById(id: number): ChainInfo | undefined {
  return CHAINS.find((chain) => chain.id === id);
}

/**
 * The environment variable prefix a chain's settings live under, `bnb-testnet`
 * becoming `BNB_TESTNET`. Derived rather than stored so the two cannot drift.
 */
export function envPrefix(key: string): string {
  return key.toUpperCase().replace(/-/g, '_');
}

export function txUrl(chain: ChainInfo, txHash: string): string {
  return `${chain.explorer.url}/tx/${txHash}`;
}

export function addressUrl(chain: ChainInfo, address: string): string {
  return `${chain.explorer.url}/address/${address}`;
}
