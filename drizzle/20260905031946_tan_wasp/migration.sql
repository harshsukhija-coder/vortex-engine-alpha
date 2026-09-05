ALTER TABLE "tentative_bookings" DROP CONSTRAINT "tentative_bookings_setup_id_setups_id_fkey";--> statement-breakpoint
ALTER TABLE "tentative_bookings" ADD COLUMN "setup_configuration_id" integer;--> statement-breakpoint
UPDATE "tentative_bookings" AS "tentative"
SET "setup_configuration_id" = "setup"."setup_configuration_id"
FROM "setups" AS "setup"
WHERE "tentative"."setup_id" = "setup"."id";--> statement-breakpoint
ALTER TABLE "tentative_bookings" ALTER COLUMN "setup_configuration_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tentative_bookings" ADD CONSTRAINT "tentative_bookings_aSjiSpbcoBtQ_fkey" FOREIGN KEY ("setup_configuration_id") REFERENCES "setup_configurations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tentative_bookings" DROP COLUMN "setup_id";