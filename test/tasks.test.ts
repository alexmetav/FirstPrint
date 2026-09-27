import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService, ONBOARDING_TASKS, START_POINTS } from '../src/services/firstprint.ts';
import type { Venue } from '../src/exchanges/types.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 12);

/** Minimal priced exchange, so createLiveMarket has something real to quote. */
function stubVenue(clock: ManualClock): Venue {
  const price = (ts: number) => 100 * (1 + (Math.max(0, ts - T0) / (20 * MIN)) * 0.3);
  return {
    id: 'exa',
    name: 'Exchange A',
    pair: (b) => `${b}USDT`,
    async fetchTicker(pair) {
      return pair === 'SOLUSDT' ? { price: price(clock.now()), ts: clock.now() } : null;
    },
    async fetchCandles(pair, start, end) {
      if (pair !== 'SOLUSDT') return [];
      const out = [];
      for (let ts = Math.ceil(start / MIN) * MIN; ts < end && ts + MIN <= clock.now(); ts += MIN) {
        out.push({ ts, close: price(ts), volume: 1000 });
      }
      return out;
    },
    async listPairs() {
      return [{ pair: 'SOLUSDT', base: 'SOL', quote: 'USDT', listingAt: null }];
    },
  };
}

function setup() {
  const clock = new ManualClock(T0);
  const service = new FirstprintService(openDb(':memory:'), clock, [stubVenue(clock)]);
  return { clock, service };
}

test('onboarding tasks unlock as the user actually does them', async () => {
  const { clock, service } = setup();
  const u = await service.createUser({ username: 'newcomer', password: 'password123' });
  const byId = () => Object.fromEntries(service.tasks(u.id).map((t) => [t.id, t]));

  // An email signup has a username but no wallet and no predictions yet.
  assert.equal(byId().pick_username.done, true);
  assert.equal(byId().connect_wallet.done, false);
  assert.equal(byId().first_prediction.done, false);
  assert.equal(byId().three_markets.done, false);
  assert.equal(byId().see_a_settlement.done, false);

  // Unfinished tasks cannot be collected.
  assert.throws(() => service.claimTask(u.id, 'first_prediction'), /Finish/);
  assert.throws(() => service.claimTask(u.id, 'not_a_task'), /does not exist/);

  // Collecting a finished one pays exactly once.
  const before = service.getUser(u.id).points;
  const out = service.claimTask(u.id, 'pick_username');
  assert.equal(out.awarded, 100);
  assert.equal(service.getUser(u.id).points, before + 100);
  assert.throws(() => service.claimTask(u.id, 'pick_username'), /already collected/);
  assert.equal(service.getUser(u.id).points, before + 100, 'a second claim must not pay again');

  // Predicting on three markets satisfies both prediction tasks.
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const m = await service.createLiveMarket({ symbol: 'SOL', exchanges: ['exa'] });
    ids.push(m.marketId);
    service.placePrediction(m.marketId, u.id, 'up', 20);
  }
  assert.equal(byId().first_prediction.done, true);
  assert.equal(byId().three_markets.done, true);
  assert.equal(byId().see_a_settlement.done, false, 'nothing has settled yet');

  assert.equal(service.claimTask(u.id, 'first_prediction').awarded, 250);
  assert.equal(service.claimTask(u.id, 'three_markets').awarded, 500);

  // Once a market reaches a result, the settlement task opens.
  clock.advance(20 * MIN);
  await service.ingestPrices();
  service.closeDueMarkets();
  service.settleDueMarkets();
  assert.ok(['resolved', 'void'].includes(service.getMarket(ids[0]).status));
  assert.equal(byId().see_a_settlement.done, true);
  assert.equal(service.claimTask(u.id, 'see_a_settlement').awarded, 250);

  // Every payment is on the ledger under its own reason.
  const rows = service.db.prepare("SELECT task_id, points FROM task_claims WHERE user_id = ? ORDER BY task_id").all(u.id) as { task_id: string; points: number }[];
  assert.equal(rows.length, 4);
  const ledger = service.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND reason = 'task'").get(u.id) as { n: number };
  assert.equal(ledger.n, 4);
});

test('wallet tasks track linked wallets', async () => {
  const { service } = setup();
  const u = await service.createUser({ username: 'walletless', password: 'password123' });
  const byId = () => Object.fromEntries(service.tasks(u.id).map((t) => [t.id, t]));
  assert.equal(byId().connect_wallet.done, false);
  assert.equal(byId().link_second_wallet.done, false);

  const now = service.clock.now();
  const add = (address: string) =>
    service.db
      .prepare('INSERT INTO wallets (address, user_id, wallet_name, verified_at) VALUES (?, ?, ?, ?)')
      .run(address, u.id, 'Phantom', now);

  add('Wallet1111111111111111111111111111111111111');
  assert.equal(byId().connect_wallet.done, true);
  assert.equal(byId().link_second_wallet.done, false, 'one wallet is not two');

  add('Wallet2222222222222222222222222222222222222');
  assert.equal(byId().link_second_wallet.done, true);
});

test('the practice backend offers the same tasks as the server', () => {
  // The UI calls one task API against either backend, so a drift in ids, points
  // or wording would show users different rewards depending on the mode.
  const demo = readFileSync(new URL('../web/demo.js', import.meta.url), 'utf8');
  const block = /const DEMO_TASKS = \[([\s\S]*?)\n\];/.exec(demo);
  assert.ok(block, 'DEMO_TASKS list present in web/demo.js');

  for (const t of ONBOARDING_TASKS) {
    assert.match(block[1], new RegExp(`id: '${t.id}'`), `demo.js is missing task ${t.id}`);
    assert.match(block[1], new RegExp(`points: ${t.points}`), `demo.js has no task worth ${t.points}`);
    assert.ok(block[1].includes(t.title), `demo.js title differs for ${t.id}`);
  }
  const demoIds = [...block[1].matchAll(/id: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(demoIds, ONBOARDING_TASKS.map((t) => t.id), 'task ids and order must match');
});

test('new accounts start unchanged by the tasks feature', async () => {
  const { service } = setup();
  const u = await service.createUser({ username: 'baseline', password: 'password123' });
  assert.equal(service.getUser(u.id).points, START_POINTS);
  assert.equal(service.tasks(u.id).filter((t) => t.claimed).length, 0);
});

test('username can be changed after sign-up, not only at first sign-in', async () => {
  const { service } = setup();
  const u = await service.createUser({ username: 'firstname', password: 'password123' });
  assert.equal(service.getUser(u.id).username, 'firstname');

  // The portfolio Profile section drives this; before it existed the name chosen
  // at sign-up could never be changed from the UI.
  const updated = service.setUsername(u.id, 'secondname');
  assert.equal(updated.username, 'secondname');
  assert.equal(updated.needs_username, 0);

  const other = await service.createUser({ username: 'taken', password: 'password123' });
  assert.throws(() => service.setUsername(u.id, 'taken'), /taken/);
  assert.throws(() => service.setUsername(u.id, 'no'), /3–20/);
  assert.throws(() => service.setUsername(u.id, 'bad name!'), /3–20/);
  assert.equal(service.getUser(u.id).username, 'secondname', 'a rejected rename must not stick');
  assert.equal(service.getUser(other.id).username, 'taken');
});
