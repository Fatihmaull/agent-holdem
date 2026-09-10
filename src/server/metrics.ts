import { and, desc, eq, inArray, sql as raw } from 'drizzle-orm';
import { db } from '../db/client';
import { agents, decisions, matchResults, results, seats, users } from '../db/schema';
import { type Axes, type AxisDecision, computeAxes } from '../lib/axes';
import { winRate, type WinRate } from '../lib/stats';
import { conservative } from '../lib/rating';

/**
 * The published numbers.
 *
 * The standings rank on the rating, not on chips and not on a win rate. Once
 * the arena matches agents by strength a win rate stops separating anybody:
 * everyone plays opponents of their own level and everyone converges on break
 * even. The rating asks the question that survives that, which is how often an
 * agent finished above players we already believed were good.
 *
 * The money is still published, because it is what actually happened and
 * because an arena that hid it would be hiding the only number with a unit.
 */
export interface AgentMetrics {
  agentId: string;
  name: string;
  /** Everything it holds: balance plus whatever is in front of it right now. */
  chips: number;
  /** Won at the tables. Purchases and the daily top-up never touch it. */
  earnings: number;
  /** What the standings sort on: the pessimistic end of the rating. */
  rating: number;
  ratingMu: number;
  ratingSigma: number;
  matchesPlayed: number;
  /** Matches won outright, whether by elimination or on chips at the cap. */
  wins: number;
  rate: WinRate;
}

export async function leaderboard(options: { limit?: number; agentId?: string } = {}): Promise<AgentMetrics[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      balance: users.chips,
      stack: raw<number>`coalesce(${seats.stack}, 0)`,
      ratingMu: agents.ratingMu,
      ratingSigma: agents.ratingSigma,
      matchesPlayed: agents.matchesPlayed,
      wins: raw<number>`(
        select count(*)::int from ${matchResults}
        where ${matchResults.agentId} = ${agents.id} and ${matchResults.place} = 1
      )`,
      hands: raw<number>`count(${results.id})::int`,
      earnings: raw<number>`coalesce(sum(${results.net}), 0)::int`,
      // In big blinds, because a win rate compares across stakes and a chip
      // does not: the same pot is a rout at one table and a blind at another.
      meanBb: raw<number>`coalesce(avg(${results.net}::numeric / ${results.bigBlind}), 0)::float8`,
      sdBb: raw<number>`coalesce(stddev_samp(${results.net}::numeric / ${results.bigBlind}), 0)::float8`,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .leftJoin(seats, eq(seats.agentId, agents.id))
    .leftJoin(results, eq(results.agentId, agents.id))
    .where(options.agentId ? eq(agents.id, options.agentId) : undefined)
    .groupBy(agents.id, agents.name, users.chips, seats.stack)
    .orderBy(desc(agents.ratingMu))
    .limit(options.limit ?? 50);

  return rows
    .map((row) => ({
      agentId: row.agentId,
      name: row.name,
      chips: row.balance + row.stack,
      earnings: row.earnings,
      rating: conservative({ mu: row.ratingMu, sigma: row.ratingSigma }),
      ratingMu: row.ratingMu,
      ratingSigma: row.ratingSigma,
      matchesPlayed: row.matchesPlayed,
      wins: row.wins,
      rate: winRate(row.hands, row.meanBb, row.sdBb),
    }))
    // An agent nobody has seen play publishes nothing, so ties at the bottom
    // fall back to who has actually played, rather than to insertion order.
    .sort((a, b) => b.rating - a.rating || b.matchesPlayed - a.matchesPlayed);
}

/**
 * The four axis scores for one agent.
 *
 * Fetched over a bounded window and computed in memory rather than in SQL. The
 * definitions are the argument here, and they belong somewhere they can be read
 * and tested without a database, not buried in a query nobody will revisit.
 */
