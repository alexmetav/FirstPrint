import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { Scheduler } from '../src/workers/scheduler.ts';
import { createApiServer } from '../src/api/server.ts';
import { summarizeRecord, type RecordRow } from '../src/engine/engine.ts';
import type { Venue } from '../src/exchanges/types.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 14, 12);
const venue: Venue = (() => {
  const no = async () => {
    throw new Error('not used');
  };
  return { id: 'exa', name: 'Exchange A', pair: (b: string) => `${b}USDT`, fetchTicker: no, fetchCandles: no, listPairs: no };
})();

const row = (over: Partial<RecordRow>): RecordRow => ({
  marketId: 'm1', symbol: 'AAA', status: 'resolved', settledAt: 1, winningBucket: 'up',
  bucket: 'up', stake: 100, accepted: 100, refund: 0, payout: 0, ...over,
});

test('record: wins, losses, streaks, best win, open and refunded markets, per-outcome record', () => {
  const r = summarizeRecord([
    row({ marketId: 'a', symbol: 'AAA', settledAt: 1, bucket: 'up', payout: 250 }), // +150
    row({ marketId: 'a', symbol: 'AAA', settledAt: 1, bucket: 'down', stake: 50, accepted: 50, payout: 0 }), // same market, a losing side bet
    row({ marketId: 'b', symbol: 'BBB', settledAt: 2, bucket: 'moon', payout: 0 }), // −100
    row({ marketId: 'c', symbol: 'CCC', settledAt: 3, bucket: 'flat', payout: 180 }), // +80
    row({ marketId: 'd', symbol: 'DDD', settledAt: 4, bucket: 'crash', payout: 400 }), // +300
    row({ marketId: 'e', symbol: 'EEE', status: 'open', settledAt: null, accepted: null, stake: 70 }),
    row({ marketId: 'f', symbol: 'FFF', status: 'void', settledAt: 5, refund: 100 }),
    row({ marketId: 'g', symbol: 'GGG', status: 'resolved', settledAt: 6, accepted: 0, refund: 100 }), // fully refunded by a pool limit
  ]);
  assert.equal(r.marketsPlayed, 7);
  assert.equal(r.settled, 4);
  assert.equal(r.wins, 3);
  assert.equal(r.losses, 1);
  assert.equal(r.winRate, 0.75);
  assert.equal(r.totalStaked, 450);
  assert.equal(r.totalWon, 830);
  assert.equal(r.netProfit, 380);
  assert.deepEqual(r.bestWin, { marketId: 'd', symbol: 'DDD', profit: 300, payout: 400 });
  assert.equal(r.currentStreak, 2);
  assert.equal(r.bestStreak, 2);
  assert.deepEqual(r.open, { markets: 1, staked: 70 });
  assert.equal(r.refundedMarkets, 1);
  assert.deepEqual(r.byOutcome.up, { picks: 1, wins: 1 });
  assert.deepEqual(r.byOutcome.down, { picks: 1, wins: 0 });
  assert.deepEqual(r.history.map((m) => [m.symbol, m.profit, m.cumulative]), [['DDD', 300, 380], ['CCC', 80, 80], ['BBB', -100, 0], ['AAA', 100, 100]]);
  assert.deepEqual(r.history[3].buckets, ['up', 'down']);

  const empty = summarizeRecord([]);
  assert.equal(empty.winRate, null);
  assert.equal(empty.bestWin, null);
  assert.equal(empty.netProfit, 0);
});

test('stats endpoint: a real market settles into the winner\'s and loser\'s dashboards, with ranks', async () => {
  const clock = new ManualClock(T0);
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const scheduler = new Scheduler(service, async () => {}, { tickMs: 1000 });
  const server = createApiServer({ service, scheduler, adminKey: null, manualOnly: true, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const a = await service.createUser({ username: 'alice' });
    const b = await service.createUser({ username: 'bob' });
    const id = service.createManualMarket({ symbol: 'XYZ', exchanges: ['exa'], basePrice: 2, closeAt: T0 + HOUR, publish: true });
    service.placePrediction(id, a.id, 'up', 100);
    service.placePrediction(id, b.id, 'down', 100);
    clock.advance(2 * HOUR);
    await scheduler.tick();
    service.resolveManualMarket(id, { finalPrice: 2.5 }); // +25%: Up wins

    const winner = service.myStats(a.id);
    assert.equal(winner.winRate, 1);
    assert.equal(winner.netProfit, 92);
    assert.equal(winner.history[0].winningBucket, 'up');
    assert.equal(winner.rank, 1);
    assert.equal(winner.players, 2);

    const loser = service.myStats(b.id);
    assert.equal(loser.winRate, 0);
    assert.equal(loser.netProfit, -100);
    assert.equal(loser.rank, 2);

    const fresh = await service.createUser({ username: 'carol' });
    assert.equal(service.myStats(fresh.id).rank, null, 'no rank until a market settles');

    assert.equal((await fetch(`${base}/api/me/stats`)).status, 401);
    const session = service.createSession(a.id);
    const res = await fetch(`${base}/api/me/stats`, { headers: { authorization: `Bearer ${session.token}` } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).wins, 1);
  } finally {
    server.close();
  }
});

test('PnL cards: a settled prediction has a shareable image and a link preview page; nothing else does', async () => {
  const clock = new ManualClock(T0);
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const scheduler = new Scheduler(service, async () => {}, { tickMs: 1000 });
  const server = createApiServer({ service, scheduler, adminKey: null, manualOnly: true, secureCookies: false, publicUrl: 'https://firstprint.fun', webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const a = await service.createUser({ username: 'alice' });
    const b = await service.createUser({ username: 'bob' });
    const c = await service.createUser({ username: 'carol' });
    const id = service.createManualMarket({ symbol: 'XYZ', exchanges: ['exa'], basePrice: 2, closeAt: T0 + HOUR, publish: true });
    service.placePrediction(id, a.id, 'up', 100);
    service.placePrediction(id, b.id, 'down', 100);
    assert.equal((await fetch(`${base}/share/pnl/${id}/alice.png`)).status, 404, 'not settled yet');
    clock.advance(2 * HOUR);
    await scheduler.tick();
    service.resolveManualMarket(id, { finalPrice: 2.5 });

    const card = service.pnlCard(id, 'ALICE');
    assert.equal(card.won, true);
    assert.equal(card.profit, 92);
    assert.deepEqual(card.picks, ['up']);
    assert.equal(service.pnlCard(id, 'bob').profit, -100);

    const png = await fetch(`${base}/share/pnl/${id}/alice.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.match(png.headers.get('cache-control') ?? '', /max-age=86400/);
    const bytes = new Uint8Array(await png.arrayBuffer());
    assert.equal(bytes[1], 0x50, 'PNG');

    const page = await (await fetch(`${base}/share/pnl/${id}/alice`)).text();
    assert.match(page, new RegExp(`<meta property="og:image" content="https://firstprint.fun/share/pnl/${id}/alice.png">`));
    assert.match(page, /twitter:card" content="summary_large_image"/);
    assert.match(page, /@alice won \+92 pts on XYZ/);
    assert.match(page, new RegExp(`url=https://firstprint.fun/app/#/market/${id}`));

    assert.equal((await fetch(`${base}/share/pnl/${id}/carol.png`)).status, 404, 'no prediction');
    assert.equal((await fetch(`${base}/share/pnl/${id}/nobody`)).status, 404);
    assert.ok(c);
  } finally {
    server.close();
  }
});
