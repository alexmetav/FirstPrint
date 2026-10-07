import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binance, bitget, bybit, extractListingTime, extractSymbols, gate, kucoin, mexc, okx, type Http, type Venue } from '../src/exchanges/venues.ts';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { ListingTracker } from '../src/workers/listingTracker.ts';
import { LiveFeed } from '../src/workers/liveFeed.ts';
import { SimVenue } from '../src/exchanges/sim.ts';

const MIN = 60_000;
const T = Date.UTC(2026, 0, 5, 10, 0); // fixed past time so candles count as closed

/** Fake HTTP: first route whose substring matches the URL wins. */
function fakeHttp(routes: [string, unknown][]): Http & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const hit = routes.find(([k]) => url.includes(k));
    if (!hit) throw new Error(`no fixture for ${url}`);
    return typeof hit[1] === 'function' ? (hit[1] as (u: string) => unknown)(url) : hit[1];
  }) as Http & { calls: string[] };
  fn.calls = calls;
  return fn;
}

// --- Parsing -------------------------------------------------------------------

test('extractSymbols handles common announcement titles', () => {
  assert.deepEqual(extractSymbols('Binance Will List Kora Network (KORA) with Seed Tag Applied'), ['KORA']);
  assert.deepEqual(extractSymbols('New Listing: BRINE/USDT — Grab a Share of 500,000 BRINE'), ['BRINE']);
  assert.deepEqual(extractSymbols('Bitget Will List Otto Agents (OTTO) in the Innovation Zone'), ['OTTO']);
  assert.deepEqual(extractSymbols('OKX to list PEBL (PEBL) and NIMB (NIMB) for spot trading'), ['PEBL', 'NIMB']);
  assert.deepEqual(extractSymbols('Maintenance for USDT (USDT) deposits at 10:00 (UTC)'), []);
});

test('extractListingTime reads the usual date formats in UTC', () => {
  assert.equal(extractListingTime('Spot trading opens 2026-09-20 10:00 (UTC).'), Date.UTC(2026, 8, 20, 10, 0));
  assert.equal(extractListingTime('Trading: Sep 20, 2026, 14:30 (UTC)'), Date.UTC(2026, 8, 20, 14, 30));
  assert.equal(extractListingTime('Deposits open now. Trading starts at 2:00 PM UTC on September 21, 2026'), Date.UTC(2026, 8, 21, 14, 0));
  assert.equal(
    extractListingTime('Deposits: 2026/09/19 08:00 UTC. Spot trading: 2026/09/20 12:00 UTC.'),
    Date.UTC(2026, 8, 20, 12, 0),
    'prefers the time after "trading"',
  );
  assert.equal(extractListingTime('No time here'), null);
});

// --- Adapters --------------------------------------------------------------------

test('binance: klines, ticker, pairs, announcements', async () => {
  const http = fakeHttp([
    ['/api/v3/klines', [[T, '1', '1.2', '0.9', '1.1', '500', T + MIN - 1, '550', 42], [T + MIN, '1.1', '1.3', '1', '1.25', '400', T + 2 * MIN - 1, '480', 30]]],
    ['/api/v3/ticker/price', { symbol: 'KORAUSDT', price: '1.31' }],
    ['/api/v3/exchangeInfo', { symbols: [{ symbol: 'KORAUSDT', baseAsset: 'KORA', quoteAsset: 'USDT' }, { symbol: 'KORABTC', baseAsset: 'KORA', quoteAsset: 'BTC' }] }],
    ['/bapi/composite', { data: { catalogs: [{ articles: [{ id: 1, code: 'abc', title: 'Binance Will List Kora Network (KORA)', releaseDate: T }] }] } }],
  ]);
  const v = binance(http);
  const candles = await v.fetchCandles('KORAUSDT', T, T + 2 * MIN);
  assert.deepEqual(candles, [{ ts: T, close: 1.1, volume: 550, trades: 42 }, { ts: T + MIN, close: 1.25, volume: 480, trades: 30 }]);
  assert.equal((await v.fetchTicker('KORAUSDT'))?.price, 1.31);
  assert.deepEqual((await v.listPairs()).map((p) => p.pair), ['KORAUSDT']);
  const [a] = await v.fetchAnnouncements!();
  assert.deepEqual([a.exchange, a.symbols, a.url], ['binance', ['KORA'], 'https://www.binance.com/en/support/announcement/detail/abc']);
  assert.equal(v.pair('kora'), 'KORAUSDT');
});

