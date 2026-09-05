export interface OfferRecord {
  id: number;
  name: string;
  offerType: 'EXCLUSIVE' | 'INCLUSIVE' | null;
}

export interface OfferDetailRecord {
  offerId: number;
  condObj: 'amount' | 'person' | 'game' | 'time' | null;
  cond: '=' | '%' | '>' | '<' | '<=' | '>=' | null;
  condValue: string | null;
  offerObj: 'amount' | 'person' | 'time' | null;
  offerValue: string | null;
}

export interface OfferEvaluationInput {
  offers: OfferRecord[];
  details: OfferDetailRecord[];
  originalAmount: number;
  players: number;
  durationHours: number;
  ratePerPersonPerHour: number;
  gameIds: number[];
  selectedOfferIds?: number[];
}

export interface EvaluatedOffer {
  id: number;
  name: string;
  offerType: 'EXCLUSIVE' | 'INCLUSIVE';
  eligible: boolean;
  discount: number;
  reason: string;
}

function compare(actual: number, operator: OfferDetailRecord['cond'], expected: number) {
  switch (operator) {
    case '>': return actual > expected;
    case '<': return actual < expected;
    case '>=': return actual >= expected;
    case '<=': return actual <= expected;
    case '=': return actual === expected;
    case '%': return expected !== 0 && actual % expected === 0;
    default: return true;
  }
}

function conditionFailureReason(detail: OfferDetailRecord, expected: number) {
  const labels = {
    amount: 'amount',
    person: 'players',
    game: 'game ID',
    time: 'hours'
  };
  return `Requires ${labels[detail.condObj ?? 'amount']} ${detail.cond ?? '='} ${expected}`;
}

function evaluateCondition(
  detail: OfferDetailRecord,
  input: OfferEvaluationInput
) {
  const expected = Number(detail.condValue ?? 0);
  if (!Number.isFinite(expected)) return { passes: false, reason: 'Offer has an invalid condition value' };

  if (detail.condObj === 'game') {
    const passes = detail.cond === '='
      ? input.gameIds.includes(expected)
      : compare(input.gameIds.length, detail.cond, expected);
    return { passes, reason: conditionFailureReason(detail, expected) };
  }

  const actual = detail.condObj === 'amount'
    ? input.originalAmount
    : detail.condObj === 'person'
      ? input.players
      : detail.condObj === 'time'
        ? input.durationHours
        : 0;
  const passes = compare(actual, detail.cond, expected);
  return { passes, reason: conditionFailureReason(detail, expected) };
}

function calculateOfferDiscount(
  details: OfferDetailRecord[],
  input: OfferEvaluationInput
) {
  return details.reduce((discount, detail) => {
    if (!detail.offerObj) return discount;
    const rawValue = detail.offerValue?.trim() ?? '0';

    if (detail.offerObj === 'amount') {
      const amount = rawValue.endsWith('%')
        ? input.originalAmount * (Number(rawValue.slice(0, -1)) / 100)
        : Number(rawValue);
      return discount + (Number.isFinite(amount) ? amount : 0);
    }

    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) return discount;
    if (detail.offerObj === 'person') {
      const freePlayers = Math.min(input.players, value);
      return discount + freePlayers * input.ratePerPersonPerHour * input.durationHours;
    }

    const freeHours = Math.min(input.durationHours, value);
    return discount + freeHours * input.ratePerPersonPerHour * input.players;
  }, 0);
}

export function evaluateOffers(input: OfferEvaluationInput) {
  const evaluated: EvaluatedOffer[] = input.offers.map((offer) => {
    const details = input.details.filter((detail) => detail.offerId === offer.id);
    const failedCondition = details
      .map((detail) => evaluateCondition(detail, input))
      .find((condition) => !condition.passes);
    const eligible = !failedCondition;
    const discount = eligible
      ? Math.min(input.originalAmount, Math.ceil(calculateOfferDiscount(details, input)))
      : 0;

    return {
      id: offer.id,
      name: offer.name,
      offerType: offer.offerType ?? 'EXCLUSIVE',
      eligible,
      discount,
      reason: failedCondition?.reason ?? (discount > 0 ? 'Applicable' : 'Offer has no discount')
    };
  });

  const candidates = evaluated.filter(
    (offer) =>
      offer.eligible &&
      offer.discount > 0 &&
      (!input.selectedOfferIds || input.selectedOfferIds.includes(offer.id))
  );
  const exclusive = candidates
    .filter((offer) => offer.offerType === 'EXCLUSIVE')
    .sort((a, b) => b.discount - a.discount)[0];
  const inclusive = candidates.filter((offer) => offer.offerType === 'INCLUSIVE');

  let appliedOffers: EvaluatedOffer[];
  if (input.selectedOfferIds) {
    appliedOffers = exclusive ? [exclusive] : inclusive;
  } else {
    const inclusiveDiscount = inclusive.reduce((sum, offer) => sum + offer.discount, 0);
    appliedOffers = exclusive && exclusive.discount >= inclusiveDiscount ? [exclusive] : inclusive;
  }

  const discountApplied = Math.min(
    input.originalAmount,
    appliedOffers.reduce((sum, offer) => sum + offer.discount, 0)
  );

  return {
    originalAmount: input.originalAmount,
    discountApplied,
    totalAmount: input.originalAmount - discountApplied,
    appliedOffers,
    offers: evaluated
  };
}
