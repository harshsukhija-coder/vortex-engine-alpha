import { Hono } from 'hono';
import { and, asc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '../core/db/index.js';
import {
  bookingAndGames,
  bookingSlotsTable,
  bookingTable,
  gamesTable,
  setupConfigurationsTable,
  setupsTable,
  slotLocksTable,
  tentativeBookingTable
} from '../core/db/schema.js';
import { getOperatingSlots } from '../core/schedule.js';
import { addDaysIst, formatIstTime, parseTimeToDate, todayIst } from '../core/time.js';
import { authMiddleware, requireRole } from '../middlewares/auth.js';

const schedule = new Hono();

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().int().min(1).max(30).optional().default(14),
  setupConfigurationId: z.coerce.number().int().positive().optional(),
  view: z.enum(['upcoming', 'grid']).optional().default('upcoming')
});

const updateUpcomingSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime: z.string().min(1).optional(),
  noOfHours: z.number().positive().max(12).optional(),
  playersCount: z.number().int().positive().max(20).optional(),
  phoneNumber: z.string().trim().min(8).max(20).optional(),
  setupInstanceId: z.number().int().positive().optional()
}).refine(
  (data) =>
    data.date !== undefined ||
    data.startTime !== undefined ||
    data.noOfHours !== undefined ||
    data.playersCount !== undefined ||
    data.phoneNumber !== undefined ||
    data.setupInstanceId !== undefined,
  { message: 'Provide at least one field to update' }
);

interface ConfigurationInterval {
  startTime: Date;
  endTime: Date;
  setupConfigurationId: number;
  status: 'BOOKED' | 'TENTATIVE' | 'LOCKED';
}

function parseBookingId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
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

