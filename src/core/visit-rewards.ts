import crypto from 'crypto';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import { db } from './db/index.js';
import {
  visitRewardCodesTable,
  visitRewardsTable
} from './db/schema.js';
import { addDaysIst, todayIst } from './time.js';

// Reward rules
export const REQUIRED_VISITS = 7;
export const REWARD_WINDOW_DAYS = 30; // "last 1 month"
export const CODE_VALIDITY_DAYS = 7;

const CODE_PREFIX = 'VTX-';
// No 0/O/1/I so codes are easy to read out at the counter
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_CODE_ATTEMPTS = 5;

// Namespaces the per-customer advisory lock so it can never collide with the
// setup-id based advisory locks used by bookings.
const VISIT_REWARD_LOCK_NAMESPACE = 7001;

export class VisitRewardError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 410
  ) {
    super(message);
    this.name = 'VisitRewardError';
  }
}

// Visits are tracked per phone number, so every spelling of the same number
// ("98765 43210", "+91 98765-43210", "09876543210") must map to one value:
// the 10-digit Indian mobile number.
export function normalizePhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export const phoneNumberSchema = z
  .string()
  .trim()
  .transform(normalizePhoneNumber)
  .pipe(
    z.string().regex(
      /^[6-9]\d{9}$/,
      "Enter a valid 10-digit mobile number"
    )
  );

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function generateRewardCode(): string {
  let suffix = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    suffix += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return `${CODE_PREFIX}${suffix}`;
}

export function rewardWindowStart(): string {
  return addDaysIst(todayIst(), -REWARD_WINDOW_DAYS);
}

