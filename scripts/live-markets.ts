/**
 * Creates test markets on real tokens with real exchange prices.
 *
 *   npm run live                         → suggested tokens, 15-minute markets starting in 2 minutes
 *   npm run live -- SOL BTC HIMSB        → specific tokens
 *   npm run live -- --length=hour SOL    → quick | hour | day | full (72 hours)
 *   npm run live -- --starts=5 --exchanges=bybit,okx SOL
 *
 * Needs internet access. Start the site with `npm run dev` to predict and watch them settle.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from '../src/db/db.ts';
import { systemClock } from '../src/clock.ts';
import { FirstprintService, LIVE_PRESETS, SUGGESTED_LIVE_TOKENS } from '../src/services/firstprint.ts';
import { allVenues } from '../src/exchanges/venues.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const tokens = args.filter((a) => !a.startsWith('--'));
const preset = flag('length') ?? 'quick';
const startsInMinutes = Number(flag('starts') ?? 2);
const exchanges = flag('exchanges')?.split(',').filter(Boolean);

if (!LIVE_PRESETS[preset]) {
  console.error(`--length must be one of: ${Object.keys(LIVE_PRESETS).join(', ')}`);
  process.exit(1);
}

const dbPath = process.env.DB_PATH ?? './data/firstprint.db';
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const service = new FirstprintService(db, systemClock, allVenues());
const port = process.env.PORT ?? '8787';

const list = tokens.length ? tokens.map((symbol) => ({ symbol, name: undefined as string | undefined })) : SUGGESTED_LIVE_TOKENS;
console.log(`Creating ${LIVE_PRESETS[preset].label} markets starting in ${startsInMinutes} min…\n`);

let created = 0;
for (const t of list) {
  try {
    const out = await service.createLiveMarket({ symbol: t.symbol, name: t.name, preset, startsInMs: startsInMinutes * 60_000, exchanges });
    created++;
    console.log(`✓ ${t.symbol.padEnd(6)} ${out.exchanges.map((e) => `${e.name} ${e.price}`).join(', ')}`);
    console.log(`         http://localhost:${port}/#/market/${out.marketId}`);
  } catch (err) {
    console.log(`✗ ${t.symbol.padEnd(6)} ${(err as Error).message}`);
  }
}
db.close();
console.log(`\n${created} market(s) created. Run "npm run dev" (if it isn't running) and open http://localhost:${port}`);
