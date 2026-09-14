import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
// First, before anything that loads the database module. Without a test
// database configured this suite skips itself; see the helper for why.
import { testDatabaseUrl } from '../dev/test-db';
import { and, eq, sql as raw } from 'drizzle-orm';
import { db, sql } from '../db/client';
import {
  agents,
  decisions,
  depositIntents,
  hands,
  ledgerEntries,
  matchResults,
  matches,
  results,
  seats,
  users,
} from '../db/schema';
import type { DecisionRecord } from '../agent/decide';
import { ENTRY_FEE, MATCH, SEAT_COST, STARTING_GRANT, chipsToWei } from '../lib/economy';
import { DEFAULT_RATING, conservative, type Rating } from '../lib/rating';
import { applyAction, startHand, totalPot } from '../poker/engine';
import { ActionError, claimChips, confirmDeposit, startDeposit, type DepositResult } from './actions';
import type { Session } from './auth';
import type { observeDeposit } from './chain';
import { shuffledDeck } from './deck';
import { leaderboard } from './metrics';
import {
  createMatch,
  markInHand,
  recordHand,
  settleMatch,
  type Candidate,
  type PersistedHand,
} from './store';

/**
 * The paths that move chips, against a real database.
 *
 * Everything else about the arena can be wrong for a hand and recover. A ledger
 * that credits twice, charges a seat nobody sat in, or settles a match into more
 * chips than went onto the table stays wrong, so these run the real queries and
 * the real transactions rather than a model of them.
 */

const CHAIN = 'bnb-testnet';
const TX = `0x${'ab'.repeat(32)}`;

// Starting a deposit refuses a chain with no vault. The address is never
// called: the chain read is replaced below, and nothing here signs anything.
process.env.BNB_TESTNET_VAULT_ADDRESS ||= '0x000000000000000000000000000000000000dEaD';

after(async () => {
  await sql.end();
});

