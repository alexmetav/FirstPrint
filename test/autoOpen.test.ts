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
  assert.equal(m.basePrice, null, 'opened while trading, so its start price is the price at the close');
  assert.equal(m.startAtClose, true);
  assert.equal(m.autoOpenAt, null);
  assert.match(m.autoOpenNote ?? '', /trading at \$0\.302[\s\S]*taken when predictions close/);
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

test('upcoming markets: the opening price is read from the first minutes of trading, and the result is asked for only when due', async () => {
  const { clock, state, service, alerts, opener } = setup();
  const { Scheduler } = await import('../src/workers/scheduler.ts');
  const closedAlerts: string[] = [];
  service.onClosed = (ids) => {
    for (const id of ids) if (service.getMarket(id).basePrice !== null) closedAlerts.push(id);
  };
  // Published before listing, no start price: predictions close when trading starts.
  const id = service.createManualMarket({ symbol: 'EVAA', exchanges: ['mexc'], basePrice: null, closeAt: T0 + 2 * HOUR, resultAt: T0 + 50 * HOUR, logoUrl: LOGO, publish: true } as never);
  const scheduler = new Scheduler(service, async () => {}, { tickMs: 1000 });
  clock.advance(2 * HOUR + MIN);
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(service.getMarket(id).phase, 'awaiting_result');
  assert.deepEqual(closedAlerts, [], 'no "needs you" alert: nothing to do yet');

  await opener.run();
  assert.equal(service.getMarket(id).basePrice, null);
  assert.match(service.getMarket(id, undefined, true).autoOpenNote ?? '', /no trades yet/);

  // KuCoin's timer ran a little late: trading starts 20 minutes after the close, with a first-minute spike.
  clock.advance(20 * MIN);
  state.listedAt = clock.now();
  state.closes = [0.5, 0.21, 0.2, 0.19, 0.18];
  clock.advance(3 * MIN);
  await opener.run();
  assert.equal(service.getMarket(id).basePrice, null, '3 minutes: still waiting for 4');
  clock.advance(2 * MIN);
  await opener.run();
  assert.equal(service.getMarket(id).basePrice, 0.2, 'the middle of minutes 2–4, not the 0.5 spike');
  assert.match(service.getMarket(id, undefined, true).autoOpenNote ?? '', /Opening price \$0\.2 set by itself/);
  assert.equal(alerts.length, 0, 'set quietly');

  await opener.run();
  assert.equal(alerts.length, 0, 'result not due yet');
  clock.advance(48 * HOUR);
  await opener.run();
  await opener.run();
  assert.equal(alerts.length, 1, 'asked for the result once, when it is due');
});

test('upcoming markets: no trades a day after the close, the admin is asked for the opening price', async () => {
  const { clock, service, alerts, opener } = setup();
  const { Scheduler } = await import('../src/workers/scheduler.ts');
  const id = service.createManualMarket({ symbol: 'GONE', exchanges: ['mexc'], basePrice: null, closeAt: T0 + HOUR, resultAt: T0 + 50 * HOUR, logoUrl: LOGO, publish: true } as never);
  clock.advance(HOUR + MIN);
  await new Scheduler(service, async () => {}, { tickMs: 1000 }).tick();
  await opener.run();
  clock.advance(24 * HOUR);
  await opener.run();
  await opener.run();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /GONE: add its opening price/);
  assert.equal(service.awaitingOpeningPrice().length, 0, 'stops trying');
  assert.match(service.getMarket(id, undefined, true).autoOpenNote ?? '', /Opening price not found/);
});

/** A market already trading, priced at the close: the start price is read when predictions close. */
function closeSetup(priceOnly = false) {
  const clock = new ManualClock(T0);
  // One reading per minute (or per 5 minutes on a price-only source like CoinGecko) from T0 - 1h.
  const prices = new Map<number, number>();
  const venue: Venue = {
    id: priceOnly ? 'coingecko' : 'mexc',
    name: priceOnly ? 'CoinGecko' : 'MEXC',
    ...(priceOnly ? { priceOnly: true } : {}),
    pair: (b) => (priceOnly ? b.toLowerCase() : `${b}USDT`),
    fetchCandles: async (_p, from, to) =>
      [...prices]
        .filter(([ts]) => ts >= from && ts <= Math.min(to, clock.now() - MIN))
        .map(([ts, close]) => ({ ts, close, volume: priceOnly ? 0 : 500, trades: priceOnly ? undefined : 5 })),
    fetchTicker: async () => null,
    listPairs: async () => [],
  };
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const alerts: string[] = [];
  const opener = new AutoOpener(service, [venue], (t) => void alerts.push(t));
  return { clock, prices, venue, service, alerts, opener };
}