export async function axesFor(agentId: string, window = 5_000): Promise<Axes> {
  const mine = await db
    .select({
      handId: results.handId,
      agentId: results.agentId,
      matchId: results.matchId,
      bigBlind: results.bigBlind,
      net: results.net,
      opponentRating: results.opponentRating,
      showdown: results.showdown,
    })
    .from(results)
    .where(eq(results.agentId, agentId))
    .orderBy(desc(results.id))
    .limit(window);

  // Back into playing order. The query takes the most recent, but adaptation
  // asks what happened first and what happened later.
  mine.reverse();
  if (mine.length === 0) return { reading: null, deception: null, adaptation: null, exploitation: null };

  const handIds = mine.map((row) => row.handId);

  const [decisionRows, opponentRows, field] = await Promise.all([
    db
      .select({
        handId: decisions.handId,
        agentId: decisions.agentId,
        street: decisions.street,
        action: decisions.action,
        equity: decisions.equity,
      })
      .from(decisions)
      .where(and(eq(decisions.agentId, agentId), inArray(decisions.handId, handIds))),
    db
      .select({ handId: results.handId, agentId: results.agentId })
      .from(results)
      .where(inArray(results.handId, handIds)),
    fieldVersusWeak(),
  ]);

  const opponentsByHand = new Map<string, string[]>();
  for (const row of opponentRows) {
    if (row.agentId === agentId) continue;
    opponentsByHand.set(row.handId, [...(opponentsByHand.get(row.handId) ?? []), row.agentId]);
  }

  return computeAxes({
    agentId,
    decisions: decisionRows as AxisDecision[],
    results: mine,
    looseness: await loosenessOfEveryone([...new Set(opponentRows.map((row) => row.agentId))]),
    opponentsByHand,
    weakOpponentRating: field.threshold,
    fieldVersusWeak: field.rate,
  });
}

/**
 * How often each of these agents pays to enter a pot.
 *
 * Computed over everyone at once rather than per opponent, because the same
 * handful of players recur across a window of hands and asking about each one
 * separately would be the same query many times over.
 */
async function loosenessOfEveryone(agentIds: string[]): Promise<Map<string, number>> {
  if (agentIds.length === 0) return new Map();

  const rows = await db
    .select({
      agentId: decisions.agentId,
      preflop: raw<number>`count(*) filter (where ${decisions.street} = 'preflop')::int`,
      entered: raw<number>`count(*) filter (where ${decisions.street} = 'preflop' and ${decisions.action} in ('call', 'bet', 'raise'))::int`,
    })
    .from(decisions)
    .where(inArray(decisions.agentId, agentIds))
    .groupBy(decisions.agentId);

  const looseness = new Map<string, number>();
  for (const row of rows) {
    if (row.agentId === null || row.preflop === 0) continue;
    looseness.set(row.agentId, row.entered / row.preflop);
  }
  return looseness;
}

/**
 * Who counts as weak, and how the field as a whole does against them.
 *
 * Exploitation used to mean beating four house scripts with hand-written flaws.
 * The ratings are a better answer: the weak players are now whoever the arena
 * has actually measured as weak, and the question becomes whether an agent
 * punishes them harder than everybody else manages to.
 *
 * The threshold is the median opponent strength across every hand on record, so
 * it moves with the field instead of being a number somebody picked.
 */
async function fieldVersusWeak(): Promise<{ threshold: number | null; rate: number | null }> {
  const [median] = await db
    .select({
      threshold: raw<number | null>`percentile_cont(0.5) within group (order by ${results.opponentRating})`,
      hands: raw<number>`count(*)::int`,
    })
    .from(results);

  if (!median || median.hands === 0 || median.threshold === null) return { threshold: null, rate: null };

  const [field] = await db
    .select({
      hands: raw<number>`count(*)::int`,
      meanBb: raw<number>`coalesce(avg(${results.net}::numeric / ${results.bigBlind}), 0)::float8`,
    })
    .from(results)
    .where(raw`${results.opponentRating} <= ${median.threshold}`);

  return {
    threshold: median.threshold,
    rate: field && field.hands > 0 ? field.meanBb * 100 : null,
  };
}
