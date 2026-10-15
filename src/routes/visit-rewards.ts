import { Hono } from 'hono';
import { and, desc, eq, gt, isNotNull, isNull, lte, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '../core/db/index.js';
import {
  bookingTable,
  visitRewardCodesTable,
  visitRewardsTable
} from '../core/db/schema.js';
import {
  approveVisit,
  getCustomerCoupons,
  getVisitProgress,
  normalizeCode,
  phoneNumberSchema,
  redeemRewardCode,
  requestVisit,
  VisitRewardError
} from '../core/visit-rewards.js';
import { authMiddleware, requireRole } from '../middlewares/auth.js';

const visitRewards = new Hono();

interface AuthPayload {
  id?: number;
}

const requestVisitSchema = z.object({
  phoneNumber: phoneNumberSchema,
  name: z.string().trim().min(1).max(255)
});

const statusQuerySchema = z.object({
  phone: phoneNumberSchema
});

const listVisitsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'all']).default('pending'),
  phone: phoneNumberSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const listCodesQuerySchema = z.object({
  status: z.enum(['active', 'redeemed', 'expired', 'all']).default('active'),
  phone: phoneNumberSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const redeemSchema = z.object({
  code: z.string().trim().min(1).max(32),
  phoneNumber: phoneNumberSchema.optional(),
  bookingId: z.number().int().positive().optional()
});

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validationError(error: z.ZodError) {
  return {
    success: false as const,
    error: "Validation failed",
    details: z.treeifyError(error)
  };
}

function codeView(code: typeof visitRewardCodesTable.$inferSelect) {
  const now = Date.now();
  const status = code.redeemedAt
    ? 'REDEEMED'
    : code.expiresAt.getTime() <= now
      ? 'EXPIRED'
      : 'ACTIVE';
  return { ...code, status };
}

// 1. POST /api/visit-rewards/visits - Public: customer claims they visited today
visitRewards.post('/visit-rewards/visits', async (c) => {
  try {
    const parsed = requestVisitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(validationError(parsed.error), 400);
    }

    const visit = await requestVisit(parsed.data);

    const progress = await getVisitProgress(parsed.data.phoneNumber);
    return c.json(
      {
        success: true,
        message: "Visit request submitted. It will count once an admin approves it.",
        visit: {
          id: visit.id,
          phoneNumber: visit.phoneNumber,
          name: visit.name,
          dateOfVisit: visit.dateOfVisit,
          isApproved: visit.isApproved
        },
        progress
      },
      201
    );
  } catch (error: unknown) {
    console.error(error);
    return c.json({ success: false, error: "Failed to submit visit request" }, 500);
  }
});

// 2. GET /api/visit-rewards/status?phone= - Public: the customer's reward status.
// Includes their coupon code(s) once unlocked, so they can show it to staff.
visitRewards.get('/visit-rewards/status', async (c) => {
  try {
    const parsed = statusQuerySchema.safeParse({ phone: c.req.query('phone') });
    if (!parsed.success) {
      return c.json(validationError(parsed.error), 400);
    }

    const [progress, coupons] = await Promise.all([
      getVisitProgress(parsed.data.phone),
      getCustomerCoupons(parsed.data.phone)
    ]);
    const activeCoupons = coupons.filter((coupon) => coupon.status === 'ACTIVE');

    let state: 'NO_VISITS' | 'IN_PROGRESS' | 'REWARD_UNLOCKED';
    let message: string;
    if (activeCoupons.length > 0) {
      state = 'REWARD_UNLOCKED';
      message = activeCoupons.length === 1
        ? "Reward unlocked! Show your coupon code to the staff for a free visit."
        : `Reward unlocked! You have ${activeCoupons.length} coupons. Show them to the staff for free visits.`;
    } else if (progress.approvedVisits > 0 || progress.pendingVisits > 0) {
      state = 'IN_PROGRESS';
      message = progress.visitsRemaining > 0
        ? `${progress.visitsRemaining} more approved visit${progress.visitsRemaining === 1 ? '' : 's'} to unlock a free visit.`
        : "Your visits are awaiting approval.";
    } else {
      state = 'NO_VISITS';
      message = `Visit us ${progress.requiredVisits} times in ${progress.windowDays} days to unlock a free visit.`;
    }

    return c.json({
      success: true,
      state,
      message,
      progress: { ...progress, activeCoupons: activeCoupons.length },
      coupons
    });
  } catch (error: unknown) {
    console.error(error);
    return c.json({ success: false, error: "Failed to load visit progress" }, 500);
  }
});

// 3. GET /api/visit-rewards/visits - Admin: list visit requests
visitRewards.get(
  '/visit-rewards/visits',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const parsed = listVisitsQuerySchema.safeParse(c.req.query());
      if (!parsed.success) {
        return c.json(validationError(parsed.error), 400);
      }
      const { status, phone, limit, offset } = parsed.data;

      const filters: SQL[] = [];
      if (status !== 'all') {
        filters.push(eq(visitRewardsTable.isApproved, status === 'approved'));
      }
      if (phone) filters.push(eq(visitRewardsTable.phoneNumber, phone));

      const visits = await db
        .select()
        .from(visitRewardsTable)
        .where(and(...filters))
        .orderBy(desc(visitRewardsTable.createdAt), desc(visitRewardsTable.id))
        .limit(limit)
        .offset(offset);

      return c.json({ success: true, count: visits.length, visits });
    } catch (error: unknown) {
      console.error(error);
      return c.json({ success: false, error: "Failed to list visit requests" }, 500);
    }
  }
);

