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
  const id = service.createManualMarket({ symbol: 'PENGU', name: 'Pudgy Penguins', exchanges: ['coingecko'], pairs: { coingecko: 'pudgy-penguins' }, basePrice: 0.0325, closeAt: clock.now() + 72 * HOUR, resultAt: clock.now() + 18 * 24 * HOUR, publish: true });
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

test('admin checks ask CoinGecko once for every market, reuse prices for a minute, and say when it is busy', async () => {
  const clock = new ManualClock(Date.now());
  const urls: string[] = [];
  let busy = false;
  const http = async (url: string) => {
    urls.push(url);
    if (busy) throw new Error('429 Too Many Requests for api.coingecko.com/api/v3/simple/price');
    const ids = new URL(url).searchParams.get('ids')!.split(',');
    return Object.fromEntries(ids.map((id, i) => [id, { usd: 1 + i }]));
  };
  const service = new FirstprintService(openDb(':memory:'), clock, [coingecko(http)]);
  for (const id of ['aaa-coin', 'bbb-coin', 'ccc-coin']) {
    service.createManualMarket({ symbol: id.slice(0, 3).toUpperCase(), exchanges: ['coingecko'], pairs: { coingecko: id }, basePrice: 1, closeAt: clock.now() + 48 * HOUR, resultAt: clock.now() + 20 * 24 * HOUR, publish: true });
  }
  // Priced at the close and far from closing: no live price needed.
  service.createManualMarket({ symbol: 'DDD', exchanges: ['coingecko'], pairs: { coingecko: 'ddd-coin' }, basePrice: null, startAtClose: true, closeAt: clock.now() + 48 * HOUR, resultAt: clock.now() + 20 * 24 * HOUR, publish: true } as never);

  const checks = await service.marketChecks();
  assert.equal(urls.length, 1, 'one call for all of them');
  assert.match(urls[0], /ids=aaa-coin,bbb-coin,ccc-coin&/);
  assert.equal(checks.filter((c) => c.livePrice !== null).length, 3);

  const again = await service.exchangePrices('BBB', ['coingecko'], { coingecko: 'bbb-coin' });
  assert.equal(again[0].price, 2);
  assert.equal(urls.length, 1, 'the price check right after reuses it');

  busy = true;
  const fresh = await service.exchangePrices('NEW', ['coingecko'], { coingecko: 'new-coin' });
  assert.equal(fresh[0].price, null);
  assert.match(fresh[0].error ?? '', /busy \(rate limit\)/, 'not "not trading"');
});

