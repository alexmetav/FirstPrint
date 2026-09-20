import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService, START_POINTS } from '../src/services/firstprint.ts';
import { SimVenue } from '../src/exchanges/sim.ts';
import { Scheduler } from '../src/workers/scheduler.ts';
import { createApiServer } from '../src/api/server.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 12, 0); // a Monday

/** Fast market: 5-min baseline, 30-min duration, 5-min settlement window. */
const FAST = { baselineMs: 5 * MIN, durationMs: 30 * MIN, settleWindowMs: 5 * MIN, minTrades: 1 };

function setup(targetReturn = -0.3) {
  const db = openDb(':memory:');
  const clock = new ManualClock(T0);
  const sim = new SimVenue('sim', clock);
  const service = new FirstprintService(db, clock, [sim]);
  const listingAt = T0 + 10 * MIN;
  sim.add('XYZUSDT', { listingAt, startPrice: 1, targetReturn, horizonMs: 30 * MIN, noise: 0, volume: 1000 });
  const marketId = service.createMarket({
    symbol: 'XYZ',
    exchange: 'mexc',
    venues: [{ venue: 'sim', symbol: 'XYZUSDT' }],
    announcedListingAt: listingAt,
    listingAt,
    config: FAST,
  });
  const scheduler = new Scheduler(service, async () => {}, { tickMs: 1000 });
  return { db, clock, sim, service, marketId, listingAt, scheduler };
}

function ledgerMatchesBalances(db: ReturnType<typeof openDb>) {
  const rows = db
    .prepare('SELECT u.points AS points, COALESCE(SUM(l.delta), 0) AS sum FROM users u LEFT JOIN ledger l ON l.user_id = u.id GROUP BY u.id')
    .all() as { points: number; sum: number }[];
  return rows.every((r) => r.points === r.sum);
}

async function runUntil(clock: ManualClock, scheduler: Scheduler, until: number) {
  while (clock.now() < until) {
    clock.advance(MIN);
    await scheduler.tick();
  }
}

test('full lifecycle: predict → close → settle → payout', async () => {
  const { db, clock, service, marketId, listingAt, scheduler } = setup(-0.3);
  const alice = (await service.createUser({ username: 'alice' }));
  const bob = (await service.createUser({ username: 'bob' }));
  assert.equal(alice.points, START_POINTS);

  service.placePrediction(marketId, alice.id, 'down', 100);
  clock.advance(MIN);
  service.placePrediction(marketId, bob.id, 'up', 100);
  assert.equal(service.getUser(alice.id).points, 900);
  assert.equal(service.getMarket(marketId).phase, 'pre_listing');

  await runUntil(clock, scheduler, listingAt + 2 * MIN);
  const during = service.getMarket(marketId);
  assert.equal(during.phase, 'baseline');
  assert.ok(during.live?.lastPrice, 'live price visible during baseline');

  await runUntil(clock, scheduler, listingAt + 6 * MIN);
  assert.equal(service.getMarket(marketId).status, 'locked');
  assert.throws(() => service.placePrediction(marketId, alice.id, 'down', 50), /closed/);

  await runUntil(clock, scheduler, listingAt + 31 * MIN);
  const done = service.getMarket(marketId, alice.id);
  assert.equal(done.status, 'resolved');
  assert.equal(done.result?.winningBucket, 'down');
  // pool 200, 4% fee → 192 to the only winner
  assert.equal(done.mine[0].payout, 192);
  assert.equal(service.getUser(alice.id).points, 900 + 192);
  assert.equal(service.getUser(bob.id).points, 900);
  assert.ok(ledgerMatchesBalances(db));

  const s = service.settlement(marketId);
  assert.match(s.dataHash, /^[0-9a-f]{64}$/);

  const lb = service.leaderboard(alice.id);
  assert.equal(lb.entries[0].name, 'alice');
  assert.equal(lb.me?.profit, 92);
});

