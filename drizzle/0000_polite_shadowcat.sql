CREATE TYPE "public"."decision_outcome" AS ENUM('decided', 'timeout', 'error');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('pending', 'credited', 'expired', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."ledger_reason" AS ENUM('deposit', 'redemption', 'table-buy-in', 'table-cash-out', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."redemption_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"hands_played" integer DEFAULT 0 NOT NULL,
	"hands_won" integer DEFAULT 0 NOT NULL,
	"chips_won" bigint DEFAULT 0 NOT NULL,
	"biggest_pot" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"table_id" text NOT NULL,
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
CREATE TABLE "redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chips" integer NOT NULL,
	"gross_wei" text NOT NULL,
	"fee_wei" text NOT NULL,
	"net_wei" text NOT NULL,
	"status" "redemption_status" DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" text NOT NULL,
	"seat_index" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"stack" integer NOT NULL,
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
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_intents" ADD CONSTRAINT "deposit_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_user_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "decisions_hand_idx" ON "decisions" USING btree ("hand_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_intents_tx_idx" ON "deposit_intents" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "deposit_intents_status_idx" ON "deposit_intents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "hands_table_number_idx" ON "hands" USING btree ("table_id","hand_number");--> statement-breakpoint
CREATE INDEX "hands_ended_idx" ON "hands" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "ledger_user_idx" ON "ledger_entries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "redemptions_tx_idx" ON "redemptions" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "seats_table_seat_idx" ON "seats" USING btree ("table_id","seat_index");--> statement-breakpoint
CREATE UNIQUE INDEX "seats_agent_idx" ON "seats" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_address_idx" ON "users" USING btree ("address");