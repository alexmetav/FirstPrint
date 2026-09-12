import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  applyCaps,
  bucketForReturn,
  computePayouts,
  quote,
  returnPct,
  settleMarket,
  twap,
  venueMedian,
  weightFor,
  type AcceptedPrediction,
  type Candle,
  type MarketConfig,
  type Prediction,
} from '../src/engine/engine.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

function flatCandles(start: number, minutes: number, price: number, volume = 100, trades = 5): Candle[] {
  return Array.from({ length: minutes }, (_, i) => ({ ts: start + i * MIN, close: price, volume, trades }));
}

function accepted(p: Partial<AcceptedPrediction> & Pick<Prediction, 'id' | 'userId' | 'bucket' | 'stake'>): AcceptedPrediction {
  return { placedAt: 0, accepted: p.stake, refund: 0, weight: 1, ...p };
}

// --- Buckets ---------------------------------------------------------------

test('bucket boundaries match the spec', () => {
  assert.equal(bucketForReturn(-0.5), 'crash');
  assert.equal(bucketForReturn(-0.49), 'down');
  assert.equal(bucketForReturn(-0.1), 'down');
  assert.equal(bucketForReturn(-0.099), 'flat');
  assert.equal(bucketForReturn(0.099), 'flat');
  assert.equal(bucketForReturn(0.1), 'up');
  assert.equal(bucketForReturn(0.499), 'up');
  assert.equal(bucketForReturn(0.5), 'moon');
});

test('float noise does not move exact boundaries', () => {
  // 0.9 / 1 - 1 = -0.09999999999999998 in raw floats
  assert.equal(bucketForReturn(returnPct(1, 0.9)), 'down');
  assert.equal(bucketForReturn(returnPct(1, 1.1)), 'up');
});

// --- Oracle ----------------------------------------------------------------

test('twap averages closes and reports coverage', () => {
  const candles = [
    { ts: 0, close: 1, volume: 10, trades: 1 },
    { ts: MIN, close: 3, volume: 10, trades: 1 },
  ];
  const s = twap(candles, 0, 2 * MIN);
  assert.equal(s.twap, 2);
  assert.equal(s.coverage, 1);
  assert.equal(s.volume, 20);
  assert.equal(s.trades, 2);
});

test('twap carries prices forward across gaps, including from before the window', () => {
  const candles = [
    { ts: -MIN, close: 2, volume: 1 },
    { ts: 2 * MIN, close: 5, volume: 1 },
  ];
  const s = twap(candles, 0, 4 * MIN);
  // slots: 2, 2, 5, 5
  assert.equal(s.twap, 3.5);
  assert.equal(s.coverage, 0.25);
  assert.equal(s.trades, null);
});

test('a one-minute spike barely moves a one-hour twap', () => {
  const candles = flatCandles(0, 60, 1);
  candles[59] = { ...candles[59], close: 10 };
  const s = twap(candles, 0, HOUR);
  assert.ok(s.twap! < 1.2, `twap was ${s.twap}`);
});

test('venue median is volume weighted', () => {
  const price = venueMedian([
    { venue: 'big', price: 1.0, volume: 900 },
    { venue: 'thin', price: 5.0, volume: 10 },
    { venue: 'mid', price: 1.1, volume: 200 },
  ]);
  assert.equal(price, 1.0);
});

test('venue median falls back to plain median without volume', () => {
  assert.equal(venueMedian([{ venue: 'a', price: 1, volume: 0 }, { venue: 'b', price: 3, volume: 0 }]), 2);
  assert.equal(venueMedian([{ venue: 'a', price: null, volume: 5 }]), null);
});

// --- Pool ------------------------------------------------------------------

test('early-bird weight runs from 1+k down to 1', () => {
  assert.equal(weightFor(0, 0, 100, 0.5), 1.5);
  assert.equal(weightFor(50, 0, 100, 0.5), 1.25);
  assert.equal(weightFor(100, 0, 100, 0.5), 1);
  assert.equal(weightFor(500, 0, 100, 0.5), 1);
});

