// Yes/No markets, odds history, top predictors, public profiles and leaderboard periods.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { AppError, FirstprintService, periodRange } from '../src/services/firstprint.ts';
import { createApiServer } from '../src/api/server.ts';
import { bucketFor, summarizeRecord } from '../src/engine/engine.ts';
import type { Venue } from '../src/exchanges/types.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 16, 12); // a Wednesday

function venue(id: string, name: string): Venue {
  const boom = async () => {
    throw new Error('manual markets must not fetch prices');
  };
  return { id, name, pair: (b) => `${b}USDT`, fetchTicker: boom, fetchCandles: boom, listPairs: boom };
}

function setup() {
  const db = openDb(':memory:');
  const clock = new ManualClock(T0);
  const service = new FirstprintService(db, clock, [venue('exa', 'Exchange A')]);
  return { db, clock, service };
}

const market = (over: Record<string, unknown> = {}) => ({
  symbol: 'sol',
  name: 'Solana',
  exchanges: ['exa'],
  basePrice: 250,
  closeAt: T0 + 2 * HOUR,
  resultAt: T0 + 26 * HOUR,
  publish: true,
  ...over,
});

test('bucketFor: Yes at or above the target, No below; ladders unchanged', () => {
  const cfg = { outcomes: 'binary' as const, thresholds: { crash: -0.5, down: -0.1, up: 0.1, moon: 0.5 } };
  assert.equal(bucketFor(0, cfg), 'up');
  assert.equal(bucketFor(0.001, cfg), 'up');
  assert.equal(bucketFor(-0.001, cfg), 'down');
  assert.equal(bucketFor(0.6, { ...cfg, outcomes: 'ladder' }), 'moon');
  assert.equal(bucketFor(0.6, { thresholds: cfg.thresholds }), 'moon');
});

test('Yes/No market: only Yes and No can be picked, and the result follows the target price', async () => {
  const { clock, service } = setup();
  const yes = await service.createUser({ username: 'yesbot' });
  const no = await service.createUser({ username: 'nobot' });
  const id = service.createManualMarket(market({ config: { outcomes: 'binary' } }));

  const m = service.getMarket(id);
  assert.equal(m.outcomes, 'binary');
  for (const b of ['crash', 'flat', 'moon'] as const) {
    assert.throws(() => service.placePrediction(id, yes.id, b, 100), (e) => e instanceof AppError && e.code === 'bad_bucket');
    assert.throws(() => service.quote(id, b, 100), (e) => e instanceof AppError && e.code === 'bad_bucket');
  }
  service.placePrediction(id, yes.id, 'up', 100);
  service.placePrediction(id, no.id, 'down', 300);

  clock.advance(3 * HOUR);
  assert.throws(() => service.previewResolution(id, { finalPrice: 260, winningBucket: 'moon' }), (e) => e instanceof AppError && e.code === 'bad_bucket');
  const preview = service.previewResolution(id, { finalPrice: 250 });
  assert.equal(preview.winningBucket, 'up', 'exactly the target counts as Yes');
  assert.equal(preview.outcomes, 'binary');

  const { summary } = service.resolveManualMarket(id, { finalPrice: 249.99 });
  assert.equal(summary.winningBucket, 'down');
  assert.equal(service.getUser(no.id).points > service.getUser(yes.id).points, true);

  const st = service.myStats(no.id);
  assert.equal(st.history[0].binary, true);
  assert.equal(st.byOutcome.down.picks, 0, 'Yes/No picks stay out of the ladder breakdown');
});

test('market type must be ladder or binary', () => {
  const { service } = setup();
  assert.throws(() => service.createManualMarket(market({ config: { outcomes: 'maybe' } })), (e) => e instanceof AppError && e.code === 'bad_config');
  const id = service.createManualMarket(market());
  assert.equal(service.getMarket(id).outcomes, 'ladder');
});

test('odds history: each outcome’s share after every prediction', async () => {
  const { clock, service } = setup();
  const a = await service.createUser({ username: 'alice' });
  const b = await service.createUser({ username: 'bob' });
  const id = service.createManualMarket(market({ config: { outcomes: 'binary' } }));
  service.placePrediction(id, a.id, 'up', 100);
  clock.advance(MIN);
  service.placePrediction(id, b.id, 'down', 300);

  const o = service.odds(id);
  assert.equal(o.outcomes, 'binary');
  assert.deepEqual(o.buckets, ['up', 'down']);
  assert.deepEqual(
    o.series.map((p) => p.shares),
    [
      { up: 1, down: 0 },
      { up: 0.25, down: 0.75 },
    ],
  );
  assert.equal(o.series[1].t, T0 + MIN);
});

test('holders: biggest stakes first, picks grouped, payouts only after settling', async () => {
  const { clock, service } = setup();
  const a = await service.createUser({ username: 'alice' });
  const b = await service.createUser({ username: 'bob' });
  const id = service.createManualMarket(market());
  service.placePrediction(id, a.id, 'up', 100);
  service.placePrediction(id, a.id, 'moon', 50);
  service.placePrediction(id, b.id, 'down', 200);

  let h = service.holders(id);
  assert.equal(h.total, 2);
  assert.deepEqual(
    h.holders.map((x) => [x.username, x.total, x.picks.map((p) => p.bucket), x.payout]),
    [
      ['bob', 200, ['down'], null],
      ['alice', 150, ['up', 'moon'], null],
    ],
  );

  clock.advance(3 * HOUR);
  service.resolveManualMarket(id, { finalPrice: 290 }); // +16%: Up
  h = service.holders(id);
  assert.equal(h.holders.find((x) => x.username === 'alice')!.payout! > 0, true);
  assert.equal(h.holders.find((x) => x.username === 'bob')!.payout, 0);
});