test('mexc: binance-compatible without trade counts', async () => {
  const v = mexc(fakeHttp([['/api/v3/klines', [[T, '1', '1', '1', '2', '10', T + MIN - 1, '20']]]]));
  assert.deepEqual(await v.fetchCandles('XUSDT', T, T + MIN), [{ ts: T, close: 2, volume: 20, trades: undefined }]);
  assert.equal(v.fetchAnnouncements, undefined);
});

test('bybit: newest-first klines, tickers, paginated instruments, announcements', async () => {
  const v = bybit(
    fakeHttp([
      ['/v5/market/kline', { result: { list: [[String(T + MIN), '1', '1', '1', '1.5', '10', '15'], [String(T), '1', '1', '1', '1.2', '10', '12']] } }],
      ['/v5/market/tickers', { time: T, result: { list: [{ lastPrice: '1.6' }] } }],
      ['cursor=next', { result: { list: [{ symbol: 'BUSDT', baseCoin: 'B', quoteCoin: 'USDT' }], nextPageCursor: '' } }],
      ['/v5/market/instruments-info', { result: { list: [{ symbol: 'AUSDT', baseCoin: 'A', quoteCoin: 'USDT' }], nextPageCursor: 'next' } }],
      ['/v5/announcements/index', { result: { list: [{ title: 'New Listing: BRINE/USDT', description: 'Trading starts 2026-09-20 10:00 (UTC)', url: 'https://announcements.bybit.com/x', dateTimestamp: T }] } }],
    ]),
  );
  assert.deepEqual((await v.fetchCandles('BRINEUSDT', T, T + 2 * MIN)).map((c) => [c.ts, c.close, c.volume]), [[T, 1.2, 12], [T + MIN, 1.5, 15]]);
  assert.deepEqual(await v.fetchTicker('BRINEUSDT'), { price: 1.6, ts: T });
  assert.deepEqual((await v.listPairs()).map((p) => p.pair), ['AUSDT', 'BUSDT']);
  const [a] = await v.fetchAnnouncements!();
  assert.deepEqual([a.symbols, a.listingAt], [['BRINE'], Date.UTC(2026, 8, 20, 10)]);
});

test('okx: history candles skip unconfirmed, instruments carry listTime', async () => {
  const v = okx(
    fakeHttp([
      ['/market/history-candles', { data: [[String(T + MIN), '1', '1', '1', '9', '1', '1', '99', '0'], [String(T), '1', '1', '1', '2', '1', '1', '30', '1']] }],
      ['/market/ticker', { data: [{ last: '2.5', ts: String(T) }] }],
      ['/public/instruments', { data: [{ instId: 'PEBL-USDT', baseCcy: 'PEBL', quoteCcy: 'USDT', listTime: String(T + 60 * MIN) }] }],
      ['/support/announcements', { data: [{ details: [{ title: 'OKX to list Pebble (PEBL) for spot trading', url: 'https://www.okx.com/help/x', pTime: String(T) }] }] }],
    ]),
  );
  assert.deepEqual((await v.fetchCandles('PEBL-USDT', T, T + 2 * MIN)).map((c) => c.close), [2]);
  assert.equal((await v.fetchTicker('PEBL-USDT'))?.price, 2.5);
  assert.equal((await v.listPairs())[0].listingAt, T + 60 * MIN);
  assert.deepEqual((await v.fetchAnnouncements!())[0].symbols, ['PEBL']);
  assert.equal(v.pair('pebl'), 'PEBL-USDT');
});

test('gate: second timestamps, closed flag, buy_start', async () => {
  const v = gate(
    fakeHttp([
      ['/spot/candlesticks', [[String(T / 1000), '77', '3.3', '3.4', '3.2', '3.25', '23', 'true']]],
      ['/spot/currency_pairs', [{ id: 'GLINT_USDT', base: 'GLINT', quote: 'USDT', buy_start: T / 1000 + 3600 }]],
    ]),
  );
  assert.deepEqual(await v.fetchCandles('GLINT_USDT', T, T + MIN), [{ ts: T, close: 3.3, volume: 77 }]);
  assert.equal((await v.listPairs())[0].listingAt, T + 3_600_000);
});

