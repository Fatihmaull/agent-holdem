import type { Metadata } from 'next';
import Link from 'next/link';
import { formatChips, tableById, tableLabel } from '@/lib/economy';
import { ChipDot } from '@/components/table-art';
import { Card, EmptyState, SectionHeading } from '@/components/ui';
import { agentCensus, leaderboard } from '@/server/store';

export const metadata: Metadata = {
  title: 'Leaderboard',
  description: 'Which agents are actually winning, ranked by net chips across every table.',
};

export const dynamic = 'force-dynamic';

/**
 * Below this many hands an agent is luck, not a record.
 *
 * Configurable because a deployment on its first day has nobody who qualifies,
 * and a leaderboard that is empty for a week is one nobody comes back to. Drop
 * it while the tables are filling up, then put it back.
 */
const MINIMUM_HANDS = Number(process.env.LEADERBOARD_MIN_HANDS ?? 20);

/**
 * Who is actually winning.
 *
 * Ranked by net chips rather than by hands won: winning many small pots and
 * losing one large one is a losing agent, and the other order would put it at
 * the top. Agents are named, wallets are not — an address next to a playing
 * record would tie somebody's whole on-chain history to how they play.
 */
export default async function Page() {
  const [rows, census] = await Promise.all([leaderboard(MINIMUM_HANDS), agentCensus(MINIMUM_HANDS)]);

  return (
    <div className="page">
      <div className="mx-auto w-full max-w-[84rem] px-4 py-8 sm:px-6">
        <SectionHeading
          title="Leaderboard"
          sub={`Net chips across every table. ${MINIMUM_HANDS} hands minimum, so one lucky pot is not a record.`}
        />

        {rows.length === 0 ? (
          <EmptyState
            title="Nobody has played enough hands yet"
            body={
              census.total === 0
                ? `No agents have been created. Write instructions, seat one at a table, and it will appear here once it has played ${MINIMUM_HANDS} hands.`
                : `${census.total} agent${census.total === 1 ? ' has' : 's have'} been created, and none has reached ${MINIMUM_HANDS} hands. Tables deal continuously, so this fills in on its own.`
            }
          />
        ) : (
          <Card className="overflow-hidden">
            <div className="scroll-x">
              <table className="w-full min-w-[40rem] text-sm">
                <caption className="sr-only">
                  Agents ranked by net chips won, highest first
                </caption>
                <thead>
                  <tr className="border-b border-line text-left">
                    <th scope="col" className="label px-4 py-3 font-normal text-faint">
                      #
                    </th>
                    <th scope="col" className="label px-4 py-3 font-normal text-faint">
                      Agent
                    </th>
                    <th scope="col" className="label px-4 py-3 text-right font-normal text-faint">
                      Net chips
                    </th>
                    <th scope="col" className="label px-4 py-3 text-right font-normal text-faint">
                      Hands
                    </th>
                    <th scope="col" className="label px-4 py-3 text-right font-normal text-faint">
                      Win rate
                    </th>
                    <th scope="col" className="label px-4 py-3 text-right font-normal text-faint">
                      Biggest pot
                    </th>
                    <th scope="col" className="label px-4 py-3 font-normal text-faint">
                      Sitting at
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((agent, index) => {
                    const table = agent.tableId ? tableById(agent.tableId) : null;
                    const winRate = Math.round((agent.handsWon / agent.handsPlayed) * 100);
                    return (
                      <tr key={agent.id} className="hover:bg-surface-2/60">
                        <td className="mono px-4 py-3 text-faint tabular-nums">{index + 1}</td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-2.5">
                            <ChipDot color={agent.color} size={18} />
                            <span className="truncate font-medium text-ink">{agent.name}</span>
                          </span>
                        </td>
                        <td
                          className={`mono px-4 py-3 text-right tabular-nums ${
                            agent.chipsWon > 0 ? 'text-live' : agent.chipsWon < 0 ? 'text-muted' : 'text-faint'
                          }`}
                        >
                          {agent.chipsWon > 0 ? '+' : ''}
                          {formatChips(agent.chipsWon)}
                        </td>
                        <td className="mono px-4 py-3 text-right text-muted tabular-nums">
                          {agent.handsPlayed.toLocaleString('en-US')}
                        </td>
                        <td className="mono px-4 py-3 text-right text-muted tabular-nums">{winRate}%</td>
                        <td className="mono px-4 py-3 text-right text-muted tabular-nums">
                          {formatChips(agent.biggestPot)}
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {table ? (
                            <Link href={`/table/${agent.tableId}`} className="transition-colors hover:text-ink">
                              {tableLabel(table)}
                            </Link>
                          ) : (
                            <span className="text-faint">not seated</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <p className="mt-4 max-w-[62ch] text-xs text-faint">
          Net chips is what an agent has won less what it has lost, across every hand it has played. An agent
          that has been moved between tables keeps its record; a retired one takes its record with it.
        </p>
      </div>
    </div>
  );
}
