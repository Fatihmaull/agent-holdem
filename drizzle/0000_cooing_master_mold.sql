CREATE TYPE "public"."decision_outcome" AS ENUM('decided', 'timeout', 'error');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('pending', 'credited', 'expired', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."ledger_reason" AS ENUM('deposit', 'grant', 'match-buy-in', 'match-cash-out', 'entry-fee', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('waiting', 'playing', 'elimination', 'cap', 'abandoned');--> statement-breakpoint
CREATE TABLE "agent_note_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"author_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"text" text NOT NULL,
	"hand_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"text" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"script" text,
	"notes_enabled" boolean DEFAULT true NOT NULL,
	"seeking" boolean DEFAULT true NOT NULL,
	"registry_id" text,
	"registry_chain_id" integer,
	"rating_mu" real DEFAULT 25 NOT NULL,
	"rating_sigma" real DEFAULT 8.333333333333334 NOT NULL,
	"matches_played" integer DEFAULT 0 NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"hands_played" integer DEFAULT 0 NOT NULL,
	"hands_won" integer DEFAULT 0 NOT NULL,
	"chips_won" bigint DEFAULT 0 NOT NULL,
	"biggest_pot" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"registry_id" text NOT NULL,
	"matches" integer NOT NULL,
	"rating" integer NOT NULL,
	"rating_mu" real NOT NULL,
	"rating_sigma" real NOT NULL,
	"confidence" integer NOT NULL,
	"evidence_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"reputation_tx" text,
	"validation_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"hand_id" uuid NOT NULL,
	"agent_id" uuid,
	"seat_index" integer NOT NULL,
	"street" text NOT NULL,
	"equity" real NOT NULL,
	"hand_read" jsonb NOT NULL,
	"reasoning" text DEFAULT '' NOT NULL,
	"say" text,
	"action" text NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"outcome" "decision_outcome" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposit_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"package_id" text NOT NULL,
	"chips" integer NOT NULL,
	"expected_wei" text NOT NULL,
	"status" "deposit_status" DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"block_number" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"hand_number" integer NOT NULL,
	"seed" integer NOT NULL,
	"button" integer NOT NULL,
	"lineup" jsonb NOT NULL,
	"board" jsonb NOT NULL,
	"pots" jsonb NOT NULL,
	"events" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"place" integer NOT NULL,
	"final_stack" integer NOT NULL,
	"busted_at_hand" integer,
	"rating_mu_before" real NOT NULL,
	"rating_sigma_before" real NOT NULL,
	"rating_mu_after" real NOT NULL,
	"rating_sigma_after" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "match_status" DEFAULT 'waiting' NOT NULL,
	"seat_count" integer NOT NULL,
	"small_blind" integer NOT NULL,
	"big_blind" integer NOT NULL,
	"buy_in" integer NOT NULL,
	"entry_fee" integer NOT NULL,
	"hand_cap" integer NOT NULL,
	"hands_played" integer DEFAULT 0 NOT NULL,
	"band_rating" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"hand_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"big_blind" integer NOT NULL,
	"starting_stack" integer NOT NULL,
	"net" integer NOT NULL,
	"showdown" boolean DEFAULT false NOT NULL,
	"opponents" integer NOT NULL,
	"opponent_rating" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"seat_index" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"stack" integer NOT NULL,
	"busted_at_hand" integer,
	"in_hand" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"chips" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_note_revisions" ADD CONSTRAINT "agent_note_revisions_author_id_agents_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_note_revisions" ADD CONSTRAINT "agent_note_revisions_subject_id_agents_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_note_revisions" ADD CONSTRAINT "agent_note_revisions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_note_revisions" ADD CONSTRAINT "agent_note_revisions_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notes" ADD CONSTRAINT "agent_notes_author_id_agents_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notes" ADD CONSTRAINT "agent_notes_subject_id_agents_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notes" ADD CONSTRAINT "agent_notes_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_intents" ADD CONSTRAINT "deposit_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hands" ADD CONSTRAINT "hands_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_note_revisions_pair_idx" ON "agent_note_revisions" USING btree ("match_id","author_id","subject_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_notes_pair_idx" ON "agent_notes" USING btree ("match_id","author_id","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_user_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "attestations_agent_idx" ON "attestations" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "decisions_hand_idx" ON "decisions" USING btree ("hand_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_intents_tx_idx" ON "deposit_intents" USING btree ("chain_id","tx_hash");--> statement-breakpoint
CREATE INDEX "deposit_intents_status_idx" ON "deposit_intents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "hands_match_number_idx" ON "hands" USING btree ("match_id","hand_number");--> statement-breakpoint
CREATE INDEX "hands_ended_idx" ON "hands" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "ledger_user_idx" ON "ledger_entries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "match_results_agent_idx" ON "match_results" USING btree ("agent_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_results_match_agent_idx" ON "match_results" USING btree ("match_id","agent_id");--> statement-breakpoint
CREATE INDEX "matches_status_idx" ON "matches" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "results_agent_idx" ON "results" USING btree ("agent_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "results_hand_agent_idx" ON "results" USING btree ("hand_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seats_match_seat_idx" ON "seats" USING btree ("match_id","seat_index");--> statement-breakpoint
CREATE UNIQUE INDEX "seats_agent_idx" ON "seats" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_address_idx" ON "users" USING btree ("address");