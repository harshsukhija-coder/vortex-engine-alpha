import assert from 'node:assert/strict';
import { evaluateOffers, type OfferDetailRecord, type OfferRecord } from './offers.js';
import { calculatePriceForRule } from './pricing.js';

const offers: OfferRecord[] = [
  { id: 1, name: 'Buy 1 Get 1', offerType: 'EXCLUSIVE' },
  { id: 2, name: 'Flat 50', offerType: 'INCLUSIVE' }
];
const details: OfferDetailRecord[] = [
  {
    offerId: 1,
    condObj: 'person',
    cond: '>=',
    condValue: '2',
    offerObj: 'person',
    offerValue: '1'
  },
  {
    offerId: 2,
    condObj: 'amount',
    cond: '>=',
    condValue: '500',
    offerObj: 'amount',
    offerValue: '50'
  }
];

const bigScreen = { price: 150, singlePlayerPrice: 150, multiplayerPrice: 120 };
assert.equal(calculatePriceForRule(bigScreen, 1, 2).basePrice, 300);

const threePlayerPrice = calculatePriceForRule(bigScreen, 3, 2);
assert.equal(threePlayerPrice.ratePerPersonPerHour, 120);
assert.equal(threePlayerPrice.basePrice, 720);

const threePlayerOffers = evaluateOffers({
  offers,
  details,
  originalAmount: threePlayerPrice.basePrice,
  players: 3,
  durationHours: 2,
  ratePerPersonPerHour: threePlayerPrice.ratePerPersonPerHour,
  gameIds: []
});
assert.equal(threePlayerOffers.discountApplied, 240);
assert.equal(threePlayerOffers.totalAmount, 480);
assert.deepEqual(threePlayerOffers.appliedOffers.map((offer) => offer.id), [1]);

const fourPlayerPrice = calculatePriceForRule(bigScreen, 4, 2);
const fourPlayerOffers = evaluateOffers({
  offers,
  details,
  originalAmount: fourPlayerPrice.basePrice,
  players: 4,
  durationHours: 2,
  ratePerPersonPerHour: fourPlayerPrice.ratePerPersonPerHour,
  gameIds: []
});
assert.equal(fourPlayerOffers.discountApplied, 240);
assert.equal(fourPlayerOffers.totalAmount, 720);

const standardScreen = { price: 100, singlePlayerPrice: 100, multiplayerPrice: 80 };
const standardPrice = calculatePriceForRule(standardScreen, 3, 2);
assert.equal(standardPrice.basePrice, 480);
const standardOffers = evaluateOffers({
  offers,
  details,
  originalAmount: standardPrice.basePrice,
  players: 3,
  durationHours: 2,
  ratePerPersonPerHour: standardPrice.ratePerPersonPerHour,
  gameIds: []
});
assert.equal(standardOffers.discountApplied, 160);
assert.equal(standardOffers.totalAmount, 320);

console.log('Pricing and offer checks passed.');
