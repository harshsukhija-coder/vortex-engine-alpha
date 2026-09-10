import { pool } from './db/index.js';
import { addDaysIst, todayIst } from './time.js';

export interface AnalyticsRange {
  type: 'LAST_15_DAYS' | 'MONTH' | 'DATE';
  label: string;
  start: string;
  endExclusive: string;
  days: number;
  timezone: 'Asia/Kolkata';
}

interface AnalyticsQueryRow {
  overview: Record<string, unknown>;
  playerCountBreakdown: Array<Record<string, unknown>>;
  ageGroups: Array<Record<string, unknown>>;
  consoleInstances: Array<Record<string, unknown>>;
  games: Array<Record<string, unknown>>;
  topPlayers: Array<Record<string, unknown>>;
  dailyTrend: Array<Record<string, unknown>>;
  peakStartHours: Array<Record<string, unknown>>;
  configurationBreakdown: Array<Record<string, unknown>>;
  dataQuality: Record<string, unknown>;
}

export interface SessionAnalytics {
  generatedAt: string;
  range: AnalyticsRange;
  overview: Record<string, unknown>;
  playerCountBreakdown: Array<Record<string, unknown>>;
  ageGroups: Array<Record<string, unknown>>;
  consoleInstances: Array<Record<string, unknown>>;
  games: Array<Record<string, unknown>>;
  topPlayers: Array<Record<string, unknown>>;
  dailyTrend: Array<Record<string, unknown>>;
  peakStartHours: Array<Record<string, unknown>>;
  configurationBreakdown: Array<Record<string, unknown>>;
  dataQuality: Record<string, unknown>;
}

function monthEndExclusive(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const nextYear = monthNumber === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
}

export function resolveAnalyticsRange(options?: {
  month?: string;
  date?: string;
}): AnalyticsRange {
  const { month, date } = options ?? {};
  if (date) {
    const endDate = addDaysIst(date, 1);
    return {
      type: 'DATE',
      label: date,
      start: new Date(`${date}T00:00:00+05:30`).toISOString(),
      endExclusive: new Date(`${endDate}T00:00:00+05:30`).toISOString(),
      days: 1,
      timezone: 'Asia/Kolkata'
    };
  }

  if (month) {
    const startDate = `${month}-01`;
    const endDate = monthEndExclusive(month);
    const start = new Date(`${startDate}T00:00:00+05:30`);
    const end = new Date(`${endDate}T00:00:00+05:30`);

    return {
      type: 'MONTH',
      label: month,
      start: start.toISOString(),
      endExclusive: end.toISOString(),
      days: Math.round((end.getTime() - start.getTime()) / 86_400_000),
      timezone: 'Asia/Kolkata'
    };
  }

  const endDate = addDaysIst(todayIst(), 1);
  const startDate = addDaysIst(endDate, -15);
  return {
    type: 'LAST_15_DAYS',
    label: `${startDate} to ${addDaysIst(endDate, -1)}`,
    start: new Date(`${startDate}T00:00:00+05:30`).toISOString(),
    endExclusive: new Date(`${endDate}T00:00:00+05:30`).toISOString(),
    days: 15,
    timezone: 'Asia/Kolkata'
  };
}