test('caps refund the latest predictions first', () => {
  const preds: Prediction[] = [
    { id: 'a', userId: 'u1', bucket: 'up', stake: 60, placedAt: 1 },
    { id: 'b', userId: 'u2', bucket: 'down', stake: 60, placedAt: 2 },
  ];
  const res = applyCaps(preds, 100, { perUserCapPct: 1, earlyBirdK: 0 }, 0, 10);
  assert.deepEqual(res.map((p) => [p.id, p.accepted, p.refund]), [['a', 60, 0], ['b', 40, 20]]);
});

test('per-user cap applies across multiple predictions', () => {
  const preds: Prediction[] = [
    { id: 'a', userId: 'u1', bucket: 'up', stake: 8, placedAt: 1 },
    { id: 'b', userId: 'u1', bucket: 'moon', stake: 8, placedAt: 2 },
  ];
  const res = applyCaps(preds, 100, { perUserCapPct: 0.1, earlyBirdK: 0 }, 0, 10);
  assert.deepEqual(res.map((p) => p.accepted), [8, 2]);
});

test('spec worked example: 250 on Down pays 960', () => {
  const preds = [
    accepted({ id: 'c', userId: 'x1', bucket: 'crash', stake: 1500 }),
    accepted({ id: 'd1', userId: 'me', bucket: 'down', stake: 250 }),
    accepted({ id: 'd2', userId: 'x2', bucket: 'down', stake: 2250 }),
    accepted({ id: 'f', userId: 'x3', bucket: 'flat', stake: 3000 }),
    accepted({ id: 'u', userId: 'x4', bucket: 'up', stake: 2000 }),
    accepted({ id: 'm', userId: 'x5', bucket: 'moon', stake: 1000 }),
  ];
  const res = computePayouts(preds, 'down', { feeBps: 400 });
  assert.equal(res.pool, 10_000);
  assert.equal(res.fee, 400);
  assert.equal(res.payouts.find((p) => p.predictionId === 'd1')!.payout, 960);
  assert.equal(res.payouts.find((p) => p.predictionId === 'f')!.payout, 0);
});

test('payouts never exceed the net pool', () => {
  const preds = [
    accepted({ id: '1', userId: 'a', bucket: 'up', stake: 333, weight: 1.37 }),
    accepted({ id: '2', userId: 'b', bucket: 'up', stake: 777, weight: 1.02 }),
    accepted({ id: '3', userId: 'c', bucket: 'down', stake: 1001, weight: 1.5 }),
  ];
  const res = computePayouts(preds, 'up', { feeBps: 400 });
  const paid = res.payouts.reduce((s, p) => s + p.payout, 0);
  assert.ok(paid <= res.netPool);
  assert.equal(res.dust, res.netPool - paid);
  assert.ok(res.dust < preds.length);
});

test('earlier winners earn more per point staked', () => {
  const preds = [
    accepted({ id: 'early', userId: 'a', bucket: 'up', stake: 100, weight: 1.5 }),
    accepted({ id: 'late', userId: 'b', bucket: 'up', stake: 100, weight: 1.0 }),
    accepted({ id: 'loser', userId: 'c', bucket: 'down', stake: 1000 }),
  ];
  const res = computePayouts(preds, 'up', { feeBps: 0 });
  const early = res.payouts.find((p) => p.predictionId === 'early')!.payout;
  const late = res.payouts.find((p) => p.predictionId === 'late')!.payout;
  assert.equal(early, 720);
  assert.equal(late, 480);
});

test('one-sided pools and empty winning buckets are refunded', () => {
  const oneSided = computePayouts([accepted({ id: '1', userId: 'a', bucket: 'up', stake: 50 })], 'up', { feeBps: 400 });
  assert.equal(oneSided.voidReason, 'one_sided_pool');
  assert.equal(oneSided.payouts[0].refund, 50);

  const noWinners = computePayouts(
    [accepted({ id: '1', userId: 'a', bucket: 'up', stake: 50 }), accepted({ id: '2', userId: 'b', bucket: 'down', stake: 50 })],
    'moon',
    { feeBps: 400 },
  );
  assert.equal(noWinners.voidReason, 'no_winners');
  assert.equal(noWinners.fee, 0);
  assert.deepEqual(noWinners.payouts.map((p) => p.refund), [50, 50]);
});