test('bitget and kucoin: candles and announcements', async () => {
  const bg = bitget(
    fakeHttp([
      ['/spot/market/candles', { data: [[String(T), '1', '1', '1', '4.4', '5', '22', '22']] }],
      ['/public/annoucements', { data: [{ annId: '9', annTitle: 'Bitget Will List Otto Agents (OTTO)', annDesc: 'Trading: 2026-09-22 08:00 (UTC)', annUrl: 'https://www.bitget.com/support/x', cTime: String(T) }] }],
    ]),
  );
  assert.deepEqual(await bg.fetchCandles('OTTOUSDT', T, T + MIN), [{ ts: T, close: 4.4, volume: 22 }]);
  const [ba] = await bg.fetchAnnouncements!();
  assert.deepEqual([ba.symbols, ba.listingAt], [['OTTO'], Date.UTC(2026, 8, 22, 8)]);

  const kc = kucoin(
    fakeHttp([
      ['/market/candles', { data: [[String(T / 1000), '1', '5.5', '6', '5', '10', '55']] }],
      ['/api/v3/announcements', { data: { items: [{ annId: 3, annTitle: 'Nimbus AI (NIMB) Gets Listed on KuCoin!', annUrl: 'https://www.kucoin.com/announcement/x', cTime: T }] } }],
    ]),
  );
  assert.deepEqual(await kc.fetchCandles('NIMB-USDT', T, T + MIN), [{ ts: T, close: 5.5, volume: 55 }]);
  assert.deepEqual((await kc.fetchAnnouncements!())[0].symbols, ['NIMB']);
});

// --- Listing tracker -----------------------------------------------------------------

function fakeVenue(id: string, state: { pairs: { pair: string; base: string; listingAt: number | null }[]; anns: { id: string; title: string; listingAt: number | null; publishedAt?: number }[] }): Venue {
  return {
    id,
    name: id.toUpperCase(),
    pair: (b) => `${b}USDT`,
    fetchCandles: async () => [],
    fetchTicker: async () => ({ price: 1, ts: Date.now() }),
    listPairs: async () => state.pairs.map((p) => ({ ...p, quote: 'USDT' })),
    fetchAnnouncements: async () =>
      state.anns.map((a) => ({ exchange: id, id: a.id, title: a.title, url: `https://ex/${a.id}`, publishedAt: a.publishedAt ?? T, listingAt: a.listingAt, symbols: extractSymbols(a.title) })),
  };
}

test('listing tracker: announcements, pair diffs, first-run behaviour, dedupe, approval', async () => {
  const clock = new ManualClock(T);
  const state = {
    pairs: [
      { pair: 'OLDUSDT', base: 'OLD', listingAt: null },
      { pair: 'SOONUSDT', base: 'SOON', listingAt: T + 5 * 60 * MIN },
    ],
    anns: [{ id: 'a1', title: 'EXA Will List Kora Network (KORA)', listingAt: T + 24 * 60 * MIN }],
  };
  const venue = fakeVenue('exa', state);
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const tracker = new ListingTracker(service, [venue], { autoCreate: false });

  assert.equal((await tracker.run()).detected, 2, 'announcement + upcoming pair; existing pairs ignored on first run');
  assert.equal((await tracker.run()).detected, 0, 'dedupe on repeat runs');

  state.pairs.push({ pair: 'NEWUSDT', base: 'NEW2', listingAt: null });
  assert.equal((await tracker.run()).detected, 1, 'new pair detected by diff');

  const pending = service.detections({ status: 'pending' });
  const kora = pending.find((d) => d.symbol === 'KORA')!;
  assert.equal(kora.source, 'announcement');
  const marketId = service.approveDetection(kora.id, { name: 'Kora Network' });
  const m = service.getMarket(marketId);
  assert.deepEqual([m.symbol, m.exchange, m.listingAt], ['KORA', 'EXA', T + 24 * 60 * MIN]);
  assert.throws(() => service.approveDetection(kora.id), /already has a market/);

  const noTime = pending.find((d) => d.symbol === 'NEW2')!;
  assert.throws(() => service.approveDetection(noTime.id), /trading start time/);
});

