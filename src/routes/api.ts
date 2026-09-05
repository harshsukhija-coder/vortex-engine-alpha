import { Hono } from 'hono';
import { db } from '../core/db/index.js';
import {
  gamesTable,
  setupsTable,
  setupConfigurationsTable,
  setupGamesTable,
  offerTable,
  bookingTable,
  bookingAndGames,
  bookingAndOffersTable,
  slotLocksTable,
  bookingSlotsTable,
  tentativeBookingTable,
  customersTable,
  usersTable
} from '../core/db/schema.js';
import { eq, and, gte, lte, lt, gt, or, ilike, ne, inArray, desc, isNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import { authMiddleware, requireRole } from '../middlewares/auth.js';
import { verify } from 'hono/jwt';
import env from '../core/env.js';
import { calculatePriceForRule } from '../core/pricing.js';

const api = new Hono();

class BookingConflictError extends Error {}

const HARDCODED_OFFERS = [
  {
    id: 1,
    code: "PLAY_2_GET_1_FREE",
    name: "PLAY 2, GET 1 FREE",
    description: "Bring 2 players and the 3rd player joins FREE on the same PS5.",
    offerType: "EXCLUSIVE" as const
  },
  {
    id: 2,
    code: "HAPPY_HOURS_MON_THU",
    name: "HAPPY HOURS — MON–THU | 11 AM–5 PM",
    description: "Rs 60 per hour multiplayer; Rs 70 per hour single player",
    offerType: "EXCLUSIVE" as const
  }
] as const;

interface BookingInterval {
  startTime: Date;
  endTime: Date;
}

function hasConfigurationCapacity(
  intervals: BookingInterval[],
  requestedStart: Date,
  requestedEnd: Date,
  capacity: number
) {
  const events = [
    ...intervals.flatMap((interval) => [
      { at: Math.max(interval.startTime.getTime(), requestedStart.getTime()), delta: 1 },
      { at: Math.min(interval.endTime.getTime(), requestedEnd.getTime()), delta: -1 }
    ]),
    { at: requestedStart.getTime(), delta: 1 },
    { at: requestedEnd.getTime(), delta: -1 }
  ].sort((a, b) => a.at - b.at || a.delta - b.delta);

  let concurrent = 0;
  for (const event of events) {
    concurrent += event.delta;
    if (concurrent > capacity) return false;
  }
  return true;
}

// Helper function to parse Date and Time String in Asia/Kolkata timezone to a UTC Date object
function parseTimeToDate(dateStr: string, timeStr: string): Date {
  let hour = 0;
  let minute = 0;
  
  const cleanTime = timeStr.trim().toUpperCase();
  const ampmMatch = cleanTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (ampmMatch) {
    hour = parseInt(ampmMatch[1], 10);
    minute = parseInt(ampmMatch[2], 10);
    const ampm = ampmMatch[3];
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
  } else {
    const simpleMatch = cleanTime.match(/^(\d{1,2}):(\d{2})$/);
    if (simpleMatch) {
      hour = parseInt(simpleMatch[1], 10);
      minute = parseInt(simpleMatch[2], 10);
    }
  }
  
  const [year, month, day] = dateStr.split('-').map(Number);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const kolkataStr = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
  return new Date(`${kolkataStr}+05:30`);
}

// Validation Schema for Booking creation (accepts full nested frontend payload or flat payload)
const bookingSchema = z.object({
  setupConfigurationId: z.number().int().positive("Invalid setup configuration ID").optional(),
  setupInstanceId: z.number().int().positive("Invalid setup instance ID").optional(),
  setupId: z.number().int().positive().optional(),
  setupName: z.string().optional(),
  consoleType: z.string().optional(),
  customer: z.object({
    name: z.string().optional(),
    phoneNumber: z.string().optional(),
    dateOfBirth: z.string().optional()
  }).optional(),
  additionalMembers: z.array(z.object({
    name: z.string().optional(),
    phone: z.string().optional(),
    dateOfBirth: z.string().optional()
  })).optional(),
  bookingDetails: z.object({
    playersCount: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
    date: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    noOfHours: z.number().positive().optional(),
    gameIds: z.array(z.number().int().positive()).optional(),
    games: z.array(z.object({ id: z.number().int().positive(), name: z.string().optional() })).optional()
  }).optional(),
  pricing: z.object({
    basePrice: z.number().optional(),
    ratePerPersonPerHour: z.number().optional(),
    playerType: z.string().optional(),
    calculationFormula: z.string().optional()
  }).optional(),
  offers: z.object({
    appliedOfferIds: z.array(z.number().int()).optional(),
    appliedOffers: z.array(z.object({
      id: z.number().optional(),
      code: z.string().optional(),
      name: z.string().optional(),
      discount: z.number().optional(),
      reason: z.string().optional()
    })).optional(),
    originalAmount: z.number().optional(),
    discountApplied: z.number().optional(),
    totalAmount: z.number().optional()
  }).optional(),
  // Flat fields for backwards compatibility
  phoneNumber: z.string().optional(),
  userId: z.number().int().positive().optional(),
  lockToken: z.string().optional(),
  count: z.number().int().positive().optional(),
  date: z.string().optional(),
  startTime: z.string().optional(),
  noOfHours: z.number().positive().optional(),
  gameIds: z.array(z.number().int().positive()).optional(),
  appliedOfferIds: z.array(z.number().int().positive()).optional(),
  cashAmount: z.number().nonnegative().optional(),
  upiAmount: z.number().nonnegative().optional()
});

// 1. GET /api/games - List active games, optionally filtered by setup configuration
api.get('/games', async (c) => {
  try {
    const query = c.req.query('q');
    const setupIdParam = c.req.query('setupConfigurationId') || c.req.query('setupId');

    let configId: number | null = null;
    if (setupIdParam) {
      const parsedId = parseInt(setupIdParam, 10);
      if (!isNaN(parsedId)) {
        configId = parsedId;
      }
    }

    if (configId) {
      const setupGames = await db
        .select({
          id: gamesTable.id,
          name: gamesTable.name,
          price: gamesTable.price,
          images: gamesTable.images,
          gameplays: gamesTable.gameplays,
          isActive: gamesTable.isActive,
          createdAt: gamesTable.createdAt,
          updatedAt: gamesTable.updatedAt
        })
        .from(setupGamesTable)
        .innerJoin(gamesTable, eq(setupGamesTable.gameId, gamesTable.id))
        .where(
          and(
            eq(setupGamesTable.setupConfigurationId, configId),
            eq(gamesTable.isActive, true),
            query ? ilike(gamesTable.name, `%${query}%`) : undefined
          )
        );

      return c.json({ success: true, count: setupGames.length, games: setupGames });
    }

    const conditions = [eq(gamesTable.isActive, true)];
    if (query) {
      conditions.push(ilike(gamesTable.name, `%${query}%`));
    }

    const games = await db
      .select()
      .from(gamesTable)
      .where(and(...conditions));

    return c.json({ success: true, count: games.length, games });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 2. GET /api/setups - List customer-selectable setup configurations
api.get('/setups', async (c) => {
  try {
    const configs = await db
      .select()
      .from(setupConfigurationsTable)
      .where(eq(setupConfigurationsTable.isActive, true));

    const setupGames = await db
      .select({
        setupConfigurationId: setupGamesTable.setupConfigurationId,
        game: {
          id: gamesTable.id,
          name: gamesTable.name,
          price: gamesTable.price,
          images: gamesTable.images,
          isActive: gamesTable.isActive
        }
      })
      .from(setupGamesTable)
      .innerJoin(gamesTable, eq(setupGamesTable.gameId, gamesTable.id))
      .where(eq(gamesTable.isActive, true));

    const result = configs.map((config) => {
      const gamesForConfig = setupGames
        .filter((sg) => sg.setupConfigurationId === config.id)
        .map((sg) => sg.game);

      return {
        setupConfigurationId: config.id,
        name: config.name,
        description: config.description,
        consoleType: config.consoleType,
        screenType: config.screenType,
        price: config.price,
        basePrice: config.price,
        singlePlayerPrice: config.singlePlayerPrice ?? config.price,
        multiplayerPrice: config.multiplayerPrice ?? config.price,
        pricingUnit: 'PER_PERSON_PER_HOUR',
        extendedConfigurations: config.extendedConfigurations,
        otherNecessaries: config.extendedConfigurations,
        isActive: config.isActive,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
        games: gamesForConfig
      };
    });

    return c.json({ success: true, setupConfigurations: result });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

api.get(
  '/setup-configurations/:id/instances',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    const setupConfigurationId = Number(c.req.param('id'));
    if (!Number.isInteger(setupConfigurationId) || setupConfigurationId <= 0) {
      return c.json({ success: false, error: "Invalid setup configuration ID" }, 400);
    }

    const [configuration] = await db
      .select()
      .from(setupConfigurationsTable)
      .where(eq(setupConfigurationsTable.id, setupConfigurationId));
    if (!configuration) {
      return c.json({ success: false, error: "Setup configuration not found" }, 404);
    }

    const instances = await db
      .select()
      .from(setupsTable)
      .where(
        and(
          eq(setupsTable.setupConfigurationId, setupConfigurationId),
          eq(setupsTable.isActive, true)
        )
      );

    return c.json({ success: true, setupConfigurationId, instances });
  }
);

// 3. GET /api/offers - List the hardcoded promotions
api.get('/offers', async (c) => {
  return c.json({
    success: true,
    offers: HARDCODED_OFFERS
  });
});

// Validation schema for offer evaluation (accepts both nested frontend payload and flat payload)
const evaluateOfferSchema = z.object({
  setupConfigurationId: z.number().int().positive("Invalid setup configuration ID").optional(),
  setupId: z.number().int().positive().optional(),
  setupName: z.string().optional(),
  consoleType: z.string().optional(),
  customer: z.object({
    name: z.string().optional(),
    phoneNumber: z.string().optional(),
    dateOfBirth: z.string().optional()
  }).optional(),
  additionalMembers: z.array(z.object({
    name: z.string().optional(),
    phone: z.string().optional(),
    dateOfBirth: z.string().optional()
  })).optional(),
  bookingDetails: z.object({
    playersCount: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
    date: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    noOfHours: z.number().positive().optional(),
    gameIds: z.array(z.number().int().positive()).optional(),
    games: z.array(z.object({ id: z.number().int().positive(), name: z.string().optional() })).optional()
  }).optional(),
  count: z.number().int().positive().optional(),
  playersCount: z.number().int().positive().optional(),
  date: z.string().optional(),
  startTime: z.string().optional(),
  noOfHours: z.number().positive().optional(),
  gameIds: z.array(z.number().int().positive()).optional(),
  appliedOfferIds: z.array(z.number().int().positive()).optional()
});

// Helper function to evaluate promotional offers (including Play 2 Get 1 Free and Happy Hours)
function evaluatePromotions(params: {
  setup: { id: number; name: string; consoleType: string; price: number; singlePlayerPrice?: number | null; multiplayerPrice?: number | null };
  playersCount: number;
  dateStr: string;
  startTimeStr: string;
  durationHours: number;
  selectedOfferIds?: number[];
}) {
  const { setup, playersCount, dateStr, startTimeStr, durationHours, selectedOfferIds } = params;

  // Determine standard rate
  const isSingle = playersCount === 1;
  const singleRate = setup.singlePlayerPrice && setup.singlePlayerPrice > 0 ? setup.singlePlayerPrice : setup.price;
  const multiRate = setup.multiplayerPrice && setup.multiplayerPrice > 0 ? setup.multiplayerPrice : singleRate;
  const ratePerPersonPerHour = isSingle ? singleRate : multiRate;
  const originalAmount = Math.ceil(durationHours * ratePerPersonPerHour * playersCount);

  // 1. Offer: PLAY 2, GET 1 FREE
  // Bring 2 players and the 3rd player joins FREE on the same PS5
  const play2Get1Eligible = playersCount >= 3;
  const play2Get1Discount = play2Get1Eligible
    ? Math.ceil(1 * durationHours * ratePerPersonPerHour) // 1 free player
    : 0;

  const offer1 = {
    ...HARDCODED_OFFERS[0],
    eligible: play2Get1Eligible,
    discount: play2Get1Discount,
    finalAmount: Math.max(0, originalAmount - play2Get1Discount),
    reason: play2Get1Eligible
      ? `3rd player joins FREE for the ${durationHours} hr session (Saved ₹${play2Get1Discount})`
      : `Requires at least 3 players on the same PS5 (Current: ${playersCount} players)`
  };

  // 2. Offer: HAPPY HOURS — MON–THU | 11 AM–5 PM
  // Rs 60 per hour multiplayer; Rs 70 per hour single player
  let happyHoursEligible = false;
  let happyHoursReason = "";
  try {
    const startDate = parseTimeToDate(dateStr, startTimeStr);
    const dayStr = startDate.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Kolkata' });
    const isMonThu = ['Mon', 'Tue', 'Wed', 'Thu'].includes(dayStr);

    // Time from midnight in minutes in Asia/Kolkata
    const timeParts = startDate.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    const [h, m] = timeParts.split(':').map(Number);
    const startMins = h * 60 + m;

    // 11:00 AM (660) to 5:00 PM (1020)
    const isWithinTime = startMins >= 660 && startMins < 1020;

    if (!isMonThu) {
      happyHoursReason = `Valid only Monday to Thursday (Selected date is ${dayStr})`;
    } else if (!isWithinTime) {
      happyHoursReason = `Valid only between 11:00 AM and 5:00 PM (Selected start time: ${startTimeStr})`;
    } else {
      happyHoursEligible = true;
    }
  } catch {
    happyHoursReason = "Invalid date or time format";
  }

  const happyHourRate = isSingle ? 70 : 60; // Rs 60/hr multiplayer; Rs 70/hr single player
  const happyHourTotal = Math.ceil(happyHourRate * playersCount * durationHours);
  const happyHourDiscount = happyHoursEligible ? Math.max(0, originalAmount - happyHourTotal) : 0;

  const offer2 = {
    ...HARDCODED_OFFERS[1],
    eligible: happyHoursEligible,
    discount: happyHourDiscount,
    finalAmount: Math.max(0, originalAmount - happyHourDiscount),
    reason: happyHoursEligible
      ? `Happy Hour pricing applied (₹${happyHourRate}/player/hr, Total: ₹${happyHourTotal})`
      : happyHoursReason
  };

  const offers = [offer1, offer2];
  const applicableOffers = offers.filter((o) => o.eligible);
  const ineligibleOffers = offers.filter((o) => !o.eligible);
  const selectedOffers = applicableOffers.filter(
    (offer) => !selectedOfferIds || selectedOfferIds.includes(offer.id)
  );
  const appliedOffers = selectedOffers
    .sort((a, b) => b.discount - a.discount)
    .slice(0, 1);
  const discountApplied = appliedOffers.reduce((sum, offer) => sum + offer.discount, 0);

  return {
    originalAmount,
    discountApplied,
    totalAmount: Math.max(0, originalAmount - discountApplied),
    ratePerPersonPerHour,
    durationHours,
    playersCount,
    appliedOffers,
    applicableOffers,
    ineligibleOffers,
    offers
  };
}

// Handler for offer evaluation
async function handleOffersEvaluation(c: any) {
  try {
    const body = await c.req.json();
    const validated = evaluateOfferSchema.safeParse(body);
    if (!validated.success) {
      return c.json({ success: false, error: "Validation failed", details: validated.error.format() }, 400);
    }

    const data = validated.data;
    const setupConfigurationId = data.setupConfigurationId ?? data.setupId;
    if (!setupConfigurationId) {
      return c.json({ success: false, error: "setupConfigurationId is required" }, 400);
    }
    const bDetails = data.bookingDetails || {};

    const playersCount = bDetails.playersCount ?? bDetails.count ?? data.playersCount ?? data.count ?? (1 + (data.additionalMembers?.length || 0));
    const dateStr = bDetails.date ?? data.date ?? new Date().toISOString().slice(0, 10);
    const startTimeStr = bDetails.startTime ?? data.startTime ?? "12:00 PM";
    const durationHours = bDetails.noOfHours ?? data.noOfHours ?? 1;

    const [config] = await db.select().from(setupConfigurationsTable).where(
      and(
        eq(setupConfigurationsTable.id, setupConfigurationId),
        eq(setupConfigurationsTable.isActive, true)
      )
    );

    if (!config) {
      return c.json({ success: false, error: "Setup configuration not found" }, 404);
    }

    const setup = {
      id: config.id,
      name: config.name,
      consoleType: config.consoleType,
      price: config.price,
      singlePlayerPrice: config.singlePlayerPrice ?? config.price,
      multiplayerPrice: config.multiplayerPrice ?? config.price
    };

    const pricing = calculatePriceForRule(config, playersCount, durationHours);
    const evaluation = evaluatePromotions({
      setup,
      playersCount,
      dateStr,
      startTimeStr,
      durationHours,
      selectedOfferIds: data.appliedOfferIds
    });

    return c.json({
      success: true,
      setup: {
        id: setup.id,
        name: setup.name,
        consoleType: setup.consoleType,
        singlePlayerPrice: setup.singlePlayerPrice,
        multiplayerPrice: setup.multiplayerPrice
      },
      bookingSummary: {
        playersCount,
        date: dateStr,
        startTime: startTimeStr,
        noOfHours: durationHours,
        ratePerPersonPerHour: pricing.ratePerPersonPerHour,
        calculationFormula: pricing.calculationFormula,
        originalAmount: evaluation.originalAmount,
        discountApplied: evaluation.discountApplied,
        totalAmount: evaluation.totalAmount
      },
      appliedOffers: evaluation.appliedOffers,
      applicableOffers: evaluation.offers.filter((offer) => offer.eligible),
      ineligibleOffers: evaluation.offers.filter((offer) => !offer.eligible),
      offers: evaluation.offers
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
}

// 3b. POST /api/offers/evaluate - Evaluate eligible and ineligible offers based on checkout details (Public)
api.post('/offers/evaluate', handleOffersEvaluation);

// 3c. POST /api/offers/applicable - Alias for evaluate offers
api.post('/offers/applicable', handleOffersEvaluation);

const reviewSchema = evaluateOfferSchema;

// 3c. POST /api/bookings/review - Review session details, calculate discount, formatting details (Public)
api.post('/bookings/review', async (c) => {
  try {
    const body = await c.req.json();
    const validated = reviewSchema.safeParse(body);
    if (!validated.success) {
      return c.json({ success: false, error: "Validation failed", details: validated.error.format() }, 400);
    }
    const data = validated.data;
    const bDetails = data.bookingDetails || {};
    const setupConfigurationId = data.setupConfigurationId ?? data.setupId;
    if (!setupConfigurationId) {
      return c.json({ success: false, error: "setupConfigurationId is required" }, 400);
    }
    const count = bDetails.playersCount ?? bDetails.count ?? data.playersCount ?? data.count ?? (1 + (data.additionalMembers?.length || 0));
    const date = bDetails.date ?? data.date ?? new Date().toISOString().slice(0, 10);
    const startTime = bDetails.startTime ?? data.startTime ?? "12:00 PM";
    const noOfHours = bDetails.noOfHours ?? data.noOfHours ?? 1;
    const gameIds = bDetails.gameIds ?? data.gameIds ?? (bDetails.games?.map((g: any) => g.id)) ?? [];
    const appliedOfferIds = data.appliedOfferIds;

    const [config] = await db.select().from(setupConfigurationsTable).where(
      and(
        eq(setupConfigurationsTable.id, setupConfigurationId),
        eq(setupConfigurationsTable.isActive, true)
      )
    );
    if (!config) return c.json({ success: false, error: "Setup active configuration not found" }, 404);

    const pricing = calculatePriceForRule(config, count, noOfHours);
    const ratePerPersonPerHour = pricing.ratePerPersonPerHour;

    // 2. Parse and format Date (e.g. Wednesday, 19 August 2026) in Asia/Kolkata
    const minStart = parseTimeToDate(date, startTime);
    const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' };
    const dateFormatted = minStart.toLocaleDateString('en-GB', dateOptions);

    // 3. Format Slots dynamically (e.g. 10:00 AM – 11:00 AM) in Asia/Kolkata
    const formattedSlotStrings: string[] = [];
    for (let i = 0; i < noOfHours; i++) {
      const slotStart = new Date(minStart.getTime() + i * 60 * 60 * 1000);
      const slotEnd = new Date(minStart.getTime() + (i + 1) * 60 * 60 * 1000);
      const startStr = slotStart.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
      const endStr = slotEnd.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
      formattedSlotStrings.push(`${startStr} – ${endStr}`);
    }
    const slotsFormatted = formattedSlotStrings.join(', ');

    // 4. Calculate Durations
    const durationHours = noOfHours;

    // 5. Get Games List
    let gamesList: string[] = [];
    if (gameIds && gameIds.length > 0) {
      const dbGames = await db.select().from(gamesTable);
      gamesList = dbGames.filter(g => gameIds.includes(g.id)).map(g => g.name);
    }

    // 6. Calculate Price Calculations Text (same single vs multi rates as /price)
    const priceCalculationText = pricing.calculationFormula;

    // 7. Calculate Pricing & Offers
    const originalAmount = pricing.basePrice;

    const offerEvaluation = evaluatePromotions({
      setup: {
        id: config.id,
        name: config.name,
        consoleType: config.consoleType,
        price: config.price,
        singlePlayerPrice: config.singlePlayerPrice,
        multiplayerPrice: config.multiplayerPrice
      },
      playersCount: count,
      dateStr: date,
      startTimeStr: startTime,
      durationHours,
      selectedOfferIds: appliedOfferIds
    });

    return c.json({
      success: true,
      summary: {
        date: dateFormatted,
        slotsFormatted,
        playersCount: count,
        zoneName: config.name,
        gamesList,
        durationHours,
        priceCalculationText,
        originalAmount,
        discountApplied: offerEvaluation.discountApplied,
        totalAmount: offerEvaluation.totalAmount,
        appliedPromotions: offerEvaluation.appliedOffers,
        availablePromotions: offerEvaluation.offers.filter(
          (offer) => !offerEvaluation.appliedOffers.some((applied) => applied.id === offer.id)
        )
      }
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 4. POST /api/bookings - Book/Allot a slot (Restricted to Admin/Super Admin)
api.post('/bookings', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const jwtPayload = c.get('jwtPayload') as any;
    const adminId = jwtPayload?.id;
    const body = await c.req.json();
    const result = bookingSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, error: "Validation failed", details: result.error.format() }, 400);
    }

    const data = result.data;
    const setupInstanceId = data.setupInstanceId ?? data.setupId ?? 1;

    // Extract customer info
    const customer = data.customer || {};
    const phoneNumber = customer.phoneNumber ?? data.phoneNumber;
    if (!phoneNumber) {
      return c.json({ success: false, error: "Customer phone number is required" }, 400);
    }
    const customerName = customer.name ?? "Guest Customer";
    const customerDob = customer.dateOfBirth ?? null;

    // Extract booking details
    const bDetails = data.bookingDetails || {};
    const count = bDetails.playersCount ?? bDetails.count ?? data.count ?? (1 + (data.additionalMembers?.length || 0));
    const date = bDetails.date ?? data.date ?? new Date().toISOString().slice(0, 10);
    const startTime = bDetails.startTime ?? data.startTime ?? "12:00 PM";
    const noOfHours = bDetails.noOfHours ?? data.noOfHours ?? 1;
    const gameIds = bDetails.gameIds ?? data.gameIds ?? (bDetails.games?.map((g: any) => g.id)) ?? [];
    const lockToken = data.lockToken;
    const userId = data.userId;

    // 1. Fetch setup details (instance)
    const [setupDb] = await db
      .select()
      .from(setupsTable)
      .where(eq(setupsTable.id, setupInstanceId));

    if (!setupDb) {
      return c.json({ success: false, error: "Setup instance not found" }, 404);
    }

    if (!setupDb.isActive) {
      return c.json({ success: false, error: "Setup instance is currently not active" }, 400);
    }

    const [config] = await db
      .select()
      .from(setupConfigurationsTable)
      .where(
        and(eq(setupConfigurationsTable.id, setupDb.setupConfigurationId), eq(setupConfigurationsTable.isActive, true))
      );

    if (!config) {
      return c.json({ success: false, error: "Setup configuration not found or is currently not active" }, 404);
    }

    // 2. Upsert Customer Profile in customersTable
    const [existingCust] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.phoneNumber, phoneNumber));

    if (existingCust) {
      await db
        .update(customersTable)
        .set({
          name: customerName || existingCust.name,
          dateOfBirth: customerDob || existingCust.dateOfBirth,
          updatedAt: new Date()
        })
        .where(eq(customersTable.id, existingCust.id));
    } else {
      await db
        .insert(customersTable)
        .values({
          phoneNumber,
          name: customerName,
          dateOfBirth: customerDob
        });
    }

    // Upsert Additional Members if provided
    if (data.additionalMembers && Array.isArray(data.additionalMembers)) {
      for (const m of data.additionalMembers) {
        if (m.phone && m.name) {
          const [existingM] = await db
            .select()
            .from(customersTable)
            .where(eq(customersTable.phoneNumber, m.phone));
          if (!existingM) {
            await db
              .insert(customersTable)
              .values({
                phoneNumber: m.phone,
                name: m.name,
                dateOfBirth: m.dateOfBirth || null
              });
          }
        }
      }
    }

    // 3. Timing and Pricing Calculation
    const minStart = parseTimeToDate(date, startTime);
    const maxEnd = new Date(minStart.getTime() + noOfHours * 60 * 60 * 1000);
    const durationHours = noOfHours;

    const pricing = calculatePriceForRule(config, count, durationHours);
    const ratePerPersonPerHour = pricing.ratePerPersonPerHour;
    const originalAmount = pricing.basePrice;
    const selectedOfferIds = data.appliedOfferIds
      ?? data.offers?.appliedOfferIds
      ?? data.offers?.appliedOffers?.flatMap((offer) => offer.id ? [offer.id] : []);
    const offerEvaluation = evaluatePromotions({
      setup: {
        id: config.id,
        name: config.name,
        consoleType: config.consoleType,
        price: config.price,
        singlePlayerPrice: config.singlePlayerPrice,
        multiplayerPrice: config.multiplayerPrice
      },
      playersCount: count,
      dateStr: date,
      startTimeStr: startTime,
      durationHours,
      selectedOfferIds
    });
    const discountApplied = offerEvaluation.discountApplied;
    const amountCharged = offerEvaluation.totalAmount;
    const appliedOffers = offerEvaluation.appliedOffers;

    // Payment amounts
    const cashAmount = data.cashAmount !== undefined ? data.cashAmount : (data.upiAmount !== undefined ? 0 : amountCharged);
    const upiAmount = data.upiAmount !== undefined ? data.upiAmount : 0;
    if (
      (data.cashAmount !== undefined || data.upiAmount !== undefined) &&
      cashAmount + upiAmount !== amountCharged
    ) {
      return c.json({
        success: false,
        error: `Payment total must equal the booking amount of ₹${amountCharged}`
      }, 400);
    }

    // 4. Build setup snapshot — frozen config at time of booking
    const setupSnapshot = {
      setupId: setupDb.id,
      setupConfigurationId: config.id,
      instanceName: setupDb.name,
      name: config.name,
      description: config.description ?? null,
      consoleType: config.consoleType,
      price: config.price,
      singlePlayerPrice: config.singlePlayerPrice ?? config.price,
      multiplayerPrice: config.multiplayerPrice ?? config.price,
      chargePerPersonPerHour: ratePerPersonPerHour,
      extendedConfigurations: config.extendedConfigurations ?? null,
      snapshotAt: new Date().toISOString()
    };

    // 5. Database transaction to check overlap and create confirmed booking
    const booking = await db.transaction(async (tx) => {
      // 5a. Check existing booking overlap (confirmed)
      const [existingBooking] = await tx
        .select()
        .from(bookingTable)
        .where(
          and(
            eq(bookingTable.setupId, setupInstanceId),
            lt(bookingTable.startTime, maxEnd),
            gt(bookingTable.endTime, minStart),
            ne(bookingTable.status, 'CANCELLED')
          )
        );
      if (existingBooking) {
        throw new Error(`The requested interval (${startTime} for ${noOfHours} hours) overlaps with an existing confirmed booking.`);
      }

      // 5b. Create the booking entry (associating with userId and tracking admin bookedBy)
      const [insertedBooking] = await tx
        .insert(bookingTable)
        .values({
          phoneNumber,
          setupId: setupInstanceId,
          userId: userId || adminId || null,
          bookedBy: adminId || null,
          count,
          originalAmount,
          amountCharged,
          cashAmount,
          upiAmount,
          status: 'CONFIRMED',
          startTime: minStart,
          endTime: maxEnd,
          actualStartTime: minStart,
          requestedStartTime: minStart,
          requestedNoOfHours: noOfHours,
          setupSnapshot
        })
        .returning();

      // 5c. Clear temporary slot lock if lockToken was provided
      if (lockToken) {
        await tx
          .delete(slotLocksTable)
          .where(
            and(
              eq(slotLocksTable.setupId, setupInstanceId),
              eq(slotLocksTable.lockToken, lockToken)
            )
          );
      }

      // 5d. Record each individual slot in bookingSlotsTable
      const numSlots = Math.max(1, Math.ceil(noOfHours));
      for (let i = 0; i < numSlots; i++) {
        const slotStart = new Date(minStart.getTime() + i * 60 * 60 * 1000);
        const slotEnd = new Date(Math.min(minStart.getTime() + (i + 1) * 60 * 60 * 1000, maxEnd.getTime()));
        await tx
          .insert(bookingSlotsTable)
          .values({
            bookingId: insertedBooking.id,
            startTime: slotStart,
            endTime: slotEnd
          });
      }

      // 5e. Link games to the booking
      if (gameIds && gameIds.length > 0) {
        for (const gameId of gameIds) {
          await tx
            .insert(bookingAndGames)
            .values({
              bookingId: insertedBooking.id,
              gameId: gameId
            });
        }
      }

      for (const offer of appliedOffers) {
        await tx
          .insert(bookingAndOffersTable)
          .values({ bookingId: insertedBooking.id, offerId: offer.id });
      }

      return insertedBooking;
    });

    // Fetch Admin User details
    const [adminUser] = adminId ? await db.select({ id: usersTable.id, email: usersTable.email, role: usersTable.role }).from(usersTable).where(eq(usersTable.id, adminId)) : [null];

    // Format display strings
    const dateFormatted = minStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const formattedSlotStrings: string[] = [];
    const numDisplaySlots = Math.max(1, Math.ceil(noOfHours));
    for (let i = 0; i < numDisplaySlots; i++) {
      const slotStart = new Date(minStart.getTime() + i * 60 * 60 * 1000);
      const slotEnd = new Date(Math.min(minStart.getTime() + (i + 1) * 60 * 60 * 1000, maxEnd.getTime()));
      const startStr = slotStart.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
      const endStr = slotEnd.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
      formattedSlotStrings.push(`${startStr} – ${endStr}`);
    }

    let gamesList: any[] = [];
    if (gameIds && gameIds.length > 0) {
      const dbGames = await db.select().from(gamesTable);
      gamesList = dbGames.filter(g => gameIds.includes(g.id)).map(g => ({ id: g.id, name: g.name }));
    }

    return c.json({
      success: true,
      message: "Slot allotted and booking confirmed successfully",
      booking: {
        id: booking.id,
        status: booking.status,
        customer: {
          name: customerName,
          phoneNumber: phoneNumber,
          dateOfBirth: customerDob
        },
        additionalMembers: data.additionalMembers || [],
        setup: {
          instanceId: setupDb.id,
          instanceName: setupDb.name,
          configurationName: config.name,
          consoleType: config.consoleType
        },
        session: {
          date: dateFormatted,
          startTime,
          endTime: bDetails.endTime || maxEnd.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
          slotsFormatted: formattedSlotStrings.join(', '),
          durationHours: noOfHours,
          playersCount: count
        },
        games: gamesList,
        pricing: {
          ratePerPersonPerHour,
          playerType: pricing.playerType,
          calculationFormula: pricing.calculationFormula,
          originalAmount,
          discountApplied,
          totalAmount: amountCharged,
          cashAmount: booking.cashAmount,
          upiAmount: booking.upiAmount
        },
        appliedOffers,
        applicableOffers: offerEvaluation.offers.filter((offer) => offer.eligible),
        ineligibleOffers: offerEvaluation.offers.filter((offer) => !offer.eligible),
        offers: offerEvaluation.offers,
        bookedByAdmin: adminUser ? {
          id: adminUser.id,
          email: adminUser.email,
          role: adminUser.role
        } : null,
        createdAt: booking.createdAt
      }
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 4b. POST /api/bookings/tentative - Book a tentative slot (Restricted to Admin/Super Admin)
api.post('/bookings/tentative', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const jwtPayload = c.get('jwtPayload') as any;
    const adminId = jwtPayload?.id;
    const body = await c.req.json();
    const result = bookingSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, error: "Validation failed", details: result.error.format() }, 400);
    }

    const data = result.data;
    const setupConfigurationId = data.setupConfigurationId ?? data.setupId;
    if (!setupConfigurationId) {
      return c.json({ success: false, error: "setupConfigurationId is required" }, 400);
    }
    const customer = data.customer || {};
    const phoneNumber = customer.phoneNumber ?? data.phoneNumber ?? "";
    if (!phoneNumber) {
      return c.json({ success: false, error: "Customer phone number is required" }, 400);
    }
    const bDetails = data.bookingDetails || {};
    const count = bDetails.playersCount ?? bDetails.count ?? data.count ?? (1 + (data.additionalMembers?.length || 0));
    const date = bDetails.date ?? data.date;
    const startTime = bDetails.startTime ?? data.startTime;
    const noOfHours = bDetails.noOfHours ?? data.noOfHours;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ success: false, error: "date is required in YYYY-MM-DD format" }, 400);
    }
    if (!startTime || !/^(0?[1-9]|1[0-2]):[0-5]\d\s*(AM|PM)$/i.test(startTime)) {
      return c.json({ success: false, error: "startTime is required in hh:mm AM/PM format" }, 400);
    }
    if (!noOfHours) {
      return c.json({ success: false, error: "noOfHours is required" }, 400);
    }
    const gameIds = bDetails.gameIds ?? data.gameIds ?? (bDetails.games?.map((g: any) => g.id)) ?? [];
    const userId = data.userId;
    const appliedOfferIds = data.appliedOfferIds ?? data.offers?.appliedOfferIds;

    // 1. Fetch the requested configuration. A physical instance is assigned only on confirmation.
    const [config] = await db
      .select()
      .from(setupConfigurationsTable)
      .where(
        and(
          eq(setupConfigurationsTable.id, setupConfigurationId),
          eq(setupConfigurationsTable.isActive, true)
        )
      );

    if (!config) {
      return c.json({ success: false, error: "Setup configuration not found or is currently not active" }, 404);
    }

    const pricing = calculatePriceForRule(config, count, noOfHours);

    const minStart = parseTimeToDate(date, startTime);
    const maxEnd = new Date(minStart.getTime() + noOfHours * 60 * 60 * 1000);
    const durationHours = noOfHours;

    // 2. Calculate Base Pricing
    const originalAmount = pricing.basePrice;

    const offerEvaluation = evaluatePromotions({
      setup: {
        id: config.id,
        name: config.name,
        consoleType: config.consoleType,
        price: config.price,
        singlePlayerPrice: config.singlePlayerPrice,
        multiplayerPrice: config.multiplayerPrice
      },
      playersCount: count,
      dateStr: date,
      startTimeStr: startTime,
      durationHours,
      selectedOfferIds: appliedOfferIds
    });
    const amountCharged = offerEvaluation.totalAmount;
    const appliedOffers = offerEvaluation.appliedOffers;

    // 4. Build setup snapshot
    const setupSnapshot = {
      setupConfigurationId: config.id,
      name: config.name,
      description: config.description ?? null,
      consoleType: config.consoleType,
      price: config.price,
      singlePlayerPrice: config.singlePlayerPrice ?? config.price,
      multiplayerPrice: config.multiplayerPrice ?? config.price,
      chargePerPersonPerHour: pricing.ratePerPersonPerHour,
      extendedConfigurations: config.extendedConfigurations ?? null,
      otherNecessaries: config.extendedConfigurations ?? null,
      snapshotAt: new Date().toISOString()
    };

    const [tentativeBooking] = await db
      .insert(tentativeBookingTable)
      .values({
        phoneNumber,
        setupConfigurationId,
        userId: userId || adminId || null,
        bookedBy: adminId || null,
        count,
        originalAmount,
        amountCharged,
        startTime: minStart,
        endTime: maxEnd,
        requestedStartTime: minStart,
        requestedNoOfHours: noOfHours,
        setupSnapshot,
        gameIds: gameIds || [],
        appliedOfferIds: appliedOffers.map((offer) => offer.id)
      })
      .returning();

    return c.json({
      success: true,
      booking: {
        ...tentativeBooking,
        appliedOffers,
        applicableOffers: offerEvaluation.offers.filter((offer) => offer.eligible),
        ineligibleOffers: offerEvaluation.offers.filter((offer) => !offer.eligible),
        offers: offerEvaluation.offers,
        gamesBooked: gameIds || [],
        setupSnapshot,
        pricing: {
          ratePerPersonPerHour: pricing.ratePerPersonPerHour,
          playerType: pricing.playerType,
          calculationFormula: pricing.calculationFormula,
          originalAmount,
          discountApplied: offerEvaluation.discountApplied,
          totalAmount: amountCharged
        }
      }
    });
  } catch (error: any) {
    console.error(error);
    if (error instanceof BookingConflictError) {
      return c.json({ success: false, error: error.message }, 409);
    }
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 4c. GET /api/bookings/tentative - List all active tentative bookings (Restricted to Admin/Super Admin)
api.get('/bookings/tentative', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const date = c.req.query('date');
    let bookings;

    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({ success: false, error: "Date must be in format YYYY-MM-DD" }, 400);
      }
      const dayStart = new Date(`${date}T00:00:00+05:30`);
      const dayEnd = new Date(`${date}T23:59:59.999+05:30`);

      bookings = await db
        .select()
        .from(tentativeBookingTable)
        .where(
          and(
            gte(tentativeBookingTable.startTime, dayStart),
            lte(tentativeBookingTable.startTime, dayEnd)
          )
        )
        .orderBy(tentativeBookingTable.startTime);
    } else {
      bookings = await db
        .select()
        .from(tentativeBookingTable)
        .orderBy(tentativeBookingTable.createdAt);
    }

    const configurationIds = [...new Set(bookings.map((booking) => booking.setupConfigurationId))];
    const configurations = configurationIds.length > 0
      ? await db
        .select()
        .from(setupConfigurationsTable)
        .where(inArray(setupConfigurationsTable.id, configurationIds))
      : [];

    return c.json({
      success: true,
      bookings: bookings.map((booking) => {
        const snapshot = booking.setupSnapshot as {
          name?: string;
          consoleType?: string;
          price?: number;
          singlePlayerPrice?: number;
          multiplayerPrice?: number;
          chargePerPersonPerHour?: unknown;
        } | null;
        const durationHours = booking.requestedNoOfHours
          ?? (booking.endTime.getTime() - booking.startTime.getTime()) / (60 * 60 * 1000);
        const offerEvaluation = evaluatePromotions({
          setup: {
            id: booking.setupConfigurationId,
            name: snapshot?.name ?? 'Setup',
            consoleType: snapshot?.consoleType ?? 'Console',
            price: snapshot?.price ?? 0,
            singlePlayerPrice: snapshot?.singlePlayerPrice,
            multiplayerPrice: snapshot?.multiplayerPrice
          },
          playersCount: booking.count,
          dateStr: booking.startTime.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
          startTimeStr: booking.startTime.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: 'Asia/Kolkata'
          }),
          durationHours,
          selectedOfferIds: booking.appliedOfferIds
        });

        return {
          ...booking,
          setupConfiguration: configurations.find(
            (configuration) => configuration.id === booking.setupConfigurationId
          ) ?? null,
          appliedOffers: offerEvaluation.appliedOffers,
          applicableOffers: offerEvaluation.offers.filter((offer) => offer.eligible),
          ineligibleOffers: offerEvaluation.offers.filter((offer) => !offer.eligible),
          offers: offerEvaluation.offers
        };
      })
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Validation Schema for confirming tentative bookings
const confirmBookingSchema = z.object({
  setupInstanceId: z.number().int().positive("Invalid setup instance ID"),
  cashAmount: z.number().nonnegative().optional(),
  upiAmount: z.number().nonnegative().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional()
});

// 4d. POST /api/bookings/tentative/:id/confirm - Confirm a tentative booking and allot slot (Restricted to Admin/Super Admin)
api.post('/bookings/tentative/:id/confirm', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const jwtPayload = c.get('jwtPayload') as any;
    const adminId = jwtPayload?.id;
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ success: false, error: "Invalid tentative booking ID" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const validated = confirmBookingSchema.safeParse(body);
    if (!validated.success) {
      return c.json({ success: false, error: "Validation failed", details: validated.error.format() }, 400);
    }

    const { setupInstanceId, cashAmount = 0, upiAmount = 0, startTime, endTime } = validated.data;

    const result = await db.transaction(async (tx) => {
      // 1. Fetch tentative booking
      const [tentative] = await tx
        .select()
        .from(tentativeBookingTable)
        .where(eq(tentativeBookingTable.id, id));

      if (!tentative) {
        throw new Error("Tentative booking not found");
      }

      await tx.execute(sql`select pg_advisory_xact_lock(${tentative.setupConfigurationId})`);

      // Fetch the assigned setup instance to verify
      const [setupDb] = await tx
        .select()
        .from(setupsTable)
        .where(eq(setupsTable.id, setupInstanceId));
      if (!setupDb || !setupDb.isActive) {
        throw new Error("Assigned setup instance was not found or is inactive");
      }
      if (setupDb.setupConfigurationId !== tentative.setupConfigurationId) {
        throw new Error("Assigned setup instance does not belong to the tentative booking configuration");
      }

      // Determine the session timings
      const finalStartTime = startTime ? new Date(startTime) : new Date(tentative.startTime);
      const finalEndTime = endTime ? new Date(endTime) : new Date(tentative.endTime);

      if (
        isNaN(finalStartTime.getTime()) ||
        isNaN(finalEndTime.getTime()) ||
        finalEndTime <= finalStartTime
      ) {
        throw new Error("Invalid start or end time specified");
      }

      // 2. Check overlapping confirmed bookings
      const [overlappingBooking] = await tx
        .select()
        .from(bookingTable)
        .where(
          and(
            eq(bookingTable.setupId, setupInstanceId),
            lt(bookingTable.startTime, finalEndTime),
            gt(bookingTable.endTime, finalStartTime),
            ne(bookingTable.status, 'CANCELLED')
          )
        );

      if (overlappingBooking) {
        throw new Error("Cannot confirm: The requested slot overlaps with an existing confirmed booking.");
      }

      const finalAmountCharged = tentative.amountCharged || 0;
      if (
        (body.cashAmount !== undefined || body.upiAmount !== undefined) &&
        cashAmount + upiAmount !== finalAmountCharged
      ) {
        throw new Error(`Payment total must equal the booking amount of ₹${finalAmountCharged}`);
      }

      const [config] = await tx
        .select()
        .from(setupConfigurationsTable)
        .where(eq(setupConfigurationsTable.id, tentative.setupConfigurationId));
      if (!config) {
        throw new Error("Tentative booking setup configuration not found");
      }
      const tentativeSnapshot = (
        tentative.setupSnapshot &&
        typeof tentative.setupSnapshot === 'object' &&
        !Array.isArray(tentative.setupSnapshot)
      ) ? tentative.setupSnapshot : {};
      const setupSnapshot = {
        ...tentativeSnapshot,
        setupId: setupDb.id,
        setupConfigurationId: config.id,
        instanceName: setupDb.name,
        name: config.name,
        description: config.description ?? null,
        consoleType: config.consoleType,
        price: config.price,
        extendedConfigurations: config.extendedConfigurations ?? null,
        otherNecessaries: config.extendedConfigurations ?? null,
        snapshotAt: new Date().toISOString()
      };

      // 3. Move tentative booking to main bookingTable (slot allotment)
      const [booking] = await tx
        .insert(bookingTable)
        .values({
          phoneNumber: tentative.phoneNumber,
          setupId: setupInstanceId,
          userId: tentative.userId || adminId || null,
          bookedBy: adminId || tentative.bookedBy || null,
          originalAmount: tentative.originalAmount,
          amountCharged: finalAmountCharged,
          cashAmount: cashAmount,
          upiAmount: upiAmount,
          count: tentative.count,
          status: 'CONFIRMED',
          startTime: finalStartTime,
          endTime: finalEndTime,
          requestedStartTime: tentative.requestedStartTime,
          requestedNoOfHours: tentative.requestedNoOfHours,
          setupSnapshot: setupSnapshot
        })
        .returning();

      // 4. Generate and save slots to bookingSlotsTable
      const durationMs = finalEndTime.getTime() - finalStartTime.getTime();
      const noOfHours = Math.max(1, Math.round(durationMs / (1000 * 60 * 60)));
      for (let i = 0; i < noOfHours; i++) {
        const slotStart = new Date(finalStartTime.getTime() + i * 60 * 60 * 1000);
        const slotEnd = new Date(finalStartTime.getTime() + (i + 1) * 60 * 60 * 1000);
        await tx
          .insert(bookingSlotsTable)
          .values({
            bookingId: booking.id,
            startTime: slotStart,
            endTime: slotEnd
          });
      }

      // 5. Move games to bookingAndGames
      if (tentative.gameIds && tentative.gameIds.length > 0) {
        for (const gameId of tentative.gameIds) {
          await tx
            .insert(bookingAndGames)
            .values({
              bookingId: booking.id,
              gameId: gameId
            });
        }
      }

      // 6. Move offers to bookingAndOffersTable
      if (tentative.appliedOfferIds && tentative.appliedOfferIds.length > 0) {
        for (const offerId of tentative.appliedOfferIds) {
          await tx
            .insert(bookingAndOffersTable)
            .values({
              bookingId: booking.id,
              offerId: offerId
            });
        }
      }

      // 7. Delete tentative booking
      await tx
        .delete(tentativeBookingTable)
        .where(eq(tentativeBookingTable.id, id));

      return booking;
    });

    return c.json({
      success: true,
      message: "Tentative booking successfully confirmed.",
      booking: {
        ...result,
        pricing: {
          ratePerPersonPerHour: (
            result.setupSnapshot &&
            typeof result.setupSnapshot === 'object' &&
            !Array.isArray(result.setupSnapshot) &&
            'chargePerPersonPerHour' in result.setupSnapshot
          ) ? result.setupSnapshot.chargePerPersonPerHour : null,
          playerType: result.count === 1 ? 'SINGLE_PLAYER' : 'MULTIPLAYER',
          originalAmount: result.originalAmount,
          discountApplied: (result.originalAmount ?? 0) - (result.amountCharged ?? 0),
          totalAmount: result.amountCharged,
          cashAmount: result.cashAmount,
          upiAmount: result.upiAmount
        }
      }
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// 4e. DELETE /api/bookings/tentative/:id - Cancel/Delete a tentative booking (Restricted to Admin/Super Admin)
api.delete('/bookings/tentative/:id', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ success: false, error: "Invalid tentative booking ID" }, 400);
    }

    const [deleted] = await db
      .delete(tentativeBookingTable)
      .where(eq(tentativeBookingTable.id, id))
      .returning();

    if (!deleted) {
      return c.json({ success: false, error: "Tentative booking not found" }, 404);
    }

    return c.json({ success: true, message: "Tentative booking successfully cancelled." });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 5. GET /api/bookings - List bookings (Members only see their own, Admin/Super Admin see all)
api.get('/bookings', authMiddleware, async (c) => {
  try {
    const requester = c.get('jwtPayload') as any;
    let bookings;

    if (requester.role === 'MEMBER') {
      bookings = await db
        .select()
        .from(bookingTable)
        .where(eq(bookingTable.userId, requester.id))
        .orderBy(bookingTable.createdAt);
    } else {
      bookings = await db
        .select()
        .from(bookingTable)
        .orderBy(bookingTable.createdAt);
    }

    return c.json({ success: true, bookings });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 5c. PATCH /api/bookings/:id/status - Update booking status (Requires ADMIN or SUPER_ADMIN)
const updateBookingStatusSchema = z.object({
  status: z.enum(['TENTATIVE', 'CONFIRMED', 'CANCELLED'], { message: "Invalid status value" }),
  actualStartTime: z.string().datetime().optional(),
  actualEndTime: z.string().datetime().optional()
});

api.patch('/bookings/:id/status', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ success: false, error: "Invalid booking ID" }, 400);
    }

    const body = await c.req.json();
    const validated = updateBookingStatusSchema.safeParse(body);
    if (!validated.success) {
      return c.json({ success: false, error: "Validation failed", details: validated.error.format() }, 400);
    }

    const { status, actualStartTime, actualEndTime } = validated.data;

    // Fetch original booking to check existence
    const [existing] = await db
      .select()
      .from(bookingTable)
      .where(eq(bookingTable.id, id));

    if (!existing) {
      return c.json({ success: false, error: "Booking not found" }, 404);
    }

    // Update status (and optionally actual session times set by the café owner)
    const [updated] = await db
      .update(bookingTable)
      .set({
        status,
        updatedAt: new Date(),
        ...(actualStartTime ? { actualStartTime: new Date(actualStartTime) } : {}),
        ...(actualEndTime ? { actualEndTime: new Date(actualEndTime) } : {})
      })
      .where(eq(bookingTable.id, id))
      .returning();

    // Fetch related receipt data for frontend invoice/PDF generation
    const games = await db
      .select({ name: gamesTable.name })
      .from(bookingAndGames)
      .innerJoin(gamesTable, eq(bookingAndGames.gameId, gamesTable.id))
      .where(eq(bookingAndGames.bookingId, updated.id));
    const gamesList = games.map(g => g.name);

    const linkedOfferIds = await db
      .select({ offerId: bookingAndOffersTable.offerId })
      .from(bookingAndOffersTable)
      .where(eq(bookingAndOffersTable.bookingId, updated.id));
    const offers = linkedOfferIds.flatMap(({ offerId }) => {
      const offer = HARDCODED_OFFERS.find((candidate) => candidate.id === offerId);
      return offer ? [{ id: offer.id, name: offer.name }] : [];
    });

    // Use requestedStartTime + requestedNoOfHours (what the customer booked)
    // Fall back to startTime/endTime if explicit fields are missing
    const sessionStart = updated.requestedStartTime
      ? new Date(updated.requestedStartTime)
      : new Date(updated.startTime);

    const noOfHours = updated.requestedNoOfHours
      ?? Math.round((new Date(updated.endTime).getTime() - new Date(updated.startTime).getTime()) / (1000 * 60 * 60));

    // Prefer frozen snapshot over live setup row so receipt survives future edits
    const snapshot = updated.setupSnapshot as Record<string, any> | null;

    const dateFormatted = sessionStart.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Kolkata'
    });

    const startTimeFormatted = sessionStart.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });

    const endTime = new Date(sessionStart.getTime() + noOfHours * 60 * 60 * 1000);
    const endTimeFormatted = endTime.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });

    const chargePerPersonPerHour = snapshot?.chargePerPersonPerHour ?? null;
    const setupName = snapshot?.name ?? (updated.setupId ? `Instance #${updated.setupId}` : 'Unknown Zone');

    const priceCalculationText = chargePerPersonPerHour != null
      ? `₹${chargePerPersonPerHour} × ${updated.count} people × ${noOfHours} hrs`
      : "";

    const discountApplied = (updated.originalAmount || 0) - (updated.amountCharged || 0);

    const appliedPromotions = offers.map(o => ({
      id: o.id,
      name: o.name,
      discount: discountApplied
    }));

    return c.json({
      success: true,
      booking: updated,
      receipt: {
        bookingId: updated.id,
        date: dateFormatted,
        startTime: startTimeFormatted,
        endTime: endTimeFormatted,
        noOfHours,
        playersCount: updated.count,
        zoneName: setupName,
        gamesList,
        priceCalculationText,
        originalAmount: updated.originalAmount,
        discountApplied,
        totalAmount: updated.amountCharged,
        appliedPromotions,
        setupSnapshot: snapshot
      }
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

const extendBookingSchema = z.object({
  minutes: z.number().int().min(15, "Minimum extension is 15 minutes").optional(),
  noOfHours: z.number().positive().optional(),
  hours: z.number().positive().optional(),
  appliedOfferIds: z.array(z.number().int()).optional(),
  pricing: z.object({
    basePrice: z.number().optional(),
    ratePerPersonPerHour: z.number().optional(),
    playerType: z.string().optional()
  }).optional(),
  offers: z.object({
    appliedOfferIds: z.array(z.number().int()).optional(),
    appliedOffers: z.array(z.object({
      id: z.number().optional(),
      code: z.string().optional(),
      name: z.string().optional(),
      discount: z.number().optional(),
      reason: z.string().optional()
    })).optional(),
    originalAmount: z.number().optional(),
    discountApplied: z.number().optional(),
    totalAmount: z.number().optional()
  }).optional(),
  cashAmount: z.number().nonnegative().optional(),
  upiAmount: z.number().nonnegative().optional()
});

// 5d. POST /api/bookings/:id/extend - Extend an existing booking, recalculate pricing & offers (Restricted to Admin/Super Admin)
api.post('/bookings/:id/extend', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ success: false, error: "Invalid booking ID" }, 400);
    }

    const body = await c.req.json();
    const validated = extendBookingSchema.safeParse(body);
    if (!validated.success) {
      return c.json({ success: false, error: "Validation failed", details: validated.error.format() }, 400);
    }

    const data = validated.data;
    const extensionMinutes = data.minutes ?? (data.noOfHours ? Math.round(data.noOfHours * 60) : (data.hours ? Math.round(data.hours * 60) : 60));
    const extensionHours = extensionMinutes / 60;

    // 1. Fetch existing booking
    const [booking] = await db
      .select()
      .from(bookingTable)
      .where(eq(bookingTable.id, id));

    if (!booking) {
      return c.json({ success: false, error: "Booking not found" }, 404);
    }

    if (booking.status === 'CANCELLED') {
      return c.json({ success: false, error: "Cannot extend a cancelled booking" }, 400);
    }

    const setupId = booking.setupId;
    if (!setupId) {
      return c.json({ success: false, error: "Booking has no assigned setup instance" }, 400);
    }

    const snapshot = (booking.setupSnapshot as Record<string, any> | null) || {};
    const count = booking.count || 1;
    const isSingle = count === 1;

    // Resolve rate per person per hour
    const singlePrice = snapshot.singlePlayerPrice ?? snapshot.chargePerPersonPerHour ?? snapshot.price ?? 150;
    const multiPrice = snapshot.multiplayerPrice ?? snapshot.chargePerPersonPerHour ?? snapshot.price ?? 120;
    const ratePerPersonPerHour = isSingle ? singlePrice : multiPrice;

    const currentStartTime = new Date(booking.startTime);
    const currentEndTime = new Date(booking.endTime);
    const currentDurationHours = Math.max(0.25, (currentEndTime.getTime() - currentStartTime.getTime()) / (1000 * 60 * 60));
    const totalDurationHours = currentDurationHours + extensionHours;
    const newEndTime = new Date(currentEndTime.getTime() + extensionMinutes * 60 * 1000);

    // 2. Pricing & Offers Calculation for total extended session
    const newOriginalAmount = Math.ceil(totalDurationHours * ratePerPersonPerHour * count);
    const existingBookingOffers = await db
      .select({ offerId: bookingAndOffersTable.offerId })
      .from(bookingAndOffersTable)
      .where(eq(bookingAndOffersTable.bookingId, id));
    const targetOfferIds = data.offers?.appliedOfferIds
      ?? data.appliedOfferIds
      ?? existingBookingOffers.map((offer) => offer.offerId);
    const offerEvaluation = evaluatePromotions({
      setup: {
        id: Number(snapshot.setupConfigurationId ?? setupId),
        name: String(snapshot.name ?? snapshot.instanceName ?? 'Setup'),
        consoleType: String(snapshot.consoleType ?? 'Console'),
        price: Number(snapshot.price ?? ratePerPersonPerHour),
        singlePlayerPrice: Number(singlePrice),
        multiplayerPrice: Number(multiPrice)
      },
      playersCount: count,
      dateStr: currentStartTime.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
      startTimeStr: currentStartTime.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata'
      }),
      durationHours: totalDurationHours,
      selectedOfferIds: targetOfferIds.length > 0 ? targetOfferIds : undefined
    });
    const appliedOffers = offerEvaluation.appliedOffers;
    const discountApplied = offerEvaluation.discountApplied;
    const newTotalAmount = offerEvaluation.totalAmount;
    const previousTotalAmount = booking.amountCharged || 0;
    const additionalAmountToPay = Math.max(0, newTotalAmount - previousTotalAmount);

    const addedCash = data.cashAmount !== undefined ? data.cashAmount : (data.upiAmount !== undefined ? 0 : additionalAmountToPay);
    const addedUpi = data.upiAmount !== undefined ? data.upiAmount : 0;
    if (
      (data.cashAmount !== undefined || data.upiAmount !== undefined) &&
      addedCash + addedUpi !== additionalAmountToPay
    ) {
      return c.json({
        success: false,
        error: `Extension payment must equal ₹${additionalAmountToPay}`
      }, 400);
    }

    // 3. Database transaction to check overlap and perform update
    const updated = await db.transaction(async (tx) => {
      // 3a. Check overlapping bookings (excluding this booking)
      const [overlappingBooking] = await tx
        .select()
        .from(bookingTable)
        .where(
          and(
            eq(bookingTable.setupId, setupId),
            lt(bookingTable.startTime, newEndTime),
            gt(bookingTable.endTime, currentEndTime),
            ne(bookingTable.status, 'CANCELLED'),
            ne(bookingTable.id, id)
          )
        );

      if (overlappingBooking) {
        throw new Error(`Cannot extend booking: extension interval overlaps with another confirmed booking (#${overlappingBooking.id}).`);
      }

      // 3b. Check overlapping active locks
      const [overlappingLock] = await tx
        .select()
        .from(slotLocksTable)
        .where(
          and(
            eq(slotLocksTable.setupId, setupId),
            lt(slotLocksTable.startTime, newEndTime),
            gt(slotLocksTable.endTime, currentEndTime),
            gt(slotLocksTable.lockedUntil, new Date())
          )
        );

      if (overlappingLock) {
        throw new Error("Cannot extend booking: the extension interval overlaps with an active temporary lock.");
      }

      // 3c. Update booking record
      const [updatedBooking] = await tx
        .update(bookingTable)
        .set({
          endTime: newEndTime,
          requestedNoOfHours: totalDurationHours,
          originalAmount: newOriginalAmount,
          amountCharged: newTotalAmount,
          cashAmount: (booking.cashAmount || 0) + addedCash,
          upiAmount: (booking.upiAmount || 0) + addedUpi,
          updatedAt: new Date()
        })
        .where(eq(bookingTable.id, id))
        .returning();

      await tx
        .delete(bookingAndOffersTable)
        .where(eq(bookingAndOffersTable.bookingId, id));
      for (const offer of appliedOffers) {
        await tx
          .insert(bookingAndOffersTable)
          .values({ bookingId: id, offerId: offer.id });
      }

      // 3d. Record newly added slot(s) in bookingSlotsTable
      const numSlotsToAdd = Math.ceil(extensionMinutes / 60);
      for (let i = 0; i < numSlotsToAdd; i++) {
        const slotStart = new Date(currentEndTime.getTime() + i * 60 * 60 * 1000);
        const slotEnd = new Date(Math.min(currentEndTime.getTime() + (i + 1) * 60 * 60 * 1000, newEndTime.getTime()));
        await tx
          .insert(bookingSlotsTable)
          .values({
            bookingId: id,
            startTime: slotStart,
            endTime: slotEnd
          });
      }

      return updatedBooking;
    });

    // Format display timings
    const prevEndTimeFormatted = currentEndTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
    const newEndTimeFormatted = newEndTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

    return c.json({
      success: true,
      message: `Booking #${id} successfully extended by ${extensionMinutes} minutes (${extensionHours} hr).`,
      extension: {
        addedMinutes: extensionMinutes,
        addedHours: extensionHours,
        previousEndTime: prevEndTimeFormatted,
        newEndTime: newEndTimeFormatted,
        totalDurationHours
      },
      pricing: {
        ratePerPersonPerHour,
        playerType: isSingle ? "SINGLE_PLAYER" : "MULTIPLAYER",
        previousOriginalAmount: booking.originalAmount,
        previousTotalAmount,
        newOriginalAmount,
        discountApplied,
        newTotalAmount,
        additionalAmountToPay
      },
      appliedOffers,
      booking: updated
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Comprehensive Session End Logic with Full Summary
async function handleEndSessionLogic(params: {
  bookingId?: number;
  setupId?: number;
  adminId?: number;
}) {
  const { bookingId, setupId, adminId } = params;
  const now = new Date();

  // 1. Find target booking
  let booking: any = null;
  if (bookingId) {
    const [b] = await db.select().from(bookingTable).where(eq(bookingTable.id, bookingId));
    booking = b;
  } else if (setupId) {
    // Find active booking on this setup instance
    const [b] = await db
      .select()
      .from(bookingTable)
      .where(
        and(
          eq(bookingTable.setupId, setupId),
          ne(bookingTable.status, 'CANCELLED'),
          isNull(bookingTable.actualEndTime)
        )
      )
      .orderBy(desc(bookingTable.createdAt))
      .limit(1);

    if (b) {
      booking = b;
    } else {
      // Fallback: look for most recent confirmed booking on that setup
      const [recent] = await db
        .select()
        .from(bookingTable)
        .where(
          and(
            eq(bookingTable.setupId, setupId),
            ne(bookingTable.status, 'CANCELLED')
          )
        )
        .orderBy(desc(bookingTable.createdAt))
        .limit(1);
      booking = recent;
    }
  }

  if (!booking) {
    throw new Error(bookingId ? `Booking #${bookingId} not found` : `No active booking session found on Setup #${setupId}`);
  }

  if (booking.status === 'CANCELLED') {
    throw new Error("Cannot end session for a cancelled booking");
  }

  const snapshot = (booking.setupSnapshot as Record<string, any> | null) || {};
  const count = booking.count || 1;
  const isSingle = count === 1;

  // Resolve setup pricing
  const singlePrice = snapshot.singlePlayerPrice ?? snapshot.chargePerPersonPerHour ?? snapshot.price ?? 150;
  const multiPrice = snapshot.multiplayerPrice ?? snapshot.chargePerPersonPerHour ?? snapshot.price ?? 120;
  const ratePerPersonPerHour = isSingle ? singlePrice : multiPrice;

  const actualStartTime = new Date(booking.actualStartTime || booking.startTime);
  const actualEndTime = now;

  // Calculate elapsed time (minimum 15 mins, rounded up to nearest 15 mins)
  const elapsedMs = Math.max(0, actualEndTime.getTime() - actualStartTime.getTime());
  const elapsedMinutes = Math.max(1, Math.ceil(elapsedMs / (1000 * 60)));
  const roundedMinutes = Math.max(15, Math.ceil(elapsedMinutes / 15) * 15);
  const actualDurationHours = roundedMinutes / 60;
  const scheduledDurationHours = booking.requestedNoOfHours || Math.round((new Date(booking.endTime).getTime() - actualStartTime.getTime()) / (1000 * 60 * 60) * 100) / 100;

  // Recalculate original base amount for actual duration
  const finalOriginalAmount = Math.ceil(actualDurationHours * ratePerPersonPerHour * count);

  const existingBookingOffers = await db
    .select({ offerId: bookingAndOffersTable.offerId })
    .from(bookingAndOffersTable)
    .where(eq(bookingAndOffersTable.bookingId, booking.id));
  const offerEvaluation = evaluatePromotions({
    setup: {
      id: Number(snapshot.setupConfigurationId ?? booking.setupId ?? 0),
      name: String(snapshot.name ?? snapshot.instanceName ?? 'Setup'),
      consoleType: String(snapshot.consoleType ?? 'Console'),
      price: Number(snapshot.price ?? ratePerPersonPerHour),
      singlePlayerPrice: Number(singlePrice),
      multiplayerPrice: Number(multiPrice)
    },
    playersCount: count,
    dateStr: actualStartTime.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
    startTimeStr: actualStartTime.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    }),
    durationHours: actualDurationHours,
    selectedOfferIds: existingBookingOffers.length > 0
      ? existingBookingOffers.map((offer) => offer.offerId)
      : undefined
  });

  const appliedOffers = offerEvaluation.appliedOffers;
  const discountApplied = offerEvaluation.discountApplied;
  const finalAmountCharged = offerEvaluation.totalAmount;

  const initialAmountPaid = (booking.cashAmount || 0) + (booking.upiAmount || 0) || (booking.amountCharged || 0);
  const balanceDiff = initialAmountPaid - finalAmountCharged;

  let settlementStatus = "SETTLED";
  let settlementNote = "Session completed and settled in full.";
  if (balanceDiff > 0) {
    settlementStatus = "REFUND_DUE";
    settlementNote = `Customer overpaid by ₹${balanceDiff} due to early session completion (Paid ₹${initialAmountPaid}, Final ₹${finalAmountCharged}).`;
  } else if (balanceDiff < 0) {
    settlementStatus = "PAYMENT_DUE";
    settlementNote = `Additional ₹${Math.abs(balanceDiff)} due for payment.`;
  }

  // Database update: end time set to now to release setup immediately
  const [updatedBooking] = await db
    .update(bookingTable)
    .set({
      endTime: actualEndTime,
      actualEndTime: actualEndTime,
      originalAmount: finalOriginalAmount,
      amountCharged: finalAmountCharged,
      status: 'CONFIRMED',
      updatedAt: now
    })
    .where(eq(bookingTable.id, booking.id))
    .returning();

  // Fetch Customer profile
  const [customer] = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.phoneNumber, booking.phoneNumber));

  // Fetch games played
  const dbGames = await db
    .select({
      id: gamesTable.id,
      name: gamesTable.name
    })
    .from(bookingAndGames)
    .innerJoin(gamesTable, eq(bookingAndGames.gameId, gamesTable.id))
    .where(eq(bookingAndGames.bookingId, booking.id));

  // Fetch Admin who ended session
  const [adminUser] = adminId ? await db.select({ id: usersTable.id, email: usersTable.email, role: usersTable.role }).from(usersTable).where(eq(usersTable.id, adminId)) : [null];

  // Format timings
  const startFormatted = actualStartTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  const endFormatted = actualEndTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  const sessionDateFormatted = actualStartTime.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const hours = Math.floor(elapsedMinutes / 60);
  const mins = elapsedMinutes % 60;
  const durationFormatted = hours > 0 ? `${hours} hr${hours > 1 ? 's' : ''} ${mins} min${mins !== 1 ? 's' : ''}` : `${mins} mins`;

  return {
    success: true,
    message: `Session ended successfully for ${snapshot.instanceName || `Setup #${booking.setupId}`}.`,
    sessionSummary: {
      bookingId: booking.id,
      status: "COMPLETED",
      customer: {
        name: customer?.name || "Customer",
        phoneNumber: booking.phoneNumber,
        dateOfBirth: customer?.dateOfBirth || null
      },
      setup: {
        instanceId: booking.setupId,
        instanceName: snapshot.instanceName || snapshot.name || "Setup",
        configurationName: snapshot.name || "Configuration",
        consoleType: snapshot.consoleType || "PS5"
      },
      timing: {
        sessionDate: sessionDateFormatted,
        startTime: startFormatted,
        endTime: endFormatted,
        actualStartTime: actualStartTime.toISOString(),
        actualEndTime: actualEndTime.toISOString(),
        elapsedMinutes,
        chargedMinutes: roundedMinutes,
        durationFormatted,
        scheduledDurationHours,
        actualDurationHours
      },
      players: {
        playersCount: count,
        playerType: isSingle ? "SINGLE_PLAYER" : "MULTIPLAYER"
      },
      gamesPlayed: dbGames,
      billing: {
        ratePerPersonPerHour,
        calculationFormula: `₹${ratePerPersonPerHour}/player/hr × ${count} player(s) × ${actualDurationHours} hr(s) = ₹${finalOriginalAmount}`,
        originalAmount: finalOriginalAmount,
        discountApplied,
        finalAmountCharged,
        initialAmountPaid,
        settlement: {
          status: settlementStatus,
          amount: Math.abs(balanceDiff),
          note: settlementNote
        },
        cashAmount: updatedBooking.cashAmount,
        upiAmount: updatedBooking.upiAmount
      },
      appliedOffers,
      endedByAdmin: adminUser ? {
        id: adminUser.id,
        email: adminUser.email,
        role: adminUser.role
      } : null,
      completedAt: actualEndTime.toISOString()
    }
  };
}

