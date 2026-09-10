import { Hono } from 'hono';
import * as z from 'zod';
import {
  getSessionAnalytics,
  resolveAnalyticsRange
} from '../core/analytics.js';
import { authMiddleware, requireRole } from '../middlewares/auth.js';

const analytics = new Hono();

const analyticsQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be in YYYY-MM format")
    .optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .optional()
}).refine((query) => !(query.month && query.date), {
  message: "Use either date or month, not both"
});

analytics.get(
  '/analytics/sessions',
  authMiddleware,
  requireRole(['SUPER_ADMIN']),
  async (c) => {
    try {
      const validated = analyticsQuerySchema.safeParse(c.req.query());
      if (!validated.success) {
        return c.json(
          {
            success: false,
            error: "Invalid query parameters",
            details: validated.error.format()
          },
          400
        );
      }

      const range = resolveAnalyticsRange(validated.data);
      const analyticsResult = await getSessionAnalytics(range);

      return c.json({
        success: true,
        analytics: analyticsResult
      });
    } catch (error: unknown) {
      console.error(error);
      return c.json(
        {
          success: false,
          error: error instanceof Error
            ? error.message
            : "Failed to generate session analytics"
        },
        500
      );
    }
  }
);

export default analytics;
