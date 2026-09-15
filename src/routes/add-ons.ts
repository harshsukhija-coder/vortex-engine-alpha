import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  getBookingAddOnSummary,
  resolveAddOnLines
} from '../core/add-ons.js';
import { db } from '../core/db/index.js';
import {
  addOnsTable,
  bookingAddOnsTable,
  bookingTable
} from '../core/db/schema.js';
import { authMiddleware, requireRole } from '../middlewares/auth.js';

const addOns = new Hono();

const addOnSchema = z.object({
  itemName: z.string().trim().min(1).max(255),
  price: z.number().int().nonnegative(),
  quantity: z.number().positive(),
  quantityUnit: z.string().trim().min(1).max(50),
  imageUrl: z.string().trim().url(),
  isActive: z.boolean().optional().default(true)
});

const updateAddOnSchema = addOnSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "Provide at least one field to update"
);

const bookingAddOnsSchema = z.object({
  items: z.array(z.object({
    addOnId: z.number().int().positive(),
    units: z.number().int().positive()
  })).min(1),
  cashAmount: z.number().int().nonnegative().optional(),
  upiAmount: z.number().int().nonnegative().optional()
});

interface AuthPayload {
  id?: number;
}

addOns.get(
  '/add-ons',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    const items = await db
      .select()
      .from(addOnsTable)
      .where(eq(addOnsTable.isActive, true))
      .orderBy(addOnsTable.itemName);

    return c.json({ success: true, count: items.length, addOns: items });
  }
);

addOns.post(
  '/add-ons',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const parsed = addOnSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json(
          {
            success: false,
            error: "Validation failed",
            details: parsed.error.format()
          },
          400
        );
      }

      const [created] = await db
        .insert(addOnsTable)
        .values(parsed.data)
        .returning();
      return c.json(
        {
          success: true,
          message: "Add-on created successfully",
          addOn: created
        },
        201
      );
    } catch (error: unknown) {
      console.error(error);
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to create add-on"
        },
        400
      );
    }
  }
);

addOns.put(
  '/add-ons/:id',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ success: false, error: "Invalid add-on ID" }, 400);
      }
      const parsed = updateAddOnSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json(
          {
            success: false,
            error: "Validation failed",
            details: parsed.error.format()
          },
          400
        );
      }

      const [updated] = await db
        .update(addOnsTable)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(addOnsTable.id, id))
        .returning();
      if (!updated) {
        return c.json({ success: false, error: "Add-on not found" }, 404);
      }

      return c.json({
        success: true,
        message: "Add-on updated successfully",
        addOn: updated
      });
    } catch (error: unknown) {
      console.error(error);
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to update add-on"
        },
        400
      );
    }
  }
);

addOns.get(
  '/bookings/:bookingId/add-ons',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    const bookingId = Number(c.req.param('bookingId'));
    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      return c.json({ success: false, error: "Invalid booking ID" }, 400);
    }

    const [booking] = await db
      .select({ id: bookingTable.id })
      .from(bookingTable)
      .where(eq(bookingTable.id, bookingId));
    if (!booking) {
      return c.json({ success: false, error: "Booking not found" }, 404);
    }

    const summary = await getBookingAddOnSummary(bookingId);
    return c.json({
      success: true,
      bookingId,
      addOns: summary.items,
      addOnsTotal: summary.total
    });
  }
);

addOns.post(
  '/bookings/:bookingId/add-ons',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const bookingId = Number(c.req.param('bookingId'));
      if (!Number.isInteger(bookingId) || bookingId <= 0) {
        return c.json({ success: false, error: "Invalid booking ID" }, 400);
      }
      const parsed = bookingAddOnsSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return c.json(
          {
            success: false,
            error: "Validation failed",
            details: parsed.error.format()
          },
          400
        );
      }

      const payload = c.get('jwtPayload') as AuthPayload;
      const resolved = await resolveAddOnLines(parsed.data.items);
      const addedCash = parsed.data.cashAmount
        ?? (parsed.data.upiAmount === undefined ? resolved.total : 0);
      const addedUpi = parsed.data.upiAmount ?? 0;
      if (addedCash + addedUpi !== resolved.total) {
        return c.json(
          {
            success: false,
            error: `Add-on payment must equal ₹${resolved.total}`
          },
          400
        );
      }

      const updatedBooking = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${bookingId})`);
        const [booking] = await tx
          .select()
          .from(bookingTable)
          .where(
            and(
              eq(bookingTable.id, bookingId),
              eq(bookingTable.status, 'CONFIRMED'),
              isNull(bookingTable.actualEndTime)
            )
          );
        if (!booking) {
          throw new Error("Add-ons can be added only to an active confirmed booking");
        }

        await tx.insert(bookingAddOnsTable).values(
          resolved.lines.map((line) => ({
            bookingId,
            addOnId: line.addOnId,
            itemName: line.itemName,
            unitPrice: line.unitPrice,
            itemQuantity: line.itemQuantity,
            quantityUnit: line.quantityUnit,
            imageUrl: line.imageUrl,
            units: line.units,
            lineTotal: line.lineTotal,
            addedBy: payload.id ?? null
          }))
        );

        const [updated] = await tx
          .update(bookingTable)
          .set({
            originalAmount: (booking.originalAmount ?? 0) + resolved.total,
            amountCharged: (booking.amountCharged ?? 0) + resolved.total,
            cashAmount: (booking.cashAmount ?? 0) + addedCash,
            upiAmount: (booking.upiAmount ?? 0) + addedUpi,
            updatedAt: new Date()
          })
          .where(eq(bookingTable.id, bookingId))
          .returning({
            id: bookingTable.id,
            originalAmount: bookingTable.originalAmount,
            amountCharged: bookingTable.amountCharged,
            cashAmount: bookingTable.cashAmount,
            upiAmount: bookingTable.upiAmount
          });

        return updated;
      });

      const summary = await getBookingAddOnSummary(bookingId);
      return c.json({
        success: true,
        message: "Add-ons attached to booking successfully",
        booking: updatedBooking,
        addedItems: resolved.lines,
        addedTotal: resolved.total,
        addOns: summary.items,
        addOnsTotal: summary.total
      });
    } catch (error: unknown) {
      console.error(error);
      return c.json(
        {
          success: false,
          error: error instanceof Error
            ? error.message
            : "Failed to attach add-ons"
        },
        400
      );
    }
  }
);

export default addOns;
