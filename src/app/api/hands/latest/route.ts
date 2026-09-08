import { decisionsForHand, latestHand } from '@/server/store';
import { allTables } from '@/server/registry';

/**
 * Feeds the landing page. If a table is dealing right now the hero watches it
 * live; if none is, the page replays the last real hand and says so. It never
 * invents a hand to fill the space.
 */
export async function GET(): Promise<Response> {
  const live = allTables().find((table) => {
    const view = table.view(null);
    return view.toAct !== null || view.street !== 'idle';
  });

  if (live) return Response.json({ mode: 'live', tableId: live.config.id });

  const hand = await latestHand();
  if (!hand) return Response.json({ mode: 'empty' });

  const rows = await decisionsForHand(hand.id);
  return Response.json({
    mode: 'replay',
    handId: hand.id,
    tableId: hand.tableId,
    handNumber: hand.handNumber,
    lineup: hand.lineup,
    board: hand.board,
    decisions: rows.map((row) => ({
      seatIndex: row.seatIndex,
      street: row.street,
      equity: row.equity,
      handRead: row.handRead,
      reasoning: row.reasoning,
      say: row.say,
      action: row.action,
      amount: row.amount,
      elapsedMs: row.elapsedMs,
      outcome: row.outcome,
    })),
  });
}