// 4. POST /api/visit-rewards/visits/:id/approve - Admin: approve a visit request.
// If this completes the customer's required visits, a reward code is generated.
visitRewards.post(
  '/visit-rewards/visits/:id/approve',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const id = parseId(c.req.param('id'));
      if (!id) {
        return c.json({ success: false, error: "Invalid visit ID" }, 400);
      }

      const payload = c.get('jwtPayload') as AuthPayload;
      const result = await approveVisit(id, payload.id ?? null);
      const progress = await getVisitProgress(result.visit.phoneNumber);

      return c.json({
        success: true,
        message: result.rewardCode
          ? "Visit approved. Reward unlocked!"
          : "Visit approved",
        visit: result.visit,
        rewardCode: result.rewardCode ? codeView(result.rewardCode) : null,
        progress
      });
    } catch (error: unknown) {
      if (error instanceof VisitRewardError) {
        return c.json({ success: false, error: error.message }, error.status);
      }
      console.error(error);
      return c.json({ success: false, error: "Failed to approve visit request" }, 500);
    }
  }
);

// 5. DELETE /api/visit-rewards/visits/:id - Admin: reject (delete) a pending visit request
visitRewards.delete(
  '/visit-rewards/visits/:id',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const id = parseId(c.req.param('id'));
      if (!id) {
        return c.json({ success: false, error: "Invalid visit ID" }, 400);
      }

      const [deleted] = await db
        .delete(visitRewardsTable)
        .where(
          and(
            eq(visitRewardsTable.id, id),
            eq(visitRewardsTable.isApproved, false)
          )
        )
        .returning();
      if (deleted) {
        return c.json({ success: true, message: "Visit request rejected", visit: deleted });
      }

      const [existing] = await db
        .select({ id: visitRewardsTable.id })
        .from(visitRewardsTable)
        .where(eq(visitRewardsTable.id, id));
      return existing
        ? c.json({ success: false, error: "Approved visits cannot be rejected" }, 409)
        : c.json({ success: false, error: "Visit request not found" }, 404);
    } catch (error: unknown) {
      console.error(error);
      return c.json({ success: false, error: "Failed to reject visit request" }, 500);
    }
  }
);

// 6. GET /api/visit-rewards/codes - Admin: list reward codes
visitRewards.get(
  '/visit-rewards/codes',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const parsed = listCodesQuerySchema.safeParse(c.req.query());
      if (!parsed.success) {
        return c.json(validationError(parsed.error), 400);
      }
      const { status, phone, limit, offset } = parsed.data;

      const now = new Date();
      const filters: SQL[] = [];
      if (status === 'active') {
        filters.push(
          isNull(visitRewardCodesTable.redeemedAt),
          gt(visitRewardCodesTable.expiresAt, now)
        );
      } else if (status === 'redeemed') {
        filters.push(isNotNull(visitRewardCodesTable.redeemedAt));
      } else if (status === 'expired') {
        filters.push(
          isNull(visitRewardCodesTable.redeemedAt),
          lte(visitRewardCodesTable.expiresAt, now)
        );
      }
      if (phone) filters.push(eq(visitRewardCodesTable.phoneNumber, phone));

      const codes = await db
        .select()
        .from(visitRewardCodesTable)
        .where(and(...filters))
        .orderBy(desc(visitRewardCodesTable.createdAt), desc(visitRewardCodesTable.id))
        .limit(limit)
        .offset(offset);

      return c.json({ success: true, count: codes.length, codes: codes.map(codeView) });
    } catch (error: unknown) {
      console.error(error);
      return c.json({ success: false, error: "Failed to list reward codes" }, 500);
    }
  }
);

// 7. POST /api/visit-rewards/codes/redeem - Admin: redeem a code for a free visit
visitRewards.post(
  '/visit-rewards/codes/redeem',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const parsed = redeemSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(validationError(parsed.error), 400);
      }
      const { code, phoneNumber, bookingId } = parsed.data;

      if (bookingId) {
        const [booking] = await db
          .select({ id: bookingTable.id })
          .from(bookingTable)
          .where(eq(bookingTable.id, bookingId));
        if (!booking) {
          return c.json({ success: false, error: "Booking not found" }, 404);
        }
      }

      const payload = c.get('jwtPayload') as AuthPayload;
      const redeemed = await redeemRewardCode({
        code: normalizeCode(code),
        phoneNumber,
        bookingId,
        adminId: payload.id ?? null
      });

      return c.json({
        success: true,
        message: "Reward code redeemed. This visit is free.",
        rewardCode: codeView(redeemed)
      });
    } catch (error: unknown) {
      if (error instanceof VisitRewardError) {
        return c.json({ success: false, error: error.message }, error.status);
      }
      console.error(error);
      return c.json({ success: false, error: "Failed to redeem reward code" }, 500);
    }
  }
);

export default visitRewards;
