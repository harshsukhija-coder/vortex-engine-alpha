CREATE TABLE "daily_meter_readings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "daily_meter_readings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"reading_date" varchar(10) NOT NULL UNIQUE,
	"meter_reading" double precision NOT NULL,
	"image_data" bytea NOT NULL,
	"image_mime_type" varchar(100) NOT NULL,
	"image_file_name" varchar(255) NOT NULL,
	"image_size" integer NOT NULL,
	"submitted_by" integer,
	"updated_by" integer,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "daily_meter_readings_submitted_by_idx" ON "daily_meter_readings" ("submitted_by");--> statement-breakpoint
ALTER TABLE "daily_meter_readings" ADD CONSTRAINT "daily_meter_readings_submitted_by_users_id_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "daily_meter_readings" ADD CONSTRAINT "daily_meter_readings_updated_by_users_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL;