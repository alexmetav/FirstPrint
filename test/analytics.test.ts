import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { Scheduler } from '../src/workers/scheduler.ts';
import { createApiServer } from '../src/api/server.ts';
import { analytics } from '../src/services/analytics.ts';
import type { Venue } from '../src/exchanges/types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 12);

function setup() {
  const clock = new ManualClock(T0);
  const boom = async () => {
    throw new Error('no exchange calls');
  };
  const venue: Venue = { id: 'mexc', name: 'MEXC', pair: (b) => `${b}USDT`, fetchTicker: boom, fetchCandles: boom, listPairs: boom };
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  return { clock, service };
}

test('analytics: real players only, activity, sign-in split, top markets, streaks', async () => {
  const { clock, service } = setup();
  const wallet = (id: string, address: string) =>
    service.db.prepare('INSERT INTO wallets (address, user_id, verified_at) VALUES (?, ?, ?)').run(address, id, clock.now());
  const seeded = await service.createUser({ username: 'seed_bot' }); // no email, no wallet: left out
  const a = await service.createUser({ username: 'alice', email: 'a@example.com' });
  const b = await service.createUser({ username: 'bob' });
  wallet(b.id, 'WalletBob1111111111111111111111111111111111');
  const c = await service.createUser({ username: 'carol', email: 'c@example.com' });
  wallet(c.id, 'WalletCarol111111111111111111111111111111111');

  const id = service.createManualMarket({ symbol: 'AGENCY', exchanges: ['mexc'], basePrice: 1, closeAt: T0 + 5 * DAY, resultAt: T0 + 8 * DAY, publish: true });
  service.placePrediction(id, a.id, 'up', 100);
  service.placePrediction(id, seeded.id, 'down', 500);
  clock.advance(DAY);
  service.placePrediction(id, b.id, 'moon', 50);
  service.claimDaily(a.id);
  service.claimDaily(c.id);

  const d = analytics(service.db, clock.now(), 7);
  assert.equal(d.totals.players, 3, 'the seeded account is not counted');
  assert.equal(d.totals.walletsLinked, 2);
  assert.deepEqual(d.signIn, { emailOnly: 1, walletOnly: 1, both: 1 });
  assert.equal(d.period.newPlayers, 3);
  assert.equal(d.period.predictions, 2);
  assert.equal(d.period.staked, 150);
  assert.equal(d.period.active, 3, 'alice and bob predicted, carol claimed');
  assert.equal(d.series.length, 7);
  const last = d.series[d.series.length - 1];
  assert.deepEqual([last.active, last.predictions, last.newPlayers], [3, 1, 0]);
  assert.deepEqual(d.topMarkets.map((m) => [m.symbol, m.staked, m.predictors]), [['AGENCY', 150, 2]]);
  assert.deepEqual(d.streaks.find((s) => s.label === '1 day')?.count, 2);
  assert.ok(!JSON.stringify(d).includes('example.com') && !JSON.stringify(d).includes('alice'), 'no personal data');
  assert.equal(analytics(service.db, clock.now(), 999).days, 30, 'unknown periods fall back to 30 days');
});

test('analytics share link: off by default, works with the key, old key stops after a new link', async () => {
  const { service } = setup();
  const scheduler = new Scheduler(service, async () => {}, { tickMs: 1000 });
  const server = createApiServer({ service, scheduler, adminKey: 'admin-key-for-tests-123456', manualOnly: true, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = (path: string, body?: unknown) =>
    fetch(base + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-key-for-tests-123456' } });
  try {
    assert.equal((await fetch(`${base}/api/admin/analytics`)).status, 403);
    assert.equal((await fetch(`${base}/api/public/analytics?key=anything-at-all`)).status, 404);
    const first = (await (await admin('/api/admin/analytics')).json()) as { shareKey: string | null; totals: unknown };
    assert.equal(first.shareKey, null);
    assert.ok(first.totals);

    const { shareKey } = (await (await admin('/api/admin/analytics/share', { enabled: true })).json()) as { shareKey: string };
    assert.match(shareKey, /^[A-Za-z0-9_-]{20,}$/);
    const pub = await fetch(`${base}/api/public/analytics?key=${shareKey}&days=7`);
    assert.equal(pub.status, 200);
    const body = (await pub.json()) as Record<string, unknown>;
    assert.equal(body.days, 7);
    assert.equal('shareKey' in body, false);

    const again = (await (await admin('/api/admin/analytics/share', { enabled: true })).json()) as { shareKey: string };
    assert.notEqual(again.shareKey, shareKey);
    assert.equal((await fetch(`${base}/api/public/analytics?key=${shareKey}`)).status, 404, 'the old link stops working');
    await admin('/api/admin/analytics/share', { enabled: false });
    assert.equal((await fetch(`${base}/api/public/analytics?key=${again.shareKey}`)).status, 404);
  } finally {
    server.close();
  }
});
