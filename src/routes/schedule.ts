import { Hono } from 'hono';
import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '../core/db/index.js';
import {
  bookingTable,
  setupConfigurationsTable,
  setupsTable,
  slotLocksTable,
  tentativeBookingTable
} from '../core/db/schema.js';
import { getOperatingSlots } from '../core/schedule.js';
import { addDaysIst, formatIstTime, parseTimeToDate, todayIst } from '../core/time.js';

const schedule = new Hono();

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().int().min(1).max(30).optional().default(14),
  setupConfigurationId: z.coerce.number().int().positive().optional(),
  view: z.enum(['upcoming', 'grid']).optional().default('upcoming')
});

interface ConfigurationInterval {
  startTime: Date;
  endTime: Date;
  setupConfigurationId: number;
  status: 'BOOKED' | 'TENTATIVE' | 'LOCKED';
}

async function loadOccupied(
  setups: Array<{ id: number; setupConfigurationId: number }>,
  rangeStart: Date,
  rangeEnd: Date
): Promise<ConfigurationInterval[]> {
  const instanceIds = setups.map((setup) => setup.id);
  const configurationIds = [...new Set(setups.map((setup) => setup.setupConfigurationId))];
  const [booked, tentative, locks] = await Promise.all([
    db.select({
      startTime: bookingTable.startTime,
      endTime: bookingTable.endTime,
      setupId: bookingTable.setupId
    }).from(bookingTable).where(and(
      inArray(bookingTable.setupId, instanceIds),
      lt(bookingTable.startTime, rangeEnd),
      gt(bookingTable.endTime, rangeStart),
      eq(bookingTable.status, 'CONFIRMED')
    )),
    db.select({
      startTime: tentativeBookingTable.startTime,
      endTime: tentativeBookingTable.endTime,
      setupConfigurationId: tentativeBookingTable.setupConfigurationId
    }).from(tentativeBookingTable).where(and(
      inArray(tentativeBookingTable.setupConfigurationId, configurationIds),
      lt(tentativeBookingTable.startTime, rangeEnd),
      gt(tentativeBookingTable.endTime, rangeStart)
    )),
    db.select({
      startTime: slotLocksTable.startTime,
      endTime: slotLocksTable.endTime,
      setupId: slotLocksTable.setupId,
      lockedUntil: slotLocksTable.lockedUntil
    }).from(slotLocksTable).where(and(
      inArray(slotLocksTable.setupId, instanceIds),
      lt(slotLocksTable.startTime, rangeEnd),
      gt(slotLocksTable.endTime, rangeStart),
      gt(slotLocksTable.lockedUntil, new Date())
    ))
  ]);

  return [
    ...booked.map((b) => ({
      startTime: b.startTime,
      endTime: b.endTime,
      setupConfigurationId: setups.find((setup) => setup.id === b.setupId)!.setupConfigurationId,
      status: 'BOOKED' as const
    })),
    ...tentative.map((booking) => ({
      startTime: booking.startTime,
      endTime: booking.endTime,
      setupConfigurationId: booking.setupConfigurationId,
      status: 'TENTATIVE' as const
    })),
    ...locks.map((l) => ({
      startTime: l.startTime,
      endTime: l.endTime,
      setupConfigurationId: setups.find((setup) => setup.id === l.setupId)!.setupConfigurationId,
      status: 'LOCKED' as const
    }))
  ];
}