test('listing tracker: auto-create markets when symbol and future time are known', async () => {
  const clock = new ManualClock(T);
  const venue = fakeVenue('exb', { pairs: [], anns: [{ id: 'b1', title: 'EXB lists Otto (OTTO)', listingAt: T + 3 * 60 * MIN }, { id: 'b2', title: 'EXB lists Mystery token', listingAt: null }] });
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  await new ListingTracker(service, [venue], { autoCreate: true }).run();
  assert.deepEqual(service.listMarkets('open').map((m) => m.symbol), ['OTTO']);
  assert.equal(service.detections({ status: 'pending' }).length, 1);
});

// --- Live feed -----------------------------------------------------------------------

test('live feed emits price events with projected outcome', async () => {
  const clock = new ManualClock(T);
  const sim = new SimVenue('sim', clock);
  const service = new FirstprintService(openDb(':memory:'), clock, [sim]);
  const listingAt = T + MIN;
  sim.add('LIVEUSDT', { listingAt, startPrice: 1, targetReturn: 0.8, horizonMs: 30 * MIN, noise: 0, volume: 100 });
  const id = service.createMarket({
    symbol: 'LIVE',
    exchange: 'Sim',
    venues: [{ venue: 'sim', symbol: 'LIVEUSDT' }],
    announcedListingAt: listingAt,
    listingAt,
    config: { baselineMs: 5 * MIN, durationMs: 30 * MIN, settleWindowMs: 5 * MIN, minTrades: 1 },
  });
  const feed = new LiveFeed(service);
  const events: [string, Record<string, unknown>][] = [];
  feed.subscribe((e, d) => events.push([e, d]));

  clock.advance(20 * MIN);
  await service.ingestPrices();
  await feed.poll();
  const price = events.find(([e]) => e === 'price')?.[1];
  assert.ok(price, 'price event emitted');
  assert.equal(price!.marketId, id);
  assert.ok((price!.returnPct as number) > 0.1);
  assert.ok(['up', 'moon'].includes(price!.projectedBucket as string));
});

test('MEXC pairs carry the trading start time and name; paused pairs are left out', async () => {
  const soon = Date.now() + 60 * MIN;
  const v = mexc(
    fakeHttp([
      [
        '/api/v3/exchangeInfo',
        {
          symbols: [
            { symbol: 'AGENCYUSDT', baseAsset: 'AGENCY', quoteAsset: 'USDT', isSpotTradingAllowed: true, firstOpenTime: T, fullName: 'Agency' },
            { symbol: 'SOONUSDT', baseAsset: 'SOON', quoteAsset: 'USDT', isSpotTradingAllowed: false, firstOpenTime: soon, fullName: 'Soon' },
            { symbol: 'DEADUSDT', baseAsset: 'DEAD', quoteAsset: 'USDT', isSpotTradingAllowed: false, firstOpenTime: T },
            { symbol: 'AGENCYUSDC', baseAsset: 'AGENCY', quoteAsset: 'USDC', isSpotTradingAllowed: true },
          ],
        },
      ],
    ]),
  );
  assert.deepEqual(await v.listPairs(), [
    { pair: 'AGENCYUSDT', base: 'AGENCY', quote: 'USDT', listingAt: T, name: 'Agency' },
    { pair: 'SOONUSDT', base: 'SOON', quote: 'USDT', listingAt: soon, name: 'Soon' },
  ]);
});

