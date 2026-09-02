import 'dotenv/config';
import { db, pool } from './index.js';
import { gamesTable, setupsTable, setupGamesTable, offerTable, offerDetailsTable, usersTable, setupConfigurationsTable } from './schema.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from './../../middlewares/auth.js';

async function seed() {
  console.log('Seeding database...');

  // 1. Seed Games
  const gamesList = [
    {
      name: 'FC 26',
      price: 0,
      isActive: true,
      images: [
        'https://www.mancity.com/meta/media/02ep5xmh/mcfc_fc26_launch_1920x1080-editorial.jpg',
        'https://i.ytimg.com/vi/0GE8YCIQF2M/hq720.jpg?sqp=-oaymwEhCK4FEIIDSFryq4qpAxMIARUAAAAAGAElAADIQj0AgKJD&rs=AOn4CLADrm9M9Z3lQV2T32Rl2fLnSIW1xQ',
        'https://techstory.in/wp-content/uploads/2025/09/Latest-news-on-EA-FC-26-.jpg.webp'
      ]
    },
    {
      name: 'Wwe 2k26',
      price: 0,
      isActive: true,
      images: [
        'https://image.api.playstation.com/vulcan/ap/rnd/202601/1209/a247b6822c435aa171ba98ff1855c36ceaf8ece5918094b5.jpg'
      ]
    },
    {
      name: 'Cricket24',
      price: 0,
      isActive: true,
      images: [
        'https://gamerspotstorage01.s3.ap-south-1.amazonaws.com/wp-content/uploads/2024/07/18022053/Cricket24_800.jpg'
      ]
    },
    {
      name: 'Tekken8',
      price: 0,
      isActive: true,
      images: [
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1778820/capsule_616x353.jpg?t=1787180720',
        'https://static.bandainamcoent.eu/high/tekken/tekken-8/00-page-setup/TEKKEN8_Header_mobile_2.jpg'
      ]
    },
    {
      name: 'GTA 5',
      price: 0,
      isActive: true,
      images: [
        'https://cdn1.epicgames.com/offer/b0cd075465c44f87be3b505ac04a2e46/EGS_GrandTheftAutoVEnhanced_RockstarNorth_S1_2560x1440-906d8ae76a91aafc60b1a54c23fab496',
        'https://cdn.mos.cms.futurecdn.net/XFrWHyfNRsjSGAagPtgFom.jpg'
      ]
    },
    {
      name: 'Uncharted',
      price: 0,
      isActive: true,
      images: [
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1659420/capsule_616x353.jpg?t=1779309472',
        'https://i.ytimg.com/vi/hh5HV4iic1Y/maxresdefault.jpg'
      ]
    },
    {
      name: 'Mortal Kombat',
      price: 0,
      isActive: true,
      images: [
        'https://i0.wp.com/www.qualbert.com/wp-content/uploads/2023/10/MK1-wallpaper.jpg?fit=1149%2C646&ssl=1',
        'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTaQZpHQC0bzX_tELtHykSxHuB28ejbFESDgZFjiqqfg7c3kOpsHwB-aq5m&s=10'
      ]
    }
  ];

  console.log('Inserting/updating games...');
  const seededGames: Record<string, number> = {};

  for (const game of gamesList) {
    // Check if game already exists
    const existing = await db
      .select()
      .from(gamesTable)
      .where(eq(gamesTable.name, game.name));

    if (existing.length > 0) {
      console.log(`Game "${game.name}" already exists — updating images...`);
      await db
        .update(gamesTable)
        .set({
          images: game.images,
          updatedAt: new Date()
        })
        .where(eq(gamesTable.name, game.name));
      seededGames[game.name] = existing[0].id;
    } else {
      const [inserted] = await db
        .insert(gamesTable)
        .values({
          name: game.name,
          price: game.price,
          images: game.images,
          isActive: game.isActive
        })
        .returning({ id: gamesTable.id });
      console.log(`Inserted game "${game.name}" with ID: ${inserted.id}`);
      seededGames[game.name] = inserted.id;
    }
  }

  // 2. Seed Setup Configurations & Setup Instances
  const configurationsList = [
    {
      name: 'Big Screen (65")',
      description: 'Featuring a big 65" screen setup equipped with PS5 consoles, comfortable chairs, high-end controllers, and immersive sound.',
      consoleType: 'PS5',
      screenType: '65 inch Sansui',
      price: 150,
      singlePlayerPrice: 150,
      multiplayerPrice: 120,
      isActive: true,
      extendedConfigurations: {
        headphones: 'Sony WH-CH520 Wireless',
        controllersPerConsole: 2,
        seating: 'Ergonomic Gaming Chairs',
        screenBrand: 'Sansui',
        screenSize: '65 inch'
      },
      instancesCount: 1
    },
    {
      name: 'Standard Screen (55")',
      description: 'Featuring standard 55" screen setups connected to PS5 consoles, perfect for multiplayer co-op sessions.',
      consoleType: 'PS5',
      screenType: '55 inch Sansui',
      price: 100,
      singlePlayerPrice: 100,
      multiplayerPrice: 80,
      isActive: true,
      extendedConfigurations: {
        headphones: 'Standard Wired Headphones',
        controllersPerConsole: 2,
        seating: 'Comfortable Beanbags',
        screenBrand: 'Sansui',
        screenSize: '55 inch'
      },
      instancesCount: 4
    }
  ];

  console.log('Inserting setup configurations...');
  const seededConfigs: Record<string, number> = {};

  for (const config of configurationsList) {
    const existing = await db
      .select()
      .from(setupConfigurationsTable)
      .where(eq(setupConfigurationsTable.name, config.name));

    let configId: number;

    if (existing.length > 0) {
      console.log(`Configuration "${config.name}" already exists — updating...`);
      configId = existing[0].id;
      await db
        .update(setupConfigurationsTable)
        .set({
          description: config.description,
          consoleType: config.consoleType,
          screenType: config.screenType,
          price: config.price,
          singlePlayerPrice: config.singlePlayerPrice,
          multiplayerPrice: config.multiplayerPrice,
          extendedConfigurations: config.extendedConfigurations,
          updatedAt: new Date()
        })
        .where(eq(setupConfigurationsTable.name, config.name));
    } else {
      const [inserted] = await db
        .insert(setupConfigurationsTable)
        .values({
          name: config.name,
          description: config.description,
          consoleType: config.consoleType,
          screenType: config.screenType,
          price: config.price,
          singlePlayerPrice: config.singlePlayerPrice,
          multiplayerPrice: config.multiplayerPrice,
          extendedConfigurations: config.extendedConfigurations,
          isActive: config.isActive
        })
        .returning({ id: setupConfigurationsTable.id });
      console.log(`Inserted configuration "${config.name}" with ID: ${inserted.id}`);
      configId = inserted.id;
    }

    seededConfigs[config.name] = configId;

    // Seed Actual Setup Instances for this Configuration
    for (let i = 1; i <= config.instancesCount; i++) {
      const setupName = `${config.name} - Console ${i}`;
      const existingSetup = await db
        .select()
        .from(setupsTable)
        .where(eq(setupsTable.name, setupName));

      if (existingSetup.length > 0) {
        console.log(`Setup instance "${setupName}" already exists.`);
      } else {
        await db
          .insert(setupsTable)
          .values({
            setupConfigurationId: configId,
            name: setupName,
            images: ['https://example.com/image-1.jpg', 'https://example.com/image-2.jpg'],
            videos: ['https://example.com/video-1.mp4'],
            isActive: true
          });
        console.log(`Inserted setup instance "${setupName}"`);
      }
    }
  }

  // 3. Associate Games with Configurations (Setup Games)
  console.log('Associating games with setup configurations...');
  const set1Games = [
    'FC 26',
    'Wwe 2k26',
    'Cricket24',
    'Tekken8',
    'GTA 5',
    'Uncharted',
    'Mortal Kombat'
  ];

  const set2Games = [
    'FC 26',
    'Wwe 2k26',
    'Mortal Kombat',
    'Tekken8',
    'GTA 5'
  ];

  // Big Screen (65") associations
  const set1Id = seededConfigs['Big Screen (65")'];
  if (set1Id) {
    for (const gameName of set1Games) {
      const gameId = seededGames[gameName];
      if (gameId) {
        try {
          await db
            .insert(setupGamesTable)
            .values({
              setupConfigurationId: set1Id,
              gameId: gameId
            });
          console.log(`Mapped game "${gameName}" to Configuration Big Screen (65")`);
        } catch (error) {
          // Already mapped or duplicate error, ignore
        }
      }
    }
  }

  // Standard Screen (55") associations
  const set2Id = seededConfigs['Standard Screen (55")'];
  if (set2Id) {
    for (const gameName of set2Games) {
      const gameId = seededGames[gameName];
      if (gameId) {
        try {
          await db
            .insert(setupGamesTable)
            .values({
              setupConfigurationId: set2Id,
              gameId: gameId
            });
          console.log(`Mapped game "${gameName}" to Configuration Standard Screen (55")`);
        } catch (error) {
          // Already mapped, ignore
        }
      }
    }
  }

  // 4. Seed Opening Offer
  console.log('Seeding opening offer...');
  const offerName = 'Opening Offer: Buy 1 Get 1 Free (1 person free on 1 person)';
  const existingOffer = await db
    .select()
    .from(offerTable)
    .where(eq(offerTable.name, offerName));

  let offerId: number;
  if (existingOffer.length > 0) {
    console.log(`Offer "${offerName}" already exists.`);
    offerId = existingOffer[0].id;
  } else {
    const [insertedOffer] = await db
      .insert(offerTable)
      .values({
        name: offerName,
        isActive: true,
        offerType: 'EXCLUSIVE'
      })
      .returning({ id: offerTable.id });
    console.log(`Inserted offer "${offerName}" with ID: ${insertedOffer.id}`);
    offerId = insertedOffer.id;

    // Add Offer details
    await db
      .insert(offerDetailsTable)
      .values({
        offerId: offerId,
        condObj: 'person',
        cond: '>=',
        condValue: '2',
        offerObj: 'person',
        offerValue: '1' // 1 person free
      });
    console.log(`Added offer details for Buy 1 Get 1 Free to Offer ID: ${offerId}`);
  }

  // 4b. Seed Flat 50 Off Offer
  console.log('Seeding Flat 50 Off offer...');
  const flatOfferName = 'Flat 50 Off: Save 50 on bookings >= 500';
  const existingFlatOffer = await db
    .select()
    .from(offerTable)
    .where(eq(offerTable.name, flatOfferName));

  if (existingFlatOffer.length > 0) {
    console.log(`Offer "${flatOfferName}" already exists.`);
  } else {
    const [insertedFlatOffer] = await db
      .insert(offerTable)
      .values({
        name: flatOfferName,
        isActive: true,
        offerType: 'INCLUSIVE' // Inclusive so it can apply with other offers
      })
      .returning({ id: offerTable.id });
    console.log(`Inserted offer "${flatOfferName}" with ID: ${insertedFlatOffer.id}`);

    // Add Offer details
    await db
      .insert(offerDetailsTable)
      .values({
        offerId: insertedFlatOffer.id,
        condObj: 'amount',
        cond: '>=',
        condValue: '500',
        offerObj: 'amount',
        offerValue: '50' // flat 50 rupees off
      });
    console.log(`Added offer details for Flat 50 Off to Offer ID: ${insertedFlatOffer.id}`);
  }

  // 5. Seed Users
  console.log('Seeding default users...');
  const usersList = [
    { email: 'superadmin@cafe.com', password: 'supersecret', role: 'SUPER_ADMIN' as const },
    { email: 'admin@cafe.com', password: 'adminsecret', role: 'ADMIN' as const },
    { email: 'member@cafe.com', password: 'membersecret', role: 'MEMBER' as const },
    { email: 'meet@gmail.com', password: 'Meet@1234', role: 'SUPER_ADMIN' as const },
    { email: 'harsh@gmail.com', password: 'Harsh@1234', role: 'ADMIN' as const }
  ];

  for (const u of usersList) {
    const existing = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, u.email));

    if (existing.length > 0) {
      console.log(`User "${u.email}" already exists.`);
    } else {
      const passwordHash = hashPassword(u.password);
      await db
        .insert(usersTable)
        .values({
          email: u.email,
          passwordHash,
          role: u.role
        });
      console.log(`Inserted user "${u.email}" with role "${u.role}"`);
    }
  }

  console.log('Database seeding completed successfully!');
}

seed()
  .catch((err) => {
    console.error('Error seeding database:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
