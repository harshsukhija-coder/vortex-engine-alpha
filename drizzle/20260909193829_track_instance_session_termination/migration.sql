ALTER TABLE "setups" ADD COLUMN "previous_session_terminated_successfully" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "setups" AS "setup"
SET "previous_session_terminated_successfully" = false
WHERE EXISTS (
  SELECT 1
  FROM "booking_tables" AS "booking"
  WHERE "booking"."setup_id" = "setup"."id"
    AND "booking"."status" = 'CONFIRMED'
    AND "booking"."actual_end_time" IS NULL
);