test('automatic listing markets: upcoming and just-opened pairs, 72h results, daily limit, switch off', async () => {
  const clock = new ManualClock(T);
  const state = { pairs: [{ pair: 'OLDUSDT', base: 'OLD', listingAt: T - 30 * 24 * 60 * MIN }] as { pair: string; base: string; listingAt: number | null; name?: string }[], anns: [] };
  const venue = fakeVenue('mexc', state);
  delete venue.fetchAnnouncements;
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const tracker = new ListingTracker(service, [venue], { autoCreate: true, maxPerDay: 5, durationMs: 72 * 60 * MIN, enabled: () => service.autoListingsEnabled() });

  await tracker.run(); // first run only learns the existing pairs
  assert.equal(service.listMarkets('open').length, 0);

  state.pairs.push(
    { pair: 'UPUSDT', base: 'UP', listingAt: T + 2 * 60 * MIN, name: 'Up Token' }, // upcoming
    { pair: 'JUSTUSDT', base: 'JUST', listingAt: T - 10 * MIN }, // opened 10 minutes ago
    { pair: 'LATEUSDT', base: 'LATE', listingAt: T - 2 * 60 * MIN }, // opened 2 hours ago: too late
    { pair: 'NOTIMEUSDT', base: 'NOTIME', listingAt: null },
  );
  await tracker.run();
  const open = service.listMarkets('open');
  assert.deepEqual(open.map((m) => m.symbol).sort(), ['JUST', 'UP']);
  const up = open.find((m) => m.symbol === 'UP')!;
  assert.equal(up.name, 'Up Token');
  assert.equal(up.listingAt, T + 2 * 60 * MIN);
  assert.equal(service.getMarket(up.id).settleAt - up.listingAt, 72 * 60 * MIN);
  assert.equal(service.getMarket(open.find((m) => m.symbol === 'JUST')!.id).listingAt, T - 10 * MIN, 'keeps the real start, so the start price is the first hour');

  state.pairs.push({ pair: 'UP2USDT', base: 'UP', listingAt: T + 3 * 60 * MIN }); // same token again: no second market
  await tracker.run();
  assert.equal(service.listMarkets('open').filter((m) => m.symbol === 'UP').length, 1);

  for (let i = 0; i < 6; i++) state.pairs.push({ pair: `N${i}USDT`, base: `NEWT${i}`, listingAt: T + 60 * MIN });
  await tracker.run();
  assert.equal(service.listMarkets('open').length, 5, 'no more than 5 in 24 hours');

  clock.advance(25 * 60 * MIN);
  service.setAutoListings(false);
  state.pairs.push({ pair: 'OFFUSDT', base: 'OFF', listingAt: T + 26 * 60 * MIN });
  assert.equal((await tracker.run()).detected, 0, 'switched off: nothing is checked');
  service.setAutoListings(true);
  await tracker.run();
  assert.ok(service.listMarkets('open').some((m) => m.symbol === 'OFF'));
});

test('review queue: new listings wait for the admin, with an alert; old pairs and tokens with a market are skipped', async () => {
  const clock = new ManualClock(T);
  const state = { pairs: [{ pair: 'OLDUSDT', base: 'OLD', listingAt: T - 30 * 24 * 60 * MIN }] as { pair: string; base: string; listingAt: number | null; name?: string }[], anns: [] };
  const venue = fakeVenue('mexc', state);
  delete venue.fetchAnnouncements;
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const alerts: string[] = [];
  const tracker = new ListingTracker(service, [venue], { autoCreate: false, review: true, onNew: (ds) => void alerts.push(...ds.map((d) => `${d.symbol}:${d.name ?? ''}`)) });
  await tracker.run();

  service.createMarket({ symbol: 'HAS', exchange: 'MEXC', venues: [{ venue: 'mexc', symbol: 'HASUSDT' }], announcedListingAt: T + 60 * MIN, listingAt: T + 60 * MIN });
  state.pairs.push(
    { pair: 'NEWUSDT', base: 'NEW', listingAt: T + 2 * 60 * MIN, name: 'New Token' },
    { pair: 'RECENTUSDT', base: 'RECENT', listingAt: T - 3 * 60 * MIN },
    { pair: 'BACKUSDT', base: 'BACK', listingAt: T - 5 * 24 * 60 * MIN }, // an old pair switched back on
    { pair: 'HASUSDT', base: 'HAS', listingAt: T + 60 * MIN }, // already has a market
  );
  await tracker.run();
  assert.deepEqual(alerts.sort(), ['NEW:New Token', 'RECENT:']);
  assert.deepEqual(service.detections({ status: 'pending' }).map((d) => d.symbol).sort(), ['NEW', 'RECENT']);
  assert.equal(service.listMarkets('open').length, 1, 'nothing is published by itself');

  const d = service.detections({ status: 'pending' }).find((x) => x.symbol === 'NEW')!;
  service.linkDetection(d.id, service.listMarkets('open')[0].id);
  assert.equal(service.detections({ status: 'pending' }).length, 1);

  clock.advance(4 * 24 * 60 * MIN);
  await tracker.run();
  assert.equal(service.detections({ status: 'pending' }).length, 0, 'listings left for days drop off the queue');
});

