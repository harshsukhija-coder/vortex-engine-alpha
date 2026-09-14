import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '../core/db/index.js';
import {
  dailyMeterReadingsTable,
  usersTable
} from '../core/db/schema.js';
import {
  getMeterConsumptionAnalytics,
  MeterAnalyticsError
} from '../core/meter-analytics.js';
import { todayIst } from '../core/time.js';
import { authMiddleware, requireRole } from '../middlewares/auth.js';

const meterReadings = new Hono();

const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

const readingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "readingDate must be in YYYY-MM-DD format")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "readingDate is not a valid calendar date");

const createReadingSchema = z.object({
  readingDate: readingDateSchema,
  meterReading: z.coerce.number().finite().nonnegative()
});

const updateReadingSchema = z.object({
  meterReading: z.coerce.number().finite().nonnegative().optional()
});

const meterAnalyticsQuerySchema = z.object({
  from: readingDateSchema,
  to: readingDateSchema
}).refine((value) => value.from <= value.to, {
  message: "from must be earlier than or equal to to",
  path: ["to"]
});

interface AuthPayload {
  id?: number;
  role?: 'MEMBER' | 'ADMIN' | 'SUPER_ADMIN';
}

interface ValidatedImage {
  data: Buffer;
  mimeType: string;
  fileName: string;
  size: number;
}

function hasValidImageSignature(data: Buffer, mimeType: string) {
  if (mimeType === 'image/jpeg') {
    return data.length >= 3
      && data[0] === 0xff
      && data[1] === 0xd8
      && data[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return data.length >= 8
      && data.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
  }
  return data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP';
}

async function validateImage(value: string | File | undefined) {
  if (!(value instanceof File)) {
    throw new Error("A meter image file is required");
  }
  if (!ALLOWED_IMAGE_TYPES.has(value.type)) {
    throw new Error("Image must be JPEG, PNG, or WebP");
  }
  if (value.size === 0 || value.size > MAX_IMAGE_SIZE) {
    throw new Error("Image size must be between 1 byte and 4 MB");
  }

  const data = Buffer.from(await value.arrayBuffer());
  if (!hasValidImageSignature(data, value.type)) {
    throw new Error("Image content does not match its MIME type");
  }

  return {
    data,
    mimeType: value.type,
    fileName: value.name.replace(/^.*[\\/]/, '').slice(0, 255),
    size: value.size
  } satisfies ValidatedImage;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('code' in error && error.code === '23505') {
    return true;
  }
  return 'cause' in error && isUniqueViolation(error.cause);
}

meterReadings.get(
  '/meter-readings/analytics',
  authMiddleware,
  requireRole(['SUPER_ADMIN']),
  async (c) => {
    try {
      const validated = meterAnalyticsQuerySchema.safeParse(c.req.query());
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

      const analytics = await getMeterConsumptionAnalytics(
        validated.data.from,
        validated.data.to
      );
      return c.json({
        success: true,
        analytics
      });
    } catch (error: unknown) {
      console.error(error);
      if (error instanceof MeterAnalyticsError) {
        return c.json(
          {
            success: false,
            error: error.message
          },
          error.status
        );
      }
      return c.json(
        {
          success: false,
          error: error instanceof Error
            ? error.message
            : "Failed to calculate meter consumption"
        },
        500
      );
    }
  }
);

meterReadings.get(
  '/meter-readings',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const readingDate = c.req.query('date') ?? todayIst();
      const parsedDate = readingDateSchema.safeParse(readingDate);
      if (!parsedDate.success) {
        return c.json(
          {
            success: false,
            error: "Invalid date",
            details: parsedDate.error.format()
          },
          400
        );
      }

      const [reading] = await db
        .select({
          id: dailyMeterReadingsTable.id,
          readingDate: dailyMeterReadingsTable.readingDate,
          meterReading: dailyMeterReadingsTable.meterReading,
          imageMimeType: dailyMeterReadingsTable.imageMimeType,
          imageFileName: dailyMeterReadingsTable.imageFileName,
          imageSize: dailyMeterReadingsTable.imageSize,
          submittedBy: dailyMeterReadingsTable.submittedBy,
          updatedBy: dailyMeterReadingsTable.updatedBy,
          createdAt: dailyMeterReadingsTable.createdAt,
          updatedAt: dailyMeterReadingsTable.updatedAt
        })
        .from(dailyMeterReadingsTable)
        .where(eq(dailyMeterReadingsTable.readingDate, parsedDate.data));

      if (!reading) {
        return c.json(
          {
            success: false,
            error: `No meter reading found for ${parsedDate.data}`
          },
          404
        );
      }

      const userIds = [reading.submittedBy, reading.updatedBy].filter(
        (id): id is number => id !== null
      );
      const users = userIds.length === 0
        ? []
        : await db
          .select({
            id: usersTable.id,
            email: usersTable.email,
            role: usersTable.role
          })
          .from(usersTable)
          .where(inArray(usersTable.id, userIds));

      return c.json({
        success: true,
        reading: {
          ...reading,
          imageUrl: `/api/meter-readings/${reading.id}/image`,
          submittedByUser: users.find((user) => user.id === reading.submittedBy) ?? null,
          updatedByUser: users.find((user) => user.id === reading.updatedBy) ?? null
        }
      });
    } catch (error: unknown) {
      console.error(error);
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to load meter reading"
        },
        500
      );
    }
  }
);

