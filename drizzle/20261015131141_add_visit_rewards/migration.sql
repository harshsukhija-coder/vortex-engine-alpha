CREATE TABLE "visit_reward_codes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "visit_reward_codes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"phone_number" varchar(20) NOT NULL,
	"code" varchar(32) NOT NULL UNIQUE,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"redeemed_at" timestamp(6) with time zone,
	"redeemed_by" integer,
	"redeemed_booking_id" integer,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_rewards" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "visit_rewards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"phone_number" varchar(20) NOT NULL,
	"name" varchar(255) NOT NULL,
	"date_of_visit" date NOT NULL,
	"is_used" boolean DEFAULT false NOT NULL,
	"is_approved" boolean DEFAULT false NOT NULL,
	"approved_by" integer,
	"approved_at" timestamp(6) with time zone,
	"reward_code_id" integer,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "visit_reward_codes_phone_idx" ON "visit_reward_codes" ("phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_rewards_phone_date_unique" ON "visit_rewards" ("phone_number","date_of_visit");--> statement-breakpoint
CREATE INDEX "visit_rewards_eligibility_idx" ON "visit_rewards" ("phone_number","is_approved","is_used","date_of_visit");--> statement-breakpoint
ALTER TABLE "visit_reward_codes" ADD CONSTRAINT "visit_reward_codes_redeemed_by_users_id_fkey" FOREIGN KEY ("redeemed_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "visit_reward_codes" ADD CONSTRAINT "visit_reward_codes_redeemed_booking_id_booking_tables_id_fkey" FOREIGN KEY ("redeemed_booking_id") REFERENCES "booking_tables"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "visit_rewards" ADD CONSTRAINT "visit_rewards_approved_by_users_id_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "visit_rewards" ADD CONSTRAINT "visit_rewards_reward_code_id_visit_reward_codes_id_fkey" FOREIGN KEY ("reward_code_id") REFERENCES "visit_reward_codes"("id") ON DELETE SET NULL;