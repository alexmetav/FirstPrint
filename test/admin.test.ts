import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService, START_POINTS } from '../src/services/firstprint.ts';
import { Scheduler } from '../src/workers/scheduler.ts';
import { createApiServer } from '../src/api/server.ts';
import type { Venue } from '../src/exchanges/types.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 12);

/** Exchange stub with a fixed set of tradable pairs and a price path. */
function stubVenue(id: string, name: string, prices: Record<string, (ts: number) => number>, clock: ManualClock): Venue {
  return {
    id,
    name,
    pair: (b) => `${b}USDT`,
    async fetchTicker(pair) {
      const f = prices[pair];
      return f ? { price: f(clock.now()), ts: clock.now() } : null;
    },
    async fetchCandles(pair, start, end) {
      const f = prices[pair];
      if (!f) return [];
      const out = [];
      for (let ts = Math.ceil(start / MIN) * MIN; ts < end && ts + MIN <= clock.now(); ts += MIN) out.push({ ts, close: f(ts), volume: 1000 });
      return out;
    },
    async listPairs() {
      return Object.keys(prices).map((pair) => ({ pair, base: pair.replace('USDT', ''), quote: 'USDT', listingAt: null }));
    },
  };
}

function setup() {
  const clock = new ManualClock(T0);
  const rising = (ts: number) => 100 * (1 + Math.max(0, ts - T0) / (20 * MIN) * 0.3); // +30% over 20 min
  const a = stubVenue('exa', 'Exchange A', { SOLUSDT: rising }, clock);
  const b = stubVenue('exb', 'Exchange B', { SOLUSDT: rising, NEWUSDT: () => 2 }, clock);
  const service = new FirstprintService(openDb(':memory:'), clock, [a, b]);
  const scheduler = new Scheduler(service, async () => {}, { tickMs: 1000 });
  return { clock, service, scheduler };
}

test('live test market: uses every exchange with a price, settles on real candles', async () => {
  const { clock, service, scheduler } = setup();
  const out = await service.createLiveMarket({ symbol: 'sol', preset: 'quick', startsInMs: 2 * MIN });
  assert.deepEqual(out.exchanges.map((e) => e.id), ['exa', 'exb']);
  const m = service.getMarket(out.marketId);
  assert.equal(m.kind, 'live_test');
  assert.equal(m.exchange, 'Exchange A +1');
  assert.equal(m.settleAt - m.listingAt, 15 * MIN);

  const u = await service.createUser({ username: 'tester' });
  const v = await service.createUser({ username: 'other' });
  service.placePrediction(out.marketId, u.id, 'up', 100);
  service.placePrediction(out.marketId, v.id, 'crash', 100);

  while (clock.now() < m.settleAt + MIN) {
    clock.advance(MIN);
    await scheduler.tick();
  }
  const done = service.getMarket(out.marketId, u.id);
  assert.equal(done.status, 'resolved');
  assert.equal(done.result?.winningBucket, 'up');
  assert.equal(service.getUser(u.id).points, START_POINTS - 100 + 192);
});

test('live test market: rejects tokens with no live price and skips missing exchanges', async () => {
  const { service } = setup();
  await assert.rejects(service.createLiveMarket({ symbol: 'NOPE' }), /no live price/);
  const out = await service.createLiveMarket({ symbol: 'NEW' });
  assert.deepEqual(out.exchanges.map((e) => e.id), ['exb']);
  assert.deepEqual(out.skipped.map((e) => e.id), ['exa']);
  await assert.rejects(service.createLiveMarket({ symbol: 'SOL', preset: 'forever' }), /Length must be/);
});

test('cancel refunds open and locked markets exactly once', async () => {
  const { clock, service, scheduler } = setup();
  const { marketId } = await service.createLiveMarket({ symbol: 'SOL' });
  const u = await service.createUser({ username: 'refund_me' });
  service.placePrediction(marketId, u.id, 'flat', 250);
  assert.equal(service.getUser(u.id).points, START_POINTS - 250);
  service.cancelMarket(marketId);
  assert.equal(service.getUser(u.id).points, START_POINTS);
  assert.equal(service.getMarket(marketId).status, 'void');
  assert.throws(() => service.cancelMarket(marketId), /already settled/);

  const second = await service.createLiveMarket({ symbol: 'SOL' });
  service.placePrediction(second.marketId, u.id, 'up', 100);
  clock.advance(6 * MIN);
  await scheduler.tick(); // closes the market
  assert.equal(service.getMarket(second.marketId).status, 'locked');
  service.cancelMarket(second.marketId);
  assert.equal(service.getUser(u.id).points, START_POINTS);
});

test('exchange check reports pass and fail per capability', async () => {
  const clock = new ManualClock(Date.now());
  const good = stubVenue('good', 'Good', { BTCUSDT: () => 50_000, ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`T${i}USDT`, () => 1])) }, clock);
  const broken: Venue = { ...good, id: 'bad', name: 'Bad', fetchTicker: async () => { throw new Error('451 Unavailable For Legal Reasons'); } };
  clock.advance(20 * MIN);
  const service = new FirstprintService(openDb(':memory:'), clock, [good, broken]);
  const [g, b] = await service.checkExchanges();
  assert.equal(g.ticker.ok, true);
  assert.equal(g.pairs.ok, true);
  assert.equal(g.announcements.ok, null);
  assert.equal(b.ticker.ok, false);
  assert.match(b.ticker.detail, /451/);
});

test('migrations add new columns to an existing database', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fp-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, username TEXT NOT NULL UNIQUE, password_hash TEXT, points INTEGER NOT NULL DEFAULT 0, last_claim_day TEXT, created_at INTEGER NOT NULL);
            CREATE TABLE markets (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT, exchange TEXT NOT NULL, venues TEXT NOT NULL, source_url TEXT,
              announced_listing_at INTEGER NOT NULL, listing_at INTEGER NOT NULL, opened_at INTEGER NOT NULL, config TEXT NOT NULL, scorecard TEXT,
              status TEXT NOT NULL, hard_cap INTEGER, retracted INTEGER NOT NULL DEFAULT 0, halted_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);`);
  old.close();
  const db = openDb(path);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols('markets').includes('kind'));
  assert.ok(cols('users').includes('needs_username'));
});

test('HTTP admin: ping, create live market, list, cancel', async () => {
  const { service } = setup();
  const server = createApiServer({ service, adminKey: 'admin-key-for-tests-123456', secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-key-for-tests-123456' } });
  try {
    assert.equal((await fetch(`${base}/api/admin/ping`)).status, 403);
    const ping = await (await admin('/api/admin/ping')).json();
    assert.deepEqual(ping.venues.map((v: { id: string }) => v.id), ['exa', 'exb']);
    assert.ok(ping.presets.some((p: { id: string }) => p.id === 'quick'));

    const created = await admin('/api/admin/live-markets', { method: 'POST', body: JSON.stringify({ symbol: 'SOL', exchanges: ['exb'], preset: 'hour', startsInMinutes: 3 }) });
    assert.equal(created.status, 200);
    const { marketId } = await created.json();

    const bad = await admin('/api/admin/live-markets', { method: 'POST', body: JSON.stringify({ symbol: 'NOPE' }) });
    assert.equal(bad.status, 422);

    const list = await (await admin('/api/admin/markets')).json();
    assert.equal(list.markets[0].id, marketId);

    assert.equal((await admin(`/api/admin/markets/${marketId}/cancel`, { method: 'POST', body: '{}' })).status, 200);
    assert.equal(service.getMarket(marketId).status, 'void');
  } finally {
    server.close();
  }
});
