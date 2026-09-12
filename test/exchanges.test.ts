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

function fakeVenue(id: string, state: { pairs: { pair: string; base: string; listingAt: number | null }[]; anns: { id: string; title: string; listingAt: number | null }[] }): Venue {
  return {
    id,
    name: id.toUpperCase(),
    pair: (b) => `${b}USDT`,
    fetchCandles: async () => [],
    fetchTicker: async () => ({ price: 1, ts: Date.now() }),
    listPairs: async () => state.pairs.map((p) => ({ ...p, quote: 'USDT' })),
    fetchAnnouncements: async () =>
      state.anns.map((a) => ({ exchange: id, id: a.id, title: a.title, url: `https://ex/${a.id}`, publishedAt: T, listingAt: a.listingAt, symbols: extractSymbols(a.title) })),
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
