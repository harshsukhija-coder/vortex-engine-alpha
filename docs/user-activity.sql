-- Per-customer activity: sessions, time spent and games played.
--
-- * A customer is identified by phone number (customers.phone_number matches
--   booking_tables.phone_number).
-- * Only COMPLETED sessions with an actual end time are counted, so cancelled,
--   tentative and still-running sessions never inflate the numbers.
-- * Time is the real session length (actual_end_time - actual_start_time),
--   not the scheduled slot.
-- * Sessions and games are aggregated in separate CTEs on purpose: joining
--   them directly would repeat each session once per game and double-count
--   the minutes.
-- * Customers with no completed session are still listed, with zeros.
--
-- To get a single customer, add:  WHERE c.phone_number = '9876543210'

WITH session_stats AS (
  SELECT
    b.phone_number,
    COUNT(*) AS total_sessions,
    SUM(
      EXTRACT(EPOCH FROM (b.actual_end_time - COALESCE(b.actual_start_time, b.start_time))) / 60
    )::int AS total_minutes,
    MIN(COALESCE(b.actual_start_time, b.start_time)) AS first_visit,
    MAX(COALESCE(b.actual_start_time, b.start_time)) AS last_visit
  FROM booking_tables b
  WHERE b.status = 'COMPLETED'
    AND b.actual_end_time IS NOT NULL
  GROUP BY b.phone_number
),
game_stats AS (
  SELECT
    b.phone_number,
    COUNT(*)                AS games_played,      -- one per (session, game) pair
    COUNT(DISTINCT g.id)    AS distinct_games,
    STRING_AGG(DISTINCT g.name, ', ' ORDER BY g.name) AS games
  FROM booking_tables b
  JOIN booking_games bg ON bg.booking_id = b.id
  JOIN games g          ON g.id = bg.game_id
  WHERE b.status = 'COMPLETED'
    AND b.actual_end_time IS NOT NULL
  GROUP BY b.phone_number
)
SELECT
  c.name,
  c.phone_number,
  COALESCE(s.total_sessions, 0)                         AS total_sessions,
  COALESCE(s.total_minutes, 0)                          AS total_minutes,
  ROUND(COALESCE(s.total_minutes, 0) / 60.0, 2)         AS total_hours,
  COALESCE(s.total_minutes, 0) / 60 || 'h '
    || COALESCE(s.total_minutes, 0) % 60 || 'm'         AS time_spent,
  COALESCE(gs.games_played, 0)                          AS games_played,
  COALESCE(gs.distinct_games, 0)                        AS distinct_games,
  COALESCE(gs.games, '')                                AS games,
  s.first_visit,
  s.last_visit
FROM customers c
LEFT JOIN session_stats s ON s.phone_number = c.phone_number
LEFT JOIN game_stats gs   ON gs.phone_number = c.phone_number
ORDER BY total_minutes DESC, c.name;
