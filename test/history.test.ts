import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService, START_POINTS } from '../src/services/firstprint.ts';
import { Scheduler } from '../src/workers/scheduler.ts';
import { createApiServer } from '../src/api/server.ts';
import type { Venue } from '../src/exchanges/types.ts';

const HOUR = 3_600_000;
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
  const service = new FirstprintService(openDb(':memory:'), clock, [venue('exa', 'Exchange A')]);
  const scheduler = new Scheduler(service, async () => {}, { tickMs: 1000 });
  const server = createApiServer({ service, scheduler, adminKey: KEY, manualOnly: true, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const admin = (path: string, body?: unknown) => call(path, body, { 'x-admin-key': KEY });
  return { clock, service, scheduler, call, admin, close: () => server.close() };
}

test('points history: every balance change, newest first, tied to its market', async () => {
  const { clock, service, scheduler, close, call } = await setup();
  try {
    const a = await service.createUser({ username: 'alice' });
    const b = await service.createUser({ username: 'bob' });
    const id = service.createManualMarket({ symbol: 'XYZ', exchanges: ['exa'], basePrice: 2, closeAt: T0 + HOUR, publish: true });
    service.placePrediction(id, a.id, 'up', 100);
    service.placePrediction(id, b.id, 'down', 100);
    clock.advance(2 * HOUR);
    await scheduler.tick();
    service.resolveManualMarket(id, { finalPrice: 2.5 });

    const entries = service.ledgerFor(a.id);
    assert.deepEqual(entries.map((e) => [e.reason, e.delta, e.symbol]), [['payout', 192, 'XYZ'], ['stake', -100, 'XYZ'], ['signup', START_POINTS, null]]);
    assert.equal(entries.reduce((s, e) => s + e.delta, 0), service.getUser(a.id).points); // history adds up to the balance
    assert.equal(entries[0].marketId, id);
    // The loser's history shows the stake and nothing won.
    assert.deepEqual(service.ledgerFor(b.id).map((e) => e.reason), ['stake', 'signup']);
    assert.equal(service.ledgerFor(a.id, 1).length, 1);

    // Over HTTP it needs a login and only returns your own entries.
    assert.equal((await call('/api/me/ledger')).status, 401);
  } finally {
    close();
  }
});

test('admin log: every market change is recorded with what happened, newest first, admin only', async () => {
  const { clock, scheduler, service, admin, call, close } = await setup();
  try {
    assert.equal((await call('/api/admin/log')).status, 403);

    await admin('/api/admin/exchanges/exa', { enabled: false });
    await admin('/api/admin/exchanges/exa', { enabled: true });
    const created = await admin('/api/admin/manual-markets', { symbol: 'abc', exchanges: ['exa'], basePrice: 0.5, closeAt: T0 + HOUR, publish: true });
    const id = created.json.id as string;
    await admin(`/api/admin/manual-markets/${id}`, { note: 'rules' });
    const u = await service.createUser({ username: 'carol' });
    const v = await service.createUser({ username: 'dave' });
    service.placePrediction(id, u.id, 'up', 100);
    service.placePrediction(id, v.id, 'down', 100);
    clock.advance(2 * HOUR);
    await scheduler.tick();
    assert.equal((await admin(`/api/admin/manual-markets/${id}/resolve`, { finalPrice: 0.65, note: 'close' })).status, 200);

    const second = await admin('/api/admin/manual-markets', { symbol: 'def', exchanges: ['exa'], basePrice: 1, closeAt: T0 + 5 * HOUR, publish: true });
    await admin(`/api/admin/markets/${second.json.id}/cancel`, {});

    const { json } = await admin('/api/admin/log');
    assert.deepEqual(
      json.log.map((e: { action: string }) => e.action),
      ['market_cancelled', 'market_published', 'result_posted', 'market_edited', 'market_published', 'exchange_on', 'exchange_off'],
    );
    const posted = json.log.find((e: { action: string }) => e.action === 'result_posted');
    assert.equal(posted.target, id);
    assert.match(posted.detail, /final 0\.65, up wins, pool 200, paid 192 to 1/);
    assert.ok(json.log.every((e: { at: number; ip: string | null }) => e.at >= T0 && typeof e.ip === 'string'));
    assert.match(json.log[0].detail, /predictions refunded/);
  } finally {
    close();
  }
});

test('config tells the app whether markets are admin-run, so dead pages can be hidden', async () => {
  const { call, close } = await setup();
  try {
    assert.equal((await call('/api/config')).json.manualOnly, true);
  } finally {
    close();
  }
});
