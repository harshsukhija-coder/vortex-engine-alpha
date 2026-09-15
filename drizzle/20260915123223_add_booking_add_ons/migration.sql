CREATE TABLE "add_ons" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "add_ons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"item_name" varchar(255) NOT NULL UNIQUE,
	"price" integer NOT NULL,
	"quantity" double precision NOT NULL,
	"quantity_unit" varchar(50) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "add_ons_price_nonnegative" CHECK ("price" >= 0),
	CONSTRAINT "add_ons_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "booking_add_ons" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "booking_add_ons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"booking_id" integer NOT NULL,
	"add_on_id" integer,
	"item_name" varchar(255) NOT NULL,
	"unit_price" integer NOT NULL,
	"item_quantity" double precision NOT NULL,
	"quantity_unit" varchar(50) NOT NULL,
	"units" integer NOT NULL,
	"line_total" integer NOT NULL,
	"added_by" integer,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_add_ons_units_positive" CHECK ("units" > 0),
	CONSTRAINT "booking_add_ons_line_total_nonnegative" CHECK ("line_total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tentative_booking_add_ons" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tentative_booking_add_ons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tentative_booking_id" integer NOT NULL,
	"add_on_id" integer,
	"item_name" varchar(255) NOT NULL,
	"unit_price" integer NOT NULL,
	"item_quantity" double precision NOT NULL,
	"quantity_unit" varchar(50) NOT NULL,
	"units" integer NOT NULL,
	"line_total" integer NOT NULL,
	"added_by" integer,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tentative_booking_add_ons_units_positive" CHECK ("units" > 0),
	CONSTRAINT "tentative_booking_add_ons_line_total_nonnegative" CHECK ("line_total" >= 0)
);
--> statement-breakpoint
CREATE INDEX "booking_add_ons_booking_id_idx" ON "booking_add_ons" ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_add_ons_add_on_id_idx" ON "booking_add_ons" ("add_on_id");--> statement-breakpoint
CREATE INDEX "tentative_booking_add_ons_tentative_booking_id_idx" ON "tentative_booking_add_ons" ("tentative_booking_id");--> statement-breakpoint
ALTER TABLE "booking_add_ons" ADD CONSTRAINT "booking_add_ons_booking_id_booking_tables_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking_tables"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "booking_add_ons" ADD CONSTRAINT "booking_add_ons_add_on_id_add_ons_id_fkey" FOREIGN KEY ("add_on_id") REFERENCES "add_ons"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "booking_add_ons" ADD CONSTRAINT "booking_add_ons_added_by_users_id_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tentative_booking_add_ons" ADD CONSTRAINT "tentative_booking_add_ons_mZxRugh9YISS_fkey" FOREIGN KEY ("tentative_booking_id") REFERENCES "tentative_bookings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tentative_booking_add_ons" ADD CONSTRAINT "tentative_booking_add_ons_add_on_id_add_ons_id_fkey" FOREIGN KEY ("add_on_id") REFERENCES "add_ons"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tentative_booking_add_ons" ADD CONSTRAINT "tentative_booking_add_ons_added_by_users_id_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL;