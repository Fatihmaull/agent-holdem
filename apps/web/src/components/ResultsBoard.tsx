'use client';

import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { API_BASE } from '@/lib/api';
import { formatChips, formatSigned, relativeTime, shortAddress } from '@/lib/format';

interface Settlement {
  tableId: string;
  settledAt: number;
  standings: { seat: number; agentName: string; owner: string; chips: number; buyIn: number }[];
  txHash: string | null;
  onChain: boolean;
  error?: string;
}

async function fetchSettlements(): Promise<Settlement[]> {
  const res = await fetch(`${API_BASE}/api/settlements?limit=40`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load settlements');
  const body = (await res.json()) as { settlements: Settlement[] };
  return body.settlements;
}

export function ResultsBoard() {
  const { address } = useAccount();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['settlements'],
    queryFn: fetchSettlements,
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return <div className="panel grid h-40 place-items-center text-sm text-slate-500">Loading…</div>;
  }
  if (isError) {
    return (
      <div className="panel px-5 py-8 text-center text-sm text-rose-200">
        Could not reach the engine.
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="panel px-5 py-10 text-center text-sm text-slate-500">
        No sessions have settled yet. Deploy an agent from the lobby and check back.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {data.map((settlement) => {
        const yours = address
          ? settlement.standings.find((s) => s.owner.toLowerCase() === address.toLowerCase())
          : undefined;

        return (
          <section key={`${settlement.tableId}-${settlement.settledAt}`} className="panel">
            <div className="panel-header">
              <div>
                <h3 className="font-display text-base font-semibold">{settlement.tableId}</h3>
                <p className="text-xs text-slate-500">{relativeTime(settlement.settledAt)}</p>
              </div>
              <div className="flex items-center gap-2">
                {yours ? (
                  <span
                    className={`chip-tag ${
                      yours.chips - yours.buyIn >= 0
                        ? 'border-emerald-400/30 text-emerald-200'
                        : 'border-rose-400/30 text-rose-200'
                    }`}
                  >
                    You {formatSigned(yours.chips - yours.buyIn)}
                  </span>
                ) : null}
                {settlement.onChain && settlement.txHash ? (
                  <a
                    href={`https://testnet.bscscan.com/tx/${settlement.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="chip-tag border-cyan-400/30 text-cyan-200 hover:border-cyan-400/60"
                  >
                    On chain ↗
                  </a>
                ) : (
                  <span className="chip-tag" title={settlement.error ?? undefined}>
                    Off chain
                  </span>
                )}
              </div>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5 text-left">
                  <th className="stat-label px-5 py-2 font-semibold">Agent</th>
                  <th className="stat-label px-5 py-2 font-semibold">Manager</th>
                  <th className="stat-label px-5 py-2 text-right font-semibold">Buy-in</th>
                  <th className="stat-label px-5 py-2 text-right font-semibold">Final</th>
                  <th className="stat-label px-5 py-2 text-right font-semibold">Net</th>
                </tr>
              </thead>
              <tbody>
                {[...settlement.standings]
                  .sort((a, b) => b.chips - a.chips)
                  .map((row) => {
                    const net = row.chips - row.buyIn;
                    return (
                      <tr key={row.seat} className="border-b border-white/5 last:border-0">
                        <td className="px-5 py-2">{row.agentName}</td>
                        <td className="px-5 py-2 text-slate-400">{shortAddress(row.owner)}</td>
                        <td className="px-5 py-2 text-right tabular-nums text-slate-400">
                          {formatChips(row.buyIn)}
                        </td>
                        <td className="px-5 py-2 text-right tabular-nums text-amber-300">
                          {formatChips(row.chips)}
                        </td>
                        <td
                          className={`px-5 py-2 text-right tabular-nums font-semibold ${
                            net >= 0 ? 'text-emerald-300' : 'text-rose-300'
                          }`}
                        >
                          {formatSigned(net)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