test('review queue across exchanges: one alert per token, old announcements skipped, an exchange can be switched off', async () => {
  const clock = new ManualClock(T);
  type S = { pairs: { pair: string; base: string; listingAt: number | null }[]; anns: { id: string; title: string; listingAt: number | null; publishedAt?: number }[] };
  const mexcState: S = { pairs: [{ pair: 'BTCUSDT', base: 'BTC', listingAt: null }], anns: [] };
  const gateState: S = {
    pairs: [{ pair: 'ETHUSDT', base: 'ETH', listingAt: null }],
    // Announcements a newly watched exchange already had: a week old is skipped, today's is kept.
    anns: [
      { id: 'old', title: 'GATE Will List Ancient Coin (ANCI)', listingAt: null, publishedAt: T - 7 * 24 * 60 * MIN },
      { id: 'new', title: 'GATE Will List Fresh Coin (FRSH)', listingAt: T + 5 * 60 * MIN },
    ],
  };
  const mexc = fakeVenue('mexc', mexcState);
  delete mexc.fetchAnnouncements;
  const gate = fakeVenue('gate', gateState);
  const service = new FirstprintService(openDb(':memory:'), clock, [mexc, gate]);
  const alerts: string[] = [];
  const tracker = new ListingTracker(service, [mexc, gate], {
    autoCreate: false,
    review: true,
    venueEnabled: (id) => service.exchangeEnabled(id),
    onNew: (ds) => void alerts.push(...ds.map((d) => `${d.symbol}@${d.exchange}`)),
  });
  await tracker.run();
  assert.deepEqual(alerts, ['FRSH@gate'], 'first run: only the recent announcement, no existing pairs');

  // The same new token on both exchanges in one run: one alert, from the exchange seen first.
  mexcState.pairs.push({ pair: 'DUOUSDT', base: 'DUO', listingAt: T + 60 * MIN });
  gateState.pairs.push({ pair: 'DUOUSDT', base: 'DUO', listingAt: T + 60 * MIN });
  // Announced earlier on Gate, now its pair appears too: no second alert.
  gateState.pairs.push({ pair: 'FRSHUSDT', base: 'FRSH', listingAt: T + 5 * 60 * MIN });
  await tracker.run();
  assert.deepEqual(alerts, ['FRSH@gate', 'DUO@mexc']);
  assert.deepEqual(service.detections({ status: 'pending' }).map((d) => `${d.symbol}@${d.exchange}`).sort(), ['DUO@mexc', 'FRSH@gate']);

  // Switched off under Reference exchanges: not checked at all.
  service.setExchangeEnabled('gate', false);
  gateState.pairs.push({ pair: 'OFFUSDT', base: 'OFF', listingAt: T + 60 * MIN });
  assert.equal((await tracker.run()).detected, 0);
  service.setExchangeEnabled('gate', true);
  await tracker.run();
  assert.deepEqual(alerts.at(-1), 'OFF@gate', 'picked up once switched back on');
});

test('Chinese token symbols: detected, reviewed and opened as a market with a plain link id', async () => {
  const { validSymbol } = await import('../src/services/firstprint.ts');
  assert.ok(validSymbol('币安人生'));
  assert.ok(validSymbol('龙'), 'one Chinese character can be a whole ticker');
  assert.ok(validSymbol('SOL'));
  assert.ok(!validSymbol('S'), 'one Latin letter is too short');
  assert.ok(!validSymbol('币安 人生'), 'no spaces');
  assert.ok(!validSymbol('SOL/USDT'));

  const clock = new ManualClock(T);
  const state = { pairs: [] as { pair: string; base: string; listingAt: number | null }[], anns: [] };
  const venue = fakeVenue('mexc', state);
  delete venue.fetchAnnouncements;
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const alerts: string[] = [];
  const tracker = new ListingTracker(service, [venue], { autoCreate: false, review: true, onNew: (ds) => void alerts.push(...ds.map((d) => d.symbol!)) });
  await tracker.run();
  state.pairs.push({ pair: '币安人生USDT', base: '币安人生', listingAt: T + 60 * MIN });
  await tracker.run();
  assert.deepEqual(alerts, ['币安人生']);

  const prices = await service.exchangePrices('币安人生', ['mexc']);
  assert.equal(prices[0].pair, '币安人生USDT');
  const id = service.createManualMarket({ symbol: '币安人生', exchanges: ['mexc'], basePrice: 0.5, closeAt: T + 60 * MIN, resultAt: T + 72 * 60 * MIN, publish: true });
  assert.match(id, /^token-m-[0-9a-f]{6}$/, 'link ids stay ASCII');
  assert.equal(service.getMarket(id).symbol, '币安人生');
  assert.equal(service.hasActiveMarket('币安人生'), true);
});

