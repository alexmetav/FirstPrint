import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { AppError, FirstprintService, START_POINTS } from '../src/services/firstprint.ts';
import { Scheduler } from '../src/workers/scheduler.ts';
import { createApiServer } from '../src/api/server.ts';
import type { Venue } from '../src/exchanges/types.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 14, 12);

/** Exchanges that must never be called: manual markets don't fetch prices. */
function venue(id: string, name: string): Venue {
  const boom = async () => {
    throw new Error(`${id} must not be called for manual markets`);
  };
  return { id, name, pair: (b) => `${b}USDT`, fetchTicker: boom, fetchCandles: boom, listPairs: boom };
}

/** ManualClock only moves forward by an amount; jump to an absolute time. */
function goto(clock: ManualClock, t: number) {
  clock.advance(t - clock.now());
}

function setup() {
  const db = openDb(':memory:');
  const clock = new ManualClock(T0);
  const service = new FirstprintService(db, clock, [venue('exa', 'Exchange A'), venue('exb', 'Exchange B')]);
  const scheduler = new Scheduler(service, async () => {}, { tickMs: 1000 });
  return { db, clock, service, scheduler };
}

const draft = (over: Record<string, unknown> = {}) => ({
  symbol: 'xyz',
  name: 'XYZ Protocol',
  exchanges: ['exa', 'exb'],
  basePrice: 2,
  closeAt: T0 + 2 * HOUR,
  resultAt: T0 + 26 * HOUR,
  ...over,
});

function ledgerMatchesBalances(db: ReturnType<typeof openDb>) {
  const rows = db
    .prepare('SELECT u.points AS points, COALESCE(SUM(l.delta), 0) AS sum FROM users u LEFT JOIN ledger l ON l.user_id = u.id GROUP BY u.id')
    .all() as { points: number; sum: number }[];
  return rows.every((r) => r.points === r.sum);
}

test('draft is hidden from users until published, then open for predictions', async () => {
  const { service } = setup();
  const u = await service.createUser({ username: 'alice' });
  const id = service.createManualMarket(draft());

  assert.equal(service.getMarket(id, undefined, true).phase, 'draft');
  assert.deepEqual(service.listMarkets('all'), []);
  assert.throws(() => service.getMarket(id), (e) => e instanceof AppError && e.status === 404);
  assert.throws(() => service.placePrediction(id, u.id, 'up', 100), (e) => e instanceof AppError && e.status === 404);
  assert.throws(() => service.quote(id, 'up', 100), (e) => e instanceof AppError && e.status === 404);

  service.publishMarket(id);
  const m = service.getMarket(id);
  assert.equal(m.symbol, 'XYZ');
  assert.equal(m.mode, 'manual');
  assert.equal(m.exchange, 'Exchange A, Exchange B');
  assert.equal(m.phase, 'baseline');
  assert.equal(m.closeAt, T0 + 2 * HOUR);
  assert.equal(m.settleAt, T0 + 26 * HOUR);
  assert.equal(m.basePrice, 2);
  assert.equal(service.listMarkets('open').length, 1);

  service.placePrediction(id, u.id, 'up', 100);
  assert.equal(service.getUser(u.id).points, START_POINTS - 100);
});

test('validation: exchanges, price, times; switched-off exchanges are refused', () => {
  const { service } = setup();
  const bad = (over: Record<string, unknown>, code: string) =>
    assert.throws(() => service.createManualMarket(draft(over)), (e) => e instanceof AppError && e.code === code);
  bad({ symbol: '!' }, 'bad_symbol');
  bad({ exchanges: [] }, 'bad_exchanges');
  bad({ exchanges: ['nope'] }, 'unknown_venue');
  bad({ basePrice: 0 }, 'bad_price');
  bad({ closeAt: T0 - MIN }, 'bad_close_time');
  bad({ resultAt: T0 + HOUR }, 'bad_result_time');
  bad({ config: { thresholds: { crash: 0.1 } } }, 'bad_config');

  service.setExchangeEnabled('exb', false);
  assert.equal(service.exchangeSettings().find((e) => e.id === 'exb')!.enabled, false);
  bad({ exchanges: ['exa', 'exb'] }, 'exchange_off');
  assert.ok(service.createManualMarket(draft({ exchanges: ['exa'] })));
  service.setExchangeEnabled('exb', true);
  assert.ok(service.createManualMarket(draft()));
});

