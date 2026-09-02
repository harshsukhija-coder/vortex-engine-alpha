import { Hono } from 'hono';
import { db } from '../core/db/index.js';
import { usersTable } from '../core/db/schema.js';
import { eq } from 'drizzle-orm';
import { sign } from 'hono/jwt';
import * as z from 'zod';
import { hashPassword, verifyPassword, authMiddleware, requireRole } from '../middlewares/auth.js';
import env from '../core/env.js';

const auth = new Hono();

const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters")
});

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string()
});

const updateRoleSchema = z.object({
  role: z.enum(['MEMBER', 'ADMIN', 'SUPER_ADMIN'])
});

// 1. POST /auth/register - Register a new MEMBER
auth.post('/register', async (c) => {
  try {
    const body = await c.req.json();
    const result = registerSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, error: "Validation failed", details: result.error.format() }, 400);
    }

    const { email, password } = result.data;

    // Check if user exists
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));

    if (existing) {
      return c.json({ success: false, error: "Email already registered" }, 400);
    }

    const passwordHash = hashPassword(password);

    const [user] = await db
      .insert(usersTable)
      .values({
        email,
        passwordHash,
        role: 'MEMBER'
      })
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        role: usersTable.role,
        createdAt: usersTable.createdAt
      });

    return c.json({ success: true, user });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 2. POST /auth/login - Login user and return JWT
auth.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const result = loginSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, error: "Validation failed", details: result.error.format() }, 400);
    }

    const { email, password } = result.data;

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return c.json({ success: false, error: "Invalid email or password" }, 401);
    }

    // Generate JWT token
    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 // 24 Hours
    };

    const token = await sign(payload, env.JWT_SECRET);

    return c.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 3. GET /users - List all users (ADMIN or SUPER_ADMIN only)
auth.get('/users', authMiddleware, requireRole(['ADMIN', 'SUPER_ADMIN']), async (c) => {
  try {
    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        role: usersTable.role,
        createdAt: usersTable.createdAt
      })
      .from(usersTable)
      .orderBy(usersTable.createdAt);

    return c.json({ success: true, users });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 4. PATCH /users/:id/role - Update user role (SUPER_ADMIN only)
auth.patch('/users/:id/role', authMiddleware, requireRole(['SUPER_ADMIN']), async (c) => {
  try {
    const idParam = c.req.param('id');
    const userId = parseInt(idParam, 10);
    if (isNaN(userId)) {
      return c.json({ success: false, error: "Invalid user ID" }, 400);
    }

    const body = await c.req.json();
    const result = updateRoleSchema.safeParse(body);

    if (!result.success) {
      return c.json({ success: false, error: "Validation failed", details: result.error.format() }, 400);
    }

    const { role } = result.data;

    // Check if target user exists
    const [targetUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    if (!targetUser) {
      return c.json({ success: false, error: "User not found" }, 404);
    }

    // Check if SUPER_ADMIN is trying to change their own role (optional safety check)
    const requester = c.get('jwtPayload') as any;
    if (requester.id === userId) {
      return c.json({ success: false, error: "Super Admin cannot modify their own role" }, 400);
    }

    const [updatedUser] = await db
      .update(usersTable)
      .set({ role, updatedAt: new Date() })
      .where(eq(usersTable.id, userId))
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        role: usersTable.role,
        updatedAt: usersTable.updatedAt
      });

    return c.json({ success: true, user: updatedUser });
  } catch (error: any) {
    console.error(error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default auth;