describe('ledger', { skip: testDatabaseUrl ? false : 'set TEST_DATABASE_URL to a *_test database to run' }, () => {
  beforeEach(async () => {
    await db.execute(
      raw`truncate table users, agents, deposit_intents, attestations, ledger_entries, matches, match_results, seats, hands, decisions, results restart identity cascade`,
    );
  });

  /* ------------------------------------------------------------------------ */
  /* The daily claim                                                          */
  /* ------------------------------------------------------------------------ */

  test('the daily claim pays once and refuses the second ask', async () => {
    const me = await owner(0);

    const first = await claimChips(me);
    assert.equal(first.chips, STARTING_GRANT);

    await assert.rejects(claimChips(me), ActionError);
    assert.equal(await balance(me.userId), STARTING_GRANT, 'the refusal moved nothing');
    await ledgerAgrees(me.userId, 0);
  });

  test('two claims racing each other pay once', async () => {
    const me = await owner(0);

    const outcomes = await Promise.allSettled([claimChips(me), claimChips(me)]);

    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(await balance(me.userId), STARTING_GRANT);
    await ledgerAgrees(me.userId, 0);
  });

  /* ------------------------------------------------------------------------ */
  /* Opening a match                                                          */
  /* ------------------------------------------------------------------------ */

  test('opening a match charges every entrant one seat and seats them densely', async () => {
    const field = [
      await candidate(SEAT_COST * 2, 'A'),
      await candidate(SEAT_COST * 2, 'B'),
      await candidate(SEAT_COST * 2, 'C'),
    ];

    const match = await createMatch(field);
    assert.ok(match);
    assert.equal(match.config.seats, 3, 'the table is as big as the field that turned up');

    for (const entrant of field) {
      assert.equal(await balance(entrant.ownerId), SEAT_COST);
      await ledgerAgrees(entrant.ownerId, SEAT_COST * 2);

      const reasons = await db
        .select({ reason: ledgerEntries.reason, delta: ledgerEntries.delta })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, entrant.ownerId));
      assert.deepEqual(
        reasons.map((row) => `${row.reason} ${row.delta}`).sort(),
        [`entry-fee -${MATCH.entryFee}`, `match-buy-in -${MATCH.buyIn}`],
        'the buy-in and the house cut are two different movements',
      );
    }

    const seated = await seatsOf(match.id);
    assert.deepEqual(
      seated.map((seat) => seat.seatIndex),
      [0, 1, 2],
    );
    assert.ok(seated.every((seat) => seat.stack === MATCH.buyIn));
  });

  test('an entrant who cannot cover a seat is left out rather than overdrawn', async () => {
    const a = await candidate(SEAT_COST, 'A');
    const broke = await candidate(SEAT_COST - 1, 'Broke');
    const b = await candidate(SEAT_COST, 'B');

    const match = await createMatch([a, broke, b]);
    assert.ok(match);
    assert.equal(match.config.seats, 2);

    assert.equal(await balance(broke.ownerId), SEAT_COST - 1, 'charged nothing');
    const seated = await seatsOf(match.id);
    assert.deepEqual(
      seated.map((seat) => [seat.seatIndex, seat.agentId]),
      [
        [0, a.agentId],
        [1, b.agentId],
      ],
      'and it leaves no gap, because nobody can arrive in one later',
    );
  });

  test('a match that could seat fewer than two charges nobody at all', async () => {
    const a = await candidate(SEAT_COST, 'A');
    const broke = await candidate(10, 'Broke');

    const match = await createMatch([a, broke]);

    assert.equal(match, null);
    assert.equal(await balance(a.ownerId), SEAT_COST, 'the one entrant who could pay was not charged');
    assert.equal((await db.select().from(matches)).length, 0, 'and no match was left behind');
    assert.equal((await db.select().from(ledgerEntries)).length, 0);
  });

  /* ------------------------------------------------------------------------ */
  /* Recording a hand                                                         */
  /* ------------------------------------------------------------------------ */

  test('a hand is recorded whole: stacks, busts, results and counters move together', async () => {
    const field = [await candidate(SEAT_COST, 'A'), await candidate(SEAT_COST, 'B')];
    const match = (await createMatch(field))!;
    // Seat 0 comes in short enough that posting a blind and folding it leaves
    // too little to post another.
    await setStacks(match.id, [{ stack: 25 }, { stack: MATCH.buyIn }]);
    await markInHand(match.id, [0, 1]);

    const hand = foldedHand(match.id, field, [25, MATCH.buyIn]);
    await recordHand(hand);

    const seated = await seatsOf(match.id);
    assert.deepEqual(
      seated.map((seat) => seat.stack),
      [25 - MATCH.smallBlind, MATCH.buyIn + MATCH.smallBlind],
    );
    assert.deepEqual(
      seated.map((seat) => seat.bustedAtHand),
      [1, null],
      'the short stack is out, on this hand, with its chips left where they are',
    );
    assert.ok(
      seated.every((seat) => !seat.inHand),
      'and no seat belongs to the hand any more',
    );

    assert.equal((await db.select().from(results)).length, 2);
    const counted = await countersOf(field);
    assert.deepEqual(counted, [
      { handsPlayed: 1, handsWon: 0, chipsWon: -MATCH.smallBlind },
      { handsPlayed: 1, handsWon: 1, chipsWon: MATCH.smallBlind },
    ]);

    const [stored] = await db.select().from(hands);
    assert.deepEqual(stored.deck, hand.deck, 'the deck is stored as dealt, which is what a replay deals from');
    assert.equal(stored.seed, null, 'and no seed, because nothing was dealt from one');

    const [row] = await db.select().from(matches).where(eq(matches.id, match.id));
    assert.equal(row.handsPlayed, 1);
  });

  test('a hand that cannot be recorded changes nothing at all', async () => {
    const field = [await candidate(SEAT_COST, 'A'), await candidate(SEAT_COST, 'B')];
    const match = (await createMatch(field))!;
    const hand = foldedHand(match.id, field, [MATCH.buyIn, MATCH.buyIn]);

    // An outcome for an agent that does not exist fails on its foreign key, by
    // which point the hand row and its decisions have already been written.
    const broken: PersistedHand = {
      ...hand,
      outcomes: [...hand.outcomes, { ...hand.outcomes[0], agentId: '00000000-0000-4000-8000-000000000000' }],
    };

    await assert.rejects(recordHand(broken));

    assert.equal((await db.select().from(hands)).length, 0);
    assert.equal((await db.select().from(decisions)).length, 0);
    assert.equal((await db.select().from(results)).length, 0);
    assert.deepEqual(
      (await seatsOf(match.id)).map((seat) => seat.stack),
      [MATCH.buyIn, MATCH.buyIn],
      'the stacks stand as they were',
    );
    assert.ok(
      (await countersOf(field)).every((row) => row.handsPlayed === 0),
      'and nobody is counted for a hand that is not on record',
    );
  });

  test('a hand recorded twice counts once', async () => {
    const field = [await candidate(SEAT_COST, 'A'), await candidate(SEAT_COST, 'B')];
    const match = (await createMatch(field))!;
    const hand = foldedHand(match.id, field, [MATCH.buyIn, MATCH.buyIn]);

    await recordHand(hand);
    await assert.rejects(recordHand(hand), 'a hand number is stored once per match');

    assert.deepEqual(
      (await countersOf(field)).map((row) => row.handsPlayed),
      [1, 1],
    );
    assert.equal((await db.select().from(results)).length, 2);
  });

  /* ------------------------------------------------------------------------ */
  /* Settling a match                                                         */
  /* ------------------------------------------------------------------------ */

  test('a match settled at the cap returns every stack, ranks on chips and rates everyone', async () => {
    const field = [await candidate(SEAT_COST, 'A'), await candidate(SEAT_COST, 'B'), await candidate(SEAT_COST, 'C')];
    const match = (await createMatch(field))!;

    // Chips moved between them during play. What is on the table has not changed.
    await setStacks(match.id, [{ stack: 3_000 }, { stack: 2_000 }, { stack: 1_000 }]);

    const { finishes } = await settleMatch(match.id, 'cap', 100);

    assert.deepEqual(
      field.map((entrant) => finishes.find((finish) => finish.agentId === entrant.agentId)?.place),
      [1, 2, 3],
    );
    assert.deepEqual(await Promise.all(field.map((entrant) => balance(entrant.ownerId))), [3_000, 2_000, 1_000]);
    for (const entrant of field) await ledgerAgrees(entrant.ownerId, SEAT_COST);

    const after = (await Promise.all(field.map((entrant) => balance(entrant.ownerId)))).reduce((a, b) => a + b, 0);
    assert.equal(after, SEAT_COST * field.length - ENTRY_FEE * field.length, 'the entry fees are the only chips that left');

    assert.equal((await seatsOf(match.id)).length, 0, 'the seats are gone once the chips are back');
    const [row] = await db.select().from(matches).where(eq(matches.id, match.id));
    assert.equal(row.status, 'cap');
    assert.equal(row.handsPlayed, 100);

    assert.equal((await db.select().from(matchResults).where(eq(matchResults.matchId, match.id))).length, 3);
    const rated = await ratingsOf(field.map((entrant) => entrant.agentId));
    assert.ok(rated[0].mu > DEFAULT_RATING.mu, 'the winner climbs');
    assert.ok(rated[2].mu < DEFAULT_RATING.mu, 'the last place falls');
    assert.ok(rated.every((rating) => rating.matchesPlayed === 1));
  });

  test('among the eliminated, going out later is the better finish', async () => {
    const field = [await candidate(SEAT_COST, 'A'), await candidate(SEAT_COST, 'B'), await candidate(SEAT_COST, 'C')];
    const match = (await createMatch(field))!;

    await setStacks(match.id, [{ stack: 6_000 }, { stack: 0, bustedAtHand: 40 }, { stack: 0, bustedAtHand: 12 }]);

    const { finishes } = await settleMatch(match.id, 'elimination', 41);

    assert.deepEqual(
      field.map((entrant) => finishes.find((finish) => finish.agentId === entrant.agentId)?.place),
      [1, 2, 3],
    );
    assert.equal(await balance(field[1].ownerId), 0, 'a stack of nothing returns nothing');
    await ledgerAgrees(field[1].ownerId, SEAT_COST);
  });

  test('an abandoned match gives the stacks back and rates nobody', async () => {
    const field = [await candidate(SEAT_COST, 'A'), await candidate(SEAT_COST, 'B')];
    const match = (await createMatch(field))!;
    await setStacks(match.id, [{ stack: 2_500 }, { stack: 1_500 }]);

    const settled = await settleMatch(match.id, 'abandoned', 7);

    assert.deepEqual(settled.finishes, []);
    assert.deepEqual(
      settled.entrants.map((entrant) => `${entrant.agentId} ${entrant.finalStack}`).sort(),
      [`${field[0].agentId} 2500`, `${field[1].agentId} 1500`].sort(),
      'but it still names everyone it seated, so each can be told the match ended',
    );
    assert.deepEqual(await Promise.all(field.map((entrant) => balance(entrant.ownerId))), [2_500, 1_500]);
    // Current policy, pinned so a change to it is a decision rather than an
    // accident: the stacks come back, the entry fee does not.
    const total = (await Promise.all(field.map((entrant) => balance(entrant.ownerId)))).reduce((a, b) => a + b, 0);
    assert.equal(total, SEAT_COST * 2 - ENTRY_FEE * 2);

    assert.equal((await db.select().from(matchResults)).length, 0);
    const rated = await ratingsOf(field.map((entrant) => entrant.agentId));
    assert.ok(rated.every((rating) => rating.mu === DEFAULT_RATING.mu && rating.matchesPlayed === 0));
  });

  /* ------------------------------------------------------------------------ */
  /* Deposits                                                                 */
  /* ------------------------------------------------------------------------ */

  test('a confirmed deposit is credited once, however often it is confirmed', async () => {
    const me = await owner(0);
    const quote = await startDeposit(me, 'starter', CHAIN);
    const observe = paid(quote.bytes32, me.address, BigInt(quote.valueWei));

    const result = credited(await confirmDeposit(me, TX, CHAIN, observe));
    assert.equal(result.chips, quote.chips);
    assert.equal(result.balance, quote.chips);

    await assert.rejects(confirmDeposit(me, TX, CHAIN, observe), /already been credited/);
    assert.equal(await balance(me.userId), quote.chips);
    await ledgerAgrees(me.userId, 0);

    const [intent] = await db.select().from(depositIntents).where(eq(depositIntents.id, quote.intentId));
    assert.equal(intent.status, 'credited');
    assert.equal(intent.txHash, TX);
  });

  test('two confirmations racing on one transaction credit it once', async () => {
    const me = await owner(0);
    const quote = await startDeposit(me, 'starter', CHAIN);
    const observe = paid(quote.bytes32, me.address, BigInt(quote.valueWei));

    const outcomes = await Promise.allSettled([
      confirmDeposit(me, TX, CHAIN, observe),
      confirmDeposit(me, TX, CHAIN, observe),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(await balance(me.userId), quote.chips);
    await ledgerAgrees(me.userId, 0);
  });

  test('a deposit not mined yet is pending, not refused', async () => {
    // The first ask after a wallet hands back a hash nearly always lands here,
    // and treating it as a failure used to end the cashier's wait on its first poll.
    const me = await owner(0);
    await startDeposit(me, 'starter', CHAIN);

    const result = await confirmDeposit(me, TX, CHAIN, async () => null);

    assert.deepEqual(result, { status: 'pending', confirmations: 0, required: 3 });
    assert.equal(await balance(me.userId), 0);
  });

  test('a deposit short of its confirmations credits nothing yet', async () => {
    const me = await owner(0);
    const quote = await startDeposit(me, 'starter', CHAIN);

    const result = await confirmDeposit(me, TX, CHAIN, paid(quote.bytes32, me.address, BigInt(quote.valueWei), 2n));

    assert.deepEqual(result, { status: 'pending', confirmations: 2, required: 3 });
    assert.equal(await balance(me.userId), 0);
  });

  test('a deposit paid from somebody else’s wallet is refused', async () => {
    const me = await owner(0);
    const quote = await startDeposit(me, 'starter', CHAIN);

    await assert.rejects(
      confirmDeposit(me, TX, CHAIN, paid(quote.bytes32, `0x${'9'.repeat(40)}`, BigInt(quote.valueWei))),
      /different wallet/,
    );
    assert.equal(await balance(me.userId), 0);
  });

  test('a deposit smaller than its package is refused', async () => {
    const me = await owner(0);
    const quote = await startDeposit(me, 'starter', CHAIN);

    await assert.rejects(
      confirmDeposit(me, TX, CHAIN, paid(quote.bytes32, me.address, BigInt(quote.valueWei) - 1n)),
      /smaller than the package/,
    );
    assert.equal(await balance(me.userId), 0);
  });

  test('a deposit is finished only on the chain its intent was priced on', async () => {
    const me = await owner(0);
    const quote = await startDeposit(me, 'starter', CHAIN);

    await assert.rejects(
      confirmDeposit(me, TX, 'arbitrum-sepolia', paid(quote.bytes32, me.address, BigInt(quote.valueWei))),
      /belongs to BNB Smart Chain Testnet/,
    );
    assert.equal(await balance(me.userId), 0);
  });

  test('anything paid above the package still buys chips at the peg', async () => {
    const me = await owner(0);
    const quote = await startDeposit(me, 'starter', CHAIN);

    const result = credited(
      await confirmDeposit(me, TX, CHAIN, paid(quote.bytes32, me.address, BigInt(quote.valueWei) + chipsToWei(500))),
    );

    assert.equal(result.chips, quote.chips + 500);
    await ledgerAgrees(me.userId, 0);
  });

  /* ------------------------------------------------------------------------ */
  /* Standings                                                                */
  /* ------------------------------------------------------------------------ */

  test('the standings are cut on the published rating, not on the estimate', async () => {
    // A lucky newcomer: a high estimate, and all the doubt one match leaves.
    await candidate(0, 'Lucky', { mu: 40, sigma: 8 });
    // An established agent with a lower estimate the arena is far surer of.
    await candidate(0, 'Proven', { mu: 30, sigma: 1 });

    const [top] = await leaderboard({ limit: 1 });

    assert.equal(top.name, 'Proven', 'published 27 outranks published 16, whatever mu says');
  });
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let wallets = 0;

/** An account holding some chips it was given directly, with no ledger row for them. */
async function owner(chips: number): Promise<Session> {
  wallets += 1;
  const address = `0x${wallets.toString(16).padStart(40, '0')}`;
  const [row] = await db.insert(users).values({ address, chips }).returning({ id: users.id });
  return { userId: row.id, address };
}

async function candidate(chips: number, name: string, rating: Rating = DEFAULT_RATING): Promise<Candidate> {
  const account = await owner(chips);
  const [row] = await db
    .insert(agents)
    .values({
      userId: account.userId,
      name,
      color: 'red',
      tokenHash: `test-${name}-${wallets}`,
      ratingMu: rating.mu,
      ratingSigma: rating.sigma,
    })
    .returning({ id: agents.id });

  return { agentId: row.id, name, ownerId: account.userId, rating, published: conservative(rating) };
}

async function balance(userId: string): Promise<number> {
  const [row] = await db.select({ chips: users.chips }).from(users).where(eq(users.id, userId));
  return row.chips;
}

/**
 * The balance is a cache of the ledger, so the two must agree.
 *
 * The opening balance is whatever the fixture wrote straight onto the account,
 * which is the one movement no ledger row describes.
 */
async function ledgerAgrees(userId: string, opening: number): Promise<void> {
  const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, userId)).orderBy(ledgerEntries.id);
  const now = await balance(userId);

  assert.equal(
    opening + rows.reduce((sum, row) => sum + row.delta, 0),
    now,
    'every chip that moved has a ledger row',
  );
  if (rows.length > 0) assert.equal(rows.at(-1)!.balanceAfter, now, 'and the last row states the balance it left');
}