meterReadings.post(
  '/meter-readings',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    try {
      const payload = c.get('jwtPayload') as AuthPayload;
      if (!payload.id) {
        return c.json({ success: false, error: "Authenticated user ID is required" }, 401);
      }

      const body = await c.req.parseBody();
      const parsed = createReadingSchema.safeParse({
        readingDate: body.readingDate || todayIst(),
        meterReading: body.meterReading
      });
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
      if (
        payload.role === 'ADMIN'
        && parsed.data.readingDate !== todayIst()
      ) {
        return c.json(
          {
            success: false,
            error: "Admins can submit only today's opening meter reading"
          },
          403
        );
      }

      const image = await validateImage(body.image);
      const [reading] = await db
        .insert(dailyMeterReadingsTable)
        .values({
          readingDate: parsed.data.readingDate,
          meterReading: parsed.data.meterReading,
          imageData: image.data,
          imageMimeType: image.mimeType,
          imageFileName: image.fileName,
          imageSize: image.size,
          submittedBy: payload.id
        })
        .returning({
          id: dailyMeterReadingsTable.id,
          readingDate: dailyMeterReadingsTable.readingDate,
          meterReading: dailyMeterReadingsTable.meterReading,
          imageMimeType: dailyMeterReadingsTable.imageMimeType,
          imageFileName: dailyMeterReadingsTable.imageFileName,
          imageSize: dailyMeterReadingsTable.imageSize,
          submittedBy: dailyMeterReadingsTable.submittedBy,
          createdAt: dailyMeterReadingsTable.createdAt,
          updatedAt: dailyMeterReadingsTable.updatedAt
        });

      return c.json(
        {
          success: true,
          message: "Opening meter reading recorded successfully",
          reading: {
            ...reading,
            imageUrl: `/api/meter-readings/${reading.id}/image`
          }
        },
        201
      );
    } catch (error: unknown) {
      console.error(error);
      if (isUniqueViolation(error)) {
        return c.json(
          {
            success: false,
            error: "A meter reading has already been submitted for this date"
          },
          409
        );
      }
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to record meter reading"
        },
        400
      );
    }
  }
);