async function toUpcomingItem(booking: typeof bookingTable.$inferSelect) {
  const [setup] = booking.setupId
    ? await db.select().from(setupsTable).where(eq(setupsTable.id, booking.setupId))
    : [];
  const [config] = setup
    ? await db
      .select()
      .from(setupConfigurationsTable)
      .where(eq(setupConfigurationsTable.id, setup.setupConfigurationId))
    : [];

  return {
    bookingId: booking.id,
    status: booking.status,
    setupInstanceId: booking.setupId,
    setupConfigurationId: config?.id ?? null,
    setupName: config?.name ?? null,
    instanceName: setup?.name ?? null,
    phoneNumber: booking.phoneNumber,
    playersCount: booking.count,
    date: booking.startTime.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
    startTime: formatIstTime(booking.startTime),
    endTime: formatIstTime(booking.endTime),
    startTimeIso: booking.startTime.toISOString(),
    endTimeIso: booking.endTime.toISOString(),
    noOfHours: booking.requestedNoOfHours
      ?? Math.round(
        (booking.endTime.getTime() - booking.startTime.getTime()) / 3_600_000
      ),
    originalAmount: booking.originalAmount,
    amountCharged: booking.amountCharged
  };
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
          setupInstanceId: b.setupId,
          setupConfigurationId: config?.id ?? null,
          setupName: config?.name ?? null,
          instanceName: setup?.name ?? null,
          phoneNumber: b.phoneNumber,
          playersCount: b.count,
          date: b.startTime.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
          startTime: formatIstTime(b.startTime),
          endTime: formatIstTime(b.endTime),
          startTimeIso: b.startTime.toISOString(),
          endTimeIso: b.endTime.toISOString(),
          noOfHours: b.requestedNoOfHours
            ?? Math.round((b.endTime.getTime() - b.startTime.getTime()) / 3_600_000),
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

// PATCH /api/schedule/upcoming/:bookingId - Reschedule / edit an upcoming confirmed booking
schedule.patch(
  '/schedule/upcoming/:bookingId',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const bookingId = parseBookingId(c.req.param('bookingId'));
      if (!bookingId) {
        return c.json({ success: false, error: 'Invalid booking ID' }, 400);
      }

      const parsed = updateUpcomingSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          { success: false, error: 'Validation failed', details: parsed.error.format() },
          400
        );
      }
      const data = parsed.data;
      const now = new Date();

      const updated = await db.transaction(async (tx) => {
        const [booking] = await tx
          .select()
          .from(bookingTable)
          .where(eq(bookingTable.id, bookingId));

        if (!booking) {
          throw Object.assign(new Error('Booking not found'), { status: 404 });
        }
        if (booking.status !== 'CONFIRMED') {
          throw Object.assign(
            new Error('Only confirmed upcoming bookings can be updated from schedule'),
            { status: 409 }
          );
        }
        if (booking.startTime <= now) {
          throw Object.assign(
            new Error('Past or in-progress sessions cannot be edited from upcoming schedule'),
            { status: 409 }
          );
        }
        if (!booking.setupId && data.setupInstanceId === undefined) {
          throw Object.assign(new Error('Booking has no setup instance assigned'), { status: 400 });
        }

        const setupInstanceId = data.setupInstanceId ?? booking.setupId!;
        const [setupInstance] = await tx
          .select()
          .from(setupsTable)
          .where(
            and(
              eq(setupsTable.id, setupInstanceId),
              eq(setupsTable.isActive, true)
            )
          );
        if (!setupInstance) {
          throw Object.assign(new Error('Setup instance not found or inactive'), { status: 404 });
        }

        const currentDate = booking.startTime.toLocaleDateString('en-CA', {
          timeZone: 'Asia/Kolkata'
        });
        const currentStartLabel = formatIstTime(booking.startTime);
        const currentHours = booking.requestedNoOfHours
          ?? Math.max(
            0.25,
            (booking.endTime.getTime() - booking.startTime.getTime()) / 3_600_000
          );

        const nextDate = data.date ?? currentDate;
        const nextStartLabel = data.startTime ?? currentStartLabel;
        const nextHours = data.noOfHours ?? currentHours;
        const nextPlayers = data.playersCount ?? booking.count;
        const nextPhone = data.phoneNumber ?? booking.phoneNumber;

        const nextStart = parseTimeToDate(nextDate, nextStartLabel);
        const nextEnd = new Date(nextStart.getTime() + nextHours * 3_600_000);
        if (nextStart <= now) {
          throw Object.assign(
            new Error('Updated start time must be in the future'),
            { status: 400 }
          );
        }

        await tx.execute(sql`select pg_advisory_xact_lock(${setupInstanceId})`);

        const [overlappingBooking] = await tx
          .select({ id: bookingTable.id })
          .from(bookingTable)
          .where(
            and(
              eq(bookingTable.setupId, setupInstanceId),
              lt(bookingTable.startTime, nextEnd),
              gt(bookingTable.endTime, nextStart),
              ne(bookingTable.status, 'CANCELLED'),
              ne(bookingTable.id, bookingId)
            )
          );
        if (overlappingBooking) {
          throw Object.assign(
            new Error(
              `Updated slot overlaps another booking (#${overlappingBooking.id}) on this setup`
            ),
            { status: 409 }
          );
        }

        const [overlappingLock] = await tx
          .select({ id: slotLocksTable.id })
          .from(slotLocksTable)
          .where(
            and(
              eq(slotLocksTable.setupId, setupInstanceId),
              lt(slotLocksTable.startTime, nextEnd),
              gt(slotLocksTable.endTime, nextStart),
              gt(slotLocksTable.lockedUntil, new Date())
            )
          );
        if (overlappingLock) {
          throw Object.assign(
            new Error('Updated slot overlaps an active temporary lock'),
            { status: 409 }
          );
        }

        const snapshot = (booking.setupSnapshot as Record<string, any> | null) ?? {};
        const [config] = await tx
          .select()
          .from(setupConfigurationsTable)
          .where(eq(setupConfigurationsTable.id, setupInstance.setupConfigurationId));

        const singleRate = Number(
          snapshot.singlePlayerPrice
          ?? config?.singlePlayerPrice
          ?? snapshot.price
          ?? config?.price
          ?? 150
        );
        const multiRate = Number(
          snapshot.multiplayerPrice
          ?? config?.multiplayerPrice
          ?? snapshot.price
          ?? config?.price
          ?? 120
        );
        const rate = nextPlayers === 1 ? singleRate : multiRate;

        const games = await tx
          .select({ price: gamesTable.price })
          .from(bookingAndGames)
          .innerJoin(gamesTable, eq(bookingAndGames.gameId, gamesTable.id))
          .where(eq(bookingAndGames.bookingId, bookingId));
        const gamesTotal = games.reduce(
          (sum, game) => sum + Math.max(0, Math.ceil(Number(game.price ?? 0) || 0)),
          0
        );

        const timingOrPlayersChanged =
          data.date !== undefined ||
          data.startTime !== undefined ||
          data.noOfHours !== undefined ||
          data.playersCount !== undefined ||
          data.setupInstanceId !== undefined;

        const setupPrice = Math.ceil(nextHours * rate * nextPlayers);
        const nextOriginalAmount = timingOrPlayersChanged
          ? setupPrice + gamesTotal
          : (booking.originalAmount ?? setupPrice + gamesTotal);
        // Preserve any existing discount delta when only rescheduling.
        const previousDiscount = Math.max(
          0,
          (booking.originalAmount ?? 0) - (booking.amountCharged ?? 0)
        );
        const nextAmountCharged = timingOrPlayersChanged
          ? Math.max(0, nextOriginalAmount - previousDiscount)
          : (booking.amountCharged ?? nextOriginalAmount);

        const nextSnapshot = {
          ...snapshot,
          setupId: setupInstance.id,
          instanceName: setupInstance.name,
          setupConfigurationId: setupInstance.setupConfigurationId,
          name: config?.name ?? snapshot.name,
          consoleType: config?.consoleType ?? snapshot.consoleType,
          price: config?.price ?? snapshot.price,
          singlePlayerPrice: config?.singlePlayerPrice ?? snapshot.singlePlayerPrice,
          multiplayerPrice: config?.multiplayerPrice ?? snapshot.multiplayerPrice,
          chargePerPersonPerHour: rate,
          snapshotAt: new Date().toISOString()
        };

        const [row] = await tx
          .update(bookingTable)
          .set({
            phoneNumber: nextPhone,
            setupId: setupInstanceId,
            count: nextPlayers,
            startTime: nextStart,
            endTime: nextEnd,
            requestedStartTime: nextStart,
            requestedNoOfHours: nextHours,
            actualStartTime: nextStart,
            originalAmount: nextOriginalAmount,
            amountCharged: nextAmountCharged,
            setupSnapshot: nextSnapshot,
            updatedAt: new Date()
          })
          .where(eq(bookingTable.id, bookingId))
          .returning();

        await tx
          .delete(bookingSlotsTable)
          .where(eq(bookingSlotsTable.bookingId, bookingId));

        const slotCount = Math.max(1, Math.ceil(nextHours));
        for (let i = 0; i < slotCount; i++) {
          const slotStart = new Date(nextStart.getTime() + i * 3_600_000);
          const slotEnd = new Date(
            Math.min(nextStart.getTime() + (i + 1) * 3_600_000, nextEnd.getTime())
          );
          await tx.insert(bookingSlotsTable).values({
            bookingId,
            startTime: slotStart,
            endTime: slotEnd
          });
        }

        return row;
      });

      return c.json({
        success: true,
        message: 'Upcoming booking updated',
        upcoming: await toUpcomingItem(updated)
      });
    } catch (error: unknown) {
      const status = typeof error === 'object' && error && 'status' in error
        ? Number((error as { status?: number }).status) || 500
        : 500;
      const message = error instanceof Error ? error.message : 'Failed to update upcoming booking';
      if (status >= 500) console.error(error);
      return c.json({ success: false, error: message }, status as 400 | 404 | 409 | 500);
    }
  }
);