async function seatsOf(matchId: string) {
  return db.select().from(seats).where(eq(seats.matchId, matchId)).orderBy(seats.seatIndex);
}

async function setStacks(
  matchId: string,
  stacks: Array<{ stack: number; bustedAtHand?: number }>,
): Promise<void> {
  for (const [seatIndex, entry] of stacks.entries()) {
    await db
      .update(seats)
      .set({ stack: entry.stack, bustedAtHand: entry.bustedAtHand ?? null })
      .where(and(eq(seats.matchId, matchId), eq(seats.seatIndex, seatIndex)));
  }
}

async function ratingsOf(agentIds: string[]): Promise<Array<{ mu: number; matchesPlayed: number }>> {
  const rows = await db
    .select({ id: agents.id, mu: agents.ratingMu, matchesPlayed: agents.matchesPlayed })
    .from(agents);
  return agentIds.map((id) => rows.find((row) => row.id === id)!);
}

/** The hand counters on each entrant's agent row, in field order. */
async function countersOf(
  field: Candidate[],
): Promise<Array<{ handsPlayed: number; handsWon: number; chipsWon: number }>> {
  const rows = await db
    .select({ id: agents.id, handsPlayed: agents.handsPlayed, handsWon: agents.handsWon, chipsWon: agents.chipsWon })
    .from(agents);
  return field.map((entrant) => {
    const { handsPlayed, handsWon, chipsWon } = rows.find((row) => row.id === entrant.agentId)!;
    return { handsPlayed, handsWon, chipsWon };
  });
}

