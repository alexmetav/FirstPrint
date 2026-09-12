/**
 * Checks every exchange connection with real network calls.
 * Run this on the machine or server you'll host on:  npm run check
 */
import { openDb } from '../src/db/db.ts';
import { systemClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { allVenues } from '../src/exchanges/venues.ts';

const service = new FirstprintService(openDb(':memory:'), systemClock, allVenues());
console.log('Checking exchange APIs (BTC/USDT ticker, recent candles, pair list, announcements)…\n');
const results = await service.checkExchanges();

const mark = (ok: boolean | null) => (ok === null ? '  –  ' : ok ? ' PASS' : ' FAIL');
let failures = 0;
for (const r of results) {
  console.log(`${r.name}`);
  for (const [label, c] of [['Live price', r.ticker], ['Candles', r.candles], ['Pairs', r.pairs], ['Announcements', r.announcements]] as const) {
    if (c.ok === false) failures++;
    console.log(`  ${mark(c.ok)}  ${label.padEnd(14)} ${String(c.detail).slice(0, 90)}${c.ms ? ` (${c.ms} ms)` : ''}`);
  }
  console.log('');
}

if (failures) {
  console.log(`${failures} check(s) failed. Common causes: no internet, a firewall, or the exchange blocking your region`);
  console.log('(for example Binance blocks US IP addresses). Remove failing exchanges from TRACK_VENUES or fix the adapter.');
  process.exit(1);
}
console.log('All exchange checks passed.');
