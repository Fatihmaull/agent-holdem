ALTER TABLE "hands" ALTER COLUMN "seed" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hands" ADD COLUMN "deck" jsonb;--> statement-breakpoint
CREATE INDEX "decisions_agent_idx" ON "decisions" USING btree ("agent_id","street");