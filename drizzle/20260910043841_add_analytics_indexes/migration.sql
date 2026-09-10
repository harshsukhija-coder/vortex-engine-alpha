CREATE INDEX "booking_games_game_id_idx" ON "booking_games" ("game_id");--> statement-breakpoint
CREATE INDEX "booking_tables_start_time_idx" ON "booking_tables" ("start_time");--> statement-breakpoint
CREATE INDEX "booking_tables_setup_start_time_idx" ON "booking_tables" ("setup_id","start_time");--> statement-breakpoint
CREATE INDEX "booking_tables_phone_start_time_idx" ON "booking_tables" ("phone_number","start_time");--> statement-breakpoint
CREATE INDEX "booking_tables_effective_start_active_idx"
ON "booking_tables" ((COALESCE("actual_start_time", "start_time")))
WHERE "status" <> 'CANCELLED';