function lockCustomer(tx: Pick<typeof db, 'execute'>, phoneNumber: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(${VISIT_REWARD_LOCK_NAMESPACE}, hashtext(${phoneNumber}))`
  );
}

/**
 * Records a visit claim for today (IST). The claim stays pending until an
 * admin approves it.
 *
 * TEMP: the one-claim-per-customer-per-day rule is disabled for testing.
 * To restore it, re-add a unique index on (phone_number, date_of_visit),
 * use `.onConflictDoNothing()` here, and return a 409 from the route when
 * nothing was inserted.
 */
export async function requestVisit(input: {
  phoneNumber: string;
  name: string;
}) {
  const [visit] = await db
    .insert(visitRewardsTable)
    .values({
      phoneNumber: input.phoneNumber,
      name: input.name,
      dateOfVisit: todayIst()
    })
    .returning();
  return visit;
}

/**
 * Approves a visit. If the customer now has REQUIRED_VISITS approved, unused
 * visits inside the reward window, those visits are consumed (is_used = true)
 * and a single-use reward code is generated.
 */
export async function approveVisit(visitId: number, adminId: number | null) {
  const [lookup] = await db
    .select({ phoneNumber: visitRewardsTable.phoneNumber })
    .from(visitRewardsTable)
    .where(eq(visitRewardsTable.id, visitId));
  if (!lookup) {
    throw new VisitRewardError("Visit request not found", 404);
  }

  return db.transaction(async (tx) => {
    // Serialize all approvals for one customer so concurrent approvals can't
    // both consume the same visits or issue two codes.
    await lockCustomer(tx, lookup.phoneNumber);

    const [visit] = await tx
      .select()
      .from(visitRewardsTable)
      .where(eq(visitRewardsTable.id, visitId));
    if (!visit) {
      throw new VisitRewardError("Visit request not found", 404);
    }
    if (visit.isApproved) {
      throw new VisitRewardError("Visit request is already approved", 409);
    }

    const [approved] = await tx
      .update(visitRewardsTable)
      .set({ isApproved: true, approvedBy: adminId, approvedAt: new Date() })
      .where(eq(visitRewardsTable.id, visitId))
      .returning();

    const windowStart = rewardWindowStart();
    const eligible = await tx
      .select({ id: visitRewardsTable.id })
      .from(visitRewardsTable)
      .where(
        and(
          eq(visitRewardsTable.phoneNumber, visit.phoneNumber),
          eq(visitRewardsTable.isApproved, true),
          eq(visitRewardsTable.isUsed, false),
          gte(visitRewardsTable.dateOfVisit, windowStart)
        )
      )
      // Consume the oldest visits first so the freshest ones keep counting
      .orderBy(asc(visitRewardsTable.dateOfVisit), asc(visitRewardsTable.id))
      .limit(REQUIRED_VISITS);

    if (eligible.length < REQUIRED_VISITS) {
      return {
        visit: approved,
        rewardCode: null,
        eligibleVisits: eligible.length
      };
    }

    const expiresAt = new Date(Date.now() + CODE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
    let rewardCode: typeof visitRewardCodesTable.$inferSelect | undefined;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && !rewardCode; attempt++) {
      [rewardCode] = await tx
        .insert(visitRewardCodesTable)
        .values({
          phoneNumber: visit.phoneNumber,
          code: generateRewardCode(),
          expiresAt
        })
        .onConflictDoNothing()
        .returning();
    }
    if (!rewardCode) {
      throw new Error("Failed to generate a unique reward code");
    }

    const consumed = await tx
      .update(visitRewardsTable)
      .set({ isUsed: true, rewardCodeId: rewardCode.id })
      .where(inArray(visitRewardsTable.id, eligible.map((row) => row.id)))
      .returning();

    return {
      visit: consumed.find((row) => row.id === visitId) ?? approved,
      rewardCode,
      eligibleVisits: 0
    };
  });
}

/**
 * Atomically redeems a reward code. A code can be redeemed once and only
 * before it expires.
 */
export async function redeemRewardCode(input: {
  code: string;
  phoneNumber?: string;
  bookingId?: number;
  adminId: number | null;
}) {
  const code = normalizeCode(input.code);

  const [existing] = await db
    .select()
    .from(visitRewardCodesTable)
    .where(eq(visitRewardCodesTable.code, code));
  if (!existing) {
    throw new VisitRewardError("Reward code not found", 404);
  }
  if (input.phoneNumber && existing.phoneNumber !== input.phoneNumber) {
    throw new VisitRewardError("Reward code does not belong to this phone number", 400);
  }

  // The conditional UPDATE is the source of truth: only one concurrent
  // request can flip redeemed_at from NULL, and only before expiry.
  const [redeemed] = await db
    .update(visitRewardCodesTable)
    .set({
      redeemedAt: new Date(),
      redeemedBy: input.adminId,
      redeemedBookingId: input.bookingId ?? null
    })
    .where(
      and(
        eq(visitRewardCodesTable.id, existing.id),
        isNull(visitRewardCodesTable.redeemedAt),
        gt(visitRewardCodesTable.expiresAt, new Date())
      )
    )
    .returning();
  if (redeemed) return redeemed;

  const [latest] = await db
    .select()
    .from(visitRewardCodesTable)
    .where(eq(visitRewardCodesTable.id, existing.id));
  if (latest?.redeemedAt) {
    throw new VisitRewardError("Reward code has already been used", 409);
  }
  throw new VisitRewardError("Reward code has expired", 410);
}

/** Progress towards the next reward for a customer. */
export async function getVisitProgress(phoneNumber: string) {
  const windowStart = rewardWindowStart();

  const [approved] = await db
    .select({ value: count() })
    .from(visitRewardsTable)
    .where(
      and(
        eq(visitRewardsTable.phoneNumber, phoneNumber),
        eq(visitRewardsTable.isApproved, true),
        eq(visitRewardsTable.isUsed, false),
        gte(visitRewardsTable.dateOfVisit, windowStart)
      )
    );
  const [pending] = await db
    .select({ value: count() })
    .from(visitRewardsTable)
    .where(
      and(
        eq(visitRewardsTable.phoneNumber, phoneNumber),
        eq(visitRewardsTable.isApproved, false)
      )
    );
  const [activeCode] = await db
    .select({ value: count() })
    .from(visitRewardCodesTable)
    .where(
      and(
        eq(visitRewardCodesTable.phoneNumber, phoneNumber),
        isNull(visitRewardCodesTable.redeemedAt),
        gt(visitRewardCodesTable.expiresAt, new Date())
      )
    );

  const approvedVisits = approved?.value ?? 0;
  return {
    requiredVisits: REQUIRED_VISITS,
    windowDays: REWARD_WINDOW_DAYS,
    codeValidityDays: CODE_VALIDITY_DAYS,
    approvedVisits,
    visitsRemaining: Math.max(0, REQUIRED_VISITS - approvedVisits),
    pendingVisits: pending?.value ?? 0,
    hasActiveRewardCode: (activeCode?.value ?? 0) > 0
  };
}

const MAX_COUPONS_SHOWN = 10;

export type CouponStatus = 'ACTIVE' | 'REDEEMED' | 'EXPIRED';

export function couponStatus(
  code: Pick<typeof visitRewardCodesTable.$inferSelect, 'redeemedAt' | 'expiresAt'>,
  now = new Date()
): CouponStatus {
  if (code.redeemedAt) return 'REDEEMED';
  return code.expiresAt <= now ? 'EXPIRED' : 'ACTIVE';
}

/**
 * Coupons for a customer, newest first, so the customer can see a code move
 * from ACTIVE to REDEEMED or EXPIRED.
 */
export async function getCustomerCoupons(phoneNumber: string) {
  const rows = await db
    .select()
    .from(visitRewardCodesTable)
    .where(eq(visitRewardCodesTable.phoneNumber, phoneNumber))
    .orderBy(desc(visitRewardCodesTable.createdAt), desc(visitRewardCodesTable.id))
    .limit(MAX_COUPONS_SHOWN);

  const now = new Date();
  return rows.map((row) => {
    const status = couponStatus(row, now);
    return {
      code: row.code,
      status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      redeemedAt: row.redeemedAt,
      // Whole hours left, only meaningful while ACTIVE
      expiresInHours: status === 'ACTIVE'
        ? Math.max(0, Math.floor((row.expiresAt.getTime() - now.getTime()) / 3_600_000))
        : null
    };
  });
}

// ---------------------------------------------------------------------------
// Applying coupons to a booking
// ---------------------------------------------------------------------------

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const MAX_COUPON_CODES_PER_REQUEST = 20;

/**
 * Normalizes the codes an admin typed in and enforces the booking rules:
 * no duplicates, and never more coupons than players.
 */
export function normalizeCouponCodes(
  codes: string[] | undefined,
  players: number
): string[] {
  const normalized = (codes ?? []).map(normalizeCode);
  const seen = new Set<string>();
  for (const code of normalized) {
    if (seen.has(code)) {
      throw new VisitRewardError(`Coupon ${code} was entered more than once`, 400);
    }
    seen.add(code);
  }
  if (normalized.length > players) {
    throw new VisitRewardError(
      `Cannot use ${normalized.length} coupon${normalized.length === 1 ? '' : 's'} for ${players} player${players === 1 ? '' : 's'}. Maximum is one coupon per player.`,
      400
    );
  }
  return normalized;
}

/** Throws a descriptive error unless every code exists, is unused and unexpired. */
export async function validateCoupons(codes: string[]) {
  if (codes.length === 0) return [];

  const rows = await db
    .select()
    .from(visitRewardCodesTable)
    .where(inArray(visitRewardCodesTable.code, codes));
  const byCode = new Map(rows.map((row) => [row.code, row]));

  for (const code of codes) {
    const row = byCode.get(code);
    if (!row) {
      throw new VisitRewardError(`Coupon ${code} not found`, 404);
    }
    const status = couponStatus(row);
    if (status === 'REDEEMED') {
      throw new VisitRewardError(`Coupon ${code} has already been used`, 409);
    }
    if (status === 'EXPIRED') {
      throw new VisitRewardError(`Coupon ${code} has expired`, 410);
    }
  }
  return codes.map((code) => byCode.get(code)!);
}

/**
 * Each coupon makes one player's share of the gameplay free. The share is the
 * gameplay total (after offers) divided by the players, so using one coupon per
 * player makes the whole gameplay free. Add-ons are never discounted.
 */
export function calculateCouponDiscount(
  gameplayTotal: number,
  players: number,
  couponCount: number
): number {
  if (couponCount <= 0 || players <= 0) return 0;
  const usable = Math.min(couponCount, players); // never more than one per player
  return Math.min(
    gameplayTotal,
    Math.round((gameplayTotal * usable) / players)
  );
}

/**
 * Number of coupons redeemed against a booking. Anything that re-prices a
 * booking later (extension, checkout) must apply the same coupon discount, or
 * the customer would be re-billed for the free player(s).
 */
export async function getBookingCouponCount(bookingId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(visitRewardCodesTable)
    .where(eq(visitRewardCodesTable.redeemedBookingId, bookingId));
  return row?.value ?? 0;
}

/**
 * Redeems every code for a booking inside the booking's transaction. The
 * conditional UPDATE is the source of truth, so two bookings racing for the
 * same code can't both win, and a failed booking never burns a code.
 */
export async function redeemCouponsForBooking(
  tx: DbTransaction,
  codes: string[],
  bookingId: number,
  adminId: number | null
) {
  if (codes.length === 0) return [];

  const redeemed = await tx
    .update(visitRewardCodesTable)
    .set({
      redeemedAt: new Date(),
      redeemedBy: adminId,
      redeemedBookingId: bookingId
    })
    .where(
      and(
        inArray(visitRewardCodesTable.code, codes),
        isNull(visitRewardCodesTable.redeemedAt),
        gt(visitRewardCodesTable.expiresAt, new Date())
      )
    )
    .returning();

  if (redeemed.length !== codes.length) {
    throw new VisitRewardError(
      "One or more coupons were just used or have expired. Please re-check the codes.",
      409
    );
  }
  return redeemed;
}
