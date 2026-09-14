import { TransactionRollbackError, and, desc, eq, inArray, isNotNull, isNull, sql as raw } from 'drizzle-orm';

import { db } from '../db/client';
import {
  agents,
  decisions,
  hands,
  ledgerEntries,
  matchResults,
  matches,
  results,
  seats,
  users,
} from '../db/schema';
import type { Card } from '../poker/cards';
import type { HandEvent, HandState } from '../poker/engine';
import type { DecisionRecord } from '../agent/decide';
import { MATCH, SEAT_COST, type MatchConfig } from '../lib/economy';
import { conservative, updateRatings, type Rating } from '../lib/rating';

export interface SeatedAgent {
  seatIndex: number;
  agentId: string;
  name: string;
  color: string;
  stack: number;
  /** Hand this seat went broke on, or null while it still has chips. */
  bustedAtHand: number | null;
}

export async function loadSeats(matchId: string): Promise<SeatedAgent[]> {
  const rows = await db
    .select({
      seatIndex: seats.seatIndex,
      agentId: agents.id,
      name: agents.name,
      color: agents.color,
      stack: seats.stack,
      bustedAtHand: seats.bustedAtHand,
    })
    .from(seats)
    .innerJoin(agents, eq(agents.id, seats.agentId))
    .where(eq(seats.matchId, matchId))
    .orderBy(seats.seatIndex);

  return rows;
}

/**
 * Marks the seats a hand is being played with, so nothing else settles one from
 * under it.
 *
 * Nobody can leave a match any more, so the only other writer is the code that
 * abandons a match after a restart. That is rare, and this is what makes it
 * safe rather than merely unlikely.
 */
export async function markInHand(matchId: string, seatIndexes: number[]): Promise<number[]> {
  if (seatIndexes.length === 0) return [];

  const claimed = await db
    .update(seats)
    .set({ inHand: true })
    .where(and(eq(seats.matchId, matchId), inArray(seats.seatIndex, seatIndexes)))
    .returning({ seatIndex: seats.seatIndex });

  return claimed.map((row) => row.seatIndex);
}

/** Releases every seat in a match once the hand is on record. */
export async function clearInHand(matchId: string): Promise<void> {
  await db.update(seats).set({ inHand: false }).where(eq(seats.matchId, matchId));
}