// 5e. POST /api/setups/:setupId/end-session - End active session on a setup instance (Restricted to Admin/Super Admin)
api.post('/setups/:setupId/end-session', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const setupId = parseInt(c.req.param('setupId'), 10);
    if (isNaN(setupId)) {
      return c.json({ success: false, error: "Invalid setup ID" }, 400);
    }
    const jwtPayload = c.get('jwtPayload') as any;
    const adminId = jwtPayload?.id;

    const result = await handleEndSessionLogic({ setupId, adminId });
    return c.json(result);
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Alias: POST /api/setups/:setupId/terminate
api.post('/setups/:setupId/terminate', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const setupId = parseInt(c.req.param('setupId'), 10);
    if (isNaN(setupId)) {
      return c.json({ success: false, error: "Invalid setup ID" }, 400);
    }
    const jwtPayload = c.get('jwtPayload') as any;
    const adminId = jwtPayload?.id;

    const result = await handleEndSessionLogic({ setupId, adminId });
    return c.json(result);
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// 5f. POST /api/bookings/:id/end-session - End session for a booking ID (Restricted to Admin/Super Admin)
api.post('/bookings/:id/end-session', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const bookingId = parseInt(c.req.param('id'), 10);
    if (isNaN(bookingId)) {
      return c.json({ success: false, error: "Invalid booking ID" }, 400);
    }
    const jwtPayload = c.get('jwtPayload') as any;
    const adminId = jwtPayload?.id;

    const result = await handleEndSessionLogic({ bookingId, adminId });
    return c.json(result);
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Alias: POST /api/bookings/:id/terminate
api.post('/bookings/:id/terminate', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const bookingId = parseInt(c.req.param('id'), 10);
    if (isNaN(bookingId)) {
      return c.json({ success: false, error: "Invalid booking ID" }, 400);
    }
    const jwtPayload = c.get('jwtPayload') as any;
    const adminId = jwtPayload?.id;

    const result = await handleEndSessionLogic({ bookingId, adminId });
    return c.json(result);
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

const applyDiscountSchema = z.object({
  offerIds: z.array(z.number().int().positive("Invalid offer ID"))
});

// 5f. POST /api/bookings/:id/apply-discount - Update and apply a custom list of discounts to a booking (Restricted to Admin/Super Admin)
api.post('/bookings/:id/apply-discount', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ success: false, error: "Invalid booking ID" }, 400);
    }

    const body = await c.req.json();
    const validated = applyDiscountSchema.safeParse(body);
    if (!validated.success) {
      return c.json({ success: false, error: "Validation failed", details: validated.error.format() }, 400);
    }

    const { offerIds } = validated.data;

    // 1. Fetch booking
    const [booking] = await db
      .select()
      .from(bookingTable)
      .where(eq(bookingTable.id, id));

    if (!booking) {
      return c.json({ success: false, error: "Booking not found" }, 404);
    }

    if (booking.status === 'CANCELLED') {
      return c.json({ success: false, error: "Cannot apply discounts to a cancelled booking" }, 400);
    }

    const snapshot = booking.setupSnapshot as Record<string, any> | null;
    const chargePerPersonPerHour = snapshot?.chargePerPersonPerHour;
    if (chargePerPersonPerHour === undefined) {
      return c.json({ success: false, error: "Setup charge metadata missing in booking snapshot" }, 400);
    }

    // Determine the duration of the booking to pro-rate calculations
    const startTime = booking.actualStartTime || booking.startTime;
    const endTime = booking.actualEndTime || booking.endTime;
    const durationHours = Math.max(0.25, (new Date(endTime).getTime() - new Date(startTime).getTime()) / (1000 * 60 * 60));

    const count = booking.count;

    // 2. Evaluate the hardcoded promotions against the booking.
    const startDate = new Date(startTime);
    const offerEvaluation = evaluatePromotions({
      setup: {
        id: Number(snapshot?.setupConfigurationId ?? booking.setupId ?? 0),
        name: String(snapshot?.name ?? snapshot?.instanceName ?? 'Setup'),
        consoleType: String(snapshot?.consoleType ?? 'Console'),
        price: Number(snapshot?.price ?? chargePerPersonPerHour),
        singlePlayerPrice: Number(snapshot?.singlePlayerPrice ?? chargePerPersonPerHour),
        multiplayerPrice: Number(snapshot?.multiplayerPrice ?? chargePerPersonPerHour)
      },
      playersCount: count,
      dateStr: startDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
      startTimeStr: startDate.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata'
      }),
      durationHours,
      selectedOfferIds: offerIds
    });
    const amountCharged = offerEvaluation.totalAmount;
    const appliedPromotions = offerEvaluation.appliedOffers;

    // 3. Write updates inside transaction
    const updatedBooking = await db.transaction(async (tx) => {
      // Clear existing discount mappings
      await tx
        .delete(bookingAndOffersTable)
        .where(eq(bookingAndOffersTable.bookingId, id));

      // Link new discounts
      for (const promo of appliedPromotions) {
        await tx
          .insert(bookingAndOffersTable)
          .values({
            bookingId: id,
            offerId: promo.id
          });
      }

      // Update booking entry
      const [updated] = await tx
        .update(bookingTable)
        .set({
          amountCharged,
          updatedAt: new Date()
        })
        .where(eq(bookingTable.id, id))
        .returning();

      return updated;
    });

    return c.json({
      success: true,
      message: "Discounts successfully applied.",
      appliedOffers: appliedPromotions,
      booking: updatedBooking
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Helper function to generate 14 hourly slots from 10:00 AM on dateStr to 12:00 AM (midnight) in IST (UTC+05:30)
function getSlotsForDate(dateStr: string) {
  const slots: Array<{ startTime: Date; endTime: Date }> = [];
  const [year, month, day] = dateStr.split('-').map(Number);
  
  // 10:00 AM IST corresponds to 04:30 AM UTC (10:00 - 05:30)
  const baseDate = new Date(Date.UTC(year, month - 1, day, 4, 30, 0, 0));
  
  for (let i = 0; i < 14; i++) {
    const slotStart = new Date(baseDate.getTime() + i * 60 * 60 * 1000);
    const slotEnd = new Date(baseDate.getTime() + (i + 1) * 60 * 60 * 1000);
    slots.push({ startTime: slotStart, endTime: slotEnd });
  }
  return slots;
}

const slotsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in format YYYY-MM-DD"),
  setupConfigurationId: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().int().positive()),
  lockToken: z.string().optional()
});

