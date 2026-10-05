// Trending tokens are priced from CoinGecko, which is a price source, not an exchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { ListingTracker } from '../src/workers/listingTracker.ts';
import { coingecko } from '../src/exchanges/venues.ts';

const HOUR = 3_600_000;

test('CoinGecko: live price and price points by coin id, with the optional demo key', async () => {
  const urls: string[] = [];
  const http = async (url: string) => {
    urls.push(url);
    if (url.includes('/simple/price')) return { 'pudgy-penguins': { usd: 0.0325 } };
    return { prices: [[Date.UTC(2026, 9, 5, 12, 0, 30), 0.03], [Date.UTC(2026, 9, 5, 12, 5, 10), 0.031], [Date.UTC(2026, 9, 6), 0.05]] };
  };
  const cg = coingecko(http, 'demo-key');
  assert.equal(cg.priceOnly, true);
  assert.deepEqual(await cg.fetchTicker('pudgy-penguins').then((t) => t?.price), 0.0325);
  assert.match(urls[0], /ids=pudgy-penguins&vs_currencies=usd&x_cg_demo_api_key=demo-key$/);
  assert.equal(await cg.fetchTicker('unknown-coin'), null);
  const candles = await cg.fetchCandles('pudgy-penguins', Date.UTC(2026, 9, 5, 12), Date.UTC(2026, 9, 5, 13));
  assert.deepEqual(candles.map((c) => [c.ts, c.close]), [[Date.UTC(2026, 9, 5, 12), 0.03], [Date.UTC(2026, 9, 5, 12, 5), 0.031]]);
});

test('a trending market keeps its CoinGecko coin id, prices from it, and is never scanned for listings', async () => {
  const clock = new ManualClock(Date.UTC(2026, 9, 5, 12));
  const asked: string[] = [];
  const cg = coingecko(async (url) => {
    asked.push(url);
    return { 'pudgy-penguins': { usd: 0.0325 } };
  });
  const service = new FirstprintService(openDb(':memory:'), clock, [cg]);
  const id = service.createManualMarket({ symbol: 'PENGU', name: 'Pudgy Penguins', exchanges: ['coingecko'], pairs: { coingecko: 'pudgy-penguins' }, basePrice: 0.0325, closeAt: clock.now() + 15 * 24 * HOUR, resultAt: clock.now() + 16 * 24 * HOUR, publish: true });
  assert.throws(() => service.createManualMarket({ symbol: 'SOL', exchanges: ['coingecko'], basePrice: 1, closeAt: clock.now() + HOUR, resultAt: clock.now() + 2 * HOUR }), /needs the coin id/, 'CoinGecko without a coin id is refused');
  const m = service.getMarket(id);
  assert.deepEqual(m.venues.map((v) => [v.id, v.name, v.pair]), [['coingecko', 'CoinGecko', 'pudgy-penguins']]);
  const [p] = await service.exchangePrices('PENGU', ['coingecko'], { coingecko: 'pudgy-penguins' });
  assert.equal(p.price, 0.0325);
  // Editing the market (the form sends the exchanges again) keeps the coin id.
  service.updateManualMarket(id, { exchanges: ['coingecko'], pairs: { coingecko: 'pudgy-penguins' }, note: 'Trending' });
  assert.equal(service.getMarket(id).venues[0].pair, 'pudgy-penguins');
  // The listing tracker skips price sources.
  asked.length = 0;
  await new ListingTracker(service, [cg], { autoCreate: false, review: true }).run();
  assert.equal(asked.length, 0);
  assert.equal(service.exchangeSettings().find((e) => e.id === 'coingecko')?.priceOnly, true);
});
