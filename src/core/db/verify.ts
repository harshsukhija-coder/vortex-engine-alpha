import 'dotenv/config';
import { db, pool } from './index.js';
import { gamesTable, setupsTable, setupGamesTable, offerTable, offerDetailsTable, setupConfigurationsTable } from './schema.js';

async function verify() {
  const games = await db.select().from(gamesTable);
  const setups = await db.select().from(setupsTable);
  const configs = await db.select().from(setupConfigurationsTable);
  const setupGames = await db.select().from(setupGamesTable);
  const offers = await db.select().from(offerTable);
  const details = await db.select().from(offerDetailsTable);

  console.log("--- DATABASE VERIFICATION ---");
  console.log("Games in DB:", games.map(g => g.name));
  console.log("Configurations in DB:", configs.map(c => c.name));
  console.log("Setups (instances) in DB:", setups.map(s => s.name));
  console.log("Setup-Games mapping count:", setupGames.length);
  console.log("Offers in DB:", offers.map(o => o.name));
  console.log("Offer details count:", details.length);
}

verify()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
