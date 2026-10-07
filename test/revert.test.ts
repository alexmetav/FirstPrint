import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { AppError, FirstprintService, START_POINTS } from '../src/services/firstprint.ts';
import { DEFAULT_REVERT_RULES, revertBps, revertQuote, splitEarlyPot } from '../src/engine/engine.ts';
import type { Venue } from '../src/exchanges/types.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 14, 12);

function venue(id: string): Venue {
  const boom = async () => {
    throw new Error('not called');
  };
  return { id, name: id, pair: (b) => `${b}USDT`, fetchTicker: boom, fetchCandles: boom, listPairs: boom };
}

function goto(clock: ManualClock, t: number) {
  clock.advance(t - clock.now());
}

/** A manual market open for 24 hours from T0, with the result a day later. */
async function setup() {
  const db = openDb(':memory:');
  const clock = new ManualClock(T0);
  const service = new FirstprintService(db, clock, [venue('exa')]);
  const id = service.createManualMarket({ symbol: 'xyz', exchanges: ['exa'], basePrice: 2, closeAt: T0 + 24 * HOUR, resultAt: T0 + 48 * HOUR });
  service.publishMarket(id);
  const [a, b, c] = [await service.createUser({ username: 'early' }), await service.createUser({ username: 'whale' }), await service.createUser({ username: 'other' })];
  return { db, clock, service, id, a, b, c };
}

function ledgerMatchesBalances(db: ReturnType<typeof openDb>) {
  const rows = db.prepare('SELECT u.points AS points, COALESCE(SUM(l.delta), 0) AS sum FROM users u LEFT JOIN ledger l ON l.user_id = u.id GROUP BY u.id').all() as { points: number; sum: number }[];
  return rows.every((r) => r.points === r.sum);
}

test('revert fee: flat in the first half, then climbs steeply to the maximum at the close', () => {
  const r = DEFAULT_REVERT_RULES;
  const at = (hoursLeft: number) => revertBps(72 * HOUR - hoursLeft * HOUR, 0, 72 * HOUR, r) / 100;
  assert.equal(at(72), 2);
  assert.equal(at(36), 2);
  assert.ok(at(24) > 3 && at(24) < 5);
  assert.ok(at(12) > 14 && at(12) < 18);
  assert.ok(at(1) > 44 && at(1) < 50);
  assert.equal(at(0), 50);
  // Never lower closer to the close.
  let last = 0;
  for (let h = 72; h >= 0; h--) {
    assert.ok(at(h) >= last);
    last = at(h);
  }
});

test('revert quote: free undo only early, rounding up, half burned, locked near the close', () => {
  const r = DEFAULT_REVERT_RULES;
  const end = 24 * HOUR;
  assert.deepEqual(revertQuote(100, HOUR, HOUR + MIN, 0, end, r), { allowed: true, bps: 0, fee: 0, back: 100, burn: 0, toEarly: 0, free: true });
  // Two minutes after placing, but in the second half: no free undo.
  assert.equal(revertQuote(100, 20 * HOUR, 20 * HOUR + MIN, 0, end, r).free, false);
  const q = revertQuote(10, 0, 3 * HOUR, 0, end, r);
  assert.equal(q.fee, 1); // 2% of 10 rounds up to 1
  assert.equal(q.burn + q.toEarly, q.fee);
  const big = revertQuote(1000, 0, 3 * HOUR, 0, end, r);
  assert.deepEqual([big.fee, big.burn, big.toEarly, big.back], [20, 10, 10, 980]);
  assert.equal(revertQuote(1000, 0, end - 5 * MIN, 0, end, r).allowed, false);
});

test('early pot is split by stake, with the rounding burned', () => {
  const { shares, burned } = splitEarlyPot(10, [{ id: 'a', accepted: 100 }, { id: 'b', accepted: 200 }]);
  assert.deepEqual([shares.get('a'), shares.get('b'), burned], [3, 6, 1]);
  assert.deepEqual(splitEarlyPot(50, []).burned, 50);
});