test('edit: free while a draft, rules locked once users predicted', async () => {
  const { service } = setup();
  const u = await service.createUser({ username: 'bob' });
  const id = service.createManualMarket(draft());
  service.updateManualMarket(id, { basePrice: 3, name: 'Renamed', exchanges: ['exb'], closeAt: T0 + 3 * HOUR });
  let m = service.getMarket(id, undefined, true);
  assert.equal(m.basePrice, 3);
  assert.equal(m.name, 'Renamed');
  assert.equal(m.exchange, 'Exchange B');
  assert.deepEqual(m.venues.map((v) => v.pair), ['XYZUSDT']);
  assert.equal(m.closeAt, T0 + 3 * HOUR);

  service.publishMarket(id);
  service.updateManualMarket(id, { basePrice: 4 }); // nobody predicted yet
  service.placePrediction(id, u.id, 'up', 50);

  assert.throws(() => service.updateManualMarket(id, { basePrice: 5 }), (e) => e instanceof AppError && e.code === 'locked_field');
  assert.throws(() => service.updateManualMarket(id, { config: { feeBps: 0 } }), (e) => e instanceof AppError && e.code === 'locked_field');
  assert.throws(() => service.updateManualMarket(id, { closeAt: T0 + HOUR }), (e) => e instanceof AppError && e.code === 'locked_field');
  service.updateManualMarket(id, { note: 'Price source: Exchange B close', closeAt: T0 + 4 * HOUR });
  m = service.getMarket(id, undefined, true);
  assert.equal(m.note, 'Price source: Exchange B close');
  assert.equal(m.closeAt, T0 + 4 * HOUR);

  assert.throws(() => service.unpublishMarket(id), (e) => e instanceof AppError && e.code === 'has_predictions');
  assert.throws(() => service.deleteDraft(id), (e) => e instanceof AppError && e.code === 'not_a_draft');
});

test('timer end → awaiting result → admin result pays winners, ledger balances', async () => {
  const { db, clock, service, scheduler } = setup();
  const [a, b, c] = await Promise.all(['alice', 'bob', 'carol'].map((username) => service.createUser({ username })));
  const id = service.createManualMarket(draft({ publish: true, config: { feeBps: 400 } }));

  service.placePrediction(id, a.id, 'up', 100);
  service.placePrediction(id, b.id, 'down', 100);
  service.placePrediction(id, c.id, 'up', 100);

  // Too early to enter a result.
  assert.throws(() => service.previewResolution(id, { finalPrice: 2.5 }), (e) => e instanceof AppError && e.code === 'still_open');

  goto(clock, T0 + 2 * HOUR + MIN);
  await scheduler.tick();
  let m = service.getMarket(id);
  assert.equal(m.status, 'locked');
  assert.equal(m.phase, 'awaiting_result');
  assert.equal(m.result, null);
  assert.throws(() => service.placePrediction(id, a.id, 'up', 10), (e) => e instanceof AppError && e.code === 'market_closed');

  // The scheduler never settles manual markets on its own, however long it waits.
  goto(clock, T0 + 100 * HOUR);
  await scheduler.tick();
  assert.equal(service.getMarket(id).status, 'locked');

  // Preview changes nothing: price 2 → 2.5 is +25%, which is "up".
  const preview = service.previewResolution(id, { finalPrice: 2.5 });
  assert.equal(preview.winningBucket, 'up');
  assert.equal(preview.returnPct, 0.25);
  assert.equal(preview.winnerCount, 2);
  assert.equal(preview.pool, 300);
  assert.equal(service.getMarket(id).status, 'locked');
  assert.equal(service.getUser(a.id).points, START_POINTS - 100);

  const { summary, notes } = service.resolveManualMarket(id, { finalPrice: 2.5, note: 'Closing price on Exchange B' });
  assert.equal(summary.resolved, true);
  assert.equal(summary.totalPaid + summary.fee + 0 <= 300, true);
  assert.deepEqual(summary.winners.map((w) => w.username).sort(), ['alice', 'carol']);
  assert.equal(notes.length, 3);

  m = service.getMarket(id, a.id);
  assert.equal(m.status, 'resolved');
  assert.equal(m.result?.winningBucket, 'up');
  assert.equal(m.result?.basePrice, 2);
  assert.equal(m.result?.finalPrice, 2.5);
  assert.equal(m.result?.note, 'Closing price on Exchange B');
  assert.deepEqual((m.result as unknown as { winners: { username: string }[] }).winners.map((w) => w.username).sort(), ['alice', 'carol']);
  assert.ok(m.mine[0].payout! > 100);
  assert.equal(service.getUser(b.id).points, START_POINTS - 100);
  assert.ok(service.getUser(a.id).points > START_POINTS);
  assert.ok(ledgerMatchesBalances(db));

  assert.throws(() => service.resolveManualMarket(id, { finalPrice: 2.5 }), (e) => e instanceof AppError && e.code === 'already_settled');
});

