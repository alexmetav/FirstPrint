import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { openDb } from './db/db.ts';
import { DbBackup, backupConfigFromEnv, restoreIfMissing } from './db/backup.ts';
import { systemClock } from './clock.ts';
import { FirstprintService } from './services/firstprint.ts';
import { Scheduler } from './workers/scheduler.ts';
import { ListingTracker } from './workers/listingTracker.ts';
import { LiveFeed } from './workers/liveFeed.ts';
import { createApiServer } from './api/server.ts';
import { allVenues } from './exchanges/venues.ts';
import { SimVenue, simProfileFromDb } from './exchanges/sim.ts';
import type { Venue } from './exchanges/types.ts';
import { ConsoleMailer, ResendMailer, type Mailer } from './auth/mailer.ts';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const cfg = loadConfig();
if (cfg.dbPath !== ':memory:') mkdirSync(dirname(cfg.dbPath), { recursive: true });

// Hosts without a persistent disk (Render's free plan) lose the database file on every restart,
// so it is restored from, and regularly copied to, a private Supabase Storage bucket.
const backupCfg = cfg.dbPath === ':memory:' ? null : backupConfigFromEnv();
if (backupCfg) await restoreIfMissing(cfg.dbPath, backupCfg, log);
else if (process.env.NODE_ENV === 'production') {
  log('WARNING: no SUPABASE_URL / SUPABASE_SERVICE_KEY set. Unless DB_PATH is on a persistent disk, accounts and points are lost whenever this server restarts.');
}
const db = openDb(cfg.dbPath);
const backup = backupCfg ? new DbBackup(db, cfg.dbPath, backupCfg, log) : null;

const venues: Venue[] = allVenues();
if (cfg.sim) {
  venues.push(new SimVenue('sim', systemClock, simProfileFromDb(db)));
  log('simulated venue enabled');
}

// Email codes: a real mailer in production; outside production a console mailer that also
// returns the code to the browser so sign-in can be tried without an email provider.
const production = process.env.NODE_ENV === 'production';
const mailer: Mailer | null =
  cfg.resendApiKey && cfg.mailFrom ? new ResendMailer(cfg.resendApiKey, cfg.mailFrom) : production ? null : new ConsoleMailer(log);
const devEmailCodes = !production && !(cfg.resendApiKey && cfg.mailFrom);

const service = new FirstprintService(db, systemClock, venues, log);
const live = new LiveFeed(service);  // still serves the browser event stream; prices are only polled when not manual-only
const tracked = cfg.manualOnly ? [] : venues.filter((v) => cfg.trackVenues.includes(v.id));
const tracker = tracked.length ? new ListingTracker(service, tracked, { autoCreate: cfg.autoCreateMarkets }) : null;

// Settlement notifications are logged; plug in email or web push here.
const scheduler = new Scheduler(
  service,
  async (notes) => {
    for (const n of notes) log(`notify ${n.userId}: ${n.symbol} ${n.status} payout=${n.payout} refund=${n.refund}`);
  },
  { tickMs: cfg.tickMs, liveMs: cfg.liveMs, trackEveryMs: cfg.trackEveryMs, tracker, live: cfg.manualOnly ? null : live },
);

const server = createApiServer({
  service,
  scheduler,
  live,
  adminKey: cfg.adminKey,
  manualOnly: cfg.manualOnly,
  backupStatus: () => backup?.status() ?? { enabled: false, lastOkAt: null, lastError: null },
  googleClientId: cfg.googleClientId,
  mailer,
  devEmailCodes,
  secureCookies: cfg.secureCookies,
  publicUrl: cfg.publicUrl,
  solanaChain: cfg.solanaChain,
  webDir: fileURLToPath(new URL('../web', import.meta.url)),
});

server.listen(cfg.port, '0.0.0.0', () => {
  log(`Firstprint running at http://localhost:${cfg.port} (tracking: ${tracked.map((v) => v.id).join(', ') || 'none'})`);
  scheduler.start();
  backup?.start();
  if (backup) void backup.runOnce(true); // first copy right away, so a brand-new database is protected too
});

const shutdown = () => {
  log('shutting down');
  scheduler.stop();
  server.close(() => {
    // Last copy before the host stops us, so a restart doesn't lose the latest minute of activity.
    void (backup?.stop() ?? Promise.resolve()).finally(() => {
      db.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(0), 20_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
