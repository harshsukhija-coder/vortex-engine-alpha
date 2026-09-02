import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';
import crypto from 'crypto';
import env from '../core/env.js';

// 1. Password Hashing Utility using Node.js pbkdf2
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

// 2. Authentication Middleware using Hono's JWT
export const authMiddleware = jwt({ secret: env.JWT_SECRET, alg: 'HS256' });

// 3. Role Authorization Middleware
export const requireRole = (allowedRoles: ('MEMBER' | 'ADMIN' | 'SUPER_ADMIN')[]) => {
  return createMiddleware(async (c, next) => {
    const payload = c.get('jwtPayload') as any;
    if (!payload || !payload.role || !allowedRoles.includes(payload.role)) {
      return c.json({ success: false, error: "Access denied. Insufficient permissions." }, 403);
    }
    await next();
  });
};
