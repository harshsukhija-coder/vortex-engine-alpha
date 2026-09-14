import { and, asc, gte, lte } from 'drizzle-orm';
import { db } from './db/index.js';
import { dailyMeterReadingsTable } from './db/schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function daysBetween(from: string, to: string) {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime()
      - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS
  );
}

function datesBetween(from: string, to: string) {
  const dates: string[] = [];
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let timestamp = start; timestamp <= end; timestamp += DAY_MS) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
}

export class MeterAnalyticsError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 422
  ) {
    super(message);
  }
}

export async function getMeterConsumptionAnalytics(from: string, to: string) {
  const readings = await db
    .select({
      id: dailyMeterReadingsTable.id,
      readingDate: dailyMeterReadingsTable.readingDate,
      meterReading: dailyMeterReadingsTable.meterReading,
      imageFileName: dailyMeterReadingsTable.imageFileName,
      submittedBy: dailyMeterReadingsTable.submittedBy,
      updatedBy: dailyMeterReadingsTable.updatedBy,
      createdAt: dailyMeterReadingsTable.createdAt,
      updatedAt: dailyMeterReadingsTable.updatedAt
    })
    .from(dailyMeterReadingsTable)
    .where(
      and(
        gte(dailyMeterReadingsTable.readingDate, from),
        lte(dailyMeterReadingsTable.readingDate, to)
      )
    )
    .orderBy(asc(dailyMeterReadingsTable.readingDate));

  if (readings.length === 0) {
    throw new MeterAnalyticsError(
      `No meter readings found between ${from} and ${to}`,
      404
    );
  }

  const openingReading = readings.find((reading) => reading.readingDate === from);
  const closingReading = readings.find((reading) => reading.readingDate === to);
  if (!openingReading || !closingReading) {
    const missingBoundaries = [
      ...(!openingReading ? [from] : []),
      ...(!closingReading ? [to] : [])
    ];
    throw new MeterAnalyticsError(
      `Opening and closing readings are required. Missing: ${missingBoundaries.join(', ')}`,
      422
    );
  }

  const intervals = readings.slice(1).map((reading, index) => {
    const previous = readings[index];
    const calendarDays = daysBetween(previous.readingDate, reading.readingDate);
    const unitsConsumed = round(reading.meterReading - previous.meterReading);
    return {
      fromDate: previous.readingDate,
      toDate: reading.readingDate,
      openingReading: previous.meterReading,
      closingReading: reading.meterReading,
      calendarDays,
      unitsConsumed,
      averageUnitsPerDay: round(unitsConsumed / calendarDays),
      hasNegativeConsumption: unitsConsumed < 0
    };
  });

  const expectedDates = datesBetween(from, to);
  const recordedDates = new Set(readings.map((reading) => reading.readingDate));
  const missingReadingDates = expectedDates.filter((date) => !recordedDates.has(date));
  const totalCalendarDays = daysBetween(from, to);
  const totalUnitsConsumed = round(
    closingReading.meterReading - openingReading.meterReading
  );
  const intervalConsumptions = intervals.map((interval) => interval.unitsConsumed);
  const negativeIntervals = intervals.filter(
    (interval) => interval.hasNegativeConsumption
  );

  return {
    range: {
      from,
      to,
      timezone: 'Asia/Kolkata' as const,
      totalCalendarDays
    },
    summary: {
      openingReading: openingReading.meterReading,
      closingReading: closingReading.meterReading,
      totalUnitsConsumed,
      averageUnitsPerDay: totalCalendarDays > 0
        ? round(totalUnitsConsumed / totalCalendarDays)
        : 0,
      readingsRecorded: readings.length,
      expectedReadings: expectedDates.length,
      missingReadings: missingReadingDates.length,
      recordedIntervals: intervals.length,
      minimumIntervalConsumption: intervalConsumptions.length > 0
        ? Math.min(...intervalConsumptions)
        : 0,
      maximumIntervalConsumption: intervalConsumptions.length > 0
        ? Math.max(...intervalConsumptions)
        : 0,
      hasNegativeConsumption: negativeIntervals.length > 0
    },
    opening: {
      ...openingReading,
      imageUrl: `/api/meter-readings/${openingReading.id}/image`
    },
    closing: {
      ...closingReading,
      imageUrl: `/api/meter-readings/${closingReading.id}/image`
    },
    intervals,
    dataQuality: {
      isComplete: missingReadingDates.length === 0
        && negativeIntervals.length === 0,
      missingReadingDates,
      negativeIntervals,
      calculationMethod:
        'Units consumed equals closing meter reading minus opening meter reading.'
    }
  };
}
