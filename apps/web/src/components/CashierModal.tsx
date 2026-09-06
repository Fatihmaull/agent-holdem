'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatEther, parseEther } from 'viem';
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CHIP_TIERS, POKER_ESCROW_ABI } from '@agentholdem/shared';
import { api } from '@/lib/api';
import { CHAIN_ID, ESCROW_ADDRESS } from '@/lib/wagmi';
import { formatChips } from '@/lib/format';

/**
 * The cashier.
 *
 * Prices are read back from the deployed contract rather than trusted from
 * the bundle — a stale front-end constant would send the wrong `msg.value`
 * and revert. The shared constants are only the fallback for rendering before
 * the reads resolve, or when no contract is configured at all.
 */
export function CashierModal({ onClose }: { onClose: () => void }) {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const [pendingTier, setPendingTier] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chainReady = Boolean(ESCROW_ADDRESS);

  const { data: onChainTiers } = useReadContracts({
    contracts: CHIP_TIERS.map((tier) => ({
      address: ESCROW_ADDRESS as `0x${string}`,
      abi: POKER_ESCROW_ABI,
      functionName: 'quoteTier' as const,
      args: [tier.id],
      chainId: CHAIN_ID,
    })),
    query: { enabled: chainReady },
  });

  const { data: bankrollData } = useQuery({
    queryKey: ['bankroll', address],
    queryFn: () => api.bankroll(address as string),
    enabled: Boolean(address),
  });

  const { writeContractAsync, isPending } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  // The contract is authoritative, so the off-chain mirror is refreshed only
  // once the purchase has actually confirmed.
  useEffect(() => {
    if (!isSuccess || !address) return;
    void api.syncBankroll(address).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['bankroll', address] });
    });
    setPendingTier(null);
  }, [isSuccess, address, queryClient]);

  const priced = useMemo(
    () =>
      CHIP_TIERS.map((tier, index) => {
        const result = onChainTiers?.[index];
        const onChain =
          result?.status === 'success'
            ? (result.result as unknown as readonly [bigint, bigint])
            : null;
        return {
          tier,
          priceWei: onChain ? onChain[0] : parseEther(tier.priceTbnb),
          chips: onChain ? Number(onChain[1]) : tier.chips,
          live: Boolean(onChain),
        };
      }),
    [onChainTiers],
  );

  async function buy(tierId: number, priceWei: bigint) {
    if (!chainReady) return;
    setError(null);
    setPendingTier(tierId);
    try {
      const hash = await writeContractAsync({
        address: ESCROW_ADDRESS as `0x${string}`,
        abi: POKER_ESCROW_ABI,
        functionName: 'buyChips',
        args: [tierId],
        value: priceWei,
        chainId: CHAIN_ID,
      });
      setTxHash(hash);
    } catch (err) {
      setError((err as Error).message.split('\n')[0] ?? 'Transaction rejected');
      setPendingTier(null);
    }
  }

  /** Local play money, only available when no escrow contract is configured. */
  async function devCredit(chips: number) {
    if (!address) return;
    setError(null);
    try {
      await api.devCredit(address, chips);
      await queryClient.invalidateQueries({ queryKey: ['bankroll', address] });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const busy = isPending || confirming;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          className="panel w-full max-w-2xl overflow-hidden bg-slate-950/95"
          initial={{ y: 24, scale: 0.97 }}
          animate={{ y: 0, scale: 1 }}
          exit={{ y: 12, opacity: 0 }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="panel-header">
            <div>
              <h2 className="font-display text-lg font-semibold">Cashier</h2>
              <p className="text-xs text-slate-400">
                Buy chips up front with tBNB. Prompt length never costs chips.
              </p>
            </div>
            <button type="button" onClick={onClose} className="btn-ghost !px-3 !py-1.5">
              Close
            </button>
          </div>

          <div className="grid gap-3 p-5 sm:grid-cols-2">
            {priced.map(({ tier, priceWei, chips, live }) => (
              <button
                key={tier.id}
                type="button"
                disabled={!chainReady || busy || !address}
                onClick={() => void buy(tier.id, priceWei)}
                className="group rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left
                  transition hover:border-cyan-400/50 hover:bg-cyan-400/[0.06]
                  disabled:cursor-not-allowed disabled:opacity-45"
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-display text-base font-semibold">{tier.label}</span>
                  <span className="text-xs text-slate-500">${tier.usd}</span>
                </div>
                <div className="mt-2 text-2xl font-bold tabular-nums text-amber-300">
                  {formatChips(chips)}
                  <span className="ml-1.5 text-sm font-medium text-slate-400">chips</span>
                </div>
                <div className="mt-1 text-sm tabular-nums text-slate-300">
                  {formatEther(priceWei)} tBNB
                </div>
                <p className="mt-2 text-xs leading-relaxed text-slate-500">{tier.blurb}</p>
                <div className="mt-2 text-[10px] uppercase tracking-wider text-slate-600">
                  {live ? 'price read from contract' : 'default price'}
                  {pendingTier === tier.id && busy ? ' · confirming…' : ''}
                </div>
              </button>
            ))}
          </div>

          {!chainReady ? (
            <div className="border-t border-white/10 bg-amber-400/[0.06] px-5 py-4">
              <p className="text-sm font-medium text-amber-200">
                No escrow contract configured
              </p>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                Set <code className="text-slate-300">NEXT_PUBLIC_POKER_ESCROW_ADDRESS</code> after
                deploying to BNB testnet to buy chips on chain. Until then the engine issues local
                play chips so you can still run the arena.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {[100, 1_000, 5_000, 10_000].map((chips) => (
                  <button
                    key={chips}
                    type="button"
                    onClick={() => void devCredit(chips)}
                    disabled={!address}
                    className="btn-ghost !py-1.5 text-xs"
                  >
                    +{formatChips(chips)} play chips
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-4 text-sm">
            <span className="text-slate-400">
              Bankroll:{' '}
              <strong className="tabular-nums text-slate-100">
                {bankrollData ? formatChips(bankrollData.bankroll.available) : '—'}
              </strong>{' '}
              available
              {bankrollData && bankrollData.bankroll.locked > 0
                ? ` · ${formatChips(bankrollData.bankroll.locked)} locked at tables`
                : ''}
            </span>
            {txHash ? (
              <a
                className="text-xs text-cyan-300 underline underline-offset-2"
                href={`https://testnet.bscscan.com/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction
              </a>
            ) : null}
          </div>

          {error ? (
            <p className="border-t border-rose-500/20 bg-rose-500/10 px-5 py-3 text-xs text-rose-200">
              {error}
            </p>
          ) : null}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
