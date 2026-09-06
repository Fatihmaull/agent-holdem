import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { POKER_ESCROW_ABI } from '@agentholdem/shared';
import type { SettlementResult, SettlementSink } from '../rooms/roomManager.js';

export interface EscrowClientOptions {
  rpcUrl: string;
  escrowAddress: Address;
  arbiterPrivateKey?: Hex;
  log?: (line: string) => void;
}

/** Table ids are opaque strings off chain and bytes32 on chain. */
export function tableIdToBytes32(tableId: string): Hex {
  return keccak256(toHex(tableId));
}

/**
 * Thin viem wrapper over PokerEscrow.
 *
 * Reads work with just an RPC URL; settlement additionally needs the arbiter
 * key, because `settleTable` is the one function the contract restricts to the
 * backend.
 */
export class EscrowClient implements SettlementSink {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient | null;
  private readonly account: ReturnType<typeof privateKeyToAccount> | null;

  constructor(private readonly opts: EscrowClientOptions) {
    this.publicClient = createPublicClient({
      chain: bscTestnet,
      transport: http(opts.rpcUrl),
    }) as PublicClient;

    if (opts.arbiterPrivateKey) {
      this.account = privateKeyToAccount(opts.arbiterPrivateKey);
      this.walletClient = createWalletClient({
        account: this.account,
        chain: bscTestnet,
        transport: http(opts.rpcUrl),
      });
    } else {
      this.account = null;
      this.walletClient = null;
    }
  }

  get arbiterAddress(): Address | null {
    return this.account?.address ?? null;
  }

  /** On-chain chip balance for a wallet. */
  async chipBalance(owner: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.opts.escrowAddress,
      abi: POKER_ESCROW_ABI,
      functionName: 'userChipBalance',
      args: [owner],
    }) as Promise<bigint>;
  }

  async tierQuote(tier: number): Promise<{ priceWei: bigint; chips: bigint }> {
    const [priceWei, chips] = (await this.publicClient.readContract({
      address: this.opts.escrowAddress,
      abi: POKER_ESCROW_ABI,
      functionName: 'quoteTier',
      args: [tier],
    })) as [bigint, bigint];
    return { priceWei, chips };
  }

  async tableInfo(tableId: string) {
    const [buyInChips, totalStaked, openedAt, active, settled, playerCount] =
      (await this.publicClient.readContract({
        address: this.opts.escrowAddress,
        abi: POKER_ESCROW_ABI,
        functionName: 'tableInfo',
        args: [tableIdToBytes32(tableId)],
      })) as [bigint, bigint, bigint, boolean, boolean, bigint];
    return { buyInChips, totalStaked, openedAt, active, settled, playerCount };
  }

  /**
   * Settles a finished table.
   *
   * Payouts are capped to what the table actually staked on chain before the
   * transaction is sent. The contract enforces the same bound, but failing
   * fast here turns a reverted transaction into a logged, recoverable state.
   */
  async settle(
    tableId: string,
    payouts: { owner: string; chips: number }[],
  ): Promise<SettlementResult> {
    if (!this.walletClient || !this.account) {
      return { txHash: null, onChain: false, error: 'No arbiter key configured' };
    }

    try {
      const onChainTable = await this.tableInfo(tableId);
      if (!onChainTable.active || onChainTable.settled) {
        return {
          txHash: null,
          onChain: false,
          error: 'Table is not open for settlement on chain',
        };
      }

      const scaled = capPayouts(payouts, onChainTable.totalStaked);
      const { request } = await this.publicClient.simulateContract({
        account: this.account,
        address: this.opts.escrowAddress,
        abi: POKER_ESCROW_ABI,
        functionName: 'settleTableMulti',
        args: [
          tableIdToBytes32(tableId),
          scaled.map((p) => p.owner as Address),
          scaled.map((p) => p.chips),
        ],
      });

      const hash = await this.walletClient.writeContract(request);
      await this.publicClient.waitForTransactionReceipt({ hash });
      this.opts.log?.(`[chain] settled ${tableId} in ${hash}`);
      return { txHash: hash, onChain: true };
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      this.opts.log?.(`[chain] settlement failed for ${tableId}: ${message}`);
      return { txHash: null, onChain: false, error: message };
    }
  }
}

/**
 * Trims payouts so their total never exceeds the escrowed stake.
 *
 * Off-chain chip totals can legitimately differ from the on-chain stake — a
 * table that never filled, a house agent's chips — so the excess is shaved
 * from the largest stacks down rather than rejected outright.
 */
export function capPayouts(
  payouts: { owner: string; chips: number }[],
  totalStaked: bigint,
): { owner: string; chips: bigint }[] {
  const rows = payouts.map((p) => ({
    owner: p.owner,
    chips: BigInt(Math.max(0, Math.floor(p.chips))),
  }));
  let total = rows.reduce((sum, r) => sum + r.chips, 0n);
  if (total <= totalStaked) return rows;

  const ordered = [...rows].sort((a, b) => (b.chips > a.chips ? 1 : b.chips < a.chips ? -1 : 0));
  for (const row of ordered) {
    if (total <= totalStaked) break;
    const excess = total - totalStaked;
    const cut = row.chips < excess ? row.chips : excess;
    row.chips -= cut;
    total -= cut;
  }
  return rows;
}

/** Used when the chain is not configured: play still settles, off chain only. */
export class OfflineSettlement implements SettlementSink {
  async settle(): Promise<SettlementResult> {
    return {
      txHash: null,
      onChain: false,
      error: 'Chain settlement disabled — results recorded off chain only',
    };
  }
}