// DELETE /api/schedule/upcoming/:bookingId - Cancel an upcoming confirmed booking
schedule.delete(
  '/schedule/upcoming/:bookingId',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const bookingId = parseBookingId(c.req.param('bookingId'));
      if (!bookingId) {
        return c.json({ success: false, error: 'Invalid booking ID' }, 400);
      }

      const now = new Date();
      const [booking] = await db
        .select()
        .from(bookingTable)
        .where(eq(bookingTable.id, bookingId));

      if (!booking) {
        return c.json({ success: false, error: 'Booking not found' }, 404);
      }
      if (booking.status !== 'CONFIRMED') {
        return c.json(
          { success: false, error: 'Only confirmed upcoming bookings can be deleted from schedule' },
          409
        );
      }
      if (booking.startTime <= now) {
        return c.json(
          {
            success: false,
            error: 'Past or in-progress sessions cannot be deleted from upcoming schedule'
          },
          409
        );
      }

      const [cancelled] = await db
        .update(bookingTable)
        .set({
          status: 'CANCELLED',
          updatedAt: new Date()
        })
        .where(eq(bookingTable.id, bookingId))
        .returning();

      return c.json({
        success: true,
        message: 'Upcoming booking cancelled',
        upcoming: await toUpcomingItem(cancelled)
      });
    } catch (error: unknown) {
      console.error(error);
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete upcoming booking'
        },
        500
      );
    }
  }
);

export default schedule;
