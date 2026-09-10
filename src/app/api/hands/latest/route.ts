import { decisionsForHand, latestHand } from '@/server/store';
import { allMatches } from '@/server/registry';

/**
 * Feeds the landing page. If a table is dealing right now the hero watches it
 * live; if none is, the page replays the last real hand and says so. It never
 * invents a hand to fill the space.
 *
 * A hand that was thrown away unseen stays unseen here too. The table mucks, so
 * publishing every seat's read of its own cards afterwards would hand back
 * exactly what mucking withholds, to anyone who asks for it in a browser: the
 * opponents from that hand are usually still sitting at the same table, and an
 * owner who learns what one of them folded can write it straight into their own
 * agent's instructions. What each agent did is public. What it was holding when
 * it declined to show is not.
 */
export async function GET(): Promise<Response> {
  const live = allMatches().find((match) => {
    const view = match.view(null);
    return view.toAct !== null || view.street !== 'idle';
  });

  if (live) return Response.json({ mode: 'live', matchId: live.matchId });

  const hand = await latestHand();
  if (!hand) return Response.json({ mode: 'empty' });

  const shown = tabled(hand.events);
  const rows = await decisionsForHand(hand.id);

  return Response.json({
    mode: 'replay',
    matchId: hand.matchId,
    handNumber: hand.handNumber,
    lineup: hand.lineup,
    board: hand.board,
    decisions: rows.map((row) => {
      const revealed = shown.has(row.seatIndex);
      return {
        seatIndex: row.seatIndex,
        street: row.street,
        // How the hand was played is the record. How strong it was is the
        // holding, by another name: an equity of 0.95 on the river names the
        // cards as surely as showing them would.
        equity: revealed ? row.equity : null,
        handRead: revealed ? row.handRead : null,
        reasoning: revealed ? row.reasoning : null,
        mucked: !revealed,
        say: row.say,
        action: row.action,
        amount: row.amount,
        elapsedMs: row.elapsedMs,
        outcome: row.outcome,
      };
    }),
  });
}

/**
 * Seats that turned their cards face up, read from the hand's own events.
 *
 * The engine already decided this when it settled: only winners table, plus
 * everyone still live once somebody is all in. Recomputing the rule here would
 * be a second copy of it, and the two would eventually disagree.
 */
function tabled(events: unknown): Set<number> {
  if (!Array.isArray(events)) return new Set();

  return new Set(
    events
      .filter((event) => event?.type === 'showdown' && typeof event.seat === 'number')
      .map((event) => event.seat as number),
  );
}
