export interface PriceConfig {
  price: number;
  singlePlayerPrice?: number | null;
  multiplayerPrice?: number | null;
}

export function calculatePriceForRule(
  config: PriceConfig,
  players: number,
  durationHours: number
) {
  const isSingle = players === 1;
  const singleRate = (config.singlePlayerPrice && config.singlePlayerPrice > 0)
    ? config.singlePlayerPrice
    : config.price;
  const multiRate = (config.multiplayerPrice && config.multiplayerPrice > 0)
    ? config.multiplayerPrice
    : singleRate;
  const ratePerPersonPerHour = isSingle ? singleRate : multiRate;
  const basePrice = Math.ceil(durationHours * ratePerPersonPerHour * players);

  return {
    basePrice,
    ratePerPersonPerHour,
    playerType: isSingle ? ('SINGLE_PLAYER' as const) : ('MULTIPLAYER' as const)
  };
}