test('a fixed start price nobody predicted against switches to the price at the close; one with predictions stays', async () => {
  const clock = new ManualClock(Date.now());
  const http = async () => {
    throw new Error('429 Too Many Requests for api.coingecko.com/api/v3/simple/price');
  };
  const service = new FirstprintService(openDb(':memory:'), clock, [coingecko(http)]);
  const mk = (sym: string) =>
    service.createManualMarket({ symbol: sym, exchanges: ['coingecko'], pairs: { coingecko: `${sym.toLowerCase()}-coin` }, basePrice: 1, closeAt: clock.now() + 48 * HOUR, resultAt: clock.now() + 20 * 24 * HOUR, publish: true });
  const empty = mk('QNT');
  const played = mk('DRV');
  const u = await service.createUser({ username: 'player_one', email: 'p1@example.com' });
  service.placePrediction(played, u.id, 'up', 50);

  const checks = Object.fromEntries((await service.marketChecks()).map((c) => [c.id, c]));
  assert.equal(checks[empty].canUseClose, true);
  assert.equal(checks[played].canUseClose, false, 'players predicted against the fixed price');
  assert.match(checks[empty].warnings[0].text, /didn't answer just now[\s\S]*at the close/);

  service.useCloseStart(empty);
  const m = service.getMarket(empty);
  assert.equal(m.basePrice, null);
  assert.equal(m.startAtClose, true);
  assert.throws(() => service.useCloseStart(played), /already predicted/);
  assert.equal(service.getMarket(played).basePrice, 1);
  const again = Object.fromEntries((await service.marketChecks()).map((c) => [c.id, c]));
  assert.deepEqual(again[empty].warnings, [], 'no live price needed until the close is near');
});

test('logo for a new listing: CoinGecko search, same ticker only, name match first, then biggest', async () => {
  const { Discover } = await import('../src/services/discover.ts');
  const { AppError } = await import('../src/services/firstprint.ts');
  const clock = new ManualClock(Date.UTC(2026, 9, 6, 12));
  const service = new FirstprintService(openDb(':memory:'), clock, []);
  const urls: string[] = [];
  let status = 200;
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(
      JSON.stringify({
        coins: [
          { id: 'bp-other', name: 'BP Swap', symbol: 'BP', market_cap_rank: 300, large: 'https://img/other.png' },
          { id: 'backpack', name: 'Backpack', symbol: 'bp', market_cap_rank: 900, large: 'https://img/backpack.png' },
          { id: 'bpx', name: 'Backpack X', symbol: 'BPX', market_cap_rank: 5, large: 'https://img/bpx.png' },
        ],
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const d = new Discover(service, { fetchImpl });
  assert.deepEqual(await d.tokenLogo('bp', 'Backpack'), { logo: 'https://img/backpack.png', coinId: 'backpack', name: 'Backpack', url: 'https://www.coingecko.com/en/coins/backpack' });
  assert.match(urls[0], /\/search\?query=BP$/);
  assert.equal((await d.tokenLogo('BP'))?.coinId, 'bp-other', 'no name: the biggest coin with that ticker');
  assert.equal(await d.tokenLogo('ZZZ'), null, 'no coin with that exact ticker');
  await d.tokenLogo('bp', 'Backpack');
  assert.equal(urls.length, 3, 'cached');
  await assert.rejects(d.tokenLogo('../x'), (e: unknown) => e instanceof AppError && e.code === 'bad_symbol');
  status = 429;
  clock.advance(2 * HOUR);
  await assert.rejects(d.tokenLogo('BP'), (e: unknown) => e instanceof AppError && e.code === 'rate_limited');
});

test('CoinGecko budget: admin tools get half the minute, live-market work keeps the rest and waits, a 429 backs everyone off', async () => {
  const { CoinGeckoGate, CoinGeckoBusy, asAdmin, defaultPerMinute } = await import('../src/exchanges/coingeckoGate.ts');
  let t = 0;
  const slept: number[] = [];
  const gate = new CoinGeckoGate({ perMinute: 6, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  const call = () => gate.run(async () => 'ok');
  // Admin tools: 3 of the 6, then "busy" without touching CoinGecko.
  for (let i = 0; i < 3; i++) assert.equal(await asAdmin(call), 'ok');
  await assert.rejects(asAdmin(call), (e: unknown) => e instanceof CoinGeckoBusy && /\b429\b/.test((e as Error).message));
  // Market work still has the other 3, then waits for the oldest call to age out instead of failing.
  for (let i = 0; i < 3; i++) assert.equal(await call(), 'ok');
  assert.equal(slept.length, 0);
  assert.equal(await call(), 'ok');
  assert.equal(slept.length, 1, 'waited once for room');
  assert.ok(t >= 60_000);
  // CoinGecko answers 429: admin tools stop for two minutes, market work waits about 30 seconds.
  t += 2 * 60_000;
  await assert.rejects(gate.run(async () => { throw new Error('429 Too Many Requests for api.coingecko.com/x'); }));
  await assert.rejects(asAdmin(call), (e: unknown) => e instanceof CoinGeckoBusy);
  const before = t;
  assert.equal(await call(), 'ok');
  assert.ok(t - before >= 30_000 && t - before < 60_000, 'market work waited out the short cool-down');
  await assert.rejects(asAdmin(call), (e: unknown) => e instanceof CoinGeckoBusy, 'admin still cooling');
  t += 2 * 60_000;
  assert.equal(await asAdmin(call), 'ok');
  assert.equal(defaultPerMinute({}), 10);
  assert.equal(defaultPerMinute({ COINGECKO_API_KEY: 'k' }), 25);
  assert.equal(defaultPerMinute({ COINGECKO_PER_MIN: '40' }), 40);
});

test('CoinGecko venue and Discover go through a gate when given one', async () => {
  const { CoinGeckoGate, asAdmin } = await import('../src/exchanges/coingeckoGate.ts');
  const { Discover } = await import('../src/services/discover.ts');
  const { AppError } = await import('../src/services/firstprint.ts');
  const gate = new CoinGeckoGate({ perMinute: 2, now: () => 0, sleep: async () => { throw new Error('should not wait'); } });
  let hits = 0;
  const cg = coingecko(async () => (hits++, { pepe: { usd: 1 } }), null, gate);
  assert.equal((await asAdmin(() => cg.fetchTicker('pepe')))?.price, 1);
  await assert.rejects(asAdmin(() => cg.fetchTicker('pepe')), /busy/);
  assert.equal(hits, 1, 'the refused call never reached CoinGecko');
  const service = new FirstprintService(openDb(':memory:'), new ManualClock(0), []);
  const d = new Discover(service, { gate, fetchImpl: (async () => new Response('{"coins":[]}', { status: 200 })) as typeof fetch });
  await assert.rejects(asAdmin(() => d.tokenLogo('PEPE')), (e: unknown) => e instanceof AppError && e.code === 'rate_limited');
});