test('public profile: record and open positions, nothing private', async () => {
  const { service } = setup();
  const a = await service.createUser({ username: 'Alice', email: 'alice@example.com' });
  const id = service.createManualMarket(market());
  service.placePrediction(id, a.id, 'up', 100);

  const p = service.publicProfile('alice'); // any case
  assert.equal(p.username, 'Alice');
  assert.equal(p.isMe, false);
  assert.equal(service.publicProfile('alice', a.id).isMe, true);
  assert.deepEqual(
    p.positions.map((x) => [x.symbol, x.bucket, x.stake]),
    [['SOL', 'up', 100]],
  );
  assert.equal(p.stats.marketsPlayed, 1);
  assert.equal(JSON.stringify(p).includes('alice@example.com'), false);
  assert.throws(() => service.publicProfile('nobody'), (e) => e instanceof AppError && e.status === 404);
});

test('leaderboard periods: today, this week, this month and all time', async () => {
  const { clock, service } = setup();
  const a = await service.createUser({ username: 'alice' });
  const b = await service.createUser({ username: 'bob' });
  const settle = (final: number) => {
    const id = service.createManualMarket(market({ closeAt: clock.now() + HOUR, resultAt: clock.now() + 2 * HOUR }));
    service.placePrediction(id, a.id, 'up', 100);
    service.placePrediction(id, b.id, 'down', 100);
    clock.advance(2 * HOUR);
    service.resolveManualMarket(id, { finalPrice: final });
  };
  settle(290); // alice wins, Wednesday
  clock.advance(DAY * 20); // into next month
  settle(200); // bob wins
  const names = (p: 'day' | 'week' | 'month' | 'all') => service.leaderboard(undefined, p).entries.map((e) => e.name);
  assert.deepEqual(names('day'), ['bob', 'alice']);
  assert.deepEqual(names('month'), ['bob', 'alice']);
  assert.equal(service.leaderboard(undefined, 'all').entries.length, 2);
  assert.equal(service.leaderboard(undefined, 'all').entries.reduce((s, e) => s + e.total, 0), 4);
  assert.equal(service.leaderboard(undefined, 'month').entries.reduce((s, e) => s + e.total, 0), 2);

  const d = periodRange('day', T0);
  assert.equal(d.start, Date.UTC(2026, 8, 16));
  assert.equal(periodRange('week', T0).start, Date.UTC(2026, 8, 14), 'weeks start on Monday');
  assert.equal(periodRange('month', T0).start, Date.UTC(2026, 8, 1));
  assert.deepEqual(periodRange('all', T0), { start: 0, end: null });
});

test('summarizeRecord keeps the Yes/No flag on settled markets', () => {
  const r = summarizeRecord([
    { marketId: 'm', symbol: 'SOL', status: 'resolved', settledAt: 1, winningBucket: 'up', bucket: 'up', stake: 10, accepted: 10, refund: 0, payout: 15, binary: true },
  ]);
  assert.equal(r.history[0].binary, true);
  assert.equal(r.byOutcome.up.picks, 0);
});

test('API: odds, holders, profiles and leaderboard periods', async () => {
  const { service } = setup();
  const a = await service.createUser({ username: 'alice' });
  const id = service.createManualMarket(market({ config: { outcomes: 'binary' } }));
  service.placePrediction(id, a.id, 'up', 100);
  const server = createApiServer({ service, adminKey: null, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const get = async (p: string) => {
      const res = await fetch(base + p);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    assert.equal((await get(`/api/markets/${id}/odds`)).body.outcomes, 'binary');
    assert.equal(((await get(`/api/markets/${id}/holders`)).body.holders as unknown[]).length, 1);
    assert.equal((await get('/api/users/alice')).body.username, 'alice');
    assert.equal((await get('/api/users/nobody')).status, 404);
    assert.equal((await get('/api/leaderboard?period=month')).body.period, 'month');
    assert.equal((await get('/api/leaderboard?period=forever')).body.period, 'week');
    assert.equal((await get(`/api/markets/${id}`)).body.outcomes, 'binary');
  } finally {
    server.close();
  }
});

test('market page: the market, activity, odds and holders in one answer', async () => {
  const { service } = setup();
  const a = await service.createUser({ username: 'alice' });
  const id = service.createManualMarket(market());
  service.placePrediction(id, a.id, 'up', 100);

  const page = service.marketPage(id, a.id);
  assert.deepEqual(page.market, service.getMarket(id, a.id));
  assert.equal(page.chart, null); // admin-run markets have no price chart
  assert.deepEqual(page.activity, service.activity(id));
  assert.deepEqual(page.odds, service.odds(id));
  assert.deepEqual(page.holders, service.holders(id));
  assert.equal(page.market.mine.length, 1);
});
