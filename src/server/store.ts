import { and, asc, desc, eq, inArray, isNotNull, isNull, sql as raw } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client';
import {
  agentNoteRevisions,
  agentNotes,
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
import type { HandEvent, HandState } from '../poker/engine';
import type { DecisionRecord } from '../agent/decide';
import { MAX_NOTE } from '../agent/decision';
import { MATCH, SEAT_COST, STARTING_GRANT, type MatchConfig } from '../lib/economy';
import { conservative, updateRatings, type Rating } from '../lib/rating';

export interface SeatedAgent {
  seatIndex: number;
  agentId: string;
  name: string;
  color: string;
  instructions: string;
  stack: number;
  /** False for the control arm, which plays remembering nobody. */
  notesEnabled: boolean;
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
      instructions: agents.instructions,
      stack: seats.stack,
      notesEnabled: agents.notesEnabled,
      bustedAtHand: seats.bustedAtHand,
    })
    .from(seats)
    .innerJoin(agents, eq(agents.id, seats.agentId))
    .where(eq(seats.matchId, matchId))
    .orderBy(seats.seatIndex);

  return rows;
}

export async function saveStacks(matchId: string, stacks: Array<{ seatIndex: number; stack: number }>): Promise<void> {
  if (stacks.length === 0) return;
  await db.transaction(async (tx) => {
    for (const { seatIndex, stack } of stacks) {
      await tx
        .update(seats)
        .set({ stack })
        .where(and(eq(seats.matchId, matchId), eq(seats.seatIndex, seatIndex)));
    }
  });
}

/**
 * Records that a seat can no longer play.
 *
 * The hand number is what fixes finishing order among everyone eliminated:
 * surviving to hand ninety beats going out on hand five, which is how every
 * tournament has ever ranked the people who did not win.
 *
 * The stack is deliberately left alone. An agent short of a big blind is out of
 * the match, but the chips it still holds are its owner's and are returned at
 * settlement like anyone else's. Zeroing the row here would quietly destroy
 * them.
 */
