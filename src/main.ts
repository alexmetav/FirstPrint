import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.ts';
import { openDb } from './db/db.ts';
import { systemClock } from './clock.ts';
import { FirstprintService } from './services/firstprint.ts';
import { Scheduler } from './workers/scheduler.ts';
import { ListingTracker } from './workers/listingTracker.ts';
import { LiveFeed } from './workers/liveFeed.ts';
import { createApiServer } from './api/server.ts';
import { allVenues } from './exchanges/venues.ts';
import { SimVenue, simProfileFromDb } from './exchanges/sim.ts';
import type { Venue } from './exchanges/types.ts';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const cfg = loadConfig();
if (cfg.dbPath !== ':memory:') mkdirSync(dirname(cfg.dbPath), { recursive: true });
const db = openDb(cfg.dbPath);

const venues: Venue[] = allVenues();
if (cfg.sim) {
  venues.push(new SimVenue('sim', systemClock, simProfileFromDb(db)));
  log('simulated venue enabled');
}

const service = new FirstprintService(db, systemClock, venues, log);
const live = new LiveFeed(service);
const tracked = venues.filter((v) => cfg.trackVenues.includes(v.id));
const tracker = tracked.length ? new ListingTracker(service, tracked, { autoCreate: cfg.autoCreateMarkets }) : null;

// Settlement notifications are logged; plug in email or web push here.
const scheduler = new Scheduler(
  service,
  async (notes) => {
    for (const n of notes) log(`notify ${n.userId}: ${n.symbol} ${n.status} payout=${n.payout} refund=${n.refund}`);
  },
  { tickMs: cfg.tickMs, liveMs: cfg.liveMs, trackEveryMs: cfg.trackEveryMs, tracker, live },
);

const server = createApiServer({
  service,
  scheduler,
  live,
  adminKey: cfg.adminKey,
  secureCookies: cfg.secureCookies,
  publicUrl: cfg.publicUrl,
  solanaChain: cfg.solanaChain,
  webDir: new URL('../web', import.meta.url).pathname,
});

server.listen(cfg.port, () => {
  log(`Firstprint running at http://localhost:${cfg.port} (tracking: ${tracked.map((v) => v.id).join(', ') || 'none'})`);
  scheduler.start();
});

const shutdown = () => {
  log('shutting down');
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
