import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import env from '../env.js';

const isServerless = process.env.VERCEL === '1';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: isServerless ? 1 : 10,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 10_000,
  ssl: env.DATABASE_URL.includes('localhost')
    ? undefined
    : { rejectUnauthorized: false },
});

export const db = drizzle({ client: pool });