const ANALYTICS_QUERY = `
WITH filtered_sessions AS MATERIALIZED (
  SELECT
    booking.*,
    COALESCE(booking.actual_start_time, booking.start_time) AS effective_start,
    COALESCE(booking.actual_end_time, booking.end_time) AS effective_end,
    GREATEST(
      0,
      EXTRACT(EPOCH FROM (
        COALESCE(booking.actual_end_time, booking.end_time)
        - COALESCE(booking.actual_start_time, booking.start_time)
      )) / 3600.0
    ) AS duration_hours
  FROM booking_tables AS booking
  WHERE booking.status <> 'CANCELLED'
    AND COALESCE(booking.actual_start_time, booking.start_time) >= $1
    AND COALESCE(booking.actual_start_time, booking.start_time) < $2
),
customer_sessions AS MATERIALIZED (
  SELECT
    session.*,
    customer.id AS customer_id,
    customer.name AS customer_name,
    customer.date_of_birth,
    CASE
      WHEN customer.date_of_birth ~ '^\\d{4}-\\d{2}-\\d{2}$'
      THEN EXTRACT(
        YEAR FROM age(
          (session.effective_start AT TIME ZONE 'Asia/Kolkata')::date,
          customer.date_of_birth::date
        )
      )::integer
      ELSE NULL
    END AS customer_age
  FROM filtered_sessions AS session
  LEFT JOIN customers AS customer
    ON customer.phone_number = session.phone_number
),
customer_game_counts AS MATERIALIZED (
  SELECT
    session.phone_number,
    game.id,
    game.name,
    COUNT(DISTINCT session.id)::integer AS sessions
  FROM filtered_sessions AS session
  JOIN booking_games AS booking_game ON booking_game.booking_id = session.id
  JOIN games AS game ON game.id = booking_game.game_id
  GROUP BY session.phone_number, game.id, game.name
),
top_players_base AS MATERIALIZED (
  SELECT
    session.phone_number,
    MAX(session.customer_name) AS name,
    MAX(session.date_of_birth) AS date_of_birth,
    MAX(session.customer_age) AS age,
    COUNT(*)::integer AS sessions_played,
    SUM(session.count)::integer AS party_players_brought,
    ROUND(SUM(session.duration_hours)::numeric, 2) AS total_hours,
    SUM(COALESCE(session.amount_charged, 0))::integer AS total_spent,
    MAX(session.effective_start) AS last_played_at
  FROM customer_sessions AS session
  GROUP BY session.phone_number
  ORDER BY sessions_played DESC, total_hours DESC, last_played_at DESC
  LIMIT 5
)
SELECT
  (
    SELECT jsonb_build_object(
      'totalSessions', COUNT(*)::integer,
      'completedSessions', COUNT(*) FILTER (WHERE status = 'COMPLETED')::integer,
      'confirmedSessions', COUNT(*) FILTER (WHERE status = 'CONFIRMED')::integer,
      'totalPlayerVisits', COALESCE(SUM(count), 0)::integer,
      'uniqueBookingCustomers', COUNT(DISTINCT phone_number)::integer,
      'totalOperatingHours', ROUND(COALESCE(SUM(duration_hours), 0)::numeric, 2),
      'averageSessionHours', ROUND(COALESCE(AVG(duration_hours), 0)::numeric, 2),
      'averagePlayersPerSession', ROUND(COALESCE(AVG(count), 0)::numeric, 2),
      'totalRevenue', COALESCE(SUM(amount_charged), 0)::integer,
      'cashCollected', COALESCE(SUM(cash_amount), 0)::integer,
      'upiCollected', COALESCE(SUM(upi_amount), 0)::integer,
      'totalCollected', COALESCE(SUM(COALESCE(cash_amount, 0) + COALESCE(upi_amount, 0)), 0)::integer,
      'refundDue', COALESCE(SUM(GREATEST(COALESCE(cash_amount, 0) + COALESCE(upi_amount, 0) - COALESCE(amount_charged, 0), 0)), 0)::integer,
      'paymentDue', COALESCE(SUM(GREATEST(COALESCE(amount_charged, 0) - COALESCE(cash_amount, 0) - COALESCE(upi_amount, 0), 0)), 0)::integer,
      'averageRevenuePerSession', ROUND(COALESCE(AVG(amount_charged), 0)::numeric, 2),
      'completionRatePercent', ROUND(
        CASE WHEN COUNT(*) = 0 THEN 0
        ELSE COUNT(*) FILTER (WHERE status = 'COMPLETED')::numeric * 100 / COUNT(*)
        END,
        2
      )
    )
    FROM filtered_sessions
  ) AS overview,
  (
    SELECT jsonb_build_array(
      jsonb_build_object(
        'playersCount', 1,
        'label', 'SINGLE',
        'sessions', COUNT(*) FILTER (WHERE count = 1)::integer,
        'playerVisits', COALESCE(SUM(count) FILTER (WHERE count = 1), 0)::integer
      ),
      jsonb_build_object(
        'playersCount', 2,
        'label', 'DOUBLE',
        'sessions', COUNT(*) FILTER (WHERE count = 2)::integer,
        'playerVisits', COALESCE(SUM(count) FILTER (WHERE count = 2), 0)::integer
      ),
      jsonb_build_object(
        'playersCount', 3,
        'label', 'TRIPLE',
        'sessions', COUNT(*) FILTER (WHERE count = 3)::integer,
        'playerVisits', COALESCE(SUM(count) FILTER (WHERE count = 3), 0)::integer
      ),
      jsonb_build_object(
        'playersCount', 4,
        'label', 'FOUR',
        'sessions', COUNT(*) FILTER (WHERE count = 4)::integer,
        'playerVisits', COALESCE(SUM(count) FILTER (WHERE count = 4), 0)::integer
      ),
      jsonb_build_object(
        'playersCount', 5,
        'label', 'FIVE_OR_MORE',
        'sessions', COUNT(*) FILTER (WHERE count >= 5)::integer,
        'playerVisits', COALESCE(SUM(count) FILTER (WHERE count >= 5), 0)::integer
      )
    )
    FROM filtered_sessions
  ) AS "playerCountBreakdown",
  (
    SELECT jsonb_build_array(
      jsonb_build_object('ageGroup', '0-10', 'playerVisits', COUNT(*) FILTER (WHERE customer_age >= 0 AND customer_age < 10)::integer),
      jsonb_build_object('ageGroup', '10-20', 'playerVisits', COUNT(*) FILTER (WHERE customer_age >= 10 AND customer_age < 20)::integer),
      jsonb_build_object('ageGroup', '20-30', 'playerVisits', COUNT(*) FILTER (WHERE customer_age >= 20 AND customer_age < 30)::integer),
      jsonb_build_object('ageGroup', '30-40', 'playerVisits', COUNT(*) FILTER (WHERE customer_age >= 30 AND customer_age < 40)::integer),
      jsonb_build_object('ageGroup', '40-50', 'playerVisits', COUNT(*) FILTER (WHERE customer_age >= 40 AND customer_age < 50)::integer),
      jsonb_build_object('ageGroup', '50-60', 'playerVisits', COUNT(*) FILTER (WHERE customer_age >= 50 AND customer_age < 60)::integer),
      jsonb_build_object('ageGroup', '60+', 'playerVisits', COUNT(*) FILTER (WHERE customer_age >= 60)::integer),
      jsonb_build_object('ageGroup', 'UNKNOWN_PRIMARY', 'playerVisits', COUNT(*) FILTER (WHERE customer_age IS NULL)::integer),
      jsonb_build_object('ageGroup', 'UNATTRIBUTED_ADDITIONAL', 'playerVisits', COALESCE(SUM(GREATEST(count - 1, 0)), 0)::integer)
    )
    FROM customer_sessions
  ) AS "ageGroups",
  COALESCE((
    SELECT jsonb_agg(instance_stats ORDER BY (instance_stats->>'totalOperatingHours')::numeric DESC)
    FROM (
      SELECT jsonb_build_object(
        'setupInstanceId', setup.id,
        'instanceName', setup.name,
        'setupConfigurationId', configuration.id,
        'configurationName', configuration.name,
        'consoleType', configuration.console_type,
        'sessions', COUNT(session.id)::integer,
        'completedSessions', COUNT(session.id) FILTER (WHERE session.status = 'COMPLETED')::integer,
        'playerVisits', COALESCE(SUM(session.count), 0)::integer,
        'totalOperatingHours', ROUND(COALESCE(SUM(session.duration_hours), 0)::numeric, 2),
        'revenue', COALESCE(SUM(session.amount_charged), 0)::integer,
        'utilizationPercent', ROUND(
          COALESCE(SUM(session.duration_hours), 0)::numeric * 100 / NULLIF($3 * 16, 0),
          2
        )
      ) AS instance_stats
      FROM setups AS setup
      JOIN setup_configurations AS configuration ON configuration.id = setup.setup_configuration_id
      LEFT JOIN filtered_sessions AS session ON session.setup_id = setup.id
      GROUP BY setup.id, setup.name, configuration.id, configuration.name, configuration.console_type
    ) AS instance_rows
  ), '[]'::jsonb) AS "consoleInstances",
  COALESCE((
    SELECT jsonb_agg(game_stats ORDER BY (game_stats->>'sessionsPlayed')::integer DESC, game_stats->>'name')
    FROM (
      SELECT jsonb_build_object(
        'gameId', game.id,
        'name', game.name,
        'sessionsPlayed', COUNT(DISTINCT session.id)::integer,
        'playerExposures', COALESCE(SUM(session.count), 0)::integer,
        'sessionHours', ROUND(COALESCE(SUM(session.duration_hours), 0)::numeric, 2),
        'lastPlayedAt', MAX(session.effective_start)
      ) AS game_stats
      FROM booking_games AS booking_game
      JOIN filtered_sessions AS session ON session.id = booking_game.booking_id
      JOIN games AS game ON game.id = booking_game.game_id
      GROUP BY game.id, game.name
    ) AS game_rows
  ), '[]'::jsonb) AS games,
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'phoneNumber', player.phone_number,
        'name', player.name,
        'dateOfBirth', player.date_of_birth,
        'age', player.age,
        'sessionsPlayed', player.sessions_played,
        'partyPlayersBrought', player.party_players_brought,
        'totalHours', player.total_hours,
        'totalSpent', player.total_spent,
        'lastPlayedAt', player.last_played_at,
        'favoriteGame', (
          SELECT jsonb_build_object(
            'gameId', game_count.id,
            'name', game_count.name,
            'sessionsPlayed', game_count.sessions
          )
          FROM customer_game_counts AS game_count
          WHERE game_count.phone_number = player.phone_number
          ORDER BY game_count.sessions DESC, game_count.name
          LIMIT 1
        )
      )
      ORDER BY player.sessions_played DESC, player.total_hours DESC
    )
    FROM top_players_base AS player
  ), '[]'::jsonb) AS "topPlayers",
  COALESCE((
    SELECT jsonb_agg(daily_stats ORDER BY daily_stats->>'date')
    FROM (
      SELECT jsonb_build_object(
        'date', to_char(
          (effective_start AT TIME ZONE 'Asia/Kolkata')::date,
          'YYYY-MM-DD'
        ),
        'sessions', COUNT(*)::integer,
        'playerVisits', SUM(count)::integer,
        'operatingHours', ROUND(SUM(duration_hours)::numeric, 2),
        'revenue', SUM(amount_charged)::integer
      ) AS daily_stats
      FROM filtered_sessions
      GROUP BY (effective_start AT TIME ZONE 'Asia/Kolkata')::date
    ) AS daily_rows
  ), '[]'::jsonb) AS "dailyTrend",
  COALESCE((
    SELECT jsonb_agg(hour_stats ORDER BY (hour_stats->>'sessions')::integer DESC)
    FROM (
      SELECT jsonb_build_object(
        'hour', EXTRACT(HOUR FROM effective_start AT TIME ZONE 'Asia/Kolkata')::integer,
        'label', to_char(
          MIN(effective_start AT TIME ZONE 'Asia/Kolkata'),
          'HH12:00 AM'
        ),
        'sessions', COUNT(*)::integer,
        'playerVisits', SUM(count)::integer
      ) AS hour_stats
      FROM filtered_sessions
      GROUP BY EXTRACT(HOUR FROM effective_start AT TIME ZONE 'Asia/Kolkata')
      ORDER BY COUNT(*) DESC
      LIMIT 5
    ) AS hour_rows
  ), '[]'::jsonb) AS "peakStartHours",
  COALESCE((
    SELECT jsonb_agg(configuration_stats ORDER BY (configuration_stats->>'revenue')::integer DESC)
    FROM (
      SELECT jsonb_build_object(
        'setupConfigurationId', configuration.id,
        'name', configuration.name,
        'consoleType', configuration.console_type,
        'sessions', COUNT(session.id)::integer,
        'playerVisits', COALESCE(SUM(session.count), 0)::integer,
        'operatingHours', ROUND(COALESCE(SUM(session.duration_hours), 0)::numeric, 2),
        'revenue', COALESCE(SUM(session.amount_charged), 0)::integer
      ) AS configuration_stats
      FROM setup_configurations AS configuration
      LEFT JOIN setups AS setup ON setup.setup_configuration_id = configuration.id
      LEFT JOIN filtered_sessions AS session ON session.setup_id = setup.id
      GROUP BY configuration.id, configuration.name, configuration.console_type
    ) AS configuration_rows
  ), '[]'::jsonb) AS "configurationBreakdown",
  (
    SELECT jsonb_build_object(
      'totalPlayerVisits', COALESCE(SUM(count), 0)::integer,
      'identifiedPrimaryPlayerVisits', COUNT(*) FILTER (WHERE customer_id IS NOT NULL)::integer,
      'ageKnownPrimaryPlayerVisits', COUNT(*) FILTER (WHERE customer_age IS NOT NULL)::integer,
      'unattributedAdditionalPlayerVisits', COALESCE(SUM(GREATEST(count - 1, 0)), 0)::integer,
      'ageGroupMethod', 'Age groups count identifiable primary booking customers only. Additional players are not linked to bookings in the current schema.',
      'revenueMethod', 'Revenue uses the full final booking amount for sessions whose effective start is inside the selected range.',
      'durationMethod', 'Duration uses actual session timestamps when present, otherwise scheduled timestamps.'
    )
    FROM customer_sessions
  ) AS "dataQuality"
`;

export async function getSessionAnalytics(
  range: AnalyticsRange
): Promise<SessionAnalytics> {
  const { rows } = await pool.query<AnalyticsQueryRow>(ANALYTICS_QUERY, [
    range.start,
    range.endExclusive,
    range.days
  ]);
  const result = rows[0];

  return {
    generatedAt: new Date().toISOString(),
    range,
    overview: result.overview,
    playerCountBreakdown: result.playerCountBreakdown,
    ageGroups: result.ageGroups,
    consoleInstances: result.consoleInstances,
    games: result.games,
    topPlayers: result.topPlayers,
    dailyTrend: result.dailyTrend,
    peakStartHours: result.peakStartHours,
    configurationBreakdown: result.configurationBreakdown,
    dataQuality: result.dataQuality
  };
}
