import { sql } from "drizzle-orm";
import { boolean, doublePrecision, integer, jsonb, pgEnum, pgTable, primaryKey, text, time, timestamp, varchar } from "drizzle-orm/pg-core";

// Games
export const gamesTable = pgTable("games", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull().unique(),
  price: integer().default(0), // Base game price (if applicable)
  images: text().array().notNull().default(sql`'{}'::text[]`),
  gameplays: text().array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { precision: 6, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { precision: 6, withTimezone: true }).notNull().defaultNow()
});

// Setup configurations table (Metadata)
export const setupConfigurationsTable = pgTable("setup_configurations", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull().unique(),
  description: text(),
  consoleType: varchar("console_type", { length: 255 }).notNull().default('PS5'),
  screenType: varchar("screen_type", { length: 255 }),
  price: integer().notNull().default(0),
  singlePlayerPrice: integer("single_player_price"),
  multiplayerPrice: integer("multiplayer_price").default(0),
  extendedConfigurations: jsonb("extended_configurations"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { precision: 6, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { precision: 6, withTimezone: true }).notNull().defaultNow()
});

// Setups table (Actual physical setup instances)
export const setupsTable = pgTable("setups", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  setupConfigurationId: integer("setup_configuration_id").notNull().references(() => setupConfigurationsTable.id, { onDelete: "cascade" }),
  name: varchar({ length: 255 }).notNull(),
  images: text().array().notNull().default(sql`'{}'::text[]`),
  videos: text().array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { precision: 6, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { precision: 6, withTimezone: true }).notNull().defaultNow()
});

// Setup and games junction table (Many-to-Many on configuration)
export const setupGamesTable = pgTable("setup_games", {
  setupConfigurationId: integer("setup_configuration_id").notNull().references(() => setupConfigurationsTable.id, { onDelete: "cascade" }),
  gameId: integer("game_id").notNull().references(() => gamesTable.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({
    columns: [table.setupConfigurationId, table.gameId]
  })
}));

// Offer Type Enum
export const offerTypeEnum = pgEnum('offer_type', ['EXCLUSIVE', 'INCLUSIVE']);

// Offer
export const offerTable = pgTable("offers", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull().unique(),
  fromTime: time(),
  toTime: time(),
  isActive: boolean("is_active").notNull().default(false),
  offerType: offerTypeEnum("offer_type").default('EXCLUSIVE')
});

// Condition & Offer Detail Enums
export const condObjEnum = pgEnum('condObj', ['amount', 'person', 'game', 'time']);
export const cond = pgEnum('cond', ['=', '%', '>', '<', '<=', '>=']);
export const offerObjEnum = pgEnum('offerObj', ['amount', 'person', 'time']);

// Offer details
export const offerDetailsTable = pgTable("offer_details", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  offerId: integer("offer_id").notNull().references(() => offerTable.id, { onDelete: "cascade" }),
  condObj: condObjEnum("cond_obj"),
  cond: cond(),
  condValue: text("cond_value"), // Threshold condition value, e.g. "2" for 2 persons
  offerObj: offerObjEnum("offer_obj"),
  offerValue: text("offer_value") // Discount or free value, e.g. "1" for 1 person free
});

// User Roles & Users
export const userRoleEnum = pgEnum('user_role', ['MEMBER', 'ADMIN', 'SUPER_ADMIN']);
export const bookingStatusEnum = pgEnum('booking_status', ['TENTATIVE', 'CONFIRMED', 'CANCELLED']);