export async function bustSeat(matchId: string, seatIndex: number, handNumber: number): Promise<void> {
  await db
    .update(seats)
    .set({ bustedAtHand: handNumber })
    .where(and(eq(seats.matchId, matchId), eq(seats.seatIndex, seatIndex), isNull(seats.bustedAtHand)));
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

/** Marks whether an agent is looking for a game. */
export async function setSeeking(agentId: string, seeking: boolean): Promise<void> {
  await db.update(agents).set({ seeking }).where(eq(agents.id, agentId));
}

export interface Candidate {
  agentId: string;
  name: string;
  ownerId: string;
  rating: Rating;
  /** The published figure, which is what the bands are drawn on. */
  published: number;
  waitingSince: Date;
}

/**
 * Everyone waiting for a game.
 *
 * An agent qualifies by being switched on, owned, not already sitting in a
 * match, and able to cover a seat. Ordered by how long they have waited, so the
 * matchmaker can widen a band for whoever has been waiting longest rather than
 * for whoever it happened to read first.
 */
export async function queuedAgents(): Promise<Candidate[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      ownerId: users.id,
      mu: agents.ratingMu,
      sigma: agents.ratingSigma,
      waitingSince: agents.updatedAt,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .leftJoin(seats, eq(seats.agentId, agents.id))
    .where(
      and(
        isNull(seats.id),
        eq(agents.seeking, true),
        raw`${users.chips} >= ${SEAT_COST}`,
      ),
    )
    .orderBy(asc(agents.updatedAt));

  return rows.map((row) => {
    const rating: Rating = { mu: row.mu, sigma: row.sigma };
    return {
      agentId: row.agentId,
      name: row.name,
      ownerId: row.ownerId,
      rating,
      published: conservative(rating),
      waitingSince: row.waitingSince,
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

/**
 * Closes a match: returns every stack, works out the finishing order, and
 * updates everybody's rating from it.
 *
 * An abandoned match returns the chips and rates nobody. Nothing about a match
 * the server walked out of says anything about how well anyone played.
 */
export async function settleMatch(matchId: string, ending: MatchEnding, handsPlayed: number): Promise<Finish[]> {
  return db.transaction(async (tx): Promise<Finish[]> => {
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
    if (ending === 'abandoned' || rows.length < 2) return [];

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

    return finishes;
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

/**
 * Tops every lapsed account back up to what a new one starts with.
 *
 * Honest rather than generous while chips are bought with a token that costs
 * nothing, and the single thing to delete if this ever runs where they do. An
 * account already above the line is left alone, so this never hands chips to
 * anybody who is playing successfully.
 */
export async function topUpLapsedAccounts(): Promise<number> {
  return db.transaction(async (tx) => {
    const short = await tx
      .select({ id: users.id, chips: users.chips })
      .from(users)
      .where(raw`${users.chips} < ${STARTING_GRANT}`);

    for (const account of short) {
      const delta = STARTING_GRANT - account.chips;
      await tx.update(users).set({ chips: STARTING_GRANT }).where(eq(users.id, account.id));
      await tx.insert(ledgerEntries).values({
        userId: account.id,
        delta,
        balanceAfter: STARTING_GRANT,
        reason: 'grant',
        reference: 'daily-top-up',
      });
    }

    return short.length;
  });
}

/**
 * What this agent has written about each of the given opponents in this match.
 *
 * Scoped to the match on purpose. Every agent sits down knowing nobody, so an
 * owner who rewrites an agent between matches is not facing opponents who
 * remember the version it used to be.
 */
export async function loadNotes(matchId: string, authorId: string, subjectIds: string[]): Promise<Map<string, string>> {
  if (subjectIds.length === 0) return new Map();

  const rows = await db
    .select({ subjectId: agentNotes.subjectId, text: agentNotes.text })
    .from(agentNotes)
    .where(
      and(
        eq(agentNotes.matchId, matchId),
        eq(agentNotes.authorId, authorId),
        inArray(agentNotes.subjectId, subjectIds),
      ),
    );

  return new Map(rows.map((row) => [row.subjectId, row.text]));
}

export interface MatchNote {
  authorId: string;
  authorName: string;
  subjectId: string;
  subjectName: string;
  text: string;
  updatedAt: Date;
  /** How many times this read has been rewritten, this version included. */
  revisions: number;
}

/**
 * Every note written inside one match.
 *
 * Public while the match is running, because a spectator watching a read form
 * and then break is watching the hypothesis being tested. Once it ends the
 * route serving this narrows it to the owners involved, so nobody mines a
 * finished match for an edge in the next one.
 */
export async function matchNotes(matchId: string): Promise<MatchNote[]> {
  const author = alias(agents, 'author');
  const subject = alias(agents, 'subject');

  return db
    .select({
      authorId: agentNotes.authorId,
      authorName: author.name,
      subjectId: agentNotes.subjectId,
      subjectName: subject.name,
      text: agentNotes.text,
      updatedAt: agentNotes.updatedAt,
      revisions: raw<number>`(
        select count(*)::int from ${agentNoteRevisions}
        where ${agentNoteRevisions.matchId} = ${agentNotes.matchId}
          and ${agentNoteRevisions.authorId} = ${agentNotes.authorId}
          and ${agentNoteRevisions.subjectId} = ${agentNotes.subjectId}
      )`,
    })
    .from(agentNotes)
    .innerJoin(author, eq(author.id, agentNotes.authorId))
    .innerJoin(subject, eq(subject.id, agentNotes.subjectId))
    .where(eq(agentNotes.matchId, matchId))
    .orderBy(desc(agentNotes.updatedAt));
}

/**
 * Replaces what an agent remembers about one opponent, keeping the version it
 * is replacing. Blank text erases the note rather than storing an empty one, so
 * an agent can genuinely decide an opponent is not worth remembering.
 */
export async function saveNote(input: {
  matchId: string;
  authorId: string;
  subjectId: string;
  text: string;
  handId: string | null;
}): Promise<void> {
  const text = input.text.trim().slice(0, MAX_NOTE);

  await db.transaction(async (tx) => {
    if (text.length === 0) {
      await tx
        .delete(agentNotes)
        .where(
          and(
            eq(agentNotes.matchId, input.matchId),
            eq(agentNotes.authorId, input.authorId),
            eq(agentNotes.subjectId, input.subjectId),
          ),
        );
    } else {
      await tx
        .insert(agentNotes)
        .values({ matchId: input.matchId, authorId: input.authorId, subjectId: input.subjectId, text })
        .onConflictDoUpdate({
          target: [agentNotes.matchId, agentNotes.authorId, agentNotes.subjectId],
          set: { text, updatedAt: new Date() },
        });
    }

    // The erasure is recorded too. An agent deciding a read was wrong is
    // exactly as interesting as it forming one, and a gap in the history would
    // read as the agent never having changed its mind.
    await tx.insert(agentNoteRevisions).values({
      matchId: input.matchId,
      authorId: input.authorId,
      subjectId: input.subjectId,
      text,
      handId: input.handId,
    });
  });
}

export interface PersistedHand {
  matchId: string;
  handNumber: number;
  seed: number;
  state: HandState;
  lineup: Array<{ seatIndex: number; agentId: string; name: string; startingStack: number }>;
  startedAt: Date;
  decisions: Array<{ seatIndex: number; agentId: string; record: DecisionRecord; street: string }>;
}

/** Stores a finished hand whole, so it can be replayed exactly from its seed. */
export async function saveHand(hand: PersistedHand): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(hands)
      .values({
        matchId: hand.matchId,
        handNumber: hand.handNumber,
        seed: hand.seed,
        button: hand.state.button,
        lineup: hand.lineup,
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
          // `to` is only set for a bet or a raise. A call's size comes from the
          // hand's own action event, so it is read back from there rather than
          // stored as nothing.
          amount: entry.record.action.to ?? calledAmount(hand.state, entry.seatIndex, entry.record.action.type),
          elapsedMs: entry.record.elapsedMs,
          outcome: entry.record.outcome,
        })),
      );
    }

    await tx
      .update(matches)
      .set({ handsPlayed: hand.handNumber })
      .where(eq(matches.id, hand.matchId));

    return row.id;
  });
}

/** What a seat actually put in for a given action, taken from the hand's events. */
function calledAmount(state: HandState, seatIndex: number, action: string): number {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const event = state.events[i];
    if (event.type === 'action' && event.seat === seatIndex && event.action === action) return event.amount;
  }
  return 0;
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
