import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { chipVaultAbi } from './vault-abi';

/** Confirmations required before a deposit is credited. One block is not final. */
export const REQUIRED_CONFIRMATIONS = 3n;

export function vaultAddress(): `0x${string}` {
  const address = process.env.NEXT_PUBLIC_CHIP_VAULT_ADDRESS;
  if (!address) throw new Error('NEXT_PUBLIC_CHIP_VAULT_ADDRESS is not set. Deploy ChipVault first.');
  return address as `0x${string}`;
}

/**
 * Whether a vault has been deployed and configured.
 *
 * The watcher runs on every boot, including before the contract exists. Asking
 * first lets it idle quietly rather than throwing once a second at a server
 * that is otherwise healthy.
 */
export function vaultConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CHIP_VAULT_ADDRESS);
}

let publicClient: PublicClient | null = null;

function chainClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: bscTestnet,
      transport: http(process.env.BSC_TESTNET_RPC_URL),
    });
  }
  return publicClient;
}

function treasuryClient(): WalletClient {
  const key = process.env.TREASURY_PRIVATE_KEY;
  if (!key) throw new Error('TREASURY_PRIVATE_KEY is not set. Redemptions cannot be paid without it.');
  return createWalletClient({
    account: privateKeyToAccount(key as `0x${string}`),
    chain: bscTestnet,
    transport: http(process.env.BSC_TESTNET_RPC_URL),
  });
}

export interface ObservedDeposit {
  payer: `0x${string}`;
  intentId: `0x${string}`;
  amountWei: bigint;
  blockNumber: bigint;
  confirmations: bigint;
  txHash: Hash;
}

/**
 * Reads a deposit back off the chain.
 *
 * Nothing here trusts the caller beyond the transaction hash. The receipt is
 * fetched over our own RPC, the log must come from our vault, and the payer and
 * amount are taken from the event rather than from anything the client claimed.
 */
export async function observeDeposit(txHash: Hash): Promise<ObservedDeposit | null> {
  const client = chainClient();
  const vault = vaultAddress().toLowerCase();

  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') return null;

  const head = await client.getBlockNumber();
  const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;

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
    return {
      payer: args.payer,
      intentId: args.intentId,
      amountWei: args.amount,
      blockNumber: receipt.blockNumber,
      confirmations,
      txHash,
    };
  }

  return null;
}

/**
 * Raised when a payout was broadcast but its result is unknown.
 *
 * This is the one failure that must not be refunded. The transaction may well
 * be mined, and returning the chips as well would pay the same redemption
 * twice. It carries the hash so the redemption can be reconciled by hand.
 */
export class PayoutUncertain extends Error {
  constructor(
    message: string,
    readonly txHash: Hash,
  ) {
    super(message);
  }
}

/** Raised when the chain rejected the payout outright, so nothing was paid. */
class PayoutRejected extends Error {}

/**
 * Sends a redemption payout from the treasury and waits for its receipt.
 *
 * Broadcasting is not paying. A transaction that reverts still returns a hash,
 * so the receipt is what decides whether the player was actually paid and
 * whether their chips may be returned.
 */
export async function payOut(recipient: `0x${string}`, netWei: bigint, redemptionId: `0x${string}`): Promise<Hash> {
  const wallet = treasuryClient();
  if (!wallet.account) throw new Error('treasury wallet has no account');

  let hash: Hash;
  try {
    hash = await wallet.writeContract({
      address: vaultAddress(),
      abi: chipVaultAbi,
      functionName: 'payout',
      args: [recipient, netWei, redemptionId],
      account: wallet.account,
      chain: bscTestnet,
    });
  } catch (error) {
    // Nothing reached the chain, so no value moved.
    throw new PayoutRejected(error instanceof Error ? error.message : 'the payout was rejected');
  }

  let receipt;
  try {
    receipt = await chainClient().waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 });
  } catch (error) {
    throw new PayoutUncertain(
      error instanceof Error ? error.message : 'the payout did not confirm in time',
      hash,
    );
  }

  // A revert rolls back the contract's paid flag too, so the redemption is
  // genuinely unpaid and the chips are safe to return.
  if (receipt.status !== 'success') throw new PayoutRejected('the payout transaction reverted');

  return hash;
}

/** Current chain height. */
export async function headBlock(): Promise<bigint> {
  return chainClient().getBlockNumber();
}

/**
 * Every deposit the vault recorded in a block range.
 *
 * This is the half of crediting that does not depend on anybody's browser: the
 * event carries the payer, the intent and the amount, so a deposit is
 * discoverable from the chain alone even if the tab closed before it could
 * report its transaction hash.
 */
export async function scanDeposits(fromBlock: bigint, toBlock: bigint): Promise<ObservedDeposit[]> {
  if (toBlock < fromBlock) return [];
  const head = await headBlock();

  const logs = await chainClient().getContractEvents({
    address: vaultAddress(),
    abi: chipVaultAbi,
    eventName: 'Deposited',
    fromBlock,
    toBlock,
  });

  const observed: ObservedDeposit[] = [];
  for (const log of logs) {
    // A reorg can strip a log that was already returned. Crediting one would
    // mint chips against a deposit that no longer exists on chain.
    if (log.removed) continue;
    const args = log.args as { payer?: `0x${string}`; intentId?: `0x${string}`; amount?: bigint };
    if (!args.payer || !args.intentId || args.amount === undefined) continue;
    if (log.blockNumber === null || log.transactionHash === null) continue;

    observed.push({
      payer: args.payer,
      intentId: args.intentId,
      amountWei: args.amount,
      blockNumber: log.blockNumber,
      confirmations: head >= log.blockNumber ? head - log.blockNumber + 1n : 0n,
      txHash: log.transactionHash,
    });
  }
  return observed;
}

/**
 * Whether the vault has already consumed an intent.
 *
 * Asked before an unpaid intent is expired. The contract refuses to reuse an
 * intent id, so a `true` here means somebody's money is on chain against a row
 * we were about to write off, and that row must stay open for reconciliation
 * instead.
 */
export async function intentConsumed(intentId: `0x${string}`): Promise<boolean> {
  return chainClient().readContract({
    address: vaultAddress(),
    abi: chipVaultAbi,
    functionName: 'intentUsed',
    args: [intentId],
  });
}

/** What the treasury has left to pay redemptions with. */
export async function treasuryBalanceWei(): Promise<bigint> {
  return chainClient().getBalance({ address: vaultAddress() });
}