const lockIntervalSchema = z.object({
  setupConfigurationId: z.number().int().positive("Invalid setup configuration ID"),
  lockToken: z.string().min(1, "lockToken is required"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in format YYYY-MM-DD"),
  startTime: z.string().min(1, "Start time is required"),
  noOfHours: z.number().int().positive("noOfHours must be at least 1")
});

// 5a. GET /api/slots/available - List all bookable slots for a setup on a date (Public)
api.get('/slots/available', async (c) => {
  try {
    const query = c.req.query();
    const validated = slotsQuerySchema.safeParse(query);
    if (!validated.success) {
      return c.json({ success: false, error: "Invalid query parameters", details: validated.error.format() }, 400);
    }
    const { date, setupConfigurationId } = validated.data;

    const [config] = await db
      .select()
      .from(setupConfigurationsTable)
      .where(eq(setupConfigurationsTable.id, setupConfigurationId));
    if (!config) return c.json({ success: false, error: "Setup configuration not found" }, 404);

    const slots = getSlotsForDate(date).map((slot) => ({
      startTime: slot.startTime.toISOString(),
      endTime: slot.endTime.toISOString(),
      startTimeFormatted: slot.startTime.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata'
      }),
      endTimeFormatted: slot.endTime.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata'
      }),
      status: 'AVAILABLE'
    }));

    return c.json({
      success: true,
      date,
      setupConfigurationId,
      slots,
      bookedIntervals: [],
      tentativeIntervals: [],
      lockedIntervals: []
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 5b. POST /api/slots/lock - Temporary lock an interval during checkout (Restricted to Admin/Super Admin)
api.post('/slots/lock', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const jwtPayload = c.get('jwtPayload') as { id?: number };
    const userId = jwtPayload?.id;
    const body = await c.req.json();
    const validated = lockIntervalSchema.safeParse(body);
    if (!validated.success) {
      return c.json({ success: false, error: "Validation failed", details: validated.error.format() }, 400);
    }
    const { setupConfigurationId, lockToken, date, startTime, noOfHours } = validated.data;

    const [configuration] = await db
      .select()
      .from(setupConfigurationsTable)
      .where(
        and(
          eq(setupConfigurationsTable.id, setupConfigurationId),
          eq(setupConfigurationsTable.isActive, true)
        )
      );
    if (!configuration) {
      return c.json({ success: false, error: "Setup configuration was not found or is inactive" }, 404);
    }
    const configurationInstances = await db
      .select()
      .from(setupsTable)
      .where(
        and(
          eq(setupsTable.setupConfigurationId, setupConfigurationId),
          eq(setupsTable.isActive, true)
        )
      );
    if (configurationInstances.length === 0) {
      return c.json({ success: false, error: "Setup configuration has no active instances" }, 409);
    }

    const requestedStart = parseTimeToDate(date, startTime);
    const requestedEnd = new Date(requestedStart.getTime() + noOfHours * 60 * 60 * 1000);
    const lockedUntil = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${setupConfigurationId})`);

      const configurationInstanceIds = configurationInstances.map((setup) => setup.id);
      const confirmedIntervals = await tx
        .select({
          setupId: bookingTable.setupId,
          startTime: bookingTable.startTime,
          endTime: bookingTable.endTime
        })
        .from(bookingTable)
        .where(
          and(
            inArray(bookingTable.setupId, configurationInstanceIds),
            lt(bookingTable.startTime, requestedEnd),
            gt(bookingTable.endTime, requestedStart),
            ne(bookingTable.status, 'CANCELLED')
          )
        );
      const tentativeIntervals = await tx
        .select({
          startTime: tentativeBookingTable.startTime,
          endTime: tentativeBookingTable.endTime
        })
        .from(tentativeBookingTable)
        .where(
          and(
            eq(tentativeBookingTable.setupConfigurationId, setupConfigurationId),
            lt(tentativeBookingTable.startTime, requestedEnd),
            gt(tentativeBookingTable.endTime, requestedStart)
          )
        );
      const lockIntervals = await tx
        .select({
          setupId: slotLocksTable.setupId,
          startTime: slotLocksTable.startTime,
          endTime: slotLocksTable.endTime
        })
        .from(slotLocksTable)
        .where(
          and(
            inArray(slotLocksTable.setupId, configurationInstanceIds),
            lt(slotLocksTable.startTime, requestedEnd),
            gt(slotLocksTable.endTime, requestedStart),
            gt(slotLocksTable.lockedUntil, new Date()),
            ne(slotLocksTable.lockToken, lockToken)
          )
        );
      if (!hasConfigurationCapacity(
        [...confirmedIntervals, ...tentativeIntervals, ...lockIntervals],
        requestedStart,
        requestedEnd,
        configurationInstances.length
      )) {
        throw new Error("No setup instance is available for this configuration and interval.");
      }

      await tx
        .delete(slotLocksTable)
        .where(eq(slotLocksTable.lockToken, lockToken));

      const occupiedInstanceIds = new Set([
        ...confirmedIntervals.map((interval) => interval.setupId),
        ...lockIntervals.map((interval) => interval.setupId)
      ]);
      const selectedInstance = configurationInstances.find(
        (instance) => !occupiedInstanceIds.has(instance.id)
      );
      if (!selectedInstance) {
        throw new Error("No setup instance is available for this configuration and interval.");
      }

      const [lockRecord] = await tx
        .insert(slotLocksTable)
        .values({
          setupId: selectedInstance.id,
          userId: userId ?? null,
          lockToken,
          slotDate: date,
          startTime: requestedStart,
          endTime: requestedEnd,
          lockedUntil
        })
        .returning();

      return lockRecord;
    });

    return c.json({
      success: true,
      message: "Configuration interval successfully locked for 5 minutes",
      lock: {
        id: result.id,
        setupConfigurationId,
        lockToken: result.lockToken,
        startTime: result.startTime,
        endTime: result.endTime,
        lockedUntil: result.lockedUntil
      }
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// 6. POST /api/games - Add a new game (ADMIN or SUPER_ADMIN only)
const gameSchema = z.object({
  name: z.string().min(1, "Name is required"),
  price: z.number().int().default(0),
  isActive: z.boolean().default(true)
});

api.post('/games', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const body = await c.req.json();
    const result = gameSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, error: "Validation failed", details: result.error.format() }, 400);
    }

    const { name, price, isActive } = result.data;

    const [existing] = await db
      .select()
      .from(gamesTable)
      .where(eq(gamesTable.name, name));

    if (existing) {
      return c.json({ success: false, error: "Game already exists" }, 400);
    }

    const [game] = await db
      .insert(gamesTable)
      .values({ name, price, isActive })
      .returning();

    return c.json({ success: true, game });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 7a. POST /api/setup-configurations - Add a new setup configuration (ADMIN or SUPER_ADMIN only)
const setupConfigSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  consoleType: z.string().default('PS5'),
  screenType: z.string().optional(),
  price: z.number().int().default(0),
  singlePlayerPrice: z.number().int().optional(),
  multiplayerPrice: z.number().int().optional(),
  extendedConfigurations: z.record(z.string(), z.any()).optional(),
  isActive: z.boolean().default(true)
});

api.post('/setup-configurations', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const body = await c.req.json();
    const result = setupConfigSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, error: "Validation failed", details: result.error.format() }, 400);
    }

    const { name, description, consoleType, screenType, price, singlePlayerPrice, multiplayerPrice, extendedConfigurations, isActive } = result.data;

    const [existing] = await db
      .select()
      .from(setupConfigurationsTable)
      .where(eq(setupConfigurationsTable.name, name));

    if (existing) {
      return c.json({ success: false, error: "Setup configuration already exists" }, 400);
    }

    const [config] = await db
      .insert(setupConfigurationsTable)
      .values({
        name,
        description,
        consoleType,
        screenType,
        price,
        singlePlayerPrice: singlePlayerPrice ?? price,
        multiplayerPrice: multiplayerPrice ?? price,
        extendedConfigurations,
        isActive
      })
      .returning();

    return c.json({ success: true, config });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 7b. POST /api/setups - Add a new setup instance (ADMIN or SUPER_ADMIN only)
const setupSchema = z.object({
  setupConfigurationId: z.number().int().positive("Invalid configuration ID"),
  name: z.string().min(1, "Name is required"),
  images: z.array(z.string()).optional(),
  videos: z.array(z.string()).optional(),
  isActive: z.boolean().default(true)
});

api.post('/setups', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const body = await c.req.json();
    const result = setupSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, error: "Validation failed", details: result.error.format() }, 400);
    }

    const { setupConfigurationId, name, images, videos, isActive } = result.data;

    // Check if configuration exists
    const [config] = await db
      .select()
      .from(setupConfigurationsTable)
      .where(eq(setupConfigurationsTable.id, setupConfigurationId));

    if (!config) {
      return c.json({ success: false, error: "Setup configuration not found" }, 404);
    }

    const [existing] = await db
      .select()
      .from(setupsTable)
      .where(eq(setupsTable.name, name));

    if (existing) {
      return c.json({ success: false, error: "Setup instance with this name already exists" }, 400);
    }

    const [setup] = await db
      .insert(setupsTable)
      .values({
        setupConfigurationId,
        name,
        images: images || [],
        videos: videos || [],
        isActive
      })
      .returning();

    return c.json({ success: true, setup });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 8. POST /api/offers - Add a new offer (ADMIN or SUPER_ADMIN only)
const offerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  isActive: z.boolean().default(true),
  offerType: z.enum(['EXCLUSIVE', 'INCLUSIVE']).default('EXCLUSIVE')
});

api.post('/offers', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const body = await c.req.json();
    const result = offerSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, error: "Validation failed", details: result.error.format() }, 400);
    }

    const { name, isActive, offerType } = result.data;

    const [existing] = await db
      .select()
      .from(offerTable)
      .where(eq(offerTable.name, name));

    if (existing) {
      return c.json({ success: false, error: "Offer already exists" }, 400);
    }

    const [offer] = await db
      .insert(offerTable)
      .values({ name, isActive, offerType })
      .returning();

    return c.json({ success: true, offer });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

api.get('/setup-instances/occupancy', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const setups = await db
      .select()
      .from(setupsTable);

    const configs = await db
      .select()
      .from(setupConfigurationsTable)
      .where(eq(setupConfigurationsTable.isActive, true));

    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        role: usersTable.role
      })
      .from(usersTable);

    const now = new Date();

    // Fetch confirmed bookings that are active right now (actual slot allotments)
    const currentBookings = await db
      .select()
      .from(bookingTable)
      .where(
        and(
          lte(bookingTable.startTime, now),
          gte(bookingTable.endTime, now),
          ne(bookingTable.status, 'CANCELLED')
        )
      );

    const occupancy = setups.map((setup) => {
      const config = configs.find((cfg) => cfg.id === setup.setupConfigurationId);
      const activeBooking = currentBookings.find((b) => b.setupId === setup.id);

      const status = activeBooking ? "OCCUPIED" : "AVAILABLE";

      let timeLeftMinutes = null;
      let timeLeftFormatted = null;

      if (activeBooking) {
        const endTimeMs = new Date(activeBooking.endTime).getTime();
        const diffMs = endTimeMs - now.getTime();
        if (diffMs > 0) {
          timeLeftMinutes = Math.floor(diffMs / (1000 * 60));
          const hours = Math.floor(timeLeftMinutes / 60);
          const mins = timeLeftMinutes % 60;
          timeLeftFormatted = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        } else {
          timeLeftMinutes = 0;
          timeLeftFormatted = "0m";
        }
      }

      const bookedByUser = activeBooking?.bookedBy ? users.find(u => u.id === activeBooking.bookedBy) : null;

      return {
        instanceId: setup.id,
        instanceName: setup.name,
        isActive: setup.isActive,
        setup: config ? {
          id: config.id,
          name: config.name,
          consoleType: config.consoleType,
          basePrice: config.price,
          singlePlayerPrice: (config.singlePlayerPrice && config.singlePlayerPrice > 0)
            ? config.singlePlayerPrice
            : config.price,
          multiplayerPrice: (config.multiplayerPrice && config.multiplayerPrice > 0)
            ? config.multiplayerPrice
            : config.price,
          pricingUnit: 'PER_PERSON_PER_HOUR'
        } : null,
        status,
        currentBooking: activeBooking ? {
          bookingId: activeBooking.id,
          phoneNumber: activeBooking.phoneNumber,
          playersCount: activeBooking.count,
          status: activeBooking.status,
          startTime: activeBooking.startTime,
          endTime: activeBooking.endTime,
          originalAmount: activeBooking.originalAmount,
          amountCharged: activeBooking.amountCharged,
          bookedBy: activeBooking.bookedBy,
          bookedByAdmin: bookedByUser ? {
            id: bookedByUser.id,
            email: bookedByUser.email,
            role: bookedByUser.role
          } : null,
          timeLeftMinutes,
          timeLeftFormatted
        } : null
      };
    });

    return c.json({ success: true, occupancy });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 7. GET /api/sessions/past - Get past console sessions for a given date (Restricted to Admin/Super Admin)
const pastSessionsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in format YYYY-MM-DD").optional(),
  setupInstanceId: z.string().transform((val) => parseInt(val, 10)).pipe(z.number().int().positive()).optional(),
  status: z.enum(['ALL', 'CONFIRMED', 'CANCELLED']).optional().default('ALL')
});

api.get('/sessions/past', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const query = c.req.query();
    const validated = pastSessionsQuerySchema.safeParse(query);
    if (!validated.success) {
      return c.json({ success: false, error: "Invalid query parameters", details: validated.error.format() }, 400);
    }

    const { date, setupInstanceId, status } = validated.data;

    // Use provided date or default to today's date in Asia/Kolkata timezone (GMT+05:30)
    const targetDate = date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const dayStart = new Date(`${targetDate}T00:00:00+05:30`);
    const dayEnd = new Date(`${targetDate}T23:59:59.999+05:30`);

    // Build filter conditions
    const conditions = [
      gte(bookingTable.startTime, dayStart),
      lte(bookingTable.startTime, dayEnd)
    ];

    if (setupInstanceId) {
      conditions.push(eq(bookingTable.setupId, setupInstanceId));
    }

    if (status && status !== 'ALL') {
      conditions.push(eq(bookingTable.status, status as any));
    }

    // 1. Fetch bookings matching the date criteria
    const bookings = await db
      .select()
      .from(bookingTable)
      .where(and(...conditions))
      .orderBy(desc(bookingTable.startTime));

    // 2. Fetch all setup instances and configurations for enrichment
    const setups = await db.select().from(setupsTable);
    const configs = await db.select().from(setupConfigurationsTable);

    // 3. Fetch linked games and offers for these bookings
    const bookingIds = bookings.map((b) => b.id);

    let gamesByBookingId: Record<number, Array<{ id: number; name: string; price: number | null; images: string[] }>> = {};
    let offersByBookingId: Record<number, Array<{ id: number; name: string; offerType: string | null }>> = {};

    if (bookingIds.length > 0) {
      const linkedGames = await db
        .select({
          bookingId: bookingAndGames.bookingId,
          game: {
            id: gamesTable.id,
            name: gamesTable.name,
            price: gamesTable.price,
            images: gamesTable.images
          }
        })
        .from(bookingAndGames)
        .innerJoin(gamesTable, eq(bookingAndGames.gameId, gamesTable.id))
        .where(inArray(bookingAndGames.bookingId, bookingIds));

      for (const item of linkedGames) {
        if (!gamesByBookingId[item.bookingId]) {
          gamesByBookingId[item.bookingId] = [];
        }
        gamesByBookingId[item.bookingId].push(item.game);
      }

      const linkedOffers = await db
        .select({
          bookingId: bookingAndOffersTable.bookingId,
          offerId: bookingAndOffersTable.offerId
        })
        .from(bookingAndOffersTable)
        .where(inArray(bookingAndOffersTable.bookingId, bookingIds));

      for (const item of linkedOffers) {
        const offer = HARDCODED_OFFERS.find((candidate) => candidate.id === item.offerId);
        if (!offer) continue;
        if (!offersByBookingId[item.bookingId]) {
          offersByBookingId[item.bookingId] = [];
        }
        offersByBookingId[item.bookingId].push({
          id: offer.id,
          name: offer.name,
          offerType: offer.offerType
        });
      }
    }

    // 4. Map bookings into rich session objects
    let totalRevenue = 0;
    let totalCash = 0;
    let totalUpi = 0;
    let totalPlayers = 0;
    let totalDurationMinutes = 0;

    const sessions = bookings.map((booking) => {
      const setup = setups.find((s) => s.id === booking.setupId);
      const config = setup ? configs.find((c) => c.id === setup.setupConfigurationId) : null;
      const snapshot = booking.setupSnapshot as Record<string, any> | null;

      const effectiveStart = booking.actualStartTime || booking.startTime;
      const effectiveEnd = booking.actualEndTime || booking.endTime;

      const durationMs = new Date(effectiveEnd).getTime() - new Date(effectiveStart).getTime();
      const durationMinutes = Math.max(0, Math.round(durationMs / (1000 * 60)));
      const hours = Math.floor(durationMinutes / 60);
      const mins = durationMinutes % 60;
      const durationFormatted = hours > 0 ? (mins > 0 ? `${hours}h ${mins}m` : `${hours}h`) : `${mins}m`;

      const startTimeFormatted = new Date(booking.startTime).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata'
      });

      const endTimeFormatted = new Date(booking.endTime).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata'
      });

      const charged = booking.amountCharged || 0;
      const cash = booking.cashAmount || 0;
      const upi = booking.upiAmount || 0;

      if (booking.status !== 'CANCELLED') {
        totalRevenue += charged;
        totalCash += cash;
        totalUpi += upi;
        totalPlayers += booking.count;
        totalDurationMinutes += durationMinutes;
      }

      return {
        id: booking.id,
        bookingId: booking.id,
        phoneNumber: booking.phoneNumber,
        playersCount: booking.count,
        status: booking.status,
        startTime: booking.startTime,
        endTime: booking.endTime,
        actualStartTime: booking.actualStartTime,
        actualEndTime: booking.actualEndTime,
        startTimeFormatted,
        endTimeFormatted,
        durationMinutes,
        durationFormatted,
        pricing: {
          originalAmount: booking.originalAmount || 0,
          amountCharged: charged,
          cashAmount: cash,
          upiAmount: upi
        },
        setupInstance: {
          id: setup?.id ?? booking.setupId,
          name: setup?.name ?? snapshot?.instanceName ?? (booking.setupId ? `Console #${booking.setupId}` : 'Unknown Console'),
          configurationName: config?.name ?? snapshot?.name ?? 'Console Setup',
          consoleType: config?.consoleType ?? snapshot?.consoleType ?? 'PS5',
          screenType: config?.screenType ?? snapshot?.screenType ?? null
        },
        games: gamesByBookingId[booking.id] || [],
        offers: offersByBookingId[booking.id] || [],
        createdAt: booking.createdAt
      };
    });

    const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' };
    const dateFormatted = dayStart.toLocaleDateString('en-GB', dateOptions);

    return c.json({
      success: true,
      summary: {
        date: targetDate,
        dateFormatted,
        totalSessions: sessions.length,
        activeOrCompletedSessions: sessions.filter(s => s.status !== 'CANCELLED').length,
        cancelledSessions: sessions.filter(s => s.status === 'CANCELLED').length,
        totalRevenue,
        totalCash,
        totalUpi,
        totalPlayers,
        totalDurationMinutes,
        totalDurationFormatted: `${Math.floor(totalDurationMinutes / 60)}h ${totalDurationMinutes % 60}m`
      },
      sessions
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// GET /api/customers/lookup?phone=<phoneNumber> - Lookup customer by phone number (Admin only)
api.get('/customers/lookup', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const phone = c.req.query('phone');
    if (!phone) {
      return c.json({ success: false, error: 'Query parameter "phone" is required' }, 400);
    }

    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.phoneNumber, phone));

    if (!customer) {
      return c.json({ success: false, error: 'Customer not found' }, 404);
    }

    return c.json({
      success: true,
      customer: {
        id: customer.id,
        phoneNumber: customer.phoneNumber,
        name: customer.name,
        dateOfBirth: customer.dateOfBirth,
        createdAt: customer.createdAt,
        updatedAt: customer.updatedAt
      }
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Helper function to parse session duration flexibly (handles numbers in hours/minutes, strings like "90m", "1.5h", etc.)
function parseSessionDurationInput(rawDuration: any, rawHours?: any, rawMinutes?: any): number {
  if (rawHours !== undefined && rawHours !== null && rawHours !== '') {
    const h = parseFloat(String(rawHours));
    if (!isNaN(h) && h > 0) return h;
  }
  if (rawMinutes !== undefined && rawMinutes !== null && rawMinutes !== '') {
    const m = parseFloat(String(rawMinutes));
    if (!isNaN(m) && m > 0) return m / 60;
  }
  if (typeof rawDuration === 'number') {
    if (rawDuration <= 0) return 1;
    if (rawDuration >= 15 && Number.isInteger(rawDuration)) return rawDuration / 60;
    return rawDuration;
  }
  if (typeof rawDuration === 'string') {
    const s = rawDuration.trim().toLowerCase();
    const minMatch = s.match(/^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes)$/);
    if (minMatch) return parseFloat(minMatch[1]) / 60;
    const hrMatch = s.match(/^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours)?$/);
    if (hrMatch) {
      const val = parseFloat(hrMatch[1]);
      if (val >= 15 && !s.includes('h') && !s.includes('hr')) return val / 60;
      return val;
    }
  }
  return 1;
}

// Price Calculation Handler logic
async function handlePriceCalculation(c: any, input: { setupConfigurationId?: any; noOfPlayers?: any; sessionDuration?: any; noOfHours?: any; durationMinutes?: any }) {
  const setupConfigurationIdRaw = input.setupConfigurationId;
  if (!setupConfigurationIdRaw) {
    return c.json({ success: false, error: 'setupConfigurationId is required' }, 400);
  }

  const setupConfigurationId = parseInt(String(setupConfigurationIdRaw), 10);
  if (isNaN(setupConfigurationId) || setupConfigurationId <= 0) {
    return c.json({ success: false, error: 'Invalid setupConfigurationId' }, 400);
  }

  const players = input.noOfPlayers !== undefined && input.noOfPlayers !== null && input.noOfPlayers !== ''
    ? Math.max(1, parseInt(String(input.noOfPlayers), 10) || 1)
    : 1;

  const durationHours = parseSessionDurationInput(input.sessionDuration, input.noOfHours, input.durationMinutes);

  const [config] = await db
    .select()
    .from(setupConfigurationsTable)
    .where(eq(setupConfigurationsTable.id, setupConfigurationId));

  if (!config) {
    return c.json({ success: false, error: 'Setup configuration not found' }, 404);
  }

  const result = calculatePriceForRule(config, players, durationHours);

  return c.json({
    success: true,
    basePrice: result.basePrice,
    pricing: {
      setupConfigurationId,
      setupName: config.name,
      configurationName: config.name,
      playerType: result.playerType,
      noOfPlayers: players,
      sessionDurationHours: durationHours,
      ratePerPersonPerHour: result.ratePerPersonPerHour,
      basePrice: result.basePrice,
      calculationFormula: result.calculationFormula
    }
  });
}

// POST /api/price - Calculate base price for a setup session
api.post('/price', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const setupConfigurationId = body.setupConfigurationId ?? body.setupId ?? body.setup_id;
    const noOfPlayers = body.noOfPlayers ?? body.no_of_players ?? body.players ?? body.count ?? body.noOfPersons;
    const sessionDuration = body.sessionDuration ?? body.session_duration ?? body.duration ?? body.noOfHours ?? body.durationHours;
    const noOfHours = body.noOfHours ?? body.durationHours;
    const durationMinutes = body.durationMinutes ?? body.session_duration_minutes;

    return await handlePriceCalculation(c, { setupConfigurationId, noOfPlayers, sessionDuration, noOfHours, durationMinutes });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// GET /api/price - Calculate base price via query parameters
api.get('/price', async (c) => {
  try {
    const setupConfigurationId = c.req.query('setupConfigurationId') || c.req.query('setupId') || c.req.query('setup_id');
    const noOfPlayers = c.req.query('noOfPlayers') || c.req.query('no_of_players') || c.req.query('players') || c.req.query('count');
    const sessionDuration = c.req.query('sessionDuration') || c.req.query('session_duration') || c.req.query('duration') || c.req.query('noOfHours');
    const noOfHours = c.req.query('noOfHours') || c.req.query('durationHours');
    const durationMinutes = c.req.query('durationMinutes');

    return await handlePriceCalculation(c, { setupConfigurationId, noOfPlayers, sessionDuration, noOfHours, durationMinutes });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default api;

