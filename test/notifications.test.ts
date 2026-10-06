// Result notifications: stored when a market settles or is cancelled, read in the app, emailed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { resultEmail } from '../src/services/notify.ts';
import { createApiServer } from '../src/api/server.ts';
import type { Venue } from '../src/exchanges/types.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 16, 12);

function venue(id: string, name: string): Venue {
  const boom = async () => {
    throw new Error('manual markets must not fetch prices');
  };
  return { id, name, pair: (b) => `${b}USDT`, fetchTicker: boom, fetchCandles: boom, listPairs: boom };
}

async function setup() {
  const db = openDb(':memory:');
  const clock = new ManualClock(T0);
  const service = new FirstprintService(db, clock, [venue('exa', 'Exchange A')]);
  const alice = await service.createUser({ username: 'alice', email: 'alice@example.com' });
  const bob = await service.createUser({ username: 'bob' });
  const market = (over: Record<string, unknown> = {}) =>
    service.createManualMarket({ symbol: 'pump', exchanges: ['exa'], basePrice: 1, closeAt: clock.now() + HOUR, resultAt: clock.now() + 2 * HOUR, publish: true, ...over });
  return { db, clock, service, alice, bob, market };
}

test('a settled market leaves each player a result: won, lost, with amounts', async () => {
  const { clock, service, alice, bob, market } = await setup();
  const id = market();
  service.placePrediction(id, alice.id, 'up', 100);
  service.placePrediction(id, bob.id, 'down', 100);
  assert.equal(service.unreadNotifications(alice.id), 0);

  clock.advance(2 * HOUR);
  const { notes } = service.resolveManualMarket(id, { finalPrice: 1.3 }); // +30%: Up
  assert.equal(notes.length, 2);

  const a = service.notificationsFor(alice.id);
  assert.equal(a.unread, 1);
  assert.equal(a.notifications[0].won, true);
  assert.equal(a.notifications[0].symbol, 'PUMP');
  assert.equal(a.notifications[0].winningBucket, 'up');
  assert.equal(a.notifications[0].payout > 100, true);
  const b = service.notificationsFor(bob.id).notifications[0];
  assert.equal(b.won, false);
  assert.equal(b.payout, 0);

  service.markNotificationsRead(alice.id);
  assert.equal(service.unreadNotifications(alice.id), 0);
  assert.equal(service.notificationsFor(alice.id).notifications[0].read, true);
  assert.equal(service.unreadNotifications(bob.id), 1, 'marking one player read leaves the others');
});

test('a cancelled market tells every player their refund', async () => {
  const { service, alice, market } = await setup();
  const id = market({ config: { outcomes: 'binary' } });
  service.placePrediction(id, alice.id, 'up', 60);
  service.placePrediction(id, alice.id, 'down', 40);
  service.cancelMarket(id);
  const [n] = service.notificationsFor(alice.id).notifications;
  assert.equal(n.status, 'void');
  assert.equal(n.refund, 100);
  assert.equal(n.staked, 100);
  assert.equal(n.outcomes, 'binary');
});

test('result emails: a win, a loss on a Yes/No market and a refund', () => {
  const base = { userId: 'u', marketId: 'm-1', symbol: 'SOL', voidReason: null, staked: 100, refund: 0 };
  const win = resultEmail({ ...base, status: 'resolved', winningBucket: 'moon', payout: 240 }, 'https://x.test/app/');
  assert.equal(win.subject, 'You won 240 points on SOL');
  assert.match(win.text, /settled in Moon/);
  assert.match(win.text, /https:\/\/x\.test\/app\/#\/market\/m-1/);
  const loss = resultEmail({ ...base, status: 'resolved', winningBucket: 'down', payout: 0, outcomes: 'binary' }, 'https://x.test/app/');
  assert.equal(loss.subject, 'SOL settled as No');
  const refund = resultEmail({ ...base, status: 'void', voidReason: 'retracted', winningBucket: null, payout: 0, refund: 100 }, 'https://x.test/app/');
  assert.match(refund.subject, /cancelled: 100 points refunded/);

  // The styled version: logo from the site, the result button, and names escaped.
  assert.match(win.html, /<img src="https:\/\/x\.test\/icon-192\.png"/);
  assert.match(win.html, /href="https:\/\/x\.test\/app\/#\/market\/m-1"[^>]*>See the result</);
  const odd = resultEmail({ ...base, symbol: '<b>X&Y</b>', status: 'resolved', winningBucket: 'up', payout: 10 }, 'https://x.test/app/');
  assert.ok(odd.html.includes('&lt;b&gt;X&amp;Y&lt;/b&gt;') && !odd.html.includes('<b>X'), 'token names are escaped');
});

test('API: unread count on /api/me, list, mark read; signed-in only', async () => {
  const { clock, service, alice, bob, market } = await setup();
  const id = market();
  service.placePrediction(id, alice.id, 'up', 100);
  service.placePrediction(id, bob.id, 'down', 100);
  clock.advance(2 * HOUR);
  service.resolveManualMarket(id, { finalPrice: 1.3 });

  const server = createApiServer({ service, adminKey: null, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const { token } = service.createSession(alice.id);
  const cookie = { cookie: `fp_session=${token}` };
  try {
    assert.equal((await fetch(`${base}/api/me/notifications`)).status, 401);
    const me = (await (await fetch(`${base}/api/me`, { headers: cookie })).json()) as { unreadNotifications: number };
    assert.equal(me.unreadNotifications, 1);
    const list = (await (await fetch(`${base}/api/me/notifications`, { headers: cookie })).json()) as { notifications: { won: boolean }[] };
    assert.equal(list.notifications[0].won, true);
    const read = await fetch(`${base}/api/me/notifications/read`, { method: 'POST', headers: { ...cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(read.status, 200);
    assert.equal(service.unreadNotifications(alice.id), 0);
  } finally {
    server.close();
  }
});
