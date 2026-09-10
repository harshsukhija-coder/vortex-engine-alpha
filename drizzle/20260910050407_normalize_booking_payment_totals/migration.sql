UPDATE "booking_tables"
SET
  "status" = 'COMPLETED',
  "updated_at" = NOW()
WHERE "status" = 'CONFIRMED'
  AND "actual_end_time" IS NOT NULL;--> statement-breakpoint

WITH "payment_totals" AS (
  SELECT
    "id",
    COALESCE("amount_charged", 0) AS "final_amount",
    COALESCE("cash_amount", 0) AS "cash_paid",
    COALESCE("upi_amount", 0) AS "upi_paid",
    COALESCE("cash_amount", 0) + COALESCE("upi_amount", 0) AS "total_paid"
  FROM "booking_tables"
  WHERE "status" <> 'CANCELLED'
),
"normalized_payments" AS (
  SELECT
    "id",
    "final_amount",
    CASE
      WHEN "total_paid" = 0 THEN "final_amount"
      ELSE ROUND("final_amount" * "cash_paid"::numeric / "total_paid")::integer
    END AS "normalized_cash"
  FROM "payment_totals"
  WHERE "total_paid" <> "final_amount"
)
UPDATE "booking_tables" AS "booking"
SET
  "cash_amount" = "normalized"."normalized_cash",
  "upi_amount" = "normalized"."final_amount" - "normalized"."normalized_cash",
  "updated_at" = NOW()
FROM "normalized_payments" AS "normalized"
WHERE "booking"."id" = "normalized"."id";