/** An owner's chip balance. Read on connect so an agent can say why it is idle. */
export async function balanceOf(userId: string): Promise<number> {
  const [row] = await db.select({ chips: users.chips }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.chips ?? 0;
}

/**
 * Why each connected agent is not in a match, when it is not.
 *
 * The queue query below silently drops anyone who cannot cover a seat, which is
 * correct for matchmaking and useless to the owner: their agent says it is
 * ready, the arena says nothing, and no match ever comes. This returns the same
 * facts unfiltered so the matchmaker can say so on the socket.
 */
export async function seatingStatus(
  readyIds: readonly string[],
): Promise<Array<{ agentId: string; chips: number; playing: boolean }>> {
  if (readyIds.length === 0) return [];

  const rows = await db
    .select({ agentId: agents.id, chips: users.chips, seatId: seats.id })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .leftJoin(seats, eq(seats.agentId, agents.id))
    .where(inArray(agents.id, [...readyIds]));

  return rows.map((row) => ({ agentId: row.agentId, chips: row.chips, playing: row.seatId !== null }));
}

export interface Candidate {
  agentId: string;
  name: string;
  ownerId: string;
  rating: Rating;
  /** The published figure, which is what the bands are drawn on. */
  published: number;
}

/**
 * Everyone waiting for a game, out of those currently connected and ready.
 *
 * Readiness is not a column any more: an agent is looking for a game when it
 * has a socket open and has said so on it. The caller passes in who that is,
 * because only the process holding the sockets knows, and this adds the two
 * conditions the database owns: not already seated, and able to cover a seat.
 *
 * How long each has waited is deliberately not answered here. A row's mtime is
 * whatever last touched it, and the only thing that knows when an agent asked
 * for a game is the socket it asked on.
 */
export async function queuedAgents(readyIds: readonly string[]): Promise<Candidate[]> {
  if (readyIds.length === 0) return [];

  const rows = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      ownerId: users.id,
      mu: agents.ratingMu,
      sigma: agents.ratingSigma,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .leftJoin(seats, eq(seats.agentId, agents.id))
    .where(
      and(
        inArray(agents.id, [...readyIds]),
        isNull(seats.id),
        raw`${users.chips} >= ${SEAT_COST}`,
      ),
    );

  return rows.map((row) => {
    const rating: Rating = { mu: row.mu, sigma: row.sigma };
    return {
      agentId: row.agentId,
      name: row.name,
      ownerId: row.ownerId,
      rating,
      published: conservative(rating),
    };
  });
}

/**
 * Opens a match and seats everyone in it, as one transaction.
 *
 * The buy-in and the fee both leave the owner's balance here, so chips are
 * never in a seat and a balance at once, and never in neither. An entrant that
 * cannot be charged is dropped rather than seated on credit; if that leaves too
 * few players the whole thing rolls back and the matchmaker tries again next
 * tick with whoever is still there.
 */
export async function createMatch(
  entrants: readonly Candidate[],
): Promise<{ id: string; config: MatchConfig } | null> {
  if (entrants.length < 2) return null;

  return db.transaction(async (tx): Promise<{ id: string; config: MatchConfig } | null> => {
    const [match] = await tx
      .insert(matches)
      .values({
        status: 'playing',
        seatCount: MATCH.seats,
        smallBlind: MATCH.smallBlind,
        bigBlind: MATCH.bigBlind,
        buyIn: MATCH.buyIn,
        entryFee: MATCH.entryFee,
        handCap: MATCH.handCap,
        bandRating: entrants.reduce((sum, entrant) => sum + entrant.published, 0) / entrants.length,
        startedAt: new Date(),
      })
      .returning();

    let seated = 0;

    for (const entrant of entrants) {
      // Conditional on the balance still covering it, so an agent charged for
      // another match between the queue being read and this running is simply
      // left out rather than overdrawn.
      const [debited] = await tx
        .update(users)
        .set({ chips: raw`${users.chips} - ${SEAT_COST}` })
        .where(and(eq(users.id, entrant.ownerId), raw`${users.chips} >= ${SEAT_COST}`))
        .returning({ chips: users.chips });

      if (!debited) continue;

      // Two entries, because they are two different things. One is chips moving
      // onto a table and coming back; the other is the house's cut, which does
      // not.
      await tx.insert(ledgerEntries).values([
        {
          userId: entrant.ownerId,
          delta: -MATCH.buyIn,
          balanceAfter: debited.chips + MATCH.entryFee,
          reason: 'match-buy-in' as const,
          reference: match.id,
        },
        {
          userId: entrant.ownerId,
          delta: -MATCH.entryFee,
          balanceAfter: debited.chips,
          reason: 'entry-fee' as const,
          reference: match.id,
        },
      ]);

      // Densely numbered from zero. An entrant that failed the balance check
      // above leaves no gap, because a match has no chair anybody can arrive
      // in later: the seats it opens with are the seats it has.
      await tx.insert(seats).values({
        matchId: match.id,
        seatIndex: seated,
        agentId: entrant.agentId,
        stack: MATCH.buyIn,
      });
      seated += 1;
    }

    if (seated < 2) {
      tx.rollback();
      return null;
    }

    // The table is as big as the field that turned up. Nobody joins a match in
    // progress, so a chair nobody is sitting in is not an open seat, it is a
    // drawing of one, and every screen counting seats would report a table
    // waiting for players that will never come.
    await tx.update(matches).set({ seatCount: seated }).where(eq(matches.id, match.id));

    // The row's own figures, not the module's. A match describes itself for its
    // whole life, so one dealt under different settings still plays by the ones
    // it was opened with.
    return {
      id: match.id,
      config: {
        seats: seated,
        smallBlind: match.smallBlind,
        bigBlind: match.bigBlind,
        buyIn: match.buyIn,
        entryFee: match.entryFee,
        handCap: match.handCap,
      },
    };
  }).catch((error: unknown) => {
    // `rollback` throws rather than returning, so a match that could not seat
    // two arrives here. Letting it travel would fail the matchmaker's whole
    // tick and leave every other group it had formed unopened.
    if (error instanceof TransactionRollbackError) return null;
    throw error;
  });
}

/** How a match came to an end, which decides whether anybody is rated for it. */
export type MatchEnding = 'elimination' | 'cap' | 'abandoned';

export interface Finish {
  agentId: string;
  name: string;
  place: number;
  finalStack: number;
  bustedAtHand: number | null;
  before: Rating;
  after: Rating;
}

/** What closing a match came to. */
export interface Settlement {
  /** Everyone who held a seat, rated or not, and the stack each was paid back. */
  entrants: Array<{ agentId: string; finalStack: number }>;
  /** Places and ratings. Empty when the match rates nobody. */
  finishes: Finish[];
}

/**
 * Closes a match: returns every stack, works out the finishing order, and
 * updates everybody's rating from it.
 *
 * An abandoned match returns the chips and rates nobody. Nothing about a match
 * the server walked out of says anything about how well anyone played. Its
 * entrants are still named, because each of them is owed being told it ended.
 */
export async function settleMatch(matchId: string, ending: MatchEnding, handsPlayed: number): Promise<Settlement> {
  return db.transaction(async (tx): Promise<Settlement> => {
    const rows = await tx
      .select({
        agentId: seats.agentId,
        name: agents.name,
        stack: seats.stack,
        bustedAtHand: seats.bustedAtHand,
        userId: agents.userId,
        mu: agents.ratingMu,
        sigma: agents.ratingSigma,
      })
      .from(seats)
      .innerJoin(agents, eq(agents.id, seats.agentId))
      .where(eq(seats.matchId, matchId))
      .for('update', { of: seats });

    for (const row of rows) {
      // A stack of nothing is nothing to return. Everything else goes back to
      // the owner it was taken from, whatever place the agent finished in.
      if (row.stack <= 0) continue;

      const [updated] = await tx
        .update(users)
        .set({ chips: raw`${users.chips} + ${row.stack}` })
        .where(eq(users.id, row.userId))
        .returning({ chips: users.chips });

      await tx.insert(ledgerEntries).values({
        userId: row.userId,
        delta: row.stack,
        balanceAfter: updated.chips,
        reason: 'match-cash-out',
        reference: matchId,
      });
    }

    await tx.delete(seats).where(eq(seats.matchId, matchId));
    await tx
      .update(matches)
      .set({ status: ending, handsPlayed, endedAt: new Date() })
      .where(eq(matches.id, matchId));

    // An abandoned match rates nobody: it says nothing about how anyone played.
    // Neither does a match that somehow ended with one entrant, since a place
    // needs somebody to be placed above.
    const entrants = rows.map((row) => ({ agentId: row.agentId, finalStack: row.stack }));
    if (ending === 'abandoned' || rows.length < 2) return { entrants, finishes: [] };

    const placed = rows.map((row) => ({
      row,
      place: placeOf(row, rows),
      rating: { mu: row.mu, sigma: row.sigma } satisfies Rating,
    }));

    const updatedRatings = updateRatings(
      placed.map((entry) => ({ entrant: entry.row.agentId, rating: entry.rating, place: entry.place })),
    );

    const finishes: Finish[] = [];

    for (const [index, entry] of placed.entries()) {
      const after = updatedRatings[index].rating;

      await tx.insert(matchResults).values({
        matchId,
        agentId: entry.row.agentId,
        place: entry.place,
        finalStack: entry.row.stack,
        bustedAtHand: entry.row.bustedAtHand,
        ratingMuBefore: entry.rating.mu,
        ratingSigmaBefore: entry.rating.sigma,
        ratingMuAfter: after.mu,
        ratingSigmaAfter: after.sigma,
      });

      await tx
        .update(agents)
        .set({
          ratingMu: after.mu,
          ratingSigma: after.sigma,
          matchesPlayed: raw`${agents.matchesPlayed} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, entry.row.agentId));

      finishes.push({
        agentId: entry.row.agentId,
        name: entry.row.name,
        place: entry.place,
        finalStack: entry.row.stack,
        bustedAtHand: entry.row.bustedAtHand,
        before: entry.rating,
        after,
      });
    }

    return { entrants, finishes };
  });
}

/**
 * Where one agent finished, counting how many genuinely did better.
 *
 * Anyone still holding chips finishes above everyone eliminated, ordered by how
 * many they hold. Among the eliminated, going out later is the better finish.
 * Equal results share a place, which the rating reads as a tie.
 */
function placeOf(
  self: { stack: number; bustedAtHand: number | null },
  field: ReadonlyArray<{ stack: number; bustedAtHand: number | null }>,
): number {
  const better = field.filter((other) => {
    const otherAlive = other.bustedAtHand === null;
    const selfAlive = self.bustedAtHand === null;

    if (otherAlive !== selfAlive) return otherAlive;
    if (otherAlive) return other.stack > self.stack;
    return (other.bustedAtHand ?? 0) > (self.bustedAtHand ?? 0);
  });

  return better.length + 1;
}

/** Matches this process was dealing before it went away. Returned, never rated. */
export async function liveMatchIds(): Promise<string[]> {
  const rows = await db.select({ id: matches.id }).from(matches).where(eq(matches.status, 'playing'));
  return rows.map((row) => row.id);
}

/** A decision as it is stored with its hand. */
export interface RecordedDecision {
  /** Engine position, which is what the lineup stored beside it is indexed by. */
  seatIndex: number;
  agentId: string;
  record: DecisionRecord;
  street: string;
  /**
   * What the action came to, read off this decision's own event: the level
   * reached for a bet or a raise, the chips put in for a call. Searching the
   * hand for it afterwards found the seat's last call rather than this one.
   */
  amount: number;
}

export interface PersistedHand {
  matchId: string;
  handNumber: number;
  /** The deck as dealt, off the end. What a replay deals from. */
  deck: readonly Card[];
  state: HandState;
  startedAt: Date;
  bigBlind: number;
  /** In engine order: `seatIndex` is the position, `chair` the seat row it plays from. */
  lineup: Array<{ seatIndex: number; chair: number; agentId: string; name: string; startingStack: number }>;
  decisions: RecordedDecision[];
  outcomes: HandOutcome[];
}

/**
 * Stores a finished hand and everything it changed, as one transaction.
 *
 * The hand, its decisions, the results and counters, the stacks it left, the
 * seats it knocked out and the release of the seats land together or not at
 * all. Written separately, a failure between them left results and counters
 * describing a hand whose stacks never moved: numbers published about chips that
 * stayed where they were, and a table that dealt on from the old stacks.
 */
export async function recordHand(hand: PersistedHand): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(hands)
      .values({
        matchId: hand.matchId,
        handNumber: hand.handNumber,
        deck: [...hand.deck],
        button: hand.state.button,
        // Stored in the shape replays already read. The chair is the runtime's
        // business; the stored hand is indexed by position throughout.
        lineup: hand.lineup.map(({ seatIndex, agentId, name, startingStack }) => ({
          seatIndex,
          agentId,
          name,
          startingStack,
        })),
        board: hand.state.board,
        pots: hand.state.pots,
        events: hand.state.events satisfies HandEvent[],
        startedAt: hand.startedAt,
        endedAt: new Date(),
      })
      .returning({ id: hands.id });

    if (hand.decisions.length > 0) {
      await tx.insert(decisions).values(
        hand.decisions.map((entry) => ({
          handId: row.id,
          agentId: entry.agentId,
          seatIndex: entry.seatIndex,
          street: entry.street,
          equity: entry.record.equity.equity,
          handRead: entry.record.read,
          reasoning: entry.record.reasoning,
          say: entry.record.say,
          action: entry.record.action.type,
          amount: entry.amount,
          elapsedMs: entry.record.elapsedMs,
          outcome: entry.record.outcome,
        })),
      );
    }

    if (hand.outcomes.length > 0) {
      const filed = await tx
        .insert(results)
        .values(
          hand.outcomes.map((outcome) => ({
            handId: row.id,
            agentId: outcome.agentId,
            matchId: hand.matchId,
            bigBlind: hand.bigBlind,
            startingStack: outcome.startingStack,
            net: outcome.net,
            showdown: outcome.showdown,
            opponents: outcome.opponents,
            opponentRating: outcome.opponentRating,
          })),
        )
        .onConflictDoNothing()
        .returning({ agentId: results.agentId });

      // The counters follow the rows that actually went in. A result row that
      // already existed was already counted, and counting it again would move
      // a profile's numbers away from the rows every metric is computed from.
      const counted = new Set(filed.map((entry) => entry.agentId));

      for (const outcome of hand.outcomes) {
        if (!counted.has(outcome.agentId)) continue;
        await tx
          .update(agents)
          .set({
            handsPlayed: raw`${agents.handsPlayed} + 1`,
            handsWon: raw`${agents.handsWon} + ${outcome.won ? 1 : 0}`,
            chipsWon: raw`${agents.chipsWon} + ${outcome.net}`,
            biggestPot: raw`GREATEST(${agents.biggestPot}, ${outcome.won ? outcome.potSize : 0})`,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, outcome.agentId));
      }
    }

    for (const seat of hand.lineup) {
      const stack = hand.state.seats[seat.seatIndex].stack;
      const chair = and(eq(seats.matchId, hand.matchId), eq(seats.seatIndex, seat.chair));

      await tx.update(seats).set({ stack }).where(chair);

      // A stack too short to post a big blind cannot play another hand. The
      // hand number fixes finishing order among everyone who went out, and the
      // stack is deliberately left alone: those chips are still the owner's and
      // go back at settlement like anyone else's.
      if (stack < hand.bigBlind) {
        await tx
          .update(seats)
          .set({ bustedAtHand: hand.handNumber })
          .where(and(chair, isNull(seats.bustedAtHand)));
      }
    }

    // The chips are on record, so no seat belongs to a hand any more.
    await tx.update(seats).set({ inHand: false }).where(eq(seats.matchId, hand.matchId));

    await tx
      .update(matches)
      .set({ handsPlayed: hand.handNumber })
      .where(eq(matches.id, hand.matchId));

    return row.id;
  });
}

export interface HandOutcome {
  agentId: string;
  won: boolean;
  net: number;
  potSize: number;
  startingStack: number;
  /** Whether the hand was decided by comparing cards. */
  showdown: boolean;
  opponents: number;
  /** Average published rating of those opponents, as it stood when the hand was dealt. */
  opponentRating: number;
}

/**
 * Files a finished hand for everyone who was dealt into it.
 *
 * Two things happen here and they answer different questions. The counters on
 * the agent row are what a profile page reads without scanning anything. The
 * result rows are what every metric is computed from, including ones that do
 * not exist yet, over hands already played.
 */
export async function recordResults(
  hand: { handId: string; matchId: string; bigBlind: number },
  outcomes: HandOutcome[],
): Promise<void> {
  if (outcomes.length === 0) return;
  await db.transaction(async (tx) => {
    await tx
      .insert(results)
      .values(
        outcomes.map((outcome) => ({
          handId: hand.handId,
          agentId: outcome.agentId,
          matchId: hand.matchId,
          bigBlind: hand.bigBlind,
          startingStack: outcome.startingStack,
          net: outcome.net,
          showdown: outcome.showdown,
          opponents: outcome.opponents,
          opponentRating: outcome.opponentRating,
        })),
      )
      // A hand that somehow gets stored twice must not count twice. The rows
      // are the measurement, so a duplicate would move every published number.
      .onConflictDoNothing();

    for (const outcome of outcomes) {
      await tx
        .update(agents)
        .set({
          handsPlayed: raw`${agents.handsPlayed} + 1`,
          handsWon: raw`${agents.handsWon} + ${outcome.won ? 1 : 0}`,
          chipsWon: raw`${agents.chipsWon} + ${outcome.net}`,
          biggestPot: raw`GREATEST(${agents.biggestPot}, ${outcome.won ? outcome.potSize : 0})`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, outcome.agentId));
    }
  });
}

/** The most recently completed hand anywhere, for the landing page replay. */
export async function latestHand(): Promise<{
  id: string;
  matchId: string;
  handNumber: number;
  lineup: unknown;
  events: unknown;
  board: unknown;
} | null> {
  const [row] = await db
    .select({
      id: hands.id,
      matchId: hands.matchId,
      handNumber: hands.handNumber,
      lineup: hands.lineup,
      events: hands.events,
      board: hands.board,
    })
    .from(hands)
    .where(isNotNull(hands.endedAt))
    .orderBy(desc(hands.endedAt))
    .limit(1);

  return row ?? null;
}

export async function decisionsForHand(handId: string) {
  return db.select().from(decisions).where(eq(decisions.handId, handId)).orderBy(decisions.id);
}

/** Current ratings for a set of agents, for anything that needs them mid-match. */
export async function ratingsOf(agentIds: string[]): Promise<Map<string, Rating>> {
  if (agentIds.length === 0) return new Map();

  const rows = await db
    .select({ id: agents.id, mu: agents.ratingMu, sigma: agents.ratingSigma })
    .from(agents)
    .where(inArray(agents.id, agentIds));

  return new Map(rows.map((row) => [row.id, { mu: row.mu, sigma: row.sigma }]));
}

/** A match as it can be described without the process that is dealing it. */
export interface StoredMatch {
  matchId: string;
  status: string;
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  handCap: number;
  handsPlayed: number;
  bandRating: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  seats: Array<{ index: number; agentId: string; name: string; color: string; stack: number; busted: boolean }>;
}

/**
 * Every match worth showing, read from the database rather than from process
 * memory.
 *
 * Only one instance deals, so only that one has runtimes to describe. A lobby
 * read off them would tell every other instance that the room is empty, which
 * is indistinguishable from the room being empty and is the worst way for it to
 * be wrong.
 */
export async function storedMatches(limit = 20): Promise<StoredMatch[]> {
  const rows = await db
    .select()
    .from(matches)
    .where(inArray(matches.status, ['playing', 'elimination', 'cap']))
    .orderBy(desc(matches.startedAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const occupied = await db
    .select({
      matchId: seats.matchId,
      seatIndex: seats.seatIndex,
      agentId: seats.agentId,
      stack: seats.stack,
      bustedAtHand: seats.bustedAtHand,
      name: agents.name,
      color: agents.color,
    })
    .from(seats)
    .innerJoin(agents, eq(agents.id, seats.agentId))
    .where(
      inArray(
        seats.matchId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(seats.seatIndex);

  return rows.map((row) => ({
    matchId: row.id,
    status: row.status,
    seatCount: row.seatCount,
    smallBlind: row.smallBlind,
    bigBlind: row.bigBlind,
    buyIn: row.buyIn,
    handCap: row.handCap,
    handsPlayed: row.handsPlayed,
    bandRating: row.bandRating,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    seats: occupied
      .filter((seat) => seat.matchId === row.id)
      .map((seat) => ({
        index: seat.seatIndex,
        agentId: seat.agentId,
        name: seat.name,
        color: seat.color,
        stack: seat.stack,
        busted: seat.bustedAtHand !== null,
      })),
  }));
}