test('quote matches the eventual payout when nobody else joins', () => {
  const tOpen = 0;
  const tClose = 1000;
  const existing: Prediction[] = [
    { id: 'x', userId: 'x', bucket: 'down', stake: 900, placedAt: 100 },
    { id: 'y', userId: 'y', bucket: 'up', stake: 300, placedAt: 200 },
  ];
  const q = quote(existing, 'up', 200, 400, DEFAULT_CONFIG, tOpen, tClose);

  const mine: Prediction = { id: 'me', userId: 'me', bucket: 'up', stake: 200, placedAt: 400 };
  const acc = applyCaps([...existing, mine], 1_000_000, { perUserCapPct: 1, earlyBirdK: DEFAULT_CONFIG.earlyBirdK }, tOpen, tClose);
  const res = computePayouts(acc, 'up', DEFAULT_CONFIG);
  assert.equal(q.payout, res.payouts.find((p) => p.predictionId === 'me')!.payout);
});

// --- Settlement ------------------------------------------------------------

function market(overrides: Partial<MarketConfig> = {}) {
  const cfg: MarketConfig = { ...DEFAULT_CONFIG, ...overrides };
  const listingAt = 10 * HOUR;
  const preds = applyCaps(
    [
      { id: 'a', userId: 'a', bucket: 'down', stake: 100, placedAt: listingAt - HOUR },
      { id: 'b', userId: 'b', bucket: 'moon', stake: 100, placedAt: listingAt - HOUR },
    ],
    cfg.softCap,
    cfg,
    listingAt - 2 * HOUR,
    listingAt + cfg.baselineMs,
  );
  return { cfg, listingAt, preds };
}

test('settles a clean 30% drop into Down', () => {
  const { cfg, listingAt, preds } = market();
  const candles = [
    ...flatCandles(listingAt, 60, 2.0),
    ...flatCandles(listingAt + cfg.durationMs - HOUR, 60, 1.4),
  ];
  const res = settleMarket({
    cfg,
    announcedListingAt: listingAt,
    listingAt,
    openedAt: listingAt - 2 * HOUR,
    retracted: false,
    haltedMs: 0,
    candles: { mexc: candles },
    accepted: preds,
  });
  assert.equal(res.voidReason, null);
  assert.equal(res.winningBucket, 'down');
  assert.equal(res.returnPct, -0.3);
  assert.equal(res.payouts.find((p) => p.userId === 'a')!.payout, 192);
});

test('voids when the settlement window has no data', () => {
  const { cfg, listingAt, preds } = market();
  const res = settleMarket({
    cfg,
    announcedListingAt: listingAt,
    listingAt,
    openedAt: 0,
    retracted: false,
    haltedMs: 0,
    candles: { mexc: flatCandles(listingAt, 60, 2) },
    accepted: preds,
  });
  // Carry-forward gives a price, but coverage in the final window is zero.
  assert.equal(res.voidReason, 'insufficient_settlement_data');
  assert.ok(res.payouts.every((p) => p.refund === 100 && p.payout === 0));
});

test('voids delayed listings, halts, and retractions', () => {
  const { cfg, listingAt, preds } = market();
  const candles = { mexc: [...flatCandles(listingAt, 60, 2), ...flatCandles(listingAt + cfg.durationMs - HOUR, 60, 2)] };
  const base = { cfg, listingAt, openedAt: 0, candles, accepted: preds };

  assert.equal(settleMarket({ ...base, announcedListingAt: listingAt - 25 * HOUR, retracted: false, haltedMs: 0 }).voidReason, 'listing_delayed');
  assert.equal(settleMarket({ ...base, announcedListingAt: listingAt, retracted: false, haltedMs: 7 * HOUR }).voidReason, 'trading_halted');
  assert.equal(settleMarket({ ...base, announcedListingAt: listingAt, retracted: true, haltedMs: 0 }).voidReason, 'retracted');
});

test('a thin venue cannot move the settlement price', () => {
  const { cfg, listingAt, preds } = market();
  const end = listingAt + cfg.durationMs - HOUR;
  const res = settleMarket({
    cfg,
    announcedListingAt: listingAt,
    listingAt,
    openedAt: 0,
    retracted: false,
    haltedMs: 0,
    candles: {
      mexc: [...flatCandles(listingAt, 60, 2, 5000), ...flatCandles(end, 60, 2, 5000)],
      thin: [...flatCandles(listingAt, 60, 2, 10), ...flatCandles(end, 60, 9, 10)],
    },
    accepted: preds,
  });
  assert.equal(res.winningBucket, 'flat');
});
