import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { AutoOpener } from '../src/workers/autoOpen.ts';
import type { Venue } from '../src/exchanges/types.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 6, 8);
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAAABJRU5ErkJggg==';

/** An exchange whose trades the test controls: closes per minute after listing, and a live price. */
function exchange(clock: ManualClock) {
  const state = { listedAt: null as number | null, closes: [] as number[], live: null as number | null };
  const venue: Venue = {
    id: 'mexc',
    name: 'MEXC',
    pair: (b) => `${b}USDT`,
    fetchCandles: async (_p, from, to) =>
      state.listedAt === null
        ? []
        : state.closes
            .map((close, i) => ({ ts: state.listedAt! + i * MIN, close, volume: 1000, trades: 10 }))
            .filter((c) => c.ts >= from && c.ts + MIN <= Math.min(to, clock.now())),
    fetchTicker: async () => (state.live === null ? null : { price: state.live, ts: clock.now() }),
    listPairs: async () => [],
  };
  return { state, venue };
}

function setup() {
  const clock = new ManualClock(T0);
  const { state, venue } = exchange(clock);
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const alerts: string[] = [];
  const announced: string[] = [];
  service.onAnnounce = (kind, id) => void announced.push(`${kind}:${id}`);
  const opener = new AutoOpener(service, [venue], (t) => void alerts.push(t));
  const schedule = (over: Record<string, unknown> = {}) =>
    service.createManualMarket({ symbol: 'NEWT', exchanges: ['mexc'], basePrice: 123, closeAt: T0 + 26 * HOUR, resultAt: T0 + 74 * HOUR, logoUrl: LOGO, publish: true, autoOpenAt: T0 + 2 * HOUR, ...over } as never);
  return { clock, state, service, alerts, announced, opener, schedule };
}

test('auto-open: checked, complete markets only; scheduling keeps it a draft with no start price', () => {
  const { service, schedule } = setup();
  assert.throws(() => schedule({ logoUrl: '' }), /logo/);
  assert.throws(() => schedule({ closeAt: T0 + 2 * HOUR + 10 * MIN }), /30 minutes/);
  assert.throws(() => schedule({ autoOpenAt: T0 - MIN }), /future/);
  const id = schedule();
  const m = service.getMarket(id, undefined, true);
  assert.equal(m.published, false, 'publish is ignored: it opens by itself');
  assert.equal(m.basePrice, null, 'the start price comes from the exchange, not the form');
  assert.equal(m.autoOpenAt, T0 + 2 * HOUR);
  assert.equal(service.autoOpenDue().length, 0, 'not due yet');
});

test('auto-open: waits for real trading, never uses a first-minute spike, then opens with the live price', async () => {
  const { clock, state, service, alerts, announced, opener, schedule } = setup();
  const id = schedule();
  clock.advance(2 * HOUR);
  await opener.run();
  assert.equal(service.getMarket(id, undefined, true).published, false);
  assert.match(service.getMarket(id, undefined, true).autoOpenNote ?? '', /no trades yet/);

  // Listing delayed by 10 minutes, then a wild first minute.
  clock.advance(10 * MIN);
  state.listedAt = clock.now();
  state.closes = [0.9, 0.31, 0.3, 0.29];
  state.live = 0.3;
  clock.advance(2 * MIN);
  await opener.run();
  assert.match(service.getMarket(id, undefined, true).autoOpenNote ?? '', /2 minutes of trading so far/);
  clock.advance(MIN);
  await opener.run();
  assert.match(service.getMarket(id, undefined, true).autoOpenNote ?? '', /swinging/, 'the 0.9 spike is still in the last 3 minutes');

  // Live price far from the last minutes: still wait.
  clock.advance(MIN);
  state.live = 0.5;
  await opener.run();
  assert.match(service.getMarket(id, undefined, true).autoOpenNote ?? '', /far from the last minutes/);

  state.live = 0.302;
  await opener.run();
  const m = service.getMarket(id, undefined, true);
  assert.equal(m.published, true);
  assert.equal(m.basePrice, 0.302, 'the live price, agreeing with the last 3 minutes');
  assert.equal(m.autoOpenAt, null);
  assert.match(m.autoOpenNote ?? '', /Opened by itself at \$0\.302/);
  assert.deepEqual(announced, [`live:${id}`], 'posted to the channel as a new market');
  assert.match(alerts.at(-1)!, /NEWT is open/);
  await opener.run();
  assert.equal(announced.length, 1, 'opened once');
});

test('auto-open: hands the market back to the admin when it is no longer ready or trading never starts', async () => {
  const { clock, service, alerts, opener, schedule } = setup();
  const noLogo = schedule();
  service.updateManualMarket(noLogo, { logoUrl: '', autoOpenAt: null });
  assert.equal(service.getMarket(noLogo, undefined, true).autoOpenAt, null, 'clearing the schedule');
  assert.throws(() => service.updateManualMarket(noLogo, { autoOpenAt: T0 + 2 * HOUR }), /logo/);

  const never = schedule({ symbol: 'LATE' });
  clock.advance(2 * HOUR);
  await opener.run();
  clock.advance(3 * HOUR + MIN);
  await opener.run();
  const m = service.getMarket(never, undefined, true);
  assert.equal(m.published, false);
  assert.equal(m.autoOpenAt, null, 'no longer scheduled');
  assert.match(m.autoOpenNote ?? '', /Not opened: trading hadn’t started 3 hours/);
  assert.match(alerts.at(-1)!, /LATE did not open by itself/);

  // Publishing a scheduled draft by hand takes it off the schedule.
  const manual = schedule({ symbol: 'HAND', autoOpenAt: clock.now() + HOUR, closeAt: clock.now() + 30 * HOUR, resultAt: clock.now() + 80 * HOUR });
  service.publishMarket(manual);
  assert.equal(service.getMarket(manual, undefined, true).autoOpenAt, null);
});
