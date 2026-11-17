export interface PriceConfig {
  price: number;
  singlePlayerPrice?: number | null;
  multiplayerPrice?: number | null;
}

export interface GamePriceInput {
  id: number;
  name: string;
  price: number | null;
}

export interface SelectedGamePrice {
  id: number;
  name: string;
  price: number;
}

/**
 * Flat per-game premium added on top of setup pricing.
 * Zero / null game prices contribute nothing.
 */
export function calculateGamePricing(games: GamePriceInput[]) {
  const selectedGames: SelectedGamePrice[] = games.map((game) => ({
    id: game.id,
    name: game.name,
    price: Math.max(0, Math.ceil(Number(game.price ?? 0) || 0))
  }));
  const gamesTotal = selectedGames.reduce((sum, game) => sum + game.price, 0);
  const pricedGames = selectedGames.filter((game) => game.price > 0);
  const calculationFormula = pricedGames.length === 0
    ? "No game premium"
    : pricedGames
      .map((game) => `${game.name} ₹${game.price}`)
      .join(" + ") + ` = ₹${gamesTotal}`;

  return {
    selectedGames,
    gamesTotal,
    calculationFormula
  };
}

export function calculatePriceForRule(
  config: PriceConfig,
  players: number,
  durationHours: number,
  games: GamePriceInput[] = []
) {
  const isSingle = players === 1;
  const singleRate = (config.singlePlayerPrice && config.singlePlayerPrice > 0)
    ? config.singlePlayerPrice
    : config.price;
  const multiRate = (config.multiplayerPrice && config.multiplayerPrice > 0)
    ? config.multiplayerPrice
    : singleRate;
  const ratePerPersonPerHour = isSingle ? singleRate : multiRate;
  const setupPrice = Math.ceil(durationHours * ratePerPersonPerHour * players);
  const gamePricing = calculateGamePricing(games);
  const basePrice = setupPrice + gamePricing.gamesTotal;
  const setupFormula = `₹${ratePerPersonPerHour} × ${players} player${players === 1 ? '' : 's'} × ${durationHours} hour${durationHours === 1 ? '' : 's'} = ₹${setupPrice}`;
  const calculationFormula = gamePricing.gamesTotal > 0
    ? `${setupFormula} + games ₹${gamePricing.gamesTotal} = ₹${basePrice}`
    : setupFormula;

  return {
    basePrice,
    setupPrice,
    gamesTotal: gamePricing.gamesTotal,
    selectedGames: gamePricing.selectedGames,
    ratePerPersonPerHour,
    playerType: isSingle ? ('SINGLE_PLAYER' as const) : ('MULTIPLAYER' as const),
    calculationFormula,
    setupFormula,
    gamesFormula: gamePricing.calculationFormula
  };
}
