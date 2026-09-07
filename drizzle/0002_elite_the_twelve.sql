DROP INDEX "agents_user_idx";--> statement-breakpoint
CREATE INDEX "agents_user_idx" ON "agents" USING btree ("user_id");