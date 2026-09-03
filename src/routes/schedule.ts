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
import { formatSlot, getOperatingSlots, type OccupiedInterval } from '../core/schedule.js';
import { addDaysIst, formatIstTime, parseTimeToDate, todayIst } from '../core/time.js';

const schedule = new Hono();

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().int().min(1).max(30).optional().default(14),
  setupInstanceId: z.coerce.number().int().positive().optional(),
  view: z.enum(['upcoming', 'grid']).optional().default('upcoming')
});

async function loadOccupied(instanceIds: number[], rangeStart: Date, rangeEnd: Date): Promise<OccupiedInterval[]> {
  const [booked, tentative, locks] = await Promise.all([
    db.select({
      id: bookingTable.id,
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
      id: tentativeBookingTable.id,
      startTime: tentativeBookingTable.startTime,
      endTime: tentativeBookingTable.endTime,
      setupId: tentativeBookingTable.setupId
    }).from(tentativeBookingTable).where(and(
      inArray(tentativeBookingTable.setupId, instanceIds),
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
      setupInstanceId: b.setupId,
      status: 'BOOKED' as const,
      bookingId: b.id
    })),
    ...tentative.map((t) => ({
      startTime: t.startTime,
      endTime: t.endTime,
      setupInstanceId: t.setupId,
      status: 'TENTATIVE' as const,
      bookingId: t.id
    })),
    ...locks.map((l) => ({
      startTime: l.startTime,
      endTime: l.endTime,
      setupInstanceId: l.setupId,
      status: 'LOCKED' as const,
      lockedUntil: l.lockedUntil
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
      const filters = [
        eq(bookingTable.status, 'CONFIRMED'),
        gt(bookingTable.startTime, now),
        lt(bookingTable.startTime, windowEnd)
      ];
      if (parsed.data.setupInstanceId) {
        filters.push(eq(bookingTable.setupId, parsed.data.setupInstanceId));
      }

      const bookings = await db
        .select()
        .from(bookingTable)
        .where(and(...filters))
        .orderBy(asc(bookingTable.startTime));

      const setups = await db.select().from(setupsTable);
      const upcoming = bookings.map((b) => {
        const setup = setups.find((s) => s.id === b.setupId);
        return {
          bookingId: b.id,
          status: b.status,
          setupInstanceId: b.setupId,
          setupName: setup?.name ?? null,
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

    let setups = await db.select().from(setupsTable).where(eq(setupsTable.isActive, true));
    if (parsed.data.setupInstanceId) {
      setups = setups.filter((s) => s.id === parsed.data.setupInstanceId);
      if (setups.length === 0) {
        return c.json({ success: false, error: 'Setup instance not found' }, 404);
      }
    }

    const instanceIds = setups.map((s) => s.id);
    const occupied = instanceIds.length > 0
      ? await loadOccupied(instanceIds, rangeStart, rangeEnd)
      : [];
    const configs = await db.select().from(setupConfigurationsTable);
    const dateList = Array.from({ length: days }, (_, i) => addDaysIst(startDate, i));

    return c.json({
      success: true,
      view: 'grid',
      timezone: 'Asia/Kolkata',
      operatingHours: { start: '08:00 AM', end: '12:00 AM', slotMinutes: 60 },
      days: dateList.map((date) => ({
        date,
        setups: setups.map((setup) => {
          const config = configs.find((cfg) => cfg.id === setup.setupConfigurationId);
          const setupOccupied = occupied.filter((item) => item.setupInstanceId === setup.id);
          return {
            instanceId: setup.id,
            instanceName: setup.name,
            consoleType: config?.consoleType ?? null,
            slots: getOperatingSlots(date).map((slot) => formatSlot(slot.startTime, slot.endTime, setupOccupied, now))
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