meterReadings.put(
  '/meter-readings/:date',
  authMiddleware,
  requireRole(['SUPER_ADMIN']),
  async (c) => {
    try {
      const payload = c.get('jwtPayload') as AuthPayload;
      if (!payload.id) {
        return c.json({ success: false, error: "Authenticated user ID is required" }, 401);
      }

      const parsedDate = readingDateSchema.safeParse(c.req.param('date'));
      if (!parsedDate.success) {
        return c.json(
          {
            success: false,
            error: "Invalid date",
            details: parsedDate.error.format()
          },
          400
        );
      }

      const body = await c.req.parseBody();
      const parsed = updateReadingSchema.safeParse({
        meterReading: body.meterReading || undefined
      });
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

      const hasImage = body.image instanceof File;
      if (parsed.data.meterReading === undefined && !hasImage) {
        return c.json(
          {
            success: false,
            error: "Provide meterReading, image, or both"
          },
          400
        );
      }

      const image = hasImage ? await validateImage(body.image) : undefined;
      const [existingReading] = await db
        .select({ id: dailyMeterReadingsTable.id })
        .from(dailyMeterReadingsTable)
        .where(eq(dailyMeterReadingsTable.readingDate, parsedDate.data));

      if (!existingReading) {
        if (parsed.data.meterReading === undefined || !image) {
          return c.json(
            {
              success: false,
              error: "Creating a missing record requires meterReading and image"
            },
            400
          );
        }

        const [created] = await db
          .insert(dailyMeterReadingsTable)
          .values({
            readingDate: parsedDate.data,
            meterReading: parsed.data.meterReading,
            imageData: image.data,
            imageMimeType: image.mimeType,
            imageFileName: image.fileName,
            imageSize: image.size,
            submittedBy: payload.id
          })
          .returning({
            id: dailyMeterReadingsTable.id,
            readingDate: dailyMeterReadingsTable.readingDate,
            meterReading: dailyMeterReadingsTable.meterReading,
            imageMimeType: dailyMeterReadingsTable.imageMimeType,
            imageFileName: dailyMeterReadingsTable.imageFileName,
            imageSize: dailyMeterReadingsTable.imageSize,
            submittedBy: dailyMeterReadingsTable.submittedBy,
            updatedBy: dailyMeterReadingsTable.updatedBy,
            createdAt: dailyMeterReadingsTable.createdAt,
            updatedAt: dailyMeterReadingsTable.updatedAt
          });

        return c.json(
          {
            success: true,
            created: true,
            message: "Meter reading created successfully",
            reading: {
              ...created,
              imageUrl: `/api/meter-readings/${created.id}/image`
            }
          },
          201
        );
      }

      const [reading] = await db
        .update(dailyMeterReadingsTable)
        .set({
          ...(parsed.data.meterReading !== undefined
            ? { meterReading: parsed.data.meterReading }
            : {}),
          ...(image
            ? {
              imageData: image.data,
              imageMimeType: image.mimeType,
              imageFileName: image.fileName,
              imageSize: image.size
            }
            : {}),
          updatedBy: payload.id,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(dailyMeterReadingsTable.readingDate, parsedDate.data)
          )
        )
        .returning({
          id: dailyMeterReadingsTable.id,
          readingDate: dailyMeterReadingsTable.readingDate,
          meterReading: dailyMeterReadingsTable.meterReading,
          imageMimeType: dailyMeterReadingsTable.imageMimeType,
          imageFileName: dailyMeterReadingsTable.imageFileName,
          imageSize: dailyMeterReadingsTable.imageSize,
          submittedBy: dailyMeterReadingsTable.submittedBy,
          updatedBy: dailyMeterReadingsTable.updatedBy,
          createdAt: dailyMeterReadingsTable.createdAt,
          updatedAt: dailyMeterReadingsTable.updatedAt
        });

      if (!reading) {
        return c.json(
          {
            success: false,
            error: `No meter reading found for ${parsedDate.data}`
          },
          404
        );
      }

      return c.json({
        success: true,
        created: false,
        message: "Meter reading updated successfully",
        reading: {
          ...reading,
          imageUrl: `/api/meter-readings/${reading.id}/image`
        }
      });
    } catch (error: unknown) {
      console.error(error);
      if (isUniqueViolation(error)) {
        return c.json(
          {
            success: false,
            error: "A meter reading already exists for this date; retry the update"
          },
          409
        );
      }
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to update meter reading"
        },
        400
      );
    }
  }
);

meterReadings.get(
  '/meter-readings/:id/image',
  authMiddleware,
  requireRole(['ADMIN', 'SUPER_ADMIN']),
  async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ success: false, error: "Invalid meter reading ID" }, 400);
    }

    const [image] = await db
      .select({
        data: dailyMeterReadingsTable.imageData,
        mimeType: dailyMeterReadingsTable.imageMimeType,
        fileName: dailyMeterReadingsTable.imageFileName
      })
      .from(dailyMeterReadingsTable)
      .where(eq(dailyMeterReadingsTable.id, id));
    if (!image) {
      return c.json({ success: false, error: "Meter image not found" }, 404);
    }

    return new Response(new Uint8Array(image.data), {
      headers: {
        'Content-Type': image.mimeType,
        'Content-Disposition': `inline; filename="${image.fileName.replaceAll('"', '')}"`,
        'Cache-Control': 'private, max-age=300'
      }
    });
  }
);

export default meterReadings;
