CREATE TABLE "chain_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deposit_intents" ADD COLUMN "start_block" bigint;