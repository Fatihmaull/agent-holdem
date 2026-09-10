import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  type Chain,
  type Hash,
  type PublicClient,
} from 'viem';
import { vaultAddress, type DeployedChain } from './chains';
import { chipVaultAbi } from './vault-abi';

/**
 * Chain access, for whichever chain the caller names.
 *
 * Nothing here imports a network: the viem chain is built from this
 * deployment's own registry, so a chain that viem has never heard of works as
 * soon as it has a row in `src/lib/chains.ts`.
 *
 * Read-only by design. Chips are one-way, so nothing in the running server ever
 * signs a transaction and there is no wallet client here to do it with. The
 * treasury key exists for deploying a vault and is never loaded by the app.
 */

/** Confirmations required before a deposit is credited. One block is not final. */
export const REQUIRED_CONFIRMATIONS = 3n;

const chainDefinitions = new Map<number, Chain>();
const publicClients = new Map<number, PublicClient>();

export function chainDefinition(chain: DeployedChain): Chain {
  let existing = chainDefinitions.get(chain.id);
  if (!existing) {
    existing = defineChain({
      id: chain.id,
      name: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: { default: { http: [chain.rpcUrl] } },
      blockExplorers: { default: chain.explorer },
      testnet: chain.testnet,
    });
    chainDefinitions.set(chain.id, existing);
  }
  return existing;
}

export function publicClientFor(chain: DeployedChain): PublicClient {
  let existing = publicClients.get(chain.id);
  if (!existing) {
    existing = createPublicClient({ chain: chainDefinition(chain), transport: http(chain.rpcUrl) });
    publicClients.set(chain.id, existing);
  }
  return existing;
}


export interface ObservedDeposit {
  payer: `0x${string}`;
  intentId: `0x${string}`;
  amountWei: bigint;
  blockNumber: bigint;
  confirmations: bigint;
}

/**
 * Reads a deposit back off the chain.
 *
 * Nothing here trusts the caller beyond the transaction hash. The receipt is
 * fetched over our own RPC, the log must come from that chain's vault, and the
 * payer and amount are taken from the event rather than from anything the
 * client claimed.
 */
export async function observeDeposit(chain: DeployedChain, txHash: Hash): Promise<ObservedDeposit[]> {
  const client = publicClientFor(chain);
  const vault = vaultAddress(chain).toLowerCase();

  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') return [];

  const head = await client.getBlockNumber();
  const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;

  // Every deposit in the transaction, not the first. One call can carry several
  // intents, and returning only one would strand the rest: their chips are in
  // the vault, their intent is spent on chain, and nothing would ever credit
  // them.
  const found: ObservedDeposit[] = [];

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vault) continue;

    let decoded;
    try {
      decoded = decodeEventLog({ abi: chipVaultAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'Deposited') continue;

    const args = decoded.args as unknown as { payer: `0x${string}`; intentId: `0x${string}`; amount: bigint };
    found.push({
      payer: args.payer,
      intentId: args.intentId,
      amountWei: args.amount,
      blockNumber: receipt.blockNumber,
      confirmations,
    });
  }

  return found;
}
