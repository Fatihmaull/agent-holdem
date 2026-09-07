import { relations } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Chip amounts are integers everywhere. Wei amounts are stored as text because
 * they exceed what a double can hold exactly, and are read back as bigint.
 */

export const depositStatus = pgEnum('deposit_status', ['pending', 'credited', 'expired', 'rejected']);
export const redemptionStatus = pgEnum('redemption_status', ['pending', 'sent', 'failed']);
export const ledgerReason = pgEnum('ledger_reason', [
  'deposit',
  'redemption',
  'table-buy-in',
  'table-cash-out',
  'adjustment',
]);
export const decisionOutcome = pgEnum('decision_outcome', ['decided', 'timeout', 'error']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lowercase checksum-stripped address. One account per wallet. */
    address: text('address').notNull(),
    chips: integer('chips').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_address_idx').on(table.address)],
);

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Chip colour that identifies this agent at every table. */
    color: text('color').notNull(),
    /** Free-form strategy written by the owner. Treated as untrusted input. */
    instructions: text('instructions').notNull().default(''),
    handsPlayed: integer('hands_played').notNull().default(0),
    handsWon: integer('hands_won').notNull().default(0),
    /** Net chips won across every hand. Negative is a losing agent. */
    chipsWon: bigint('chips_won', { mode: 'number' }).notNull().default(0),
    biggestPot: integer('biggest_pot').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('agents_user_idx').on(table.userId)],
);

/** Chips the operator issued against a deposit that has not landed yet. */
export const depositIntents = pgTable(
  'deposit_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packageId: text('package_id').notNull(),
    chips: integer('chips').notNull(),
    expectedWei: text('expected_wei').notNull(),
    status: depositStatus('status').notNull().default('pending'),
    /** Set once the on-chain event has been read back and credited. */
    txHash: text('tx_hash'),
    blockNumber: bigint('block_number', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    creditedAt: timestamp('credited_at', { withTimezone: true }),
  },
  (table) => [
    // One credit per transaction, enforced by the database rather than by
    // whatever the indexer believes it has already seen.
    uniqueIndex('deposit_intents_tx_idx').on(table.txHash),
    index('deposit_intents_status_idx').on(table.status),
  ],
);

export const redemptions = pgTable(
  'redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chips: integer('chips').notNull(),
    grossWei: text('gross_wei').notNull(),
    feeWei: text('fee_wei').notNull(),
    netWei: text('net_wei').notNull(),
    status: redemptionStatus('status').notNull().default('pending'),
    txHash: text('tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('redemptions_tx_idx').on(table.txHash)],
);

/** Append-only record of every chip movement. The users.chips column is a cache of this. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: ledgerReason('reason').notNull(),
    reference: text('reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ledger_user_idx').on(table.userId, table.createdAt)],
);

/** An agent occupying a seat at one of the fixed tables. */
export const seats = pgTable(
  'seats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: text('table_id').notNull(),
    seatIndex: integer('seat_index').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    stack: integer('stack').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('seats_table_seat_idx').on(table.tableId, table.seatIndex),
    // An agent plays one table at a time, so its stack is never split.
    uniqueIndex('seats_agent_idx').on(table.agentId),
  ],
);

/** A completed hand, stored whole so it can be replayed exactly. */
export const hands = pgTable(
  'hands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: text('table_id').notNull(),
    handNumber: integer('hand_number').notNull(),
    seed: integer('seed').notNull(),
    button: integer('button').notNull(),
    /** Agent identities and starting stacks, as dealt. */
    lineup: jsonb('lineup').notNull(),
    board: jsonb('board').notNull(),
    pots: jsonb('pots').notNull(),
    events: jsonb('events').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('hands_table_number_idx').on(table.tableId, table.handNumber),
    index('hands_ended_idx').on(table.endedAt),
  ],
);

/**
 * One row per decision an agent made, including the ones it failed to make.
 * This is what the Brain Visualizer replays, so a timeout is recorded as a
 * timeout rather than dressed up as a fold.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    handId: uuid('hand_id')
      .notNull()
      .references(() => hands.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    seatIndex: integer('seat_index').notNull(),
    street: text('street').notNull(),
    /** Monte Carlo result at the moment of the decision. */
    equity: real('equity').notNull(),
    handRead: jsonb('hand_read').notNull(),
    reasoning: text('reasoning').notNull().default(''),
    /** Short line of table talk, if the agent offered one. */
    say: text('say'),
    action: text('action').notNull(),
    amount: integer('amount').notNull().default(0),
    elapsedMs: integer('elapsed_ms').notNull(),
    outcome: decisionOutcome('outcome').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('decisions_hand_idx').on(table.handId, table.id)],
);

export const usersRelations = relations(users, ({ one, many }) => ({
  agent: one(agents, { fields: [users.id], references: [agents.userId] }),
  ledger: many(ledgerEntries),
}));

export const agentsRelations = relations(agents, ({ one }) => ({
  owner: one(users, { fields: [agents.userId], references: [users.id] }),
  seat: one(seats, { fields: [agents.id], references: [seats.agentId] }),
}));

export const handsRelations = relations(hands, ({ many }) => ({
  decisions: many(decisions),
}));

export type User = typeof users.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Seat = typeof seats.$inferSelect;
export type Hand = typeof hands.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
