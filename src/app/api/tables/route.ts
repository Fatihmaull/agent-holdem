import { TABLES, tableLabel } from '@/lib/economy';
import { getSession } from '@/server/auth';
import { account } from '@/server/actions';
import { allTables } from '@/server/registry';

/** The lobby roster: every fixed table, who is sitting, and how full it is. */
export async function GET(): Promise<Response> {
  const session = await getSession();
  const mine = session ? await account(session).catch(() => null) : null;
  const runtimes = new Map(allTables().map((table) => [table.config.id, table]));
  const myAgentIds = new Set(mine?.agents.map((agent) => agent.id) ?? []);

  const tables = await Promise.all(
    TABLES.map(async (config) => {
      // Read what the table already knows. Forcing a refresh here would publish
      // a snapshot into every spectator's feed on each lobby poll.
      // A wallet holds at most one seat per table, so there is at most one of
      // its agents to un-redact here.
      const seatedHere = mine?.agents.find((agent) => agent.seat?.tableId === config.id);
      const view = runtimes.get(config.id)?.view(seatedHere?.id ?? null);

      return {
        id: config.id,
        label: tableLabel(config),
        format: config.format,
        seatCount: config.seats,
        smallBlind: config.smallBlind,
        bigBlind: config.bigBlind,
        buyIn: config.buyIn,
        wordLimit: config.wordLimit,
        handNumber: view?.handNumber ?? 0,
        // Whether the table is mid-hand right now, so the lobby can mark it
        // live rather than making the reader infer it from a seat count.
        live: view ? view.toAct !== null || view.street !== 'idle' : false,
        pot: view?.pot ?? 0,
        seats:
          view?.seats.map((seat) => ({
            index: seat.index,
            name: seat.name,
            color: seat.color,
            stack: seat.stack,
            isMine: seat.agentId !== null && myAgentIds.has(seat.agentId),
          })) ?? [],
      };
    }),
  );

  // Every table this account currently occupies, since it may hold several.
  const seatedAt = (mine?.agents ?? [])
    .map((agent) => agent.seat?.tableId)
    .filter((id): id is string => Boolean(id));

  return Response.json({ tables, seatedAt });
}
