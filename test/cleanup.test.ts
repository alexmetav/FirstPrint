import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { Scheduler } from '../src/workers/scheduler.ts';
import { createApiServer } from '../src/api/server.ts';
import type { Venue } from '../src/exchanges/types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 14, 12);
const KEY = 'admin-key-for-tests-123456';
const venue = (id: string, name: string): Venue => {
  const no = async () => {
    throw new Error('not used');
  };
  return { id, name, pair: (b) => `${b}USDT`, fetchTicker: no, fetchCandles: no, listPairs: no };
};

async function setup() {
  const clock = new ManualClock(T0);
  const db = openDb(':memory:');
  const service = new FirstprintService(db, clock, [venue('exa', 'Exchange A')]);
  const scheduler = new Scheduler(service, async () => {}, { tickMs: 1000 });
  const server = createApiServer({ service, scheduler, adminKey: KEY, manualOnly: true, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const admin = (path: string, body?: unknown) => call(path, body, { 'x-admin-key': KEY });
  return { db, clock, service, scheduler, call, admin, close: () => server.close() };
}

test('home stats: every market counts, top payout is the best multiple actually paid', async () => {
  const { clock, service, scheduler, call, close } = await setup();
  try {
    const a = await service.createUser({ username: 'alice' });
    const b = await service.createUser({ username: 'bob' });
    const c = await service.createUser({ username: 'carol' });
    const id = service.createManualMarket({ symbol: 'XYZ', exchanges: ['exa'], basePrice: 2, closeAt: T0 + HOUR, publish: true });
    service.createManualMarket({ symbol: 'OPEN', exchanges: ['exa'], basePrice: 1, closeAt: T0 + 2 * DAY, publish: true });
    let r = await call('/api/markets?filter=open');
    assert.equal(r.json.stats.totalMarkets, 2);
    assert.equal(r.json.stats.topPayout, null); // nothing paid yet
    service.placePrediction(id, a.id, 'up', 100);
    service.placePrediction(id, b.id, 'down', 300);
    service.placePrediction(id, c.id, 'flat', 100);
    clock.advance(2 * HOUR);
    await scheduler.tick();
    service.resolveManualMarket(id, { finalPrice: 2.5 }); // +25%: Up wins the whole pool
    const best = service.marketStats();
    assert.ok(best.topPayout && best.topPayout > 4.5 && best.topPayout <= 5, `top payout ${best.topPayout}`);
    assert.equal(best.topWin?.username, 'alice');
    assert.equal(best.topWin?.symbol, 'XYZ');
    assert.equal(best.topWin?.staked, 100);
    assert.equal(best.topWin?.multiple, best.topPayout);
  } finally {
    close();
  }
});

test('old results: listed after 3 days, exported, cleared without touching players’ records', async () => {
  const { db, clock, service, scheduler, admin, call, close } = await setup();
  try {
    const a = await service.createUser({ username: 'alice' });
    const b = await service.createUser({ username: 'bob' });
    const played = service.createManualMarket({ symbol: 'WIN', exchanges: ['exa'], basePrice: 2, closeAt: T0 + HOUR, publish: true });
    const empty = service.createManualMarket({ symbol: 'NOBODY', exchanges: ['exa'], basePrice: 2, closeAt: T0 + HOUR, publish: true });
    service.placePrediction(played, a.id, 'up', 100);
    service.placePrediction(played, b.id, 'down', 100);
    clock.advance(2 * HOUR);
    await scheduler.tick();
    service.resolveManualMarket(played, { finalPrice: 2.5 });
    service.resolveManualMarket(empty, { finalPrice: 2.5 });
    db.prepare('INSERT INTO candles (market_id, venue, ts, close, volume) VALUES (?, ?, ?, ?, ?)').run(played, 'exa', T0, 2, 1);
    const pointsBefore = service.getUser(a.id).points;
    const ledgerBefore = service.ledgerFor(a.id).length;

    assert.equal((await admin('/api/admin/old-results')).json.results.length, 0); // not old yet
    clock.advance(3 * DAY + HOUR);
    const old = (await admin('/api/admin/old-results')).json.results;
    assert.deepEqual(old.map((m: { symbol: string }) => m.symbol).sort(), ['NOBODY', 'WIN']);
    const csv = (await admin('/api/admin/old-results/csv')).json.csv as string;
    assert.match(csv.split('\n')[0], /^market_id,symbol,/);
    assert.equal(csv.trim().split('\n').length, 3);

    // Not for guests or players.
    assert.equal((await call('/api/admin/old-results/clear', {})).status, 403);

    const out = (await admin('/api/admin/old-results/clear', {})).json;
    assert.deepEqual(out, { deleted: 1, archived: 1 });
    // The empty one is gone; the played one is hidden, its price data dropped, the player's record kept.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM markets WHERE id = ?').get(empty)!.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candles WHERE market_id = ?').get(played)!.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM predictions WHERE market_id = ?').get(played)!.n, 2);
    assert.equal(service.getUser(a.id).points, pointsBefore);
    assert.equal(service.ledgerFor(a.id).length, ledgerBefore);
    assert.ok(!service.listMarketsPage('settled', undefined, 50).markets.some((m) => m.id === played));
    assert.ok(!service.adminMarkets().some((m) => m.id === played));
    assert.equal(service.getMarket(played).symbol, 'WIN'); // links from a player's history still open
    assert.equal(service.marketStats().totalMarkets, 1); // the cleared one still counts
    assert.equal((await admin('/api/admin/old-results')).json.results.length, 0);
  } finally {
    close();
  }
});

test('user activity: every player’s moves with the pick and the win, paged and filtered', async () => {
  const { clock, service, scheduler, admin, call, close } = await setup();
  try {
    const a = await service.createUser({ username: 'alice' });
    const b = await service.createUser({ username: 'bob' });
    const id = service.createManualMarket({ symbol: 'XYZ', exchanges: ['exa'], basePrice: 2, closeAt: T0 + HOUR, publish: true });
    service.placePrediction(id, a.id, 'up', 100);
    service.placePrediction(id, b.id, 'down', 50);
    clock.advance(2 * HOUR);
    await scheduler.tick();
    service.resolveManualMarket(id, { finalPrice: 2.5 });

    assert.equal((await call('/api/admin/user-activity')).status, 403);
    const all = (await admin('/api/admin/user-activity?per=10')).json;
    assert.equal(all.total, 5); // two sign-ups, two stakes, one payout
    const win = all.entries[0];
    assert.equal(win.reason, 'payout');
    assert.equal(win.user.username, 'alice');
    assert.deepEqual([win.market.symbol, win.pick.bucket, win.pick.stake], ['XYZ', 'up', 100]);
    assert.ok(win.delta > 100);
    const stake = all.entries.find((e: { reason: string; user: { username: string } }) => e.reason === 'stake' && e.user.username === 'bob');
    assert.deepEqual([stake.delta, stake.pick.bucket], [-50, 'down']);

    const bob = (await admin('/api/admin/user-activity?q=bob')).json;
    assert.equal(bob.total, 2);
    assert.ok(bob.entries.every((e: { user: { username: string } }) => e.user.username === 'bob'));
    const p2 = (await admin('/api/admin/user-activity?per=2&page=2')).json;
    assert.deepEqual([p2.page, p2.pages, p2.entries.length], [2, 3, 2]);
    // A % in the filter is a letter, not a wildcard.
    assert.equal((await admin('/api/admin/user-activity?q=%25')).json.total, 0);
  } finally {
    close();
  }
});