/**
 * A finished heads-up hand, ready to record: seat 0 posts the small blind and
 * folds it to seat 1. `stacks` are what each seat sat down with.
 */
function foldedHand(matchId: string, field: Candidate[], stacks: [number, number]): PersistedHand {
  const deck = shuffledDeck();
  const state = applyAction(
    startHand({
      handId: 'h-1',
      seats: field.map((entrant, index) => ({ agentId: entrant.agentId, stack: stacks[index] })),
      button: 0,
      smallBlind: MATCH.smallBlind,
      bigBlind: MATCH.bigBlind,
      deck,
    }),
    { type: 'fold' },
  );

  const record: DecisionRecord = {
    action: { type: 'fold' },
    reasoning: '',
    say: null,
    equity: { equity: 0.3, win: 30, tie: 0, lose: 70, samples: 100 },
    read: { made: 'high card', category: 0, flushDraw: false, openEnded: false, gutshot: false, overcards: false },
    outcome: 'decided',
    elapsedMs: 5,
    source: 'agent',
    failure: null,
  };

  return {
    matchId,
    handNumber: 1,
    deck,
    state,
    startedAt: new Date(),
    bigBlind: MATCH.bigBlind,
    lineup: field.map((entrant, index) => ({
      seatIndex: index,
      chair: index,
      agentId: entrant.agentId,
      name: entrant.name,
      startingStack: stacks[index],
    })),
    decisions: [{ seatIndex: 0, agentId: field[0].agentId, record, street: 'preflop', amount: 0 }],
    outcomes: field.map((entrant, index) => {
      const net = state.seats[index].stack - stacks[index];
      return {
        agentId: entrant.agentId,
        won: net > 0,
        net,
        potSize: totalPot(state),
        startingStack: stacks[index],
        showdown: false,
        opponents: 1,
        opponentRating: 0,
      };
    }),
  };
}

/** The credited half of a confirmation, failing the test if it came back pending. */
function credited(result: DepositResult): { chips: number; balance: number } {
  if (result.status !== 'credited') assert.fail(`expected a credit, got ${result.status}`);
  return result;
}

/** A chain read that saw this deposit, in place of a node. */
function paid(
  intentId: `0x${string}`,
  payer: string,
  amountWei: bigint,
  confirmations = 3n,
): typeof observeDeposit {
  return async () => [
    {
      payer: payer as `0x${string}`,
      intentId,
      amountWei,
      blockNumber: 100n,
      confirmations,
    },
  ];
}
