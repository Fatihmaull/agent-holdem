import { cookies } from 'next/headers';
import { CHAINS, chainByKey, envPrefix, type ChainInfo, type PublicChain } from '../lib/chains';

/**
 * Which chains this deployment actually settles on, and where.
 *
 * `src/lib/chains.ts` says what a chain is. This says which of them are switched
 * on here, which endpoint to reach them over, and which vault holds their float.
 * Adding a chain to a deployment is two environment variables, named after the
 * chain's own key: `MONAD_TESTNET_RPC_URL` and `MONAD_TESTNET_VAULT_ADDRESS`.
 */

const CHAIN_COOKIE = 'ah_chain';

export interface DeployedChain extends ChainInfo {
  rpcUrl: string;
  /** Null until a vault has been deployed here. Watching still works; buying does not. */
  vault: `0x${string}` | null;
}

function settingsFor(chain: ChainInfo): DeployedChain {
  const prefix = envPrefix(chain.key);
  const vault = process.env[`${prefix}_VAULT_ADDRESS`]?.trim();

  if (vault && !/^0x[0-9a-fA-F]{40}$/.test(vault)) {
    throw new Error(`${prefix}_VAULT_ADDRESS is not an address: ${vault}`);
  }

  return {
    ...chain,
    rpcUrl: process.env[`${prefix}_RPC_URL`]?.trim() || chain.defaultRpcUrl,
    // An empty variable is an undeployed chain, not an address of length zero.
    vault: vault ? (vault as `0x${string}`) : null,
  };
}

/**
 * The chains a player may switch between, in the order they are offered.
 *
 * `CHAINS` names them by key. Left unset every chain in the registry is offered,
 * which is what a developer wants and what a deployment should override.
 */
export function enabledChains(): DeployedChain[] {
  const configured = process.env.CHAINS?.split(',').map((key) => key.trim()).filter(Boolean);
  if (!configured?.length) return CHAINS.map(settingsFor);

  return configured.map((key) => {
    const chain = chainByKey(key);
    if (!chain) throw new Error(`CHAINS names a chain that does not exist: ${key}. Add it to src/lib/chains.ts.`);
    return settingsFor(chain);
  });
}

/** The chain a player lands on before they have chosen one. */
function defaultChain(): DeployedChain {
  const enabled = enabledChains();
  const preferred = process.env.DEFAULT_CHAIN?.trim();
  if (!preferred) return enabled[0];

  const chosen = enabled.find((chain) => chain.key === preferred);
  if (!chosen) throw new Error(`DEFAULT_CHAIN is ${preferred}, which CHAINS does not enable.`);
  return chosen;
}

/** Raised when a request names a chain this deployment does not settle on. */
export class UnknownChain extends Error {}

export function requireChain(key: string): DeployedChain {
  const chain = enabledChains().find((entry) => entry.key === key);
  if (!chain) throw new UnknownChain(`This deployment does not settle on ${key}.`);
  return chain;
}

/**
 * The vault a deposit is paid into. Nothing is ever paid out of one.
 *
 * Separate from `requireChain` because a chain can be enabled before its vault
 * exists, and the difference between "no such network" and "nothing deployed
 * there yet" is worth saying out loud.
 */
export function vaultAddress(chain: DeployedChain): `0x${string}` {
  if (!chain.vault) {
    throw new Error(`${envPrefix(chain.key)}_VAULT_ADDRESS is not set. Deploy ChipVault to ${chain.name} first.`);
  }
  return chain.vault;
}

/**
 * The chain the caller is currently on.
 *
 * Held in an unsigned cookie because it selects a public network rather than
 * granting anything: every request that moves money re-resolves the chain here
 * and checks it against the record it is settling.
 */
export async function selectedChain(): Promise<DeployedChain> {
  const jar = await cookies();
  const key = jar.get(CHAIN_COOKIE)?.value;
  if (!key) return defaultChain();

  const chosen = enabledChains().find((chain) => chain.key === key);
  return chosen ?? defaultChain();
}

export async function selectChain(key: string): Promise<DeployedChain> {
  const chain = requireChain(key);
  const jar = await cookies();
  jar.set(CHAIN_COOKIE, chain.key, {
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return chain;
}

/**
 * A chain as the browser is told about it.
 *
 * The configured RPC endpoint is deliberately left out: it may carry an API key,
 * and the browser never talks to a node directly. A wallet being asked to add
 * the network gets the registry's public endpoint instead.
 */
export function publicChain(chain: DeployedChain): PublicChain {
  const { rpcUrl, ...rest } = chain;
  void rpcUrl;
  return rest;
}
