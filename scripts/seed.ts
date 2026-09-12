/**
 * Seeds a local database with demo markets on the simulated venue.
 *
 *   npm run seed            → fast markets (settle in ~15–40 minutes)
 *   npm run seed -- --real  → real 72-hour timing
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from '../src/db/db.ts';
import { systemClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { SimVenue, simProfileFromDb } from '../src/exchanges/sim.ts';
import { BUCKETS } from '../src/engine/engine.ts';

const MIN = 60_000;
const real = process.argv.includes('--real');
const dbPath = process.env.DB_PATH ?? './data/firstprint.db';
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

const db = openDb(dbPath);
const service = new FirstprintService(db, systemClock, [new SimVenue('sim', systemClock, simProfileFromDb(db))], console.log);

const fast = { baselineMs: 3 * MIN, durationMs: 15 * MIN, settleWindowMs: 3 * MIN, minTrades: 1 };
const now = Date.now();

const demo = [
  { symbol: 'KORA', name: 'Kora Network', exchange: 'MEXC', inMin: 2, scorecard: { fdvUsd: 180_000_000, circulatingPct: 14, airdropPct: 8, unlocks: '6-month cliff for team and investors' } },
  { symbol: 'BRINE', name: 'Brine Finance', exchange: 'Bybit', inMin: 6, scorecard: { fdvUsd: 42_000_000, circulatingPct: 31, airdropPct: 22, unlocks: 'Airdrop fully unlocked at listing' } },
  { symbol: 'OTTO', name: 'Otto Agents', exchange: 'Binance', inMin: 12, scorecard: { fdvUsd: 610_000_000, circulatingPct: 9, airdropPct: 4, unlocks: 'Linear monthly unlocks from month 3' } },
  { symbol: 'PEBL', name: 'Pebble', exchange: 'OKX', inMin: 25, scorecard: { fdvUsd: 12_500_000, circulatingPct: 58, airdropPct: 35, unlocks: 'No vesting disclosed' } },
];

const names = ['moonmaxi', 'rektless', 'gridqueen', 'deltaneutral', 'unlockwatcher', 'airdropdan', 'thetaburn', 'bidwall'];
const players = [];
for (const name of names) {
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
  players.push(existing ? service.getUser((existing as { id: string }).id) : await service.createUser({ username: name }));
}

for (const d of demo) {
  const listingAt = now + (real ? d.inMin * 60 : d.inMin) * MIN;
  const id = service.createMarket({
    symbol: d.symbol,
    name: d.name,
    exchange: d.exchange,
    venues: [{ venue: 'sim', symbol: `${d.symbol}USDT` }],
    announcedListingAt: listingAt,
    listingAt,
    config: real ? {} : fast,
    scorecard: d.scorecard,
  });
  for (const p of players) {
    if (Math.random() < 0.3) continue;
    const bucket = BUCKETS[Math.floor(Math.random() * BUCKETS.length)];
    const stake = [25, 50, 100, 150, 250][Math.floor(Math.random() * 5)];
    service.placePrediction(id, p.id, bucket, stake);
  }
  console.log(`seeded ${d.symbol} (${id}) listing ${new Date(listingAt).toISOString()}`);
}
db.close();
