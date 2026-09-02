CREATE TYPE "booking_status" AS ENUM('TENTATIVE', 'CONFIRMED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "cond" AS ENUM('=', '%', '>', '<', '<=', '>=');--> statement-breakpoint
CREATE TYPE "condObj" AS ENUM('amount', 'person', 'game', 'time');--> statement-breakpoint
CREATE TYPE "offerObj" AS ENUM('amount', 'person', 'time');--> statement-breakpoint
CREATE TYPE "offer_type" AS ENUM('EXCLUSIVE', 'INCLUSIVE');--> statement-breakpoint
CREATE TYPE "user_role" AS ENUM('MEMBER', 'ADMIN', 'SUPER_ADMIN');--> statement-breakpoint
CREATE TABLE "booking_games" (
	"booking_id" integer,
	"game_id" integer,
	CONSTRAINT "booking_games_pkey" PRIMARY KEY("booking_id","game_id")
);
--> statement-breakpoint
CREATE TABLE "booking_offers" (
	"booking_id" integer,
	"offer_id" integer,
	CONSTRAINT "booking_offers_pkey" PRIMARY KEY("booking_id","offer_id")
);
--> statement-breakpoint
CREATE TABLE "booking_slots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "booking_slots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"booking_id" integer NOT NULL,
	"start_time" timestamp(6) with time zone NOT NULL,
	"end_time" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_tables" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "booking_tables_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"phone_number" text NOT NULL,
	"setup_id" integer,
	"user_id" integer,
	"booked_by" integer,
	"original_amount" integer DEFAULT 0,
	"amount_charged" integer DEFAULT 0,
	"cash_amount" integer DEFAULT 0,
	"upi_amount" integer DEFAULT 0,
	"count" integer DEFAULT 1 NOT NULL,
	"status" "booking_status" DEFAULT 'CONFIRMED'::"booking_status" NOT NULL,
	"start_time" timestamp(6) with time zone NOT NULL,
	"end_time" timestamp(6) with time zone NOT NULL,
	"requested_start_time" timestamp(6) with time zone,
	"requested_no_of_hours" double precision,
	"setup_snapshot" jsonb,
	"actual_start_time" timestamp(6) with time zone,
	"actual_end_time" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"phone_number" varchar(20) NOT NULL UNIQUE,
	"name" varchar(255) NOT NULL,
	"date_of_birth" varchar(10),
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "games_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(255) NOT NULL UNIQUE,
	"price" integer DEFAULT 0,
	"images" text[] DEFAULT '{}'::text[] NOT NULL,
	"gameplays" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_details" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "offer_details_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"offer_id" integer NOT NULL,
	"cond_obj" "condObj",
	"cond" "cond",
	"cond_value" text,
	"offer_obj" "offerObj",
	"offer_value" text
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "offers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(255) NOT NULL UNIQUE,
	"fromTime" time,
	"toTime" time,
	"is_active" boolean DEFAULT false NOT NULL,
	"offer_type" "offer_type" DEFAULT 'EXCLUSIVE'::"offer_type"
);
--> statement-breakpoint
CREATE TABLE "setup_configurations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "setup_configurations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(255) NOT NULL UNIQUE,
	"description" text,
	"console_type" varchar(255) DEFAULT 'PS5' NOT NULL,
	"screen_type" varchar(255),
	"price" integer DEFAULT 0 NOT NULL,
	"single_player_price" integer,
	"multiplayer_price" integer DEFAULT 0,
	"extended_configurations" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_games" (
	"setup_configuration_id" integer,
	"game_id" integer,
	CONSTRAINT "setup_games_pkey" PRIMARY KEY("setup_configuration_id","game_id")
);
--> statement-breakpoint
CREATE TABLE "setups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "setups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"setup_configuration_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"images" text[] DEFAULT '{}'::text[] NOT NULL,
	"videos" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_locks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "slot_locks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"setup_id" integer NOT NULL,
	"user_id" integer,
	"lock_token" text,
	"slot_date" text NOT NULL,
	"start_time" timestamp(6) with time zone NOT NULL,
	"end_time" timestamp(6) with time zone NOT NULL,
	"locked_until" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tentative_bookings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tentative_bookings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"phone_number" text NOT NULL,
	"setup_id" integer,
	"user_id" integer,
	"booked_by" integer,
	"original_amount" integer DEFAULT 0,
	"amount_charged" integer DEFAULT 0,
	"count" integer DEFAULT 1 NOT NULL,
	"start_time" timestamp(6) with time zone NOT NULL,
	"end_time" timestamp(6) with time zone NOT NULL,
	"requested_start_time" timestamp(6) with time zone,
	"requested_no_of_hours" double precision,
	"setup_snapshot" jsonb,
	"game_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"applied_offer_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" varchar(255) NOT NULL UNIQUE,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'MEMBER'::"user_role" NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_games" ADD CONSTRAINT "booking_games_booking_id_booking_tables_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking_tables"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "booking_games" ADD CONSTRAINT "booking_games_game_id_games_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "booking_offers" ADD CONSTRAINT "booking_offers_booking_id_booking_tables_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking_tables"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "booking_offers" ADD CONSTRAINT "booking_offers_offer_id_offers_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "booking_slots" ADD CONSTRAINT "booking_slots_booking_id_booking_tables_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking_tables"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "booking_tables" ADD CONSTRAINT "booking_tables_setup_id_setups_id_fkey" FOREIGN KEY ("setup_id") REFERENCES "setups"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "booking_tables" ADD CONSTRAINT "booking_tables_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "booking_tables" ADD CONSTRAINT "booking_tables_booked_by_users_id_fkey" FOREIGN KEY ("booked_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "offer_details" ADD CONSTRAINT "offer_details_offer_id_offers_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "setup_games" ADD CONSTRAINT "setup_games_setup_configuration_id_setup_configurations_id_fkey" FOREIGN KEY ("setup_configuration_id") REFERENCES "setup_configurations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "setup_games" ADD CONSTRAINT "setup_games_game_id_games_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "setups" ADD CONSTRAINT "setups_setup_configuration_id_setup_configurations_id_fkey" FOREIGN KEY ("setup_configuration_id") REFERENCES "setup_configurations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "slot_locks" ADD CONSTRAINT "slot_locks_setup_id_setups_id_fkey" FOREIGN KEY ("setup_id") REFERENCES "setups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "slot_locks" ADD CONSTRAINT "slot_locks_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tentative_bookings" ADD CONSTRAINT "tentative_bookings_setup_id_setups_id_fkey" FOREIGN KEY ("setup_id") REFERENCES "setups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tentative_bookings" ADD CONSTRAINT "tentative_bookings_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tentative_bookings" ADD CONSTRAINT "tentative_bookings_booked_by_users_id_fkey" FOREIGN KEY ("booked_by") REFERENCES "users"("id") ON DELETE SET NULL;