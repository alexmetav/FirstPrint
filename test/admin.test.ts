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
  assert.equal(g.verdict, 'works');
  assert.equal(b.verdict, 'blocked', 'a 451 means the exchange refuses this server\'s location');
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

test('admin by account: an ADMIN_EMAILS email signed in by code or Google, or a linked ADMIN_WALLETS wallet, opens the console without the key', async () => {
  const { createApiServer } = await import('../src/api/server.ts');
  const db = openDb(':memory:');
  const service = new FirstprintService(db, new ManualClock(Date.now()), []);
  const WALLET = '7RSEwQz5qQ8mU2J6dYzW1bq3rF1kV9cX2nL4pT8hLF37';
  const server = createApiServer({
    service,
    adminKey: 'k'.repeat(32),
    adminEmails: ['boss@example.com'],
    adminWallets: [WALLET],
    secureCookies: false,
    webDir: new URL('../web', import.meta.url).pathname,
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (token: string | null, key?: string) =>
    fetch(`${base}/api/admin/ping`, { headers: { ...(token ? { cookie: `fp_session=${token}` } : {}), ...(key !== undefined ? { 'x-admin-key': key } : {}) } }).then((r) => r.status);
  const me = (token: string) => fetch(`${base}/api/me`, { headers: { cookie: `fp_session=${token}` } }).then((r) => r.json());
  try {
    const boss = await service.createUser({ username: 'boss', email: 'Boss@Example.com' });
    const other = await service.createUser({ username: 'other', email: 'other@example.com' });
    const byCode = service.createSession(boss.id, 'email').token;
    const byGoogle = service.createSession(boss.id, 'google').token;
    const byPassword = service.createSession(boss.id, 'password').token;

    assert.equal(await as(byCode), 200);
    assert.equal(await as(byGoogle), 200);
    assert.equal((await me(byCode)).isAdmin, true);
    assert.equal(await as(byPassword), 403, 'a password sign-in never proved the email');
    assert.equal(await as(service.createSession(other.id, 'email').token), 403);
    assert.equal(await as(null), 403);
    assert.equal(await as(byCode, 'wrong-key'), 403, 'a wrong key is still refused');
    assert.equal(await as(null, 'k'.repeat(32)), 200, 'the key keeps working');

    db.prepare('INSERT INTO wallets (address, user_id, verified_at) VALUES (?, ?, ?)').run(WALLET, other.id, Date.now());
    const walletSession = service.createSession(other.id, 'wallet').token;
    assert.equal(await as(walletSession), 200, 'linked admin wallet');
    assert.equal((await me(walletSession)).isAdmin, true);
  } finally {
    server.close();
  }
});

test('team: the owner gives admin or tasks-only access by email or wallet from Settings, and can take it back', async () => {
  const { createApiServer } = await import('../src/api/server.ts');
  const db = openDb(':memory:');
  const service = new FirstprintService(db, new ManualClock(Date.now()), []);
  const KEY = 'k'.repeat(32);
  const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  const server = createApiServer({ service, adminKey: KEY, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, who: { token?: string; key?: string }, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(who.token ? { cookie: `fp_session=${who.token}` } : {}), ...(who.key ? { 'x-admin-key': who.key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    const helper = await service.createUser({ username: 'helper', email: 'helper@example.com' });
    const ops = await service.createUser({ username: 'ops' });
    db.prepare('INSERT INTO wallets (address, user_id, verified_at) VALUES (?, ?, ?)').run(WALLET, ops.id, Date.now());
    const h = { token: service.createSession(helper.id, 'email').token };
    const o = { token: service.createSession(ops.id, 'wallet').token };
    const owner = { key: KEY };

    assert.equal((await call('/api/admin/ping', h)).status, 403, 'nobody yet');
    assert.equal((await call('/api/admin/team', owner, { value: 'Helper@Example.com', role: 'tasks' })).status, 200);
    assert.equal((await call('/api/admin/team', owner, { value: WALLET, role: 'admin' })).status, 200);
    assert.equal((await call('/api/admin/team', owner, { value: 'not an address', role: 'tasks' })).status, 400);

    // Tasks only: the Tasks page and nothing else.
    const ping = await (await call('/api/admin/ping', h)).json();
    assert.equal(ping.level, 'tasks');
    assert.equal(ping.exchanges, undefined, 'no settings for tasks-only members');
    assert.notEqual((await call('/api/admin/tasks', h)).status, 403, 'allowed (tasks are off in this test server, so 404)');
    assert.equal((await call('/api/admin/markets', h)).status, 403);
    assert.equal((await call('/api/admin/team', h)).status, 403);
    assert.equal((await (await call('/api/me', h)).json()).adminLevel, 'tasks');
    // A password sign-in never proves the email.
    assert.equal((await call('/api/admin/ping', { token: service.createSession(helper.id, 'password').token })).status, 403);

    // Admin by wallet: everything but the team.
    assert.equal((await (await call('/api/admin/ping', o)).json()).level, 'admin');
    assert.equal((await call('/api/admin/markets', o)).status, 200);
    assert.equal((await call('/api/admin/team', o)).status, 403);
    assert.equal((await call('/api/admin/team', o, { value: 'x@example.com', role: 'admin' })).status, 403, 'admins can’t add people');

    // Listings + tasks: review, create, edit and publish markets; not results, refunds or settings.
    await call('/api/admin/team', owner, { value: 'helper@example.com', role: 'listings' });
    assert.equal((await (await call('/api/admin/ping', h)).json()).level, 'listings');
    assert.equal((await call('/api/admin/markets', h)).status, 200);
    assert.equal((await call('/api/admin/detected', h)).status, 200);
    const created = await call('/api/admin/manual-markets', h, { symbol: 'TEAM', exchanges: [], basePrice: 1, closeAt: Date.now() + 3_600_000 });
    assert.notEqual(created.status, 403, 'may create markets (this one fails validation: no exchanges)');
    assert.notEqual((await call('/api/admin/manual-markets/x/publish', h, {})).status, 403);
    assert.notEqual((await call('/api/admin/manual-markets/x/unpublish', h, {})).status, 403);
    assert.equal((await call('/api/admin/manual-markets/x/resolve', h, { finalPrice: 1 })).status, 403, 'results stay with admins');
    assert.equal((await call('/api/admin/markets/x/cancel', h, {})).status, 403, 'refunds stay with admins');
    assert.equal((await call('/api/admin/auto-listings', h, { enabled: false })).status, 403, 'settings stay with admins');
    assert.equal((await call('/api/admin/analytics', h)).status, 403);

    // Adding again changes the role; removing takes access away.
    await call('/api/admin/team', owner, { value: 'helper@example.com', role: 'admin' });
    assert.equal((await call('/api/admin/markets', h)).status, 200);
    const { team } = await (await call('/api/admin/team', owner)).json();
    assert.equal(team.length, 2);
    for (const m of team) await call(`/api/admin/team/${m.id}/remove`, owner, {});
    assert.equal((await call('/api/admin/ping', h)).status, 403);
    assert.equal((await call('/api/admin/ping', o)).status, 403);
  } finally {
    server.close();
  }
});

test('maintenance: players can read but not write, admins still can, workers pause, a backup is taken', async () => {
  const { clock, service, scheduler } = setup();
  let backups = 0;
  const server = createApiServer({
    service,
    adminKey: 'admin-key-for-tests-123456',
    secureCookies: false,
    webDir: new URL('../web', import.meta.url).pathname,
    backupNow: async () => (backups++, true),
    backupStatus: () => ({ enabled: true, lastOkAt: null, lastError: null }),
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const key = { 'content-type': 'application/json', 'x-admin-key': 'admin-key-for-tests-123456' };
  try {
    const player = await service.createUser({ username: 'player1' });
    const cookie = `fp_session=${service.createSession(player.id, 'email').token}`;
    const daily = (headers: Record<string, string>) => fetch(`${base}/api/me/notifications/read`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

    assert.deepEqual((await (await fetch(`${base}/api/status`)).json()).maintenance, { on: false });
    const on = await (await fetch(`${base}/api/admin/maintenance`, { method: 'POST', headers: key, body: JSON.stringify({ on: true, message: 'Back at 6pm' }) })).json();
    assert.equal(on.on, true);
    assert.equal(on.backedUp, true);
    assert.equal(backups, 1);
    assert.deepEqual((await (await fetch(`${base}/api/config`)).json()).maintenance, { on: true, message: 'Back at 6pm', since: T0 });

    // A player's write is refused with the admin's note; reads still work.
    const refused = await daily({ cookie });
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { error: 'maintenance', message: 'Back at 6pm' });
    assert.equal((await fetch(`${base}/api/markets`, { headers: { cookie } })).status, 200);
    // Sign-ups are writes too.
    assert.equal((await fetch(`${base}/api/auth/email/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"new@example.com"}' })).status, 503);
    // The admin's own test actions still go through.
    assert.notEqual((await daily({ cookie, 'x-admin-key': 'admin-key-for-tests-123456' })).status, 503);

    // The scheduler doesn't close or settle anything until maintenance ends.
    const m = service.createManualMarket({ symbol: 'MNT', exchanges: ['exa'], basePrice: 1, closeAt: T0 + 30 * MIN, resultAt: T0 + 3 * 24 * 60 * MIN, publish: true } as never);
    clock.advance(31 * MIN);
    await scheduler.tick();
    assert.equal(service.getMarket(m).phase === 'awaiting_result', false, 'paused while in maintenance');

    const off = await (await fetch(`${base}/api/admin/maintenance`, { method: 'POST', headers: key, body: JSON.stringify({ on: false }) })).json();
    assert.equal(off.on, false);
    assert.equal(backups, 1, 'no backup needed when turning it off');
    assert.notEqual((await daily({ cookie })).status, 503);
    await scheduler.tick();
    assert.equal(service.getMarket(m).phase, 'awaiting_result', 'catches up once it ends');
  } finally {
    server.close();
  }
});