test('result can be entered right after close without waiting for the scheduler; override picks the bucket', async () => {
  const { clock, service } = setup();
  const [a, b] = await Promise.all(['alice', 'bob'].map((username) => service.createUser({ username })));
  const id = service.createManualMarket(draft({ publish: true }));
  service.placePrediction(id, a.id, 'flat', 100);
  service.placePrediction(id, b.id, 'moon', 100);
  goto(clock, T0 + 2 * HOUR);

  // Prices say +25% ("up") but nobody picked it; the admin overrides to Moon after a disputed price.
  const p = service.previewResolution(id, { finalPrice: 2.5, winningBucket: 'moon' });
  assert.equal(p.computedBucket, 'up');
  assert.equal(p.winningBucket, 'moon');
  assert.equal(p.overridden, true);
  const { summary } = service.resolveManualMarket(id, { finalPrice: 2.5, winningBucket: 'moon' });
  assert.deepEqual(summary.winners.map((w) => w.username), ['bob']);
});

test('nobody picked the winning bucket → market voids and everyone is refunded', async () => {
  const { db, clock, service } = setup();
  const [a, b] = await Promise.all(['alice', 'bob'].map((username) => service.createUser({ username })));
  const id = service.createManualMarket(draft({ publish: true }));
  service.placePrediction(id, a.id, 'down', 100);
  service.placePrediction(id, b.id, 'flat', 100);
  goto(clock, T0 + 3 * HOUR);

  const { summary } = service.resolveManualMarket(id, { finalPrice: 4 }); // +100% → moon, no winners
  assert.equal(summary.voidReason, 'no_winners');
  assert.equal(service.getMarket(id).status, 'void');
  assert.equal(service.getUser(a.id).points, START_POINTS);
  assert.equal(service.getUser(b.id).points, START_POINTS);
  assert.ok(ledgerMatchesBalances(db));
});

test('cancel refunds a market that is awaiting its result; drafts can be deleted', async () => {
  const { db, clock, service } = setup();
  const a = await service.createUser({ username: 'alice' });
  const id = service.createManualMarket(draft({ publish: true }));
  service.placePrediction(id, a.id, 'up', 100);
  goto(clock, T0 + 3 * HOUR);
  service.closeDueMarkets();
  service.cancelMarket(id);
  assert.equal(service.getMarket(id).status, 'void');
  assert.equal(service.getUser(a.id).points, START_POINTS);
  assert.ok(ledgerMatchesBalances(db));

  const d = service.createManualMarket(draft({ closeAt: T0 + 10 * HOUR, resultAt: T0 + 11 * HOUR }));
  service.deleteDraft(d);
  assert.throws(() => service.getMarket(d, undefined, true), (e) => e instanceof AppError && e.status === 404);
});

test('manual markets never trigger exchange calls', async () => {
  const { clock, service, scheduler } = setup();
  const id = service.createManualMarket(draft({ publish: true }));
  goto(clock, T0 + 5 * HOUR);
  await scheduler.tick(); // would log a failure (and the venues throw) if it tried to ingest prices
  assert.equal(service.getMarket(id).status, 'locked');
  assert.deepEqual(service.tradingMarkets(), []);
});