test('review queue: deleting a draft made from a listing returns it to the queue; stale drafts and time-less listings', async () => {
  const clock = new ManualClock(T);
  const state = { pairs: [] as { pair: string; base: string; listingAt: number | null }[], anns: [] };
  const venue = fakeVenue('mexc', state);
  delete venue.fetchAnnouncements;
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const id = service.recordDetection({ exchange: 'mexc', symbol: 'NEWT', pair: 'NEWTUSDT', source: 'symbol_diff', title: null, url: null, listingAt: T + 60 * MIN, publishedAt: null, dedupeKey: 'k1' })!;
  const draft = service.createManualMarket({ symbol: 'NEWT', exchanges: ['mexc'], basePrice: 1, closeAt: T + 2 * 60 * MIN, resultAt: T + 48 * 60 * MIN });
  service.linkDetection(id, draft);
  assert.equal(service.detections({ status: 'pending' }).length, 0);
  assert.equal(service.hasActiveMarket('NEWT'), true);
  service.deleteDraft(draft);
  assert.deepEqual(service.detections({ status: 'pending' }).map((d) => d.symbol), ['NEWT'], 'back in the queue');

  const stale = service.createManualMarket({ symbol: 'OLDD', exchanges: ['mexc'], basePrice: 1, closeAt: T + 10 * MIN, resultAt: T + 48 * 60 * MIN });
  assert.equal(service.hasActiveMarket('OLDD'), true);
  clock.advance(20 * MIN);
  assert.equal(service.hasActiveMarket('OLDD'), false, 'an abandoned draft does not block the token');
  assert.ok(stale);

  service.recordDetection({ exchange: 'mexc', symbol: 'NOTIME', pair: 'NOTIMEUSDT', source: 'symbol_diff', title: null, url: null, listingAt: null, publishedAt: null, dedupeKey: 'k2' });
  clock.advance(4 * 24 * 60 * MIN);
  service.expireDetections(clock.now() - 3 * 24 * 60 * MIN);
  assert.equal(service.detections({ status: 'pending' }).length, 0, 'listings without a start time drop off too');
});

test('review queue: skip all clears it, and skipped listings stay skipped when the exchanges are checked again', async () => {
  const clock = new ManualClock(T);
  const state = {
    pairs: [
      { pair: 'AAAUSDT', base: 'AAA', listingAt: T + 60 * MIN },
      { pair: 'BBBUSDT', base: 'BBB', listingAt: T + 90 * MIN },
      { pair: 'CCCUSDT', base: 'CCC', listingAt: T + 120 * MIN },
    ],
    anns: [{ id: 'a1', title: 'EXA Will List Delta (DDD)', listingAt: T + 24 * 60 * MIN }],
  };
  const venue = fakeVenue('exa', state);
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const tracker = new ListingTracker(service, [venue], { autoCreate: false, review: true });
  await tracker.run();
  const pending = () => service.detections({ status: 'pending' }).map((d) => d.symbol).sort();
  assert.deepEqual(pending(), ['AAA', 'BBB', 'CCC', 'DDD']);

  service.ignoreDetection(service.detections({ status: 'pending' }).find((d) => d.symbol === 'AAA')!.id);
  await tracker.run();
  assert.deepEqual(pending(), ['BBB', 'CCC', 'DDD'], 'one skipped listing stays skipped');

  assert.equal(service.ignoreAllDetections(), 3);
  clock.advance(5 * MIN);
  await tracker.run();
  assert.deepEqual(pending(), [], 'a new check finds the same listings and leaves them skipped');

  state.pairs.push({ pair: 'EEEUSDT', base: 'EEE', listingAt: T + 200 * MIN });
  await tracker.run();
  assert.deepEqual(pending(), ['EEE'], 'a really new listing still shows up');
});