schedule.get('/schedule', async (c) => {
  try {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid query', details: parsed.error.format() }, 400);
    }

    const now = new Date();
    const startDate = parsed.data.date ?? todayIst();
    const days = parsed.data.days;
    const windowEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    if (parsed.data.view === 'upcoming') {
      const setups = await db.select().from(setupsTable);
      const filters = [
        eq(bookingTable.status, 'CONFIRMED'),
        gt(bookingTable.startTime, now),
        lt(bookingTable.startTime, windowEnd)
      ];
      if (parsed.data.setupConfigurationId) {
        const instanceIds = setups
          .filter((setup) => setup.setupConfigurationId === parsed.data.setupConfigurationId)
          .map((setup) => setup.id);
        if (instanceIds.length === 0) {
          return c.json({ success: false, error: 'Setup configuration not found' }, 404);
        }
        filters.push(inArray(bookingTable.setupId, instanceIds));
      }

      const bookings = await db
        .select()
        .from(bookingTable)
        .where(and(...filters))
        .orderBy(asc(bookingTable.startTime));

      const configs = await db.select().from(setupConfigurationsTable);
      const upcoming = bookings.map((b) => {
        const setup = setups.find((s) => s.id === b.setupId);
        const config = configs.find((item) => item.id === setup?.setupConfigurationId);
        return {
          bookingId: b.id,
          status: b.status,
          setupConfigurationId: config?.id ?? null,
          setupName: config?.name ?? null,
          phoneNumber: b.phoneNumber,
          playersCount: b.count,
          date: b.startTime.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
          startTime: formatIstTime(b.startTime),
          endTime: formatIstTime(b.endTime),
          startTimeIso: b.startTime.toISOString(),
          endTimeIso: b.endTime.toISOString(),
          originalAmount: b.originalAmount,
          amountCharged: b.amountCharged
        };
      });

      return c.json({
        success: true,
        view: 'upcoming',
        timezone: 'Asia/Kolkata',
        from: now.toISOString(),
        days,
        count: upcoming.length,
        upcoming
      });
    }

    const rangeStart = parseTimeToDate(startDate, '12:00 AM');
    const endDate = addDaysIst(startDate, days - 1);
    const rangeEnd = new Date(parseTimeToDate(endDate, '11:59 PM').getTime() + 60 * 1000);

    let configs = await db
      .select()
      .from(setupConfigurationsTable)
      .where(eq(setupConfigurationsTable.isActive, true));
    if (parsed.data.setupConfigurationId) {
      configs = configs.filter((config) => config.id === parsed.data.setupConfigurationId);
      if (configs.length === 0) {
        return c.json({ success: false, error: 'Setup configuration not found' }, 404);
      }
    }

    const configurationIds = configs.map((config) => config.id);
    const setups = await db
      .select()
      .from(setupsTable)
      .where(
        and(
          inArray(setupsTable.setupConfigurationId, configurationIds),
          eq(setupsTable.isActive, true)
        )
      );
    const occupied = setups.length > 0
      ? await loadOccupied(setups, rangeStart, rangeEnd)
      : [];
    const dateList = Array.from({ length: days }, (_, i) => addDaysIst(startDate, i));

    return c.json({
      success: true,
      view: 'grid',
      timezone: 'Asia/Kolkata',
      operatingHours: { start: '08:00 AM', end: '12:00 AM', slotMinutes: 60 },
      days: dateList.map((date) => ({
        date,
        setupConfigurations: configs.map((config) => {
          const capacity = setups.filter(
            (setup) => setup.setupConfigurationId === config.id
          ).length;
          return {
            setupConfigurationId: config.id,
            name: config.name,
            consoleType: config.consoleType,
            capacity,
            slots: getOperatingSlots(date).map((slot) => {
              const hits = occupied.filter(
                (item) =>
                  item.setupConfigurationId === config.id &&
                  item.startTime < slot.endTime &&
                  item.endTime > slot.startTime
              );
              const availableInstances = Math.max(0, capacity - hits.length);
              const status = slot.endTime <= now
                ? 'PAST'
                : availableInstances > 0
                  ? 'AVAILABLE'
                  : hits.some((item) => item.status === 'BOOKED')
                    ? 'BOOKED'
                    : hits.some((item) => item.status === 'TENTATIVE')
                      ? 'TENTATIVE'
                      : 'LOCKED';
              return {
                startTime: formatIstTime(slot.startTime),
                endTime: formatIstTime(slot.endTime),
                startTimeIso: slot.startTime.toISOString(),
                endTimeIso: slot.endTime.toISOString(),
                status,
                availableInstances
              };
            })
          };
        })
      }))
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load schedule';
    console.error(error);
    return c.json({ success: false, error: message }, 500);
  }
});

export default schedule;
