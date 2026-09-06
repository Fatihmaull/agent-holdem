'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ROOM_MODE_BY_KEY,
  validatePromptForMode,
  type DeployResult,
  type LobbyTableView,
} from '@agentholdem/shared';
import { api } from '@/lib/api';
import { useArenaStore } from '@/lib/store';
import { formatChips } from '@/lib/format';

/**
 * Batch deployment.
 *
 * One persona, several tables, one click — and then the browser is free to
 * close. Everything that can be checked before spending chips is checked
 * here: word budget per room, total buy-in against bankroll, duplicate seats.
 */
export function DeployPanel({ tables }: { tables: readonly LobbyTableView[] }) {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const { draft, selectedTables, toggleTable, clearSelection, agentName, setAgentName } =
    useArenaStore();
  const [result, setResult] = useState<DeployResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: bankrollData } = useQuery({
    queryKey: ['bankroll', address],
    queryFn: () => api.bankroll(address as string),
    enabled: Boolean(address),
  });

  const selected = useMemo(
    () => tables.filter((table) => selectedTables.includes(table.id)),
    [tables, selectedTables],
  );

  const totalBuyIn = selected.reduce((sum, table) => sum + table.buyInChips, 0);
  const available = bankrollData?.bankroll.available ?? 0;

  // Which of the queued tables this brief is actually short enough for.
  const checks = selected.map((table) => ({
    table,
    check: validatePromptForMode(draft.prompt, table.mode),
  }));
  const blocked = checks.filter((row) => !row.check.ok);
  const eligible = checks.filter((row) => row.check.ok);
  const eligibleBuyIn = eligible.reduce((sum, row) => sum + row.table.buyInChips, 0);
  const firstBlocked = blocked[0]?.check;
  const blockedReason = firstBlocked && !firstBlocked.ok ? firstBlocked.reason : '';

  const deploy = useMutation({
    mutationFn: () =>
      api.deploy({
        owner: address as string,
        agentName: agentName.trim() || draft.name.trim() || 'Unnamed Agent',
        prompt: draft.prompt,
        ...(draft.id ? { templateId: draft.id } : {}),
        tableIds: eligible.map((row) => row.table.id),
      }),
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      clearSelection();
      void queryClient.invalidateQueries({ queryKey: ['bankroll', address] });
      void queryClient.invalidateQueries({ queryKey: ['lobby'] });
    },
    onError: (err: Error) => {
      setError(err.message);
      setResult(null);
    },
  });

  const canDeploy =
    Boolean(address) &&
    draft.prompt.trim().length > 0 &&
    eligible.length > 0 &&
    eligibleBuyIn <= available &&
    !deploy.isPending;

  return (
    <aside className="xl:sticky xl:top-6 xl:self-start">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="font-display text-base font-semibold">Deploy agents</h2>
            <p className="text-xs text-slate-400">Set it, then close the tab.</p>
          </div>
          {selected.length > 0 ? (
            <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" onClick={clearSelection}>
              Clear
            </button>
          ) : null}
        </div>

        <div className="space-y-4 p-4">
          <div>
            <label className="stat-label" htmlFor="agent-name">
              Agent name at the table
            </label>
            <input
              id="agent-name"
              className="field mt-1.5"
              placeholder={draft.name || 'The Mathematician'}
              value={agentName}
              maxLength={40}
              onChange={(event) => setAgentName(event.target.value)}
            />
          </div>

          <div className="rounded-xl border border-white/10 bg-slate-950/50 p-3">
            <div className="flex items-center justify-between">
              <span className="stat-label">Strategy</span>
              <Link href="/lab" className="text-xs text-cyan-300 hover:underline">
                Edit in lab
              </Link>
            </div>
            {draft.prompt.trim() ? (
              <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-slate-300">
                {draft.prompt}
              </p>
            ) : (
              <p className="mt-1.5 text-xs text-slate-500">
                No strategy loaded. Write one in the Strategy Lab first.
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="stat-label">Queued tables</span>
              <span className="text-xs tabular-nums text-slate-400">
                {selected.length} selected
              </span>
            </div>

            {selected.length === 0 ? (
              <p className="mt-2 rounded-xl border border-dashed border-white/10 px-3 py-5 text-center text-xs text-slate-500">
                Pick tables from the lobby to build a batch. One strategy can sit at several
                rooms at once.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {checks.map(({ table, check }) => (
                  <li
                    key={table.id}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs ${
                      check.ok
                        ? 'border-white/10 bg-white/[0.02]'
                        : 'border-rose-400/25 bg-rose-500/[0.07]'
                    }`}
                  >
                    <span
                      className="h-4 w-1 shrink-0 rounded-full"
                      style={{ backgroundColor: ROOM_MODE_BY_KEY[table.mode].accent }}
                    />
                    <span className="min-w-0 flex-1 truncate">{table.name}</span>
                    <span className="shrink-0 tabular-nums text-amber-300">
                      {formatChips(table.buyInChips)}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-slate-500 hover:text-rose-300"
                      onClick={() => toggleTable(table.id)}
                      aria-label={`Remove ${table.name}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {blocked.length > 0 ? (
            <p className="rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-3 py-2 text-xs leading-relaxed text-rose-200">
              {blocked.length} table{blocked.length > 1 ? 's are' : ' is'} out of reach:{' '}
              {blockedReason} Trim the brief or drop those rooms — the rest will still deploy.
            </p>
          ) : null}

          <dl className="space-y-1.5 border-t border-white/10 pt-3 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-400">Total buy-in</dt>
              <dd className="tabular-nums font-semibold text-amber-300">
                {formatChips(eligibleBuyIn)} chips
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Bankroll after</dt>
              <dd
                className={`tabular-nums font-semibold ${
                  eligibleBuyIn > available ? 'text-rose-300' : 'text-slate-200'
                }`}
              >
                {formatChips(Math.max(0, available - eligibleBuyIn))} chips
              </dd>
            </div>
            {totalBuyIn !== eligibleBuyIn ? (
              <div className="flex justify-between text-slate-500">
                <dt>Excluded (over word budget)</dt>
                <dd className="tabular-nums">{formatChips(totalBuyIn - eligibleBuyIn)}</dd>
              </div>
            ) : null}
          </dl>

          <button
            type="button"
            className="btn-primary w-full"
            disabled={!canDeploy}
            onClick={() => deploy.mutate()}
          >
            {deploy.isPending
              ? 'Deploying…'
              : `Deploy ${eligible.length || ''} agent${eligible.length === 1 ? '' : 's'}`}
          </button>

          {!address ? (
            <p className="text-center text-xs text-slate-500">Connect a wallet to deploy.</p>
          ) : eligibleBuyIn > available ? (
            <p className="text-center text-xs text-rose-300">
              Short {formatChips(eligibleBuyIn - available)} chips — top up in the cashier.
            </p>
          ) : null}

          <AnimatePresence>
            {error ? (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
              >
                {error}
              </motion.p>
            ) : null}

            {result ? (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.08] p-3 text-xs"
              >
                <p className="font-semibold text-emerald-200">
                  Deployed to {result.seated.length} table
                  {result.seated.length === 1 ? '' : 's'}. You can close this tab.
                </p>
                <ul className="mt-2 space-y-1">
                  {result.seated.map((seat) => (
                    <li key={seat.tableId}>
                      <Link
                        href={`/table/${seat.tableId}`}
                        className="text-cyan-300 hover:underline"
                      >
                        Watch {seat.tableId}
                      </Link>{' '}
                      <span className="text-slate-500">seat {seat.seat}</span>
                    </li>
                  ))}
                </ul>
                {result.rejected.length > 0 ? (
                  <p className="mt-2 text-rose-200/80">
                    {result.rejected.length} rejected: {result.rejected[0]?.reason}
                  </p>
                ) : null}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </section>
    </aside>
  );
}