test('markets with no price data are voided and fully refunded', async () => {
  const db = openDb(':memory:');
  const clock = new ManualClock(T0);
  const service = new FirstprintService(db, clock, [new SimVenue('sim', clock)]); // no profile → no candles
  const listingAt = T0 + 10 * MIN;
  const id = service.createMarket({
    symbol: 'NODATA',
    exchange: 'mexc',
    venues: [{ venue: 'sim', symbol: 'NODATAUSDT' }],
    announcedListingAt: listingAt,
    listingAt,
    config: FAST,
  });
  const a = (await service.createUser({ username: 'user_a' }));
  const b = (await service.createUser({ username: 'user_b' }));
  service.placePrediction(id, a.id, 'moon', 100);
  service.placePrediction(id, b.id, 'crash', 50);
  const scheduler = new Scheduler(service, async () => {}, { tickMs: 1000 });

  let notes: unknown[] = [];
  scheduler.notify = async (n) => void (notes = n);
  await runUntil(clock, scheduler, listingAt + 31 * MIN);

  const m = service.getMarket(id);
  assert.equal(m.status, 'void');
  assert.equal(m.result?.voidReason, 'insufficient_baseline_data');
  assert.equal(service.getUser(a.id).points, START_POINTS);
  assert.equal(service.getUser(b.id).points, START_POINTS);
  assert.equal(notes.length, 2);
  assert.ok(ledgerMatchesBalances(db));
});

test('input validation: points, minimum stake, bucket', async () => {
  const { service, marketId } = setup();
  const u = (await service.createUser({ username: 'user_v' }));
  assert.throws(() => service.placePrediction(marketId, u.id, 'up', 1_001), /Not enough points/);
  assert.throws(() => service.placePrediction(marketId, u.id, 'up', 5), /at least 10/);
  assert.throws(() => service.placePrediction(marketId, u.id, 'sideways' as never, 50), /Choose/);
  assert.equal(service.getUser(u.id).points, START_POINTS, 'failed predictions never debit points');
});

test('caps: per-user limit and full pool are enforced', async () => {
  const { service, sim, listingAt } = setup();
  sim.add('CAPUSDT', { listingAt, startPrice: 1, targetReturn: 0, horizonMs: 30 * MIN, noise: 0, volume: 1000 });
  const id = service.createMarket({
    symbol: 'CAP',
    exchange: 'mexc',
    venues: [{ venue: 'sim', symbol: 'CAPUSDT' }],
    announcedListingAt: listingAt,
    listingAt,
    config: { ...FAST, softCap: 300, perUserCapPct: 0.5 },
  });
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((t) => service.createUser({ username: `cap_${t}` })));
  service.placePrediction(id, a.id, 'up', 100);
  assert.throws(() => service.placePrediction(id, a.id, 'down', 60), /up to 150 points per market/);
  service.placePrediction(id, b.id, 'down', 150);
  assert.throws(() => service.placePrediction(id, c.id, 'flat', 60), /pool is full/);
  service.placePrediction(id, c.id, 'flat', 50);
  assert.equal(service.getMarket(id).pool, 300);
});

test('daily claim works once per UTC day', async () => {
  const { clock, service } = setup();
  const u = (await service.createUser({ username: 'user_d' }));
  assert.equal(service.claimDaily(u.id).points, START_POINTS + 100);
  assert.throws(() => service.claimDaily(u.id), /already claimed/);
  clock.advance(24 * 60 * MIN);
  assert.equal(service.claimDaily(u.id).points, START_POINTS + 200);
});