export const usersTable = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  email: varchar({ length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").default('MEMBER').notNull(),
  createdAt: timestamp("created_at", { precision: 6, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { precision: 6, withTimezone: true }).notNull().defaultNow()
});

// Booking
export const bookingTable = pgTable('booking_tables', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  phoneNumber: text("phone_number").notNull(),
  setupId: integer("setup_id").references(() => setupsTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  bookedBy: integer("booked_by").references(() => usersTable.id, { onDelete: "set null" }),
  originalAmount: integer("original_amount").default(0),
  amountCharged: integer("amount_charged").default(0),
  cashAmount: integer("cash_amount").default(0),
  upiAmount: integer("upi_amount").default(0),
  count: integer().notNull().default(1), // number of persons
  status: bookingStatusEnum("status").default('CONFIRMED').notNull(),
  // Slot span (earliest start → latest end across all selected slots)
  startTime: timestamp("start_time", { precision: 6, withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { precision: 6, withTimezone: true }).notNull(),
  // Customer intent: what they booked from the website
  requestedStartTime: timestamp("requested_start_time", { precision: 6, withTimezone: true }),
  requestedNoOfHours: doublePrecision("requested_no_of_hours"),
  // Snapshot of setup configuration at the time of booking (for historical reference)
  setupSnapshot: jsonb("setup_snapshot"),
  // Actual session timestamps set by the café owner on confirmation / check-in
  actualStartTime: timestamp("actual_start_time", { precision: 6, withTimezone: true }),
  actualEndTime: timestamp("actual_end_time", { precision: 6, withTimezone: true }),
  createdAt: timestamp("created_at", { precision: 6, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { precision: 6, withTimezone: true }).notNull().defaultNow()
});

// Booking and offers
export const bookingAndOffersTable = pgTable("booking_offers", {
  bookingId: integer("booking_id").notNull().references(() => bookingTable.id, { onDelete: "cascade" }),
  offerId: integer("offer_id").notNull().references(() => offerTable.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({
    columns: [table.bookingId, table.offerId]
  })
}));

// Booking and games
export const bookingAndGames = pgTable("booking_games", {
  bookingId: integer("booking_id").notNull().references(() => bookingTable.id, { onDelete: "cascade" }),
  gameId: integer("game_id").notNull().references(() => gamesTable.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({
    columns: [table.bookingId, table.gameId]
  })
}));

// Slot Locks (PostgreSQL-based temporary locking)
export const slotLocksTable = pgTable("slot_locks", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  setupId: integer("setup_id").notNull().references(() => setupsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  lockToken: text("lock_token"), // Client-provided unique token for tracking anonymous locks
  slotDate: text("slot_date").notNull(), // Date formatted as YYYY-MM-DD
  startTime: timestamp("start_time", { precision: 6, withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { precision: 6, withTimezone: true }).notNull(),
  lockedUntil: timestamp("locked_until", { precision: 6, withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { precision: 6, withTimezone: true }).notNull().defaultNow()
});

// Booked Slots (supporting multiple slot selections per booking)
export const bookingSlotsTable = pgTable("booking_slots", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  bookingId: integer("booking_id").notNull().references(() => bookingTable.id, { onDelete: "cascade" }),
  startTime: timestamp("start_time", { precision: 6, withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { precision: 6, withTimezone: true }).notNull()
});

// Tentative Booking
export const tentativeBookingTable = pgTable('tentative_bookings', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  phoneNumber: text("phone_number").notNull(),
  setupId: integer("setup_id").references(() => setupsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  bookedBy: integer("booked_by").references(() => usersTable.id, { onDelete: "set null" }),
  originalAmount: integer("original_amount").default(0),
  amountCharged: integer("amount_charged").default(0),
  count: integer().notNull().default(1), // number of persons
  startTime: timestamp("start_time", { precision: 6, withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { precision: 6, withTimezone: true }).notNull(),
  requestedStartTime: timestamp("requested_start_time", { precision: 6, withTimezone: true }),
  requestedNoOfHours: doublePrecision("requested_no_of_hours"),
  setupSnapshot: jsonb("setup_snapshot"),
  gameIds: integer("game_ids").array().notNull().default(sql`'{}'::integer[]`),
  appliedOfferIds: integer("applied_offer_ids").array().notNull().default(sql`'{}'::integer[]`),
  createdAt: timestamp("created_at", { precision: 6, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { precision: 6, withTimezone: true }).notNull().defaultNow()
});

// Customers (end-user / walk-in customer profiles)
export const customersTable = pgTable("customers", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  phoneNumber: varchar("phone_number", { length: 20 }).notNull().unique(),
  name: varchar({ length: 255 }).notNull(),
  dateOfBirth: varchar("date_of_birth", { length: 10 }), // YYYY-MM-DD
  createdAt: timestamp("created_at", { precision: 6, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { precision: 6, withTimezone: true }).notNull().defaultNow()
});
