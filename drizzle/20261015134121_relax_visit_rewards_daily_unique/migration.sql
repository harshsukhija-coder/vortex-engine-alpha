DROP INDEX "visit_rewards_phone_date_unique";--> statement-breakpoint
CREATE INDEX "visit_rewards_phone_date_idx" ON "visit_rewards" ("phone_number","date_of_visit");