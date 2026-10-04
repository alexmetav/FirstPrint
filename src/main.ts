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
import { resultEmail } from './services/notify.ts';
import { RewardsService } from './services/rewards.ts';
import { Telegram, marketLiveText, marketResultText, newListingText, resultDueText } from './services/telegram.ts';
import { rpcChain, rpcUrlFor, type Cluster } from './solana/testfpt.ts';

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
// Tasks, referrals and TestFPT claims. TestFPT lives on a Solana test network (testnet unless
// TOKEN_CLUSTER=devnet); an admin creates it from the admin panel, or sets TESTFPT_MINT and
// TESTFPT_AUTHORITY_KEY. Until then rewards go straight to players' balances.
const tokenCluster: Cluster = process.env.TOKEN_CLUSTER === 'devnet' ? 'devnet' : 'testnet';
const rewards = new RewardsService(
  service,
  {
    cluster: tokenCluster,
    chain: rpcChain(process.env.SOLANA_RPC_URL || rpcUrlFor(tokenCluster)),
    authoritySecret: process.env.TESTFPT_AUTHORITY_KEY || null,
    mint: process.env.TESTFPT_MINT || null,
  },
  cfg.publicUrl ?? 'https://www.firstprint.fun',
);
await rewards.init();
const live = new LiveFeed(service);  // still serves the browser event stream; prices are only polled when not manual-only
// Results are stored for the in-app bell by the service. Here they are logged and, where the player
// signed in with email and a real mailer is set up, sent as a short email.
const appUrl = `${(cfg.publicUrl ?? 'https://www.firstprint.fun').replace(/\/+$/, '')}/app/`;
const adminUrl = `${appUrl}#/admin`;

// Admin alerts on Telegram (TELEGRAM_BOT_TOKEN); the chat is linked from Admin → Settings.
const telegram = cfg.telegramBotToken
  ? new Telegram(cfg.telegramBotToken, { get: () => service.getSetting('telegram_chat_id'), set: (id) => service.setSetting('telegram_chat_id', id) })
  : null;
const alert = (text: string) => {
  telegram?.send(text).catch((err: Error) => log(`telegram failed: ${err.message}`));
};

// New markets and results go to the public channel players join (set in Admin → Settings).
service.onAnnounce = (kind, id) => {
  const channel = service.getSetting('telegram_channel');
  if (!telegram || !channel) return;
  const m = service.getMarket(id);
  if (!m.published) return;
  const text = kind === 'live' ? marketLiveText(m) : marketResultText(m);
  if (!text) return;
  const button = { text: kind === 'live' ? 'Predict now' : 'See the result', url: `${appUrl}#/market/${encodeURIComponent(id)}` };
  telegram.sendTo(`@${channel}`, text, button).catch((err: Error) => log(`telegram channel post failed: ${err.message}`));
};

// Manual-only servers still watch MEXC for new listings. By default each one waits in the admin's
// review queue (with a Telegram alert); AUTO_LISTINGS=publish opens self-settling markets instead,
// and AUTO_LISTINGS=0 turns it off. Admins can pause it in Settings. Otherwise the full scanner runs.
const autoListings = cfg.manualOnly ? cfg.autoListings : 'off';
const tracked = cfg.manualOnly ? (autoListings !== 'off' ? venues.filter((v) => v.id === 'mexc') : []) : venues.filter((v) => cfg.trackVenues.includes(v.id));
const tracker = !tracked.length
  ? null
  : autoListings === 'review'
    ? new ListingTracker(service, tracked, {
        autoCreate: false,
        review: true,
        enabled: () => service.autoListingsEnabled(),
        onNew: (found) => {
          for (const d of found) alert(newListingText(d, adminUrl, systemClock.now()));
        },
      })
    : autoListings === 'publish'
      ? new ListingTracker(service, tracked, {
          autoCreate: true,
          maxPerDay: cfg.autoMarketsPerDay,
          durationMs: cfg.autoMarketHours * 3_600_000,
          enabled: () => service.autoListingsEnabled(),
        })
      : new ListingTracker(service, tracked, { autoCreate: cfg.autoCreateMarkets });

const scheduler = new Scheduler(
  service,
  async (notes) => {
    for (const n of notes) {
      log(`notify ${n.userId}: ${n.symbol} ${n.status} payout=${n.payout} refund=${n.refund}`);
      const email = mailer instanceof ResendMailer ? service.getUser(n.userId).email : null;
      if (!email) continue;
      const mail = resultEmail(n, appUrl);
      mailer!.send(email, mail.subject, mail.text).catch((err: Error) => log(`result email failed for ${n.userId}: ${err.message}`));
    }
  },
  { tickMs: cfg.tickMs, liveMs: cfg.liveMs, trackEveryMs: cfg.trackEveryMs, tracker,
    live: cfg.manualOnly && autoListings !== 'publish' ? null : live,
    // Admin-run markets whose predictions just closed need a result (and maybe an opening price).
    onClosed: (ids) => {
      for (const id of ids) {
        const m = service.getMarket(id);
        if (m.mode === 'manual') alert(resultDueText(m, adminUrl));
      }
    },
  },
);

const server = createApiServer({
  service,
  scheduler,
  live,
  rewards,
  adminKey: cfg.adminKey,
  manualOnly: cfg.manualOnly,
  autoListings: autoListings === 'off' ? null : { mode: autoListings, perDay: cfg.autoMarketsPerDay, hours: cfg.autoMarketHours },
  telegram,
  trustProxyHops: cfg.trustProxyHops,
  backupStatus: () => backup?.status() ?? { enabled: false, lastOkAt: null, lastError: null },
  googleClientId: cfg.googleClientId,
  mailer,
  devEmailCodes,
  secureCookies: cfg.secureCookies,
  publicUrl: cfg.publicUrl,
  solanaChain: cfg.solanaChain,
  webDir: fileURLToPath(new URL('../web', import.meta.url)),
  // The landing page at /, the app at /app/. Set SITE=0 to serve only the app.
  siteDir: process.env.SITE === '0' ? null : fileURLToPath(new URL('../site', import.meta.url)),
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
  // Stop taking requests, and end open live-update streams: they never close on their own,
  // so waiting for them would let the host kill us before the final backup.
  server.close();
  server.closeAllConnections();
  // Last copy before the host stops us, so a restart doesn't lose the latest minute of activity.
  void (backup?.stop() ?? Promise.resolve()).finally(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 25_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
