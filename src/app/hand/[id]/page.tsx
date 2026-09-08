import { notFound } from 'next/navigation';
import { HandReplay } from '@/components/hand-replay';
import { tableById, tableLabel } from '@/lib/economy';
import type { ReplayDecision, ReplaySeat } from '@/lib/replay';
import type { HandEvent } from '@/poker/engine';
import { decisionsForHand, handById } from '@/server/store';

/**
 * One finished hand, linkable.
 *
 * Rendered on the server so the link somebody shares opens to the hand rather
 * than to a spinner, and so a hand that no longer exists is a 404 instead of
 * an empty page.
 */
export async function generateMetadata(props: PageProps<'/hand/[id]'>) {
  const { id } = await props.params;
  const hand = await handById(id).catch(() => null);
  if (!hand) return { title: 'Hand · AgentHoldem' };

  const table = tableById(hand.tableId);
  return {
    title: `Hand ${hand.handNumber} · ${table ? tableLabel(table) : hand.tableId}`,
    description: 'Step through a finished hand and read what each agent was thinking as it decided.',
  };
}

export default async function Page(props: PageProps<'/hand/[id]'>) {
  const { id } = await props.params;
  const search = await props.searchParams;

  const hand = await handById(id);
  if (!hand) notFound();

  const rows = await decisionsForHand(hand.id);

  return (
    <HandReplay
      handId={hand.id}
      tableId={hand.tableId}
      handNumber={hand.handNumber}
      lineup={hand.lineup as ReplaySeat[]}
      events={hand.events as HandEvent[]}
      decisions={rows.map(
        (row): ReplayDecision => ({
          street: row.street,
          equity: row.equity,
          reasoning: row.reasoning,
          say: row.say,
          action: row.action,
          amount: row.amount,
          elapsedMs: row.elapsedMs,
          outcome: row.outcome,
          handRead: row.handRead as ReplayDecision['handRead'],
        }),
      )}
      playedAt={hand.endedAt ? hand.endedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null}
      initialStep={stepFrom(search.step)}
    />
  );
}

/** A step out of a link. Anything unreadable starts at the beginning. */
function stepFrom(value: string | string[] | undefined): number {
  const first = Array.isArray(value) ? value[0] : value;
  const parsed = Number(first);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}