test('priced at the close: the start price is the price just before predictions close, so the trend while they are open gives no edge', async () => {
  const { clock, prices, service, alerts, opener } = closeSetup();
  const { Scheduler } = await import('../src/workers/scheduler.ts');
  const closeAt = T0 + 48 * HOUR;
  const id = service.createManualMarket({ symbol: 'PUMP', exchanges: ['mexc'], basePrice: 0.5, startAtClose: true, closeAt, resultAt: closeAt + 15 * 24 * HOUR, logoUrl: LOGO, publish: true } as never);
  const m0 = service.getMarket(id);
  assert.equal(m0.basePrice, null, 'no start price while predictions are open, even if one was typed');
  assert.equal(m0.startAtClose, true);
  assert.throws(() => service.setStartPrice(id, 0.4), /when predictions close/);

  // The token climbs all through the two days of predictions.
  for (let t = closeAt - 10 * MIN, p = 1.0; t < closeAt + 10 * MIN; t += MIN, p += 0.01) prices.set(t, Number(p.toFixed(2)));
  clock.advance(closeAt + MIN - clock.now());
  await new Scheduler(service, async () => {}, { tickMs: 1000 }).tick();
  assert.equal(service.getMarket(id).phase, 'awaiting_result');
  await opener.run();
  assert.equal(service.getMarket(id).basePrice, null, 'waits for the last minute before the close to finish');

  clock.advance(closeAt + 3 * MIN - clock.now());
  await opener.run();
  // Minutes close-3, close-2, close-1: 1.07, 1.08, 1.09; never a price from after the close.
  assert.equal(service.getMarket(id).basePrice, 1.08);
  assert.match(service.getMarket(id, undefined, true).autoOpenNote ?? '', /Start price \$1\.08 set by itself: the price when predictions closed, on MEXC/);
  assert.equal(alerts.length, 0, 'nothing for the admin to do yet');

  // The admin is asked for the result when it is due, 15 days later, once.
  clock.advance(closeAt + 15 * 24 * HOUR - MIN - clock.now());
  await opener.run();
  assert.equal(alerts.length, 0);
  clock.advance(closeAt + 15 * 24 * HOUR + MIN - clock.now());
  await opener.run();
  await opener.run();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Result due: pump-m-/);
});

test('priced at the close: a price-only source (CoinGecko) works, and with no price the admin is asked for it', async () => {
  const cg = closeSetup(true);
  const { Scheduler } = await import('../src/workers/scheduler.ts');
  const closeAt = T0 + 24 * HOUR;
  const id = cg.service.createManualMarket({ symbol: 'PENGU', exchanges: ['coingecko'], pairs: { coingecko: 'pudgy-penguins' }, basePrice: null, startAtClose: true, closeAt, resultAt: closeAt + 30 * 24 * HOUR, publish: true } as never);
  for (const [k, p] of [[25, 0.031], [20, 0.032], [15, 0.033], [10, 0.034], [5, 0.035]]) cg.prices.set(closeAt - k * MIN, p);
  cg.prices.set(closeAt + 5 * MIN, 0.09);
  cg.clock.advance(closeAt + 10 * MIN - cg.clock.now());
  await new Scheduler(cg.service, async () => {}, { tickMs: 1000 }).tick();
  await cg.opener.run();
  assert.equal(cg.service.getMarket(id).basePrice, 0.034, 'the last three points before the close, not the spike after it');

  const ex = closeSetup();
  const gone = ex.service.createManualMarket({ symbol: 'GONE', exchanges: ['mexc'], basePrice: null, startAtClose: true, closeAt, resultAt: closeAt + 15 * 24 * HOUR, publish: true } as never);
  ex.clock.advance(closeAt + 5 * MIN - ex.clock.now());
  await new Scheduler(ex.service, async () => {}, { tickMs: 1000 }).tick();
  await ex.opener.run();
  assert.match(ex.service.getMarket(gone, undefined, true).autoOpenNote ?? '', /Reading the price at the close/);
  assert.equal(ex.alerts.length, 0);
  ex.clock.advance(closeAt + 2 * HOUR + MIN - ex.clock.now());
  await ex.opener.run();
  await ex.opener.run();
  assert.equal(ex.alerts.length, 1);
  assert.match(ex.alerts[0], /GONE: add its start price/);
  assert.equal(ex.service.awaitingOpeningPrice().length, 0, 'stops trying');
  ex.service.setStartPrice(gone, 2);
  assert.equal(ex.service.getMarket(gone).basePrice, 2, 'the admin can add it once predictions are closed');
});