test('HTTP admin: exchanges → draft → publish → predict → result', async () => {
  const { clock, service, scheduler } = setup();
  const server = createApiServer({ service, scheduler, adminKey: 'admin-key-for-tests-123456', manualOnly: true, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown, key = 'admin-key-for-tests-123456') =>
    fetch(base + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-admin-key': key } });
  try {
    assert.equal((await call('/api/admin/manual-markets', draft(), 'wrong')).status, 403);
    const ping = await (await call('/api/admin/ping')).json();
    assert.equal(ping.manualOnly, true);
    assert.deepEqual(ping.exchanges.map((e: { id: string }) => e.id), ['exa', 'exb']);

    const off = await (await call('/api/admin/exchanges/exb', { enabled: false })).json();
    assert.equal(off.exchanges[1].enabled, false);
    assert.equal((await call('/api/admin/manual-markets', draft())).status, 400);
    await call('/api/admin/exchanges/exb', { enabled: true });

    const created = await call('/api/admin/manual-markets', { ...draft(), closeAt: new Date(T0 + 2 * HOUR).toISOString(), resultAt: undefined });
    assert.equal(created.status, 200);
    const market = await created.json();
    assert.equal(market.phase, 'draft');
    const id = market.id as string;

    // Users can't see or open it yet.
    assert.equal((await fetch(`${base}/api/markets/${id}`)).status, 404);
    assert.equal((await (await fetch(`${base}/api/markets?filter=all`)).json()).markets.length, 0);
    // ...but the admin list shows it.
    assert.equal((await (await call('/api/admin/markets')).json()).markets[0].id, id);

    assert.equal((await call(`/api/admin/manual-markets/${id}`, { name: 'Edited' })).status, 200);
    const pub = await (await call(`/api/admin/manual-markets/${id}/publish`, {})).json();
    assert.equal(pub.published, true);
    assert.equal((await (await fetch(`${base}/api/markets/${id}`)).json()).name, 'Edited');

    const u = await service.createUser({ username: 'dave' });
    const v = await service.createUser({ username: 'erin' });
    service.placePrediction(id, u.id, 'moon', 100);
    service.placePrediction(id, v.id, 'down', 100);

    goto(clock, T0 + 3 * HOUR);
    await scheduler.tick();
    assert.equal((await call(`/api/admin/manual-markets/${id}/resolve`, { finalPrice: 'abc' })).status, 400);
    const prev = await (await call(`/api/admin/manual-markets/${id}/preview`, { finalPrice: 3.5 })).json();
    assert.equal(prev.winningBucket, 'moon'); // +75%
    assert.equal(prev.resolved, false);
    const done = await (await call(`/api/admin/manual-markets/${id}/resolve`, { finalPrice: 3.5, note: 'Final close' })).json();
    assert.equal(done.resolved, true);
    assert.deepEqual(done.winners.map((w: { username: string }) => w.username), ['dave']);
    assert.equal((await (await fetch(`${base}/api/markets/${id}`)).json()).status, 'resolved');
    assert.equal((await call(`/api/admin/manual-markets/${id}/resolve`, { finalPrice: 3.5 })).status, 409);
  } finally {
    server.close();
  }
});

test('editing a draft is not broadcast to visitors; editing a published market is', () => {
  const { service } = setup();
  const events: unknown[] = [];
  service.onEvent = (type, data) => events.push([type, data]);
  const id = service.createManualMarket(draft());
  service.updateManualMarket(id, { name: 'Renamed draft' });
  assert.deepEqual(events, [], 'drafts stay private');
  service.publishMarket(id);
  events.length = 0;
  service.updateManualMarket(id, { name: 'Renamed live' });
  assert.deepEqual(events, [['market', { marketId: id }]]);
});

test('upcoming token: no start price at launch, opening price set later, then the result pays out', async () => {
  const { db, clock, service, scheduler } = setup();
  const [a, b] = await Promise.all(['alice', 'bob'].map((username) => service.createUser({ username })));
  const id = service.createManualMarket(draft({ basePrice: null, publish: true }));
  assert.equal(service.getMarket(id).basePrice, null);

  service.placePrediction(id, a.id, 'up', 100);
  service.placePrediction(id, b.id, 'down', 100);

  // Trading opens and predictions close; without an opening price there's no result yet.
  goto(clock, T0 + 2 * HOUR + MIN);
  await scheduler.tick();
  assert.throws(() => service.previewResolution(id, { finalPrice: 2.5 }), (e) => e instanceof AppError && e.code === 'bad_price');

  // The admin records the opening price once; it can't be changed this way again.
  assert.throws(() => service.setStartPrice(id, 0), (e) => e instanceof AppError && e.code === 'bad_price');
  service.setStartPrice(id, 2);
  assert.equal(service.getMarket(id).basePrice, 2);
  assert.throws(() => service.setStartPrice(id, 3), (e) => e instanceof AppError && e.code === 'price_set');

  const { summary } = service.resolveManualMarket(id, { finalPrice: 2.5 });
  assert.equal(summary.winningBucket, 'up');
  assert.equal(service.getMarket(id).result?.basePrice, 2);
  assert.ok(ledgerMatchesBalances(db));
});

test('upcoming token: the opening price can also be given with the result', async () => {
  const { clock, service, scheduler } = setup();
  const [a, b] = await Promise.all(['alice', 'bob'].map((username) => service.createUser({ username })));
  const id = service.createManualMarket(draft({ basePrice: '', publish: true }));
  service.placePrediction(id, a.id, 'down', 100);
  service.placePrediction(id, b.id, 'up', 100);
  goto(clock, T0 + 3 * HOUR);
  await scheduler.tick();
  const { summary } = service.resolveManualMarket(id, { finalPrice: 1.5, basePrice: 2 });
  assert.equal(summary.winningBucket, 'down');
  assert.equal(summary.basePrice, 2);
});