test('reverting returns the stake minus the fee and takes the pick out of the pool', async () => {
  const { db, clock, service, id, a, b } = await setup();
  service.placePrediction(id, a.id, 'up', 100);
  const big = service.placePrediction(id, b.id, 'moon', 1000);

  goto(clock, T0 + 23 * HOUR); // one hour before the close
  const q = service.revertQuote(big.id, b.id);
  assert.ok(q.bps > 3_500 && q.allowed);
  const res = service.revertPrediction(big.id, b.id);
  assert.equal(res.back, 1000 - res.fee);
  assert.equal(res.burned + res.toEarly, res.fee);
  assert.equal(service.getUser(b.id).points, START_POINTS - res.fee);

  const m = service.getMarket(id, b.id);
  assert.equal(m.pool, 100);
  assert.equal(m.totals.moon, 0);
  assert.deepEqual(m.mine, []);
  assert.equal(m.earlyPot, res.toEarly);
  assert.ok(ledgerMatchesBalances(db));
  assert.deepEqual(service.burnStats(b.id), { burned: res.burned, earlyRewards: 0 });

  // Someone else's prediction, a second revert, and the last minutes are all refused.
  const other = service.placePrediction(id, b.id, 'down', 50);
  assert.throws(() => service.revertPrediction(other.id, a.id), (e) => e instanceof AppError && e.status === 404);
  assert.throws(() => service.revertPrediction(big.id, b.id), (e) => e instanceof AppError && e.status === 404);
  goto(clock, T0 + 24 * HOUR - 5 * MIN);
  assert.throws(() => service.revertPrediction(other.id, b.id), (e) => e instanceof AppError && e.code === 'revert_locked');
});

test('early players who stayed in share half the fee at settlement, win or lose', async () => {
  const { db, clock, service, id, a, b, c } = await setup();
  service.placePrediction(id, a.id, 'up', 300); // early, wins
  service.placePrediction(id, c.id, 'down', 100); // early, loses
  goto(clock, T0 + 14 * HOUR);
  service.placePrediction(id, c.id, 'down', 100); // late: not early, gets no share
  const big = service.placePrediction(id, b.id, 'moon', 1000);
  goto(clock, T0 + 23 * HOUR);
  const res = service.revertPrediction(big.id, b.id);
  assert.ok(res.toEarly > 0);

  goto(clock, T0 + 48 * HOUR);
  service.closeDueMarkets();
  service.resolveManualMarket(id, { finalPrice: 2.4 });
  const early = (u: string) => (db.prepare("SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE user_id = ? AND reason = 'early_reward'").get(u) as { s: number }).s;
  const pot = res.toEarly;
  assert.equal(early(a.id), Math.floor((pot * 300) / 400));
  assert.equal(early(c.id), Math.floor((pot * 100) / 400));
  const totals = service.burnTotals();
  assert.equal(totals.earlyPaid + (totals.burned - res.burned), pot);
  assert.equal(service.burnStats(a.id).earlyRewards, early(a.id));
  assert.ok(ledgerMatchesBalances(db));
});

test('a cancelled market burns the early players’ share', async () => {
  const { db, clock, service, id, a, b } = await setup();
  service.placePrediction(id, a.id, 'up', 300);
  const big = service.placePrediction(id, b.id, 'moon', 500);
  goto(clock, T0 + 20 * HOUR);
  const res = service.revertPrediction(big.id, b.id);
  service.cancelMarket(id);
  assert.equal(service.burnTotals().burned, res.fee);
  assert.equal(service.getUser(a.id).points, START_POINTS);
  assert.ok(ledgerMatchesBalances(db));
});

test('a revert inside the free undo window costs nothing', async () => {
  const { service, id, a, clock } = await setup();
  const p = service.placePrediction(id, a.id, 'up', 100);
  goto(clock, T0 + MIN);
  const res = service.revertPrediction(p.id, a.id);
  assert.deepEqual([res.fee, res.back, res.free], [0, 100, true]);
  assert.equal(service.getUser(a.id).points, START_POINTS);
});

test('admin revert rules are checked and saved', async () => {
  const { service } = await setup();
  assert.throws(() => service.setRevertRules({ baseBps: 600, maxBps: 500 }), (e) => e instanceof AppError && e.code === 'bad_rules');
  const r = service.setRevertRules({ baseBps: 300, maxBps: 4_000, lockMs: 15 * MIN });
  assert.deepEqual([r.baseBps, r.maxBps, r.lockMs, r.undoMs], [300, 4_000, 15 * MIN, DEFAULT_REVERT_RULES.undoMs]);
  assert.equal(service.revertRules().maxBps, 4_000);
});
