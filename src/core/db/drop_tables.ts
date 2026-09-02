import 'dotenv/config';
import { db } from './index.js';
import { sql } from 'drizzle-orm';

async function dropTables() {
  console.log("Dropping all tables...");
  const queries = [
    'DROP TABLE IF EXISTS "tentative_booking_offers" CASCADE;',
    'DROP TABLE IF EXISTS "tentative_booking_games" CASCADE;',
    'DROP TABLE IF EXISTS "tentative_booking_slots" CASCADE;',
    'DROP TABLE IF EXISTS "tentative_bookings" CASCADE;',
    'DROP TABLE IF EXISTS "booking_offers" CASCADE;',
    'DROP TABLE IF EXISTS "booking_games" CASCADE;',
    'DROP TABLE IF EXISTS "booking_slots" CASCADE;',
    'DROP TABLE IF EXISTS "booking_tables" CASCADE;',
    'DROP TABLE IF EXISTS "slot_locks" CASCADE;',
    'DROP TABLE IF EXISTS "setup_games" CASCADE;',
    'DROP TABLE IF EXISTS "setup_instances" CASCADE;',
    'DROP TABLE IF EXISTS "setups" CASCADE;',
    'DROP TABLE IF EXISTS "setup_configurations" CASCADE;',
    'DROP TABLE IF EXISTS "games" CASCADE;',
    'DROP TABLE IF EXISTS "offers" CASCADE;',
    'DROP TABLE IF EXISTS "offer_details" CASCADE;',
    'DROP TABLE IF EXISTS "users" CASCADE;',
    'DROP TABLE IF EXISTS "drizzle"."__drizzle_migrations" CASCADE;',
    'DROP SCHEMA IF EXISTS "drizzle" CASCADE;',
    'DROP TYPE IF EXISTS "cond" CASCADE;',
    'DROP TYPE IF EXISTS "condObj" CASCADE;',
    'DROP TYPE IF EXISTS "offerObj" CASCADE;',
    'DROP TYPE IF EXISTS "booking_status" CASCADE;',
    'DROP TYPE IF EXISTS "user_role" CASCADE;',
    'DROP TYPE IF EXISTS "offer_type" CASCADE;'
  ];

  for (const query of queries) {
    try {
      await db.execute(sql.raw(query));
      console.log(`Executed: ${query}`);
    } catch (e) {
      console.error(`Error executing ${query}:`, e);
    }
  }
  console.log("All tables dropped!");
}

dropTables().catch(console.error);