test('accounts: signup rules, passwords, sessions', async () => {
  const { clock, service } = setup();
  const u = await service.createUser({ email: 'Neo@Example.com', username: 'neo', password: 'correct horse' });
  assert.equal(u.email, 'neo@example.com');
  assert.notEqual(u.password_hash, 'correct horse');
  await assert.rejects(service.createUser({ email: 'neo@example.com', username: 'neo2', password: 'whatever1' }), /already exists/);
  await assert.rejects(service.createUser({ email: 'x@example.com', username: 'NEO', password: 'whatever1' }), /taken/);
  await assert.rejects(service.createUser({ email: 'y@example.com', username: 'ok_name', password: 'short' }), /at least 8/);
  await assert.rejects(service.createUser({ email: 'nope', username: 'ok_name', password: 'long enough' }), /valid email/);

  assert.equal((await service.authenticate('NEO@example.com', 'correct horse')).id, u.id);
  await assert.rejects(service.authenticate('neo@example.com', 'wrong password'), /incorrect/);
  await assert.rejects(service.authenticate('ghost@example.com', 'correct horse'), /incorrect/);

  const s = service.createSession(u.id);
  assert.equal(service.userForSession(s.token)?.id, u.id);
  assert.equal(service.userForSession('forged-token'), null);
  clock.advance(31 * 24 * 60 * MIN);
  assert.equal(service.userForSession(s.token), null, 'sessions expire');
  const s2 = service.createSession(u.id);
  service.deleteSession(s2.token);
  assert.equal(service.userForSession(s2.token), null, 'logout ends the session');
});

test('HTTP API: signup, cookie session, predict, quote, admin', async () => {
  const { service, marketId, scheduler } = setup();
  const server = createApiServer({
    service,
    scheduler,
    adminKey: 'secret-admin-key-for-tests',
    secureCookies: false, trustProxy: 0,
    webDir: new URL('../web', import.meta.url).pathname,
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });

  try {
    assert.equal((await call('/api/me')).status, 401);

    const signup = await call('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email: 'carol@example.com', username: 'carol', password: 'hunter2hunter2' }),
    });
    assert.equal(signup.status, 200);
    const setCookie = signup.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /fp_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
    cookie = setCookie.split(';')[0];

    const me = await (await call('/api/me')).json();
    assert.equal(me.username, 'carol');
    assert.equal(me.points, START_POINTS);

    const q = await (await call(`/api/markets/${marketId}/quote?bucket=down&stake=100`)).json();
    assert.equal(q.payout, 96); // alone in the pool: stake minus fee

    const placed = await call(`/api/markets/${marketId}/predictions`, { method: 'POST', body: JSON.stringify({ bucket: 'down', stake: 100 }) });
    assert.equal(placed.status, 200);
    assert.equal((await placed.json()).balance, 900);

    const formPost = await fetch(`${base}/api/markets/${marketId}/predictions`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: 'bucket=down&stake=100',
    });
    assert.equal(formPost.status, 415, 'non-JSON posts are rejected (CSRF guard)');

    const bad = await call(`/api/markets/${marketId}/predictions`, { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);

    const list = await (await call('/api/markets?filter=open')).json();
    assert.equal(list.markets[0].mine.length, 1);
    assert.equal(list.markets[0].pool, 100);

    const activity = await (await call(`/api/markets/${marketId}/activity`)).json();
    assert.equal(activity.activity[0].username, 'carol');

    assert.equal((await call('/api/admin/markets', { method: 'POST', body: '{}' })).status, 403);
    const created = await call('/api/admin/markets', {
      method: 'POST',
      headers: { 'x-admin-key': 'secret-admin-key-for-tests' },
      body: JSON.stringify({ symbol: 'NEW', exchange: 'bybit', venues: [{ venue: 'sim', symbol: 'NEWUSDT' }], listingAt: new Date(T0 + 60 * MIN).toISOString() }),
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).symbol, 'NEW');

    const logout = await call('/api/auth/logout', { method: 'POST' });
    assert.equal(logout.status, 200);
    assert.equal((await call('/api/me')).status, 401, 'session ended after logout');

    const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'carol@example.com', password: 'hunter2hunter2' }) });
    assert.equal(login.status, 200);
    assert.equal((await call('/api/markets/nope')).status, 404);
  } finally {
    server.close();
  }
});
