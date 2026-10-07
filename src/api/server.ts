import { asAdmin } from '../exchanges/coingeckoGate.ts';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { AppError, DAILY_MAX, DAILY_POINTS, dailyStatus, LEADERBOARD_PERIODS, LIVE_PRESETS, MIN_STAKE, SESSION_MS, SUGGESTED_LIVE_TOKENS, type FirstprintService, type LeaderboardPeriod, type UserRow } from '../services/firstprint.ts';
import type { Scheduler } from '../workers/scheduler.ts';
import type { LiveFeed } from '../workers/liveFeed.ts';
import { cachedGoogleJwks, verifyGoogleIdToken, type JwksFetcher } from '../auth/google.ts';
import type { Mailer } from '../auth/mailer.ts';
import { codeEmail } from '../auth/emailHtml.ts';
import type { Bucket } from '../engine/engine.ts';
import { linkSiteToApp } from '../site/links.ts';
import { fetchImage, isPrivateAddress } from './fetchImage.ts';
import { isCloudflareAddress } from './cloudflare.ts';
import { isUpcoming, publicMarket, PUBLIC_FILTERS, type MarketView, type PublicFilter } from './publicApi.ts';
import { Discover } from '../services/discover.ts';
import { drawable, renderBanner, renderPnl } from '../services/banner.ts';
import { channelName, type Telegram } from '../services/telegram.ts';
import type { ChannelPoster } from '../services/channel.ts';
import { analytics } from '../services/analytics.ts';
import type { RewardsService, TaskInput } from '../services/rewards.ts';

/**
 * Who may use the admin console: the owner (the ADMIN_KEY, or ADMIN_EMAILS / ADMIN_WALLETS),
 * team admins (everything but the team), listing managers (tasks, plus reviewing, creating,
 * editing and publishing markets, but not results, refunds or settings), and tasks only.
 */
export type AdminLevel = 'owner' | 'admin' | 'listings' | 'tasks';
const LEVEL_RANK: Record<AdminLevel, number> = { tasks: 1, listings: 2, admin: 3, owner: 4 };

export interface ServerOptions {
  service: FirstprintService;
  /** Finds tokens for new markets (CoinGecko trending, new exchange listings). Made from the service if not given. */
  discover?: Discover;
  scheduler?: Scheduler;
  live?: LiveFeed;
  adminKey: string | null;
  /** Signed-in accounts that open the admin console without the key: by verified email or linked wallet. */
  adminEmails?: string[];
  adminWallets?: string[];
  /** How many proxies sit between visitors and this server (0 = none). Used to find the visitor's address for rate limits. */
  trustProxyHops?: number;
  /** Behind Cloudflare: take the visitor's address from CF-Connecting-IP (BEHIND_CLOUDFLARE=1). */
  behindCloudflare?: boolean;
  /** Google OAuth client ID (public). Enables "Continue with Google". */
  googleClientId?: string | null;
  /** Override for tests: where Google's signing keys come from. */
  googleJwks?: JwksFetcher;
  /** Sends sign-in codes. Without one, email sign-in is off. */
  mailer?: Mailer | null;
  /** Return the code in the API response (development only, when no real mailer is configured). */
  devEmailCodes?: boolean;
  /** Database backup health, shown in the admin panel. */
  backupStatus?: () => { enabled: boolean; lastOkAt: number | null; lastError: string | null; sizeBytes?: number | null };
  /** Takes a database copy now (maintenance mode turns on just before a deploy). */
  backupNow?: () => Promise<boolean>;
  /** New accounts allowed per network (IP) per day (NEW_ACCOUNTS_PER_DAY, default 10). Raise it for an event on shared Wi-Fi. */
  newAccountsPerDay?: number;
  /** Public API (/api/v1) calls a minute from everyone together (default 600). */
  publicApiPerMinute?: number;
  /** True when exchange auto-detection and live prices are off and admins run every market. */
  manualOnly?: boolean;
  /** New-listing checks (and the exchanges watched), when the server runs them. */
  autoListings?: { mode: 'review' | 'publish'; perDay: number; hours: number; venues: string[] } | null;
  /** Admin alerts on Telegram, when TELEGRAM_BOT_TOKEN is set. */
  telegram?: Telegram | null;
  /** Posts to the public player channel. */
  channel?: ChannelPoster | null;
  /** Tasks, referrals and TestFPT claims. */
  rewards?: RewardsService | null;
  /** Public site URL used in wallet sign-in messages, e.g. https://firstprint.xyz */
  publicUrl?: string | null;
  solanaChain?: 'mainnet' | 'devnet' | 'testnet';
  /** Send cookies with the Secure flag (enable behind HTTPS). */
  secureCookies: boolean;
  webDir: string;
  /**
   * The public website. When set, it is served at / and the app moves to /app/, so visitors meet the
   * landing page first and its "Launch app" buttons open the markets.
   */
  siteDir?: string | null;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Ctx {
  req: IncomingMessage;
  url: URL;
  params: Record<string, string>;
  res: ServerResponse;
  body: () => Promise<Record<string, unknown>>;
  user: () => UserRow;
  optionalUser: () => UserRow | null;
  /** Throws unless the request may use the admin console at this level (default: admin); returns the level. */
  requireAdmin: (min?: AdminLevel) => AdminLevel;
}

/**
 * No inline scripts and no third-party scripts except Google sign-in, so an injected tag can't run
 * (the admin key sits in sessionStorage). Inline styles stay allowed: the UI sets CSS variables in style="".
 * Images may come from any https host (exchange and token logos). Keep in step with vercel.json.
 */
/** How many markets per list a visitor who isn't signed in sees. */
export const GUEST_MARKETS = 12;

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://accounts.google.com/gsi/",
  'frame-src https://accounts.google.com/gsi/',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

export function createApiServer(opts: ServerOptions): Server {
  let googleJwks: JwksFetcher | undefined;
  const proxyHops = Math.max(0, Math.floor(opts.trustProxyHops ?? 0));

  /**
   * The visitor's address, for rate limits. Hosts put load balancers in front of this server, so the
   * connecting address is the balancer's, shared by every visitor. Each trusted proxy appends the address
   * it received the request from to X-Forwarded-For, so with N trusted proxies the visitor is the Nth entry
   * from the right. Entries further left can be forged by the visitor and are never used. If the header has
   * fewer entries than expected, fall back to the connecting address instead of trusting it.
   */
  function clientIp(req: IncomingMessage): string {
    const edge = proxiedIp(req);
    // Behind Cloudflare every request reaches the host from a Cloudflare address; the visitor's own
    // address is in CF-Connecting-IP. Without this, all visitors share one rate-limit bucket.
    // The header is believed only when the request really came from Cloudflare (or from the host's own
    // internal network, which can't be checked): someone calling the host directly with a made-up
    // header is counted by their own address instead.
    if (opts.behindCloudflare) {
      const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
      if (/^[0-9a-f:.]{3,45}$/i.test(cf) && (isCloudflareAddress(edge) || isPrivateAddress(edge))) return cf;
    }
    return edge;
  }

  /** The address that reached this host's proxies (or this server, with none): the visitor, or Cloudflare. */
  function proxiedIp(req: IncomingMessage): string {
    const direct = req.socket.remoteAddress ?? 'unknown';
    if (proxyHops === 0) return direct;
    const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return chain.length >= proxyHops ? chain[chain.length - proxyHops] : direct;
  }
  /**
   * The visitor's country (two letters) as Cloudflare reports it, believed only when the request
   * really came through Cloudflare (as for CF-Connecting-IP). Unknown (XX) and Tor (T1) count as none.
   */
  function countryOf(req: IncomingMessage): string | null {
    if (!opts.behindCloudflare) return null;
    const edge = proxiedIp(req);
    if (!isCloudflareAddress(edge) && !isPrivateAddress(edge)) return null;
    const c = String(req.headers['cf-ipcountry'] ?? '').trim().toUpperCase();
    return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
  }
  /** The rate-limit key for a visitor: their IPv4 address, or their IPv6 /64 (one home or server usually gets a whole /64). */
  const visitor = (req: IncomingMessage) => ipBucket(clientIp(req));
  const { service } = opts;
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)')) + '$',
    );
    routes.push({ method, pattern, keys, handler });
  };

  // --- Auth: HttpOnly session cookie, or Bearer token for API clients ----------

  const COOKIE = 'fp_session';

  const audit = (req: IncomingMessage, action: string, target: string | null = null, detail: string | null = null) =>
    service.logAdmin(action, target, detail, clientIp(req));

  function sessionToken(req: IncomingMessage): string {
    const auth = req.headers.authorization ?? '';
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const cookies = req.headers.cookie ?? '';
    for (const part of cookies.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) {
        try { return decodeURIComponent(v.join('=')); } catch { return ''; }
      }
    }
    return '';
  }

  function setSessionCookie(res: ServerResponse, token: string, maxAgeMs: number) {
    const attrs = [
      `${COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ];
    if (opts.secureCookies) attrs.push('Secure');
    res.setHeader('set-cookie', attrs.join('; '));
  }

  // --- Rate limiting (per user or IP, writes only) -----------------------------

  const hits = new Map<string, { count: number; reset: number }>();
  /**
   * Keeps the table bounded without wiping everyone's counters at once (which would let a flood of
   * new keys reset every limit): expired entries go first, then the oldest ones.
   */
  function pruneHits(now: number) {
    for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
    for (const k of hits.keys()) {
      if (hits.size <= 40_000) break;
      hits.delete(k);
    }
  }
  function rateLimit(key: string, limit = 30, windowMs = 10_000) {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 50_000) pruneHits(now);
      return;
    }
    if (++h.count > limit) throw new AppError(429, 'rate_limited', 'Too many requests. Try again in a few seconds.');
  }

  // New accounts per network per day. Each one starts with points (and TestFPT, paid by the server),
  // so a script making endless accounts could farm them; real players are never near this. Kept in
  // the database (a restart or deploy doesn't reset it); checked before signing in and counted only
  // when an account is made.
  const NEW_ACCOUNTS_PER_DAY = opts.newAccountsPerDay ?? 10;
  function checkNewAccount(req: IncomingMessage, isNew: boolean) {
    if (!isNew) return;
    if (service.newAccountsFrom(visitor(req)) >= NEW_ACCOUNTS_PER_DAY) {
      throw new AppError(429, 'too_many_accounts', 'Too many new accounts from this network today. Sign in to an existing account, or try again tomorrow.');
    }
  }
  function countNewAccount(req: IncomingMessage, created: boolean) {
    if (created) service.noteNewAccount(visitor(req));
  }
  const emailIsNew = (email: string) => !service.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.trim().toLowerCase());

  // --- Public routes -------------------------------------------------------------

  route('GET', '/api/health', () => {
    service.db.prepare('SELECT 1').get();
    return { ok: true, time: service.clock.now() };
  });

  route('GET', '/api/config', () => ({
    minStake: MIN_STAKE,
    dailyPoints: DAILY_POINTS,
    dailyMax: DAILY_MAX,
    solanaChain: opts.solanaChain ?? 'mainnet',
    // What the sign-in popup offers. Email codes need a mailer (or dev mode); Google needs a client ID.
    signIn: { google: opts.googleClientId ?? null, email: Boolean(opts.mailer) },
    // Markets are run from the admin panel, so exchange-detection pages have nothing to show.
    manualOnly: opts.manualOnly ?? false,
    // Points as TestFPT on a Solana test network (the faucet is for the admin's mint authority).
    rewards: opts.rewards ? { onChain: opts.rewards.ready(), cluster: opts.rewards.cluster(), faucetUrl: 'https://faucet.solana.com' } : null,
    // Public Telegram channel where new markets and results are posted (username, no @).
    telegramChannel: opts.telegram ? service.getSetting('telegram_channel') : null,
    maintenance: publicMaintenance(),
    // Exchange logos for the "listed on" badges (saved once from CoinGecko; missing ones show a letter).
    exchangeLogos: discover.exchangeLogos(),
  }));

  /** What players see during maintenance: on or off, and the admin's short note. */
  const publicMaintenance = () => {
    const m = service.maintenance();
    return m.on ? { on: true, message: m.message, since: m.since } : { on: false };
  };
  // Polled by open pages, so players move to the maintenance screen (and back) without reloading.
  route('GET', '/api/status', () => ({ maintenance: publicMaintenance() }));

  route('GET', '/api/admin/maintenance', ({ requireAdmin }) => {
    requireAdmin();
    return service.maintenance();
  });

  // On: players can't write and the workers pause, then a fresh copy of the database is taken, so a
  // deploy started after this loses nothing. Off: everything resumes and catches up.
  route('POST', '/api/admin/maintenance', async ({ req, body, requireAdmin }) => {
    requireAdmin();
    const b = await body();
    const on = b.on === true;
    const m = service.setMaintenance(on, String(b.message ?? ''));
    audit(req, on ? 'maintenance_on' : 'maintenance_off', null, m.message || null);
    let backedUp = false;
    if (on && opts.backupNow) {
      // Any TestFPT send in progress finishes first (one can take up to 30 seconds to confirm), so the
      // copy records it and the new server doesn't send it again. Then a moment for any other write
      // already in progress, then the copy (once more if one was mid-upload).
      const chainStopped = opts.rewards?.chainIdle() ?? Promise.resolve();
      await Promise.race([chainStopped, new Promise((r) => setTimeout(r, 45_000))]);
      await new Promise((r) => setTimeout(r, 1500));
      backedUp = (await opts.backupNow().catch(() => false)) || (await opts.backupNow().catch(() => false));
    }
    return { ...m, backedUp, backups: Boolean(opts.backupNow && opts.backupStatus?.().enabled) };
  });

  // --- Earn: rewards, tasks, referrals, TestFPT claims --------------------------------

  const rewardsOn = () => {
    if (!opts.rewards) throw new AppError(404, 'not_found', 'Rewards are not enabled.');
    return opts.rewards;
  };

  route('GET', '/api/me/rewards', ({ user }) => rewardsOn().summary(user().id));

  // The player's Firstprint wallet and every TestFPT transaction made for them, with explorer links.
  route('GET', '/api/me/chain', ({ user, url }) => rewardsOn().chainActivity(user().id, Number(url.searchParams.get('page') ?? 1)));

  route('POST', '/api/me/x', async ({ req, user, body }) => {
    rateLimit(`x:${visitor(req)}`, 10, 60_000);
    const b = await body();
    return rewardsOn().connectX(user().id, String(b.username ?? ''));
  });

  // Checks the player's code on X (each check is a paid GetXAPI call, so they're limited per player).
  route('POST', '/api/me/x/verify', async ({ user }) => {
    const u = user();
    rateLimit(`xcheck:${u.id}`, 15, 10 * 60_000);
    return rewardsOn().verifyX(u.id);
  });

  // The team makes the tasks, so its own accounts can't earn from them (they could otherwise add
  // tasks and complete them for unlimited points). Any email or wallet on the account counts here.
  const notTeam = (u: UserRow) => {
    const email = u.email?.toLowerCase() ?? null;
    const wallets = service.walletsFor(u.id).map((w) => w.address);
    const owner = (email && (opts.adminEmails ?? []).includes(email)) || wallets.some((w) => (opts.adminWallets ?? []).includes(w));
    if (owner || service.teamRoleFor(email, wallets)) {
      throw new AppError(403, 'team_no_tasks', 'Team accounts can’t complete tasks: they’re for players. Use a test top-up in the admin panel instead.');
    }
  };

  route('POST', '/api/tasks/:id/start', ({ user, params }) => {
    notTeam(user());
    return rewardsOn().startTask(user().id, params.id);
  });

  route('POST', '/api/tasks/:id/verify', ({ req, user, params }) => {
    rateLimit(`task:${visitor(req)}`, 20, 60_000);
    notTeam(user());
    // With X checks on, each confirm can be a paid call on X: limited per player too.
    if (rewardsOn().xcheck) rateLimit(`xcheck:${user().id}`, 15, 10 * 60_000);
    return rewardsOn().verifyTask(user().id, params.id);
  });

  route('POST', '/api/me/claims', async ({ req, user, body }) => {
    rateLimit(`claim:${visitor(req)}`, 10, 60_000);
    const b = await body();
    return rewardsOn().startClaim(user().id, String(b.wallet ?? ''));
  });

  route('POST', '/api/me/claims/:id/submit', async ({ user, params, body }) => {
    const b = await body();
    return rewardsOn().submitClaim(user().id, params.id, String(b.transaction ?? ''));
  });

  route('GET', '/api/me/claims/:id', ({ user, params }) => rewardsOn().refreshClaim(user().id, params.id));

  // --- Email code and Google sign-in -----------------------------------------------

  route('POST', '/api/auth/email/start', async ({ req, body }) => {
    if (!opts.mailer) throw new AppError(503, 'email_off', 'Email sign-in isn’t set up yet. Use Google or a wallet.');
    const b = await body();
    rateLimit(`emailcode:${visitor(req)}`, 10, 10 * 60_000);
    const email = String(b.email ?? '').trim().toLowerCase();
    rateLimit(`emailcode:${email}`, 5, 60 * 60_000);
    const { code, expiresAt } = service.startEmailLogin(email);
    try {
      const mail = codeEmail(code, siteOf(req));
      await opts.mailer.send(email, mail.subject, mail.text, mail.html);
    } catch (err) {
      service.log(`email send failed: ${(err as Error).message}`);
      throw new AppError(502, 'email_failed', 'We couldn’t send the email. Try again in a moment.');
    }
    return { ok: true, expiresAt, ...(opts.devEmailCodes ? { devCode: code } : {}) };
  });

  route('POST', '/api/auth/email/verify', async ({ req, res, body }) => {
    const b = await body();
    rateLimit(`emailverify:${visitor(req)}`, 20, 10 * 60_000);
    rateLimit(`emailverify:${String(b.email ?? '').trim().toLowerCase()}`, 10, 10 * 60_000);
    checkNewAccount(req, emailIsNew(String(b.email ?? '')));
    const { user, created } = service.verifyEmailCode(String(b.email ?? ''), String(b.code ?? ''), refOf(b));
    countNewAccount(req, created);
    service.noteCountry(user.id, countryOf(req));
    const session = service.createSession(user.id, 'email');
    setSessionCookie(res, session.token, SESSION_MS);
    return { user: publicUser(user, service.clock.now(), service.walletsFor(user.id)), created };
  });

  route('POST', '/api/auth/google', async ({ req, res, body }) => {
    if (!opts.googleClientId) throw new AppError(503, 'google_off', 'Google sign-in isn’t set up yet.');
    rateLimit(`google:${visitor(req)}`, 20, 10 * 60_000);
    const b = await body();
    const who = await verifyGoogleIdToken(String(b.credential ?? ''), opts.googleClientId, opts.googleJwks ?? (googleJwks ??= cachedGoogleJwks()));
    if (!who) throw new AppError(401, 'bad_google_token', 'Google sign-in failed. Try again.');
    checkNewAccount(req, emailIsNew(who.email));
    const { user, created } = service.signInWithVerifiedEmail(who.email, who.name, refOf(b));
    countNewAccount(req, created);
    service.noteCountry(user.id, countryOf(req));
    const session = service.createSession(user.id, 'google');
    setSessionCookie(res, session.token, SESSION_MS);
    return { user: publicUser(user, service.clock.now(), service.walletsFor(user.id)), created };
  });

  // --- Solana wallet sign-in -----------------------------------------------------

  function siteFor(req: IncomingMessage) {
    const url = opts.publicUrl ? new URL(opts.publicUrl) : new URL(`http://${req.headers.host ?? 'localhost'}`);
    // No chain ID in the sign-in message: wallets refuse it when it differs from their current network.
    return { domain: url.host, uri: url.origin };
  }

  route('GET', '/api/auth/wallet/challenge', ({ req, url }) => {
    rateLimit(`challenge:${visitor(req)}`, 20, 60_000);
    return service.walletChallenge(String(url.searchParams.get('address') ?? ''), siteFor(req));
  });

  route('POST', '/api/auth/wallet/verify', async ({ req, res, body }) => {
    rateLimit(`wallet:${visitor(req)}`, 20, 60_000);
    const b = await body();
    checkNewAccount(req, !service.db.prepare('SELECT 1 FROM wallets WHERE address = ?').get(String(b.address ?? '')));
    const { user, created } = service.walletSignIn({
      address: String(b.address ?? ''),
      message: String(b.message ?? ''),
      signature: String(b.signature ?? ''),
      walletName: b.walletName ? String(b.walletName).slice(0, 40) : undefined,
      ref: refOf(b),
    });
    countNewAccount(req, created);
    service.noteCountry(user.id, countryOf(req));
    const session = service.createSession(user.id, 'wallet');
    setSessionCookie(res, session.token, SESSION_MS);
    return { user: publicUser(user, service.clock.now(), service.walletsFor(user.id)), created };
  });

  route('POST', '/api/auth/login', async ({ req, res, body }) => {
    const b = await body();
    rateLimit(`login:${visitor(req)}`, 10, 60_000);
    rateLimit(`login:${String(b.email ?? '').toLowerCase()}`, 10, 10 * 60_000);
    const user = await service.authenticate(String(b.email ?? ''), String(b.password ?? ''));
    service.noteCountry(user.id, countryOf(req));
    const session = service.createSession(user.id, 'password');
    setSessionCookie(res, session.token, SESSION_MS);
    return { user: publicUser(user, service.clock.now(), service.walletsFor(user.id)) };
  });

  route('POST', '/api/auth/logout', ({ req, res }) => {
    const token = sessionToken(req);
    if (token) service.deleteSession(token);
    setSessionCookie(res, '', 0);
    return { ok: true };
  });

  route('GET', '/api/markets', ({ url, optionalUser }) => {
    const filter = (url.searchParams.get('filter') ?? 'all') as 'open' | 'live' | 'settled' | 'all';
    if (!['open', 'live', 'settled', 'all'].includes(filter)) throw new AppError(400, 'bad_filter', 'Unknown filter.');
    // Guests get a short list (a taste, and light on the server); signed-in players get them all.
    const me = optionalUser();
    const limit = me ? 200 : filter === 'settled' ? 6 : GUEST_MARKETS;
    const page = service.listMarketsPage(filter, me?.id, limit);
    return { markets: page.markets, total: page.total, limited: !me && page.total > page.markets.length, serverTime: service.clock.now() };
  });

  route('GET', '/api/markets/:id', ({ params, optionalUser }) => service.getMarket(params.id, optionalUser()?.id));

  route('GET', '/api/markets/:id/quote', ({ params, url }) =>
    service.quote(params.id, url.searchParams.get('bucket') as Bucket, Number(url.searchParams.get('stake'))),
  );

  route('GET', '/api/markets/:id/chart', ({ params }) => service.chart(params.id));

  route('GET', '/api/markets/:id/settlement', ({ params }) => service.settlement(params.id));

  route('GET', '/api/markets/:id/activity', ({ params }) => ({ activity: service.activity(params.id) }));

  route('GET', '/api/markets/:id/odds', ({ params }) => service.odds(params.id));

  route('GET', '/api/markets/:id/holders', ({ params }) => service.holders(params.id));

  // The public Listing radar. With admin-run markets the queue is the admin's to-do list, so nothing is shown.
  route('GET', '/api/listings/detected', ({ url }) => ({
    listings: opts.manualOnly ? [] : service.detections({ status: 'all', limit: boundedLimit(url.searchParams.get('limit')) }).filter((d) => d.status !== 'ignored'),
  }));

  route('GET', '/api/leaderboard', ({ url, optionalUser }) => {
    const p = url.searchParams.get('period') ?? 'week';
    const period = (LEADERBOARD_PERIODS as readonly string[]).includes(p) ? (p as LeaderboardPeriod) : 'week';
    return service.leaderboard(optionalUser()?.id, period);
  });

  // --- Public API (read-only, no key): markets, tokens coming up, the leaderboard. Docs: /api.html ----

  /**
   * Any site may call it from the browser; 60 calls a minute per visitor, and at most
   * PUBLIC_API_PER_MINUTE in all, so callers spread over many addresses can't load the server (the
   * app's own routes aren't counted). Answers may be cached for 15 seconds by Cloudflare or a browser.
   */
  const PUBLIC_API_PER_MINUTE = opts.publicApiPerMinute ?? 600;
  const publicCall = (req: IncomingMessage, res: ServerResponse) => {
    rateLimit(`pub:${visitor(req)}`, 60, 60_000);
    rateLimit('pub:all', PUBLIC_API_PER_MINUTE, 60_000);
    res.setHeader('access-control-allow-origin', '*');
    (res as Negotiated).publicMaxAge = 15;
  };
  const siteOf = (req: IncomingMessage) => (opts.publicUrl ?? `http://${req.headers.host ?? 'localhost'}`).replace(/\/+$/, '');
  const asPublic = (req: IncomingMessage, m: unknown) => publicMarket(m as MarketView, siteOf(req), service.clock.now());

  route('GET', '/api/v1', ({ req, res }) => {
    publicCall(req, res);
    const site = siteOf(req);
    return {
      name: 'Firstprint public API',
      version: 1,
      docs: `${site}/api.html`,
      endpoints: {
        markets: `${site}/api/v1/markets?status=open`,
        market: `${site}/api/v1/markets/{id}`,
        upcoming: `${site}/api/v1/upcoming`,
        leaderboard: `${site}/api/v1/leaderboard?period=week`,
      },
      note: 'Read-only, no key. Points have no cash value. 60 requests a minute per visitor.',
    };
  });

  route('GET', '/api/v1/markets', ({ req, res, url }) => {
    publicCall(req, res);
    const status = url.searchParams.get('status') ?? 'open';
    if (status !== 'all' && !(status in PUBLIC_FILTERS)) throw new AppError(400, 'bad_status', 'status must be open, closed, settled or all.');
    const limit = Math.max(1, Math.min(100, Math.floor(Number(url.searchParams.get('limit') ?? 50)) || 50));
    const filters = status === 'all' ? (Object.keys(PUBLIC_FILTERS) as PublicFilter[]) : [status as PublicFilter];
    const markets = filters.flatMap((f) => service.listMarketsPage(PUBLIC_FILTERS[f], undefined, limit).markets).slice(0, limit);
    return { status, count: markets.length, markets: markets.map((m) => asPublic(req, m)), serverTime: new Date(service.clock.now()).toISOString() };
  });

  route('GET', '/api/v1/markets/:id', ({ req, res, params }) => {
    publicCall(req, res);
    return asPublic(req, service.getMarket(params.id));
  });

  // Tokens that aren't trading yet: their market is open and the opening price will be the start.
  route('GET', '/api/v1/upcoming', ({ req, res }) => {
    publicCall(req, res);
    const now = service.clock.now();
    const markets = service
      .listMarketsPage('open', undefined, 200)
      .markets.filter((m) => isUpcoming(m as unknown as MarketView, now))
      .sort((a, b) => a.closeAt - b.closeAt);
    return { count: markets.length, markets: markets.map((m) => asPublic(req, m)), serverTime: new Date(now).toISOString() };
  });

  route('GET', '/api/v1/leaderboard', ({ req, res, url }) => {
    publicCall(req, res);
    const p = url.searchParams.get('period') ?? 'week';
    if (!(LEADERBOARD_PERIODS as readonly string[]).includes(p)) throw new AppError(400, 'bad_period', `period must be one of: ${LEADERBOARD_PERIODS.join(', ')}.`);
    const board = service.leaderboard(undefined, p as LeaderboardPeriod);
    return {
      period: board.period,
      seasonStart: board.seasonStart ? new Date(board.seasonStart).toISOString() : null,
      seasonEnd: board.seasonEnd ? new Date(board.seasonEnd).toISOString() : null,
      entries: board.entries.map(({ rank, name, profit, wins, total }) => ({ rank, username: name, profit, wins, predictions: total })),
    };
  });

  route('GET', '/api/users/:username', ({ params, optionalUser }) => service.publicProfile(params.username, optionalUser()?.id));

  // --- User routes ----------------------------------------------------------------

  route('GET', '/api/me', async ({ req, user }) => {
    const u = user();
    // Players who signed up before countries were recorded get theirs on their next visit.
    // (Neither while handing over to a new deploy: what's saved now would be lost.)
    if (!u.country && service.handingOff === null) service.noteCountry(u.id, countryOf(req));
    // Email and Google players get a Firstprint wallet the first time they come back (or sign up).
    if (opts.rewards && service.handingOff === null) await opts.rewards.ensureWallet(u.id).catch((err: Error) => service.log(`wallet for ${u.id} failed: ${err.message}`));
    const adminLevel = accountLevel(req, u);
    return { ...publicUser(u, service.clock.now(), service.walletsFor(u.id)), unreadNotifications: service.unreadNotifications(u.id), isAdmin: adminLevel !== null, adminLevel };
  });

  route('GET', '/api/me/notifications', ({ user }) => service.notificationsFor(user().id));

  route('POST', '/api/me/notifications/read', ({ user }) => service.markNotificationsRead(user().id));

  route('GET', '/api/me/wallets', ({ user }) => ({ wallets: service.walletsFor(user().id) }));

  route('POST', '/api/me/wallets', async ({ user, body }) => {
    const u = user();
    rateLimit(`link:${u.id}`, 10, 60_000);
    const b = await body();
    const wallets = service.linkWallet(u.id, {
      address: String(b.address ?? ''),
      message: String(b.message ?? ''),
      signature: String(b.signature ?? ''),
      walletName: b.walletName ? String(b.walletName).slice(0, 40) : undefined,
    });
    return { wallets };
  });

  route('POST', '/api/me/profile', async ({ user, body }) => {
    const u = user();
    const b = await body();
    const updated = service.setUsername(u.id, String(b.username ?? ''));
    return publicUser(updated, service.clock.now(), service.walletsFor(u.id));
  });

  // A page at a time (10 entries): long histories never load all at once.
  route('GET', '/api/me/ledger', ({ user, url }) => service.ledgerPage(user().id, Number(url.searchParams.get('page') ?? 1)));

  route('GET', '/api/me/predictions', ({ user }) => ({ predictions: service.myPredictions(user().id) }));

  route('GET', '/api/me/stats', ({ user }) => service.myStats(user().id));

  route('GET', '/api/me/daily', ({ user }) => service.dailyCalendar(user().id));

  route('POST', '/api/me/claim-daily', ({ user }) => {
    const u = user();
    rateLimit(`claim:${u.id}`, 5);
    return publicUser(service.claimDaily(u.id), service.clock.now(), service.walletsFor(u.id));
  });

  route('POST', '/api/markets/:id/predictions', async ({ params, body, user }) => {
    const u = user();
    rateLimit(`predict:${u.id}`);
    const b = await body();
    return service.placePrediction(params.id, u.id, b.bucket as Bucket, Number(b.stake));
  });

  // --- Admin routes -----------------------------------------------------------------

  route('POST', '/api/admin/markets', async ({ body, requireAdmin }) => {
    requireAdmin();
    const b = await body();
    const id = service.createMarket({
      symbol: String(b.symbol ?? ''),
      name: b.name as string | undefined,
      exchange: String(b.exchange ?? ''),
      venues: b.venues as { venue: string; symbol: string }[],
      sourceUrl: b.sourceUrl as string | undefined,
      announcedListingAt: toMs(b.announcedListingAt ?? b.listingAt),
      listingAt: toMs(b.listingAt),
      config: b.config as never,
      scorecard: b.scorecard as never,
    });
    return service.getMarket(id);
  });

  route('POST', '/api/admin/markets/:id/listing-time', async ({ params, body, requireAdmin }) => {
    requireAdmin();
    service.setListingTime(params.id, toMs((await body()).listingAt));
    return service.getMarket(params.id);
  });

  route('POST', '/api/admin/markets/:id/retract', ({ params, requireAdmin }) => {
    requireAdmin();
    service.retract(params.id);
    return { ok: true };
  });

  route('POST', '/api/admin/markets/:id/halt', async ({ params, body, requireAdmin }) => {
    requireAdmin();
    service.addHalt(params.id, Number((await body()).haltedMs));
    return { ok: true };
  });

  // --- Admin: manual markets (the admin panel runs the whole market lifecycle) ---------

  const manualBody = (b: Record<string, unknown>) => ({
    symbol: b.symbol as string,
    name: b.name as string | undefined,
    exchanges: Array.isArray(b.exchanges) ? b.exchanges.map(String) : (b.exchanges as never),
    pairs: b.pairs as Record<string, string> | undefined,
    // null (or empty) means "no price yet": the token isn't trading, and the opening price comes later.
    basePrice: b.basePrice === undefined ? (undefined as never) : b.basePrice === null || b.basePrice === '' ? null : Number(b.basePrice),
    // The start price is the live price when predictions close (basePrice is then ignored).
    startAtClose: b.startAtClose === undefined ? undefined : b.startAtClose === true,
    closeAt: b.closeAt === undefined ? (undefined as never) : toMs(b.closeAt),
    resultAt: b.resultAt === undefined || b.resultAt === '' ? undefined : toMs(b.resultAt),
    config: b.config as never,
    note: b.note as string | undefined,
    sourceUrl: b.sourceUrl as string | undefined,
    logoUrl: b.logoUrl as string | undefined,
    // When an upcoming token starts trading: the market then opens by itself (null stops that).
    autoOpenAt: b.autoOpenAt === undefined ? undefined : b.autoOpenAt === null || b.autoOpenAt === '' ? null : toMs(b.autoOpenAt),
  });

  route('GET', '/api/admin/exchanges', ({ requireAdmin }) => {
    requireAdmin();
    return { exchanges: service.exchangeSettings() };
  });

  route('POST', '/api/admin/exchanges/:id', async ({ req, params, body, requireAdmin }) => {
    requireAdmin();
    const enabled = Boolean((await body()).enabled);
    const exchanges = service.setExchangeEnabled(params.id, enabled);
    audit(req, enabled ? 'exchange_on' : 'exchange_off', params.id);
    return { exchanges };
  });

  route('POST', '/api/admin/auto-listings', async ({ req, body, requireAdmin }) => {
    requireAdmin();
    if (!opts.autoListings) throw new AppError(409, 'auto_listings_off', 'Automatic markets are turned off on this server (AUTO_LISTINGS=0).');
    const enabled = service.setAutoListings(Boolean((await body()).enabled));
    audit(req, enabled ? 'auto_listings_on' : 'auto_listings_off', null);
    return { enabled };
  });

  const telegramOn = () => {
    if (!opts.telegram) throw new AppError(409, 'telegram_off', 'Add TELEGRAM_BOT_TOKEN on the server first.');
    return opts.telegram;
  };

  route('POST', '/api/admin/telegram/connect', async ({ req, body, requireAdmin }) => {
    requireAdmin();
    const code = String((await body()).code ?? '').trim();
    if (!/^FP-\d{6}$/.test(code)) throw new AppError(400, 'bad_code', 'Use the code shown in Admin.');
    const t = telegramOn();
    let found: boolean;
    try {
      found = await t.connect(code);
    } catch (err) {
      throw new AppError(502, 'telegram_failed', (err as Error).message);
    }
    if (!found) throw new AppError(404, 'not_found', `No message with ${code} yet. Send it to your bot in Telegram, then try again.`);
    audit(req, 'telegram_connected', null);
    await t.send('✅ Firstprint alerts are connected. New listings and markets that need a result will show up here.').catch(() => {});
    return { connected: true };
  });

  route('POST', '/api/admin/telegram/test', async ({ requireAdmin }) => {
    requireAdmin();
    const t = telegramOn();
    if (!t.connected) throw new AppError(409, 'not_connected', 'Connect a chat first.');
    try {
      await t.send('🔔 Test alert from Firstprint. Alerts are working.');
    } catch (err) {
      throw new AppError(502, 'telegram_failed', (err as Error).message);
    }
    return { sent: true };
  });

  // The public channel players join. The bot must be an admin of it with "Post messages".
  route('POST', '/api/admin/telegram/channel', async ({ req, body, requireAdmin }) => {
    requireAdmin();
    const raw = String((await body()).channel ?? '').trim();
    if (!raw) {
      service.setSetting('telegram_channel', null);
      audit(req, 'telegram_channel_off', null);
      return { channel: null };
    }
    const name = channelName(raw);
    if (!name) throw new AppError(400, 'bad_channel', 'Enter the channel’s public username, like @firstprint_markets.');
    const t = telegramOn();
    try {
      await t.sendTo(`@${name}`, '👋 Firstprint is connected. New prediction markets and their results will be posted here.');
    } catch (err) {
      throw new AppError(502, 'telegram_failed', `Couldn’t post to @${name}. Add your bot to the channel as an admin who can post messages, then try again. (${(err as Error).message})`);
    }
    service.setSetting('telegram_channel', name);
    audit(req, 'telegram_channel_on', `@${name}`);
    return { channel: name };
  });

  const channelOn = () => {
    if (!opts.channel?.channel) throw new AppError(409, 'no_channel', 'Set the player channel in Settings first.');
    return opts.channel;
  };

  // Post one open market to the channel now (e.g. one made before the channel was set up).
  route('POST', '/api/admin/markets/:id/telegram', async ({ req, params, requireAdmin }) => {
    requireAdmin('listings');
    try {
      await channelOn().postLive(params.id);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(502, 'telegram_failed', (err as Error).message);
    }
    audit(req, 'telegram_posted', params.id);
    return { posted: true };
  });

  // Post every open market that hasn't been posted yet, a few seconds apart.
  route('POST', '/api/admin/telegram/post-open', async ({ req, body, requireAdmin }) => {
    requireAdmin();
    const count = channelOn().postAllOpen((await body()).again === true);
    audit(req, 'telegram_posted_open', null, String(count));
    return { count };
  });

  // One post with every open market: "12 markets live", soonest to close first.
  route('POST', '/api/admin/telegram/post-summary', async ({ req, requireAdmin }) => {
    requireAdmin('listings');
    let count: number;
    try {
      count = await channelOn().postSummary();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(502, 'telegram_failed', (err as Error).message);
    }
    audit(req, 'telegram_posted_summary', null, `${count} markets`);
    return { count };
  });

  route('POST', '/api/admin/telegram/disconnect', async ({ req, requireAdmin }) => {
    requireAdmin();
    telegramOn().setChat(null);
    audit(req, 'telegram_disconnected', null);
    return { connected: false };
  });

  // --- Analytics: for the admin, and read-only for partners through a secret link ---------------

  route('GET', '/api/admin/analytics', ({ url, requireAdmin }) => {
    requireAdmin();
    const data = analytics(service.db, service.clock.now(), Number(url.searchParams.get('days') ?? 30));
    return { ...data, chain: opts.rewards?.chainInfo() ?? null, shareKey: service.getSetting('analytics_share_key') };
  });

  // Create a new partner link (any old link stops working) or turn sharing off.
  route('POST', '/api/admin/analytics/share', async ({ req, body, requireAdmin }) => {
    requireAdmin();
    const on = (await body()).enabled !== false;
    const key = on ? randomBytes(18).toString('base64url') : null;
    service.setSetting('analytics_share_key', key);
    audit(req, on ? 'analytics_shared' : 'analytics_unshared', null);
    return { shareKey: key };
  });

  // Partners see numbers at most a minute old; computing them for every page view isn't needed.
  const statsCache = new Map<number, { at: number; data: ReturnType<typeof analytics> & { chain: unknown } }>();
  route('GET', '/api/public/analytics', ({ req, url }) => {
    rateLimit(`stats:${visitor(req)}`, 30, 60_000);
    const key = service.getSetting('analytics_share_key');
    const given = url.searchParams.get('key') ?? '';
    const digest = (s: string) => createHash('sha256').update(s).digest();
    if (!key || !timingSafeEqual(digest(key), digest(given))) throw new AppError(404, 'not_found', 'This stats link is no longer active. Ask Firstprint for a new one.');
    const days = [7, 30, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 30;
    const now = service.clock.now();
    const hit = statsCache.get(days);
    if (hit && now - hit.at < 60_000) return hit.data;
    const data = { ...analytics(service.db, now, days), chain: opts.rewards?.chainInfo() ?? null };
    statsCache.set(days, { at: now, data });
    return data;
  });

  route('POST', '/api/admin/manual-markets', async ({ req, body, requireAdmin }) => {
    requireAdmin('listings');
    const b = await body();
    const id = service.createManualMarket({ ...manualBody(b), publish: b.publish === true });
    // The banner logo is stored before the channel post (queued for after this request) reads it.
    if (typeof b.logoPng === 'string' && b.logoPng) service.setLogoPng(id, b.logoPng);
    // Made from a listing in the review queue: take it off the queue.
    if (Number.isInteger(b.detectionId)) service.linkDetection(b.detectionId as number, id);
    audit(req, b.publish === true ? 'market_published' : b.autoOpenAt ? 'market_scheduled' : 'market_drafted', id, `${String(b.symbol ?? '').toUpperCase()} start price ${b.basePrice}`);
    return service.getMarket(id, undefined, true);
  });

  route('POST', '/api/admin/manual-markets/:id', async ({ req, params, body, requireAdmin }) => {
    requireAdmin('listings');
    const b = await body();
    const patch = Object.fromEntries(Object.entries(manualBody(b)).filter(([, v]) => v !== undefined));
    service.updateManualMarket(params.id, patch);
    if (typeof b.logoPng === 'string' && b.logoPng) service.setLogoPng(params.id, b.logoPng);
    audit(req, 'market_edited', params.id, Object.keys(patch).join(', '));
    return service.getMarket(params.id, undefined, true);
  });

  // The Telegram banner a market would get, drawn from the form before it is saved, so the admin
  // sees exactly what players will see (right logo, right ticker) before publishing.
  route('POST', '/api/admin/banner-preview', async ({ req, body, requireAdmin }) => {
    requireAdmin('listings');
    rateLimit(`banner:${visitor(req)}`, 60, 60_000);
    const b = await body();
    const symbol = String(b.symbol ?? '').trim().toUpperCase();
    if (!symbol) throw new AppError(400, 'bad_symbol', 'Enter the token symbol first.');
    const names = new Map(service.venueList().map((v) => [v.id, v.name]));
    const exchanges = (Array.isArray(b.exchanges) ? b.exchanges : []).map((id: unknown) => names.get(String(id))).filter(Boolean) as string[];
    const logoPng = typeof b.logoPng === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.logoPng) && b.logoPng.length < 300_000 ? b.logoPng : null;
    if (!service.tokenBannersEnabled()) return { png: null, reason: 'Token banners are off (Settings → Player channel), so this market is posted with the fixed banner.' };
    if (!drawable(symbol)) return { png: null, reason: `The banner font can’t draw “${symbol}”, so this market is posted with the fixed banner instead.` };
    const basePrice = b.basePrice === null || b.basePrice === '' || b.basePrice === undefined ? null : Number(b.basePrice);
    const png = renderBanner(
      'live',
      {
        symbol,
        name: String(b.name ?? '').trim().slice(0, 60) || null,
        exchange: exchanges.join(', ') || 'MEXC',
        outcomes: b.outcomes === 'binary' ? 'binary' : 'ladder',
        basePrice: b.startAtClose !== true && basePrice !== null && Number.isFinite(basePrice) && basePrice > 0 ? basePrice : null,
        startAtClose: b.startAtClose === true,
        closeAt: Number(b.closeAt) || Date.now(),
        settleAt: Number(b.resultAt) || Date.now(),
      },
      logoPng,
    );
    return { png: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, reason: logoPng ? null : 'No logo yet: the banner shows the first letter instead.' };
  });

  route('POST', '/api/admin/telegram/token-banners', async ({ req, body, requireAdmin }) => {
    requireAdmin();
    const enabled = service.setTokenBanners(Boolean((await body()).enabled));
    audit(req, enabled ? 'telegram_token_banners_on' : 'telegram_token_banners_off', null);
    return { enabled };
  });

  // PNG copy of a market's logo for its Telegram banners (the admin page makes it in the browser).
  route('POST', '/api/admin/markets/:id/logo-png', async ({ params, body, requireAdmin }) => {
    requireAdmin('listings');
    service.setLogoPng(params.id, String((await body()).logoPng ?? ''));
    return { ok: true };
  });

  route('POST', '/api/admin/manual-markets/:id/start-price', async ({ req, params, body, requireAdmin }) => {
    requireAdmin();
    const price = Number((await body()).basePrice);
    service.setStartPrice(params.id, price);
    audit(req, 'market_start_price', params.id, String(price));
    return service.getMarket(params.id, undefined, true);
  });

  route('POST', '/api/admin/manual-markets/:id/publish', ({ req, params, requireAdmin }) => {
    requireAdmin('listings');
    service.publishMarket(params.id);
    audit(req, 'market_published', params.id);
    return service.getMarket(params.id, undefined, true);
  });

  // A fixed start price becomes the price when predictions close (only while nobody has predicted).
  route('POST', '/api/admin/manual-markets/:id/close-start', ({ req, params, requireAdmin }) => {
    requireAdmin('listings');
    service.useCloseStart(params.id);
    audit(req, 'start_price_at_close', params.id);
    return service.getMarket(params.id, undefined, true);
  });

  // Closes predictions now (or in up to 72 hours), keeping the result date.
  route('POST', '/api/admin/manual-markets/:id/close', async ({ req, params, body, requireAdmin }) => {
    requireAdmin('listings');
    const hours = Number((await body()).inHours ?? 0);
    service.closePredictions(params.id, Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 0);
    audit(req, 'predictions_closed', params.id, hours > 0 ? `in ${hours}h` : 'now');
    return service.getMarket(params.id, undefined, true);
  });

  route('POST', '/api/admin/manual-markets/:id/unpublish', ({ req, params, requireAdmin }) => {
    requireAdmin('listings');
    service.unpublishMarket(params.id);
    audit(req, 'market_unpublished', params.id);
    return service.getMarket(params.id, undefined, true);
  });

  route('POST', '/api/admin/manual-markets/:id/delete', ({ req, params, requireAdmin }) => {
    requireAdmin('listings');
    service.deleteDraft(params.id);
    audit(req, 'draft_deleted', params.id);
    return { ok: true };
  });

  // Removes a test or cancelled market for good (admins only; drafts use the route above).
  route('POST', '/api/admin/markets/:id/delete', ({ req, params, requireAdmin }) => {
    requireAdmin();
    const symbol = service.getMarket(params.id, undefined, true).symbol;
    service.deleteMarket(params.id);
    audit(req, 'market_deleted', params.id, symbol);
    return { ok: true };
  });

  const resolveBody = (b: Record<string, unknown>) => ({
    finalPrice: Number(b.finalPrice),
    basePrice: b.basePrice === undefined || b.basePrice === '' || b.basePrice === null ? undefined : Number(b.basePrice),
    winningBucket: (b.winningBucket || undefined) as Bucket | undefined,
    note: b.note as string | undefined,
  });

  route('POST', '/api/admin/manual-markets/:id/preview', async ({ params, body, requireAdmin }) => {
    requireAdmin();
    return service.previewResolution(params.id, resolveBody(await body()));
  });

  route('POST', '/api/admin/manual-markets/:id/resolve', async ({ req, params, body, requireAdmin }) => {
    requireAdmin();
    const out = service.resolveManualMarket(params.id, resolveBody(await body()));
    audit(
      req,
      out.summary.voidReason ? 'market_voided' : 'result_posted',
      params.id,
      `final ${out.summary.finalPrice}, ${out.summary.voidReason ?? `${out.summary.winningBucket} wins${out.summary.overridden ? ' (overridden)' : ''}`}, pool ${out.summary.pool}, paid ${out.summary.totalPaid} to ${out.summary.winnerCount}`,
    );
    await opts.scheduler?.notify(out.notes);
    return out.summary;
  });

  route('GET', '/api/admin/detected', ({ url, requireAdmin }) => {
    requireAdmin('listings');
    const status = (url.searchParams.get('status') ?? 'pending') as 'pending' | 'approved' | 'ignored' | 'all';
    return { detected: service.detections({ status, limit: 200 }) };
  });

  route('POST', '/api/admin/detected/:id/approve', async ({ params, body, requireAdmin }) => {
    requireAdmin('listings');
    const b = await body();
    const marketId = service.approveDetection(Number(params.id), {
      symbol: b.symbol as string | undefined,
      name: b.name as string | undefined,
      listingAt: b.listingAt === undefined ? undefined : toMs(b.listingAt),
      config: b.config as never,
    });
    return service.getMarket(marketId);
  });

  route('POST', '/api/admin/detected/ignore-all', ({ requireAdmin }) => {
    requireAdmin('listings');
    return { skipped: service.ignoreAllDetections() };
  });

  route('POST', '/api/admin/detected/:id/ignore', ({ params, requireAdmin }) => {
    requireAdmin('listings');
    service.ignoreDetection(Number(params.id));
    return { ok: true };
  });

  route('POST', '/api/admin/track', async ({ requireAdmin }) => {
    requireAdmin();
    await opts.scheduler?.track();
    return { detected: service.detections({ status: 'pending', limit: 200 }) };
  });

  route('GET', '/api/admin/ping', ({ requireAdmin }) => {
    const level = requireAdmin('tasks');
    // Tasks-only team members get just what the Tasks page needs.
    if (level === 'tasks') return { ok: true, level, manualOnly: opts.manualOnly ?? false };
    return {
      ok: true,
      level,
      venues: service.venueList(),
      exchanges: service.exchangeSettings(),
      manualOnly: opts.manualOnly ?? false,
      autoListings: opts.autoListings
        ? {
            ...opts.autoListings,
            enabled: service.autoListingsEnabled(),
            // Exchanges actually checked now: watched by this server and not switched off in Settings.
            exchanges: service.exchangeSettings().filter((e) => e.enabled && opts.autoListings!.venues.includes(e.id)).map((e) => e.name),
          }
        : null,
      telegram: {
        configured: Boolean(opts.telegram),
        connected: Boolean(opts.telegram?.connected),
        channel: service.getSetting('telegram_channel'),
        unposted: service.unannouncedOpenMarkets().length,
        open: service.channelMarkets().length,
        tokenBanners: service.tokenBannersEnabled(),
      },
      backup: opts.backupStatus?.() ?? { enabled: false, lastOkAt: null, lastError: null },
      presets: Object.entries(LIVE_PRESETS).map(([id, p]) => ({ id, label: p.label })),
      suggestedTokens: SUGGESTED_LIVE_TOKENS,
    };
  });

  // --- Admin: TestFPT token and tasks ---------------------------------------------

  route('GET', '/api/admin/token', async ({ requireAdmin }) => {
    const level = requireAdmin();
    if (!opts.rewards) return { enabled: false };
    const status = await opts.rewards.tokenStatus();
    // The mint authority's secret key is shown to the owner only (to copy into Render).
    return level === 'owner' ? status : { ...status, authorityKey: null, authorityKeyHidden: Boolean(status.authorityKey) };
  });

  // Setting up the token creates and shows the mint authority's key: the owner only.
  route('POST', '/api/admin/token/:step', async ({ req, params, requireAdmin }) => {
    requireAdmin('owner');
    const r = rewardsOn();
    if (params.step === 'authority') return r.setupAuthority();
    if (params.step === 'airdrop') return r.airdropAuthority();
    if (params.step === 'create') {
      const out = await r.createMint();
      audit(req, 'testfpt_created', out.enabled ? out.mint : null);
      return out;
    }
    throw new AppError(404, 'not_found', 'Unknown step.');
  });

  route('GET', '/api/admin/tasks', async ({ requireAdmin }) => {
    requireAdmin('tasks');
    const r = rewardsOn();
    return { tasks: r.listTasksAdmin(), xChecks: Boolean(r.xcheck), xCredit: await r.xCredit(), xConnect: r.xConnectAdmin() };
  });

  // A task opened to everyone again (a fresh copy, no limit; the old one is switched off).
  route('POST', '/api/admin/tasks/:id/reset', async ({ req, params, body, requireAdmin }) => {
    requireAdmin();
    const b = await body();
    const out = rewardsOn().resetTask(params.id, b.points === undefined ? undefined : Number(b.points));
    audit(req, 'task_reset', params.id, `-> ${out.id}, ${out.points} pts`);
    return out;
  });

  // Connect X: a new round for everyone (all X links cleared, the reward can be earned again).
  route('POST', '/api/admin/x-connect/reset', async ({ req, body, requireAdmin }) => {
    requireAdmin();
    const out = rewardsOn().resetXConnect(Number((await body()).points));
    audit(req, 'x_connect_reset', String(out.round), `${out.points} pts, ${out.cleared} unlinked`);
    return out;
  });

  // A tasks-only team member can add tasks worth up to TEAM_TASK_MAX points; bigger ones need an admin.
  const TEAM_TASK_MAX = 500;
  const capTask = (level: string, b: Record<string, unknown>) => {
    if (level === 'tasks' && b.points !== undefined && Number(b.points) > TEAM_TASK_MAX) {
      throw new AppError(403, 'not_allowed', `Your team role can add tasks worth up to ${TEAM_TASK_MAX} points. Ask an admin for more.`);
    }
  };

  route('GET', '/api/admin/top-up', ({ requireAdmin, optionalUser }) => {
    requireAdmin();
    const me = optionalUser();
    return me ? rewardsOn().adminTopUpStatus(me.id) : null;
  });

  // Extra test points for the admin's own signed-in account (testing tasks and markets).
  route('POST', '/api/admin/top-up', async ({ req, body, requireAdmin, optionalUser }) => {
    requireAdmin();
    const me = optionalUser();
    if (!me) throw new AppError(409, 'sign_in_first', 'Sign in to the app on this browser first, so we know which account gets the points.');
    const out = rewardsOn().adminTopUp(me.id, Number((await body()).amount));
    audit(req, 'admin_topup', me.id, `${out.points} pts`);
    return out;
  });

  route('POST', '/api/admin/tasks', async ({ req, body, requireAdmin }) => {
    const level = requireAdmin('tasks');
    const b = await body();
    capTask(level, b);
    const id = rewardsOn().createTask(taskInput(b) as TaskInput);
    audit(req, 'task_created', id, `${b.kind} ${b.points} pts`);
    return { id };
  });

  route('POST', '/api/admin/tasks/:id', async ({ req, params, body, requireAdmin }) => {
    const level = requireAdmin('tasks');
    const b = await body();
    capTask(level, b);
    rewardsOn().updateTask(params.id, taskInput(b));
    audit(req, 'task_updated', params.id, JSON.stringify(b).slice(0, 200));
    return { ok: true };
  });

  // Settings → Team: the owner gives people admin or tasks-only access by email or wallet.
  route('GET', '/api/admin/team', ({ requireAdmin }) => {
    requireAdmin('owner');
    return { team: service.teamList() };
  });

  route('POST', '/api/admin/team', async ({ req, body, requireAdmin }) => {
    requireAdmin('owner');
    const b = await body();
    const team = service.teamAdd({ value: String(b.value ?? ''), role: String(b.role ?? '') });
    audit(req, 'team_member_added', null, `${String(b.value ?? '').trim().slice(0, 80)} as ${b.role}`);
    return { team };
  });

  route('POST', '/api/admin/team/:id/remove', async ({ req, params, requireAdmin }) => {
    requireAdmin('owner');
    const gone = service.teamList().find((m) => m.id === Number(params.id));
    const team = service.teamRemove(Number(params.id));
    audit(req, 'team_member_removed', null, gone ? gone.value : params.id);
    return { team };
  });

  route('GET', '/api/admin/log', ({ requireAdmin }) => {
    requireAdmin('listings');
    return { log: service.adminLog(40) };
  });

  route('GET', '/api/admin/markets', ({ requireAdmin }) => {
    requireAdmin('listings');
    return { markets: service.adminMarkets() };
  });

  route('POST', '/api/admin/live-markets', async ({ body, requireAdmin }) => {
    requireAdmin();
    const b = await body();
    return service.createLiveMarket({
      symbol: String(b.symbol ?? ''),
      name: b.name ? String(b.name) : undefined,
      exchanges: Array.isArray(b.exchanges) ? b.exchanges.map(String) : undefined,
      startsInMs: b.startsInMinutes === undefined ? undefined : Number(b.startsInMinutes) * 60_000,
      preset: b.preset ? String(b.preset) : undefined,
    });
  });

  route('POST', '/api/admin/markets/:id/cancel', ({ req, params, requireAdmin }) => {
    requireAdmin();
    const out = service.cancelMarket(params.id);
    audit(req, 'market_cancelled', params.id, `${out.refunded} predictions refunded`);
    return out;
  });

  // Live prices for the market form ("Check live price") and warnings for every open market.
  route('POST', '/api/admin/price-check', async ({ body, requireAdmin }) => {
    requireAdmin('listings');
    const b = await body();
    const pairs = Object.fromEntries(Object.entries((b.pairs as Record<string, unknown>) ?? {}).filter(([, v]) => typeof v === 'string' && /^[a-z0-9_-]{1,100}$/i.test(v))) as Record<string, string>;
    return { prices: await service.exchangePrices(String(b.symbol ?? ''), Array.isArray(b.exchanges) ? b.exchanges.map(String) : [], pairs) };
  });

  route('GET', '/api/admin/market-checks', async ({ requireAdmin }) => {
    requireAdmin('listings');
    return { checks: await service.marketChecks() };
  });

  // Copies a logo from a link so the market keeps its own copy (links break when sites change).
  route('GET', '/api/admin/fetch-image', async ({ req, url, requireAdmin }) => {
    requireAdmin('listings');
    rateLimit(`img:${visitor(req)}`, 30, 60_000);
    return fetchImage(url.searchParams.get('url') ?? '');
  });

  // Finding tokens to list: what is trending on CoinGecko, and what just listed on an exchange.
  const discover = opts.discover ?? new Discover(service);
  route('GET', '/api/admin/discover/trending', async ({ req, requireAdmin }) => {
    requireAdmin('listings');
    rateLimit(`discover:${visitor(req)}`, 20, 60_000);
    return discover.trending();
  });

  // A token's logo, found on CoinGecko by its ticker (and name), for markets made from new listings.
  route('GET', '/api/admin/discover/logo', async ({ req, url, requireAdmin }) => {
    requireAdmin('listings');
    rateLimit(`discover-logo:${visitor(req)}`, 30, 60_000);
    return { logo: await discover.tokenLogo(url.searchParams.get('symbol') ?? '', url.searchParams.get('name') ?? '') };
  });

  route('GET', '/api/admin/discover/exchange', async ({ req, url, requireAdmin }) => {
    requireAdmin('listings');
    rateLimit(`discover:${visitor(req)}`, 20, 60_000);
    return discover.exchangeListings(url.searchParams.get('venue') ?? '');
  });

  route('GET', '/api/admin/exchanges/check', async ({ requireAdmin }) => {
    requireAdmin();
    return { results: await service.checkExchanges() };
  });

  route('POST', '/api/admin/tick', async ({ requireAdmin }) => {
    requireAdmin();
    await opts.scheduler?.tick();
    return { ok: true };
  });

  // --- Server ------------------------------------------------------------------------

  const webRoot = resolve(opts.webDir);
  const siteRoot = opts.siteDir ? resolve(opts.siteDir) : null;
  const APP_PREFIX = '/app';
  /** Website files that link to the app; their /play/ links are pointed at /app/. */
  const LINKED_SITE_FILES = new Set(['index.html', join('assets', 'site.js'), 'pitch.html', 'whitepaper.html', 'tokenomics.html']);

  /**
   * Static files, read and compressed once per version of the file. Compressing the 300 KB app script on
   * every visit would hold up the single server thread that also answers the API.
   */
  const staticCache = new Map<string, { mtimeMs: number; size: number; type: string; raw: Buffer; gz: Buffer | null; etag: string }>();

  /** A short hash of a file's content, remembered until the file changes. */
  const fingerprints = new Map<string, { mtimeMs: number; v: string }>();
  function fingerprint(path: string): string | null {
    try {
      const st = statSync(path);
      const hit = fingerprints.get(path);
      if (hit && hit.mtimeMs === st.mtimeMs) return hit.v;
      const v = createHash('sha1').update(readFileSync(path)).digest('base64url').slice(0, 10);
      fingerprints.set(path, { mtimeMs: st.mtimeMs, v });
      return v;
    } catch {
      return null;
    }
  }
  /** Adds ?v=<fingerprint> to every "./name.js" or "./name.css" that exists next to the file. */
  function fingerprintRefs(text: string, dir: string) {
    return text.replace(/(["'])\.\/([\w.-]+\.(?:js|css))\1/g, (whole, q: string, name: string) => {
      const v = fingerprint(join(dir, name));
      return v ? `${q}./${name}?v=${v}${q}` : whole;
    });
  }

  async function serveStatic(res: ServerResponse, root: string, pathname: string, linkToApp = false) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(root)) return send(res, 404, { error: 'not_found', message: 'Not found.' });
    let missing = false;
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      // Clean page addresses (/pitch → pitch.html), then the SPA fallback.
      const page = extname(file) ? null : `${file}.html`;
      if (page && (await stat(page).then((s) => s.isFile(), () => false))) file = page;
      else {
        file = join(root, 'index.html');
        missing = true;
      }
    }
    try {
      const st = await stat(file);
      const key = `${linkToApp ? 'site' : 'app'}:${file}`;
      let hit = staticCache.get(key);
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        let data = await readFile(file);
        if (linkToApp && LINKED_SITE_FILES.has(file.slice(root.length + 1))) {
          data = Buffer.from(linkSiteToApp(data.toString('utf8'), APP_PREFIX, file));
        }
        // The app's page and modules name each other with a fingerprint of the file (app.js?v=…), so a
        // deploy changes every address that changed and no browser keeps running an old script.
        if (!linkToApp && ['.html', '.js'].includes(extname(file))) data = Buffer.from(fingerprintRefs(data.toString('utf8'), dirname(file)));
        const type = MIME[extname(file)] ?? 'application/octet-stream';
        hit = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          type,
          raw: data,
          gz: ZIPPABLE.test(type) && data.length >= 1400 ? gzipSync(data, { level: 9 }) : null,
          etag: `W/"${createHash('sha1').update(data).digest('base64url').slice(0, 22)}"`,
        };
        staticCache.set(key, hit);
      }
      // The app routes in the browser, so any path is its page; on the website an unknown address is
      // a 404 (still showing the landing page) so search engines don't index it.
      const status = missing && linkToApp ? 404 : 200;
      const headers: Record<string, string> = {
        'content-type': hit.type,
        // Pages, scripts and styles are checked on every load (a cheap 304 when unchanged), so after a
        // deploy no browser or CDN mixes a new script with an old stylesheet. Images may wait 5 minutes.
        'cache-control': ['.html', '.js', '.css'].includes(extname(file)) ? 'no-cache' : 'public, max-age=300',
        // Cloudflare (in front of the site) must never keep its own copy of pages, scripts or styles:
        // it once kept serving the old app after a deploy until its cache was purged by hand.
        // Browsers still revalidate them with the ETag, so this costs nothing.
        ...(['.html', '.js', '.css'].includes(extname(file)) ? { 'cloudflare-cdn-cache-control': 'no-store' } : {}),
        etag: hit.etag,
        vary: 'accept-encoding',
      };
      const r = res as Negotiated;
      // A returning visitor's browser asks "still this version?" and gets a few bytes back instead of the file.
      if (status === 200 && r.ifNoneMatch && sameEtag(r.ifNoneMatch, hit.etag)) {
        res.writeHead(304, headers);
        return res.end();
      }
      const zip = r.gzipOk ? hit.gz : null;
      res.writeHead(status, zip ? { ...headers, 'content-encoding': 'gzip' } : headers);
      res.end(zip ?? hit.raw);
    } catch {
      send(res, 404, { error: 'not_found', message: 'Not found.' });
    }
  }

  /** Website at /, app at /app/ when there is a website; otherwise the app everywhere. */
  function servePage(res: ServerResponse, url: URL) {
    const path = url.pathname;
    if (!siteRoot) return serveStatic(res, webRoot, path);
    if (path === APP_PREFIX || path === '/play' || path.startsWith('/play/')) {
      res.writeHead(301, { location: `${APP_PREFIX}/${url.search}` });
      return res.end();
    }
    if (path.startsWith(`${APP_PREFIX}/`)) return serveStatic(res, webRoot, path.slice(APP_PREFIX.length));
    return serveStatic(res, siteRoot, path, true);
  }

  // --- Live updates (Server-Sent Events) -------------------------------------------

  /** Open live-update streams per visitor, so one client can't use up every connection. */
  const streamsByVisitor = new Map<string, number>();
  const MAX_STREAMS_PER_VISITOR = 8;

  function openStream(req: IncomingMessage, res: ServerResponse) {
    if (!opts.live) return send(res, 404, { error: 'not_found', message: 'Live updates are not enabled.' });
    if (opts.live.connections >= 5_000) return send(res, 503, { error: 'busy', message: 'Too many live connections. Try again soon.' });
    const who = visitor(req);
    const open = streamsByVisitor.get(who) ?? 0;
    if (open >= MAX_STREAMS_PER_VISITOR) return send(res, 429, { error: 'rate_limited', message: 'Too many live connections from your network. Close some tabs and try again.' });
    streamsByVisitor.set(who, open + 1);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ serverTime: service.clock.now() })}\n\n`);
    const unsubscribe = opts.live.subscribe((event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      const left = (streamsByVisitor.get(who) ?? 1) - 1;
      if (left > 0) streamsByVisitor.set(who, left);
      else streamsByVisitor.delete(who);
    });
  }

  /**
   * The admin level of the signed-in account, or null. An email counts only when this session
   * signed in with an email code or Google, which prove the address (password sign-ins never do);
   * a wallet counts when linked to the account (proved by signing). ADMIN_EMAILS / ADMIN_WALLETS
   * are the owner; Settings → Team gives others admin or tasks-only access.
   */
  function accountLevel(req: IncomingMessage, u: UserRow | null): AdminLevel | null {
    if (!u) return null;
    const via = service.sessionVia(sessionToken(req));
    const email = u.email && (via === 'email' || via === 'google') ? u.email.toLowerCase() : null;
    const wallets = service.walletsFor(u.id).map((w) => w.address);
    if (email && (opts.adminEmails ?? []).includes(email)) return 'owner';
    if (wallets.some((w) => (opts.adminWallets ?? []).includes(w))) return 'owner';
    return service.teamRoleFor(email, wallets);
  }

  // --- Shareable PnL cards ----------------------------------------------------------
  // /share/pnl/<market>/<username>.png is the card; /share/pnl/<market>/<username> is a page with
  // that card as its preview image (what X shows for the link), which then opens the market.
  const pnlCache = new Map<string, Uint8Array>();

  function servePnl(req: IncomingMessage, res: ServerResponse, rawMarket: string, rawUser: string, png: boolean) {
    let marketId: string;
    let username: string;
    try {
      marketId = decodeURIComponent(rawMarket);
      username = decodeURIComponent(rawUser);
    } catch {
      return send(res, 400, { error: 'bad_path', message: 'Invalid path.' });
    }
    let card: ReturnType<FirstprintService['pnlCard']>;
    try {
      card = service.pnlCard(marketId, username);
    } catch (err) {
      if (err instanceof AppError) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('No result to show.');
      }
      throw err;
    }
    const key = `${card.marketId}|${card.username.toLowerCase()}`;
    const enc = (v: string) => encodeURIComponent(v);
    if (png) {
      let img = pnlCache.get(key);
      if (!img) {
        try {
          rateLimit(`pnl:${visitor(req)}`, 30, 60_000);
        } catch {
          res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' });
          return res.end('Too many requests.');
        }
        img = renderPnl(card, service.logoPng(card.marketId));
        if (pnlCache.size >= 300) pnlCache.delete(pnlCache.keys().next().value!);
        pnlCache.set(key, img);
      }
      // A settled result never changes, so the card can be cached for a day.
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'content-length': img.length });
      return res.end(req.method === 'HEAD' ? undefined : Buffer.from(img));
    }
    const origin = opts.publicUrl ? new URL(opts.publicUrl).origin : `http://${req.headers.host ?? 'localhost'}`;
    const image = `${origin}/share/pnl/${enc(card.marketId)}/${enc(card.username)}.png`;
    const market = `${origin}/app/#/market/${enc(card.marketId)}`;
    const amount = `${Math.abs(Math.round(card.profit)).toLocaleString('en-US')} pts`;
    const title = card.won ? `@${card.username} won +${amount} on ${card.symbol}` : `@${card.username}’s ${card.symbol} call: −${amount}`;
    const h = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const desc = 'Predict where newly listed tokens trade on Firstprint. Free points, no deposits.';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · Firstprint</title>
<meta name="description" content="${h(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Firstprint">
<meta property="og:title" content="${h(title)}"><meta property="og:description" content="${h(desc)}">
<meta property="og:image" content="${h(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${h(title)}"><meta name="twitter:description" content="${h(desc)}"><meta name="twitter:image" content="${h(image)}">
<meta http-equiv="refresh" content="0; url=${h(market)}">
<style>body{margin:0;background:#07080c;color:#f5f5f7;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;gap:16px;padding:16px;box-sizing:border-box}img{max-width:100%;border-radius:12px}a{color:#3987e5}</style>
</head><body><img src="${h(image)}" alt="${h(title)}" width="600" height="315"><a href="${h(market)}">Open the market on Firstprint</a></body></html>`);
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    (res as Negotiated).gzipOk = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    (res as Negotiated).ifNoneMatch = req.method === 'GET' ? String(req.headers['if-none-match'] ?? '') : null;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
    res.setHeader('content-security-policy', CSP);
    if (opts.secureCookies) res.setHeader('strict-transport-security', 'max-age=63072000');

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
      const share = /^\/share\/pnl\/([^/]+)\/([^/]+?)(\.png)?$/.exec(url.pathname);
      if (share) {
        try {
          // Each card works out the player's whole history, so floods are cut off (generous for link previews).
          rateLimit(`share:${visitor(req)}`, 120, 60_000);
          return servePnl(req, res, share[1], share[2], Boolean(share[3]));
        } catch (err) {
          if (err instanceof AppError && err.status === 429) return send(res, 429, { error: err.code, message: err.message });
          service.log(`500 GET ${url.pathname}: ${(err as Error).stack ?? err}`);
          return send(res, 500, { error: 'server_error', message: 'Something went wrong on our side. Try again.' });
        }
      }
      try { return await servePage(res, url); }
      catch { return send(res, 400, { error: 'bad_path', message: 'Invalid path.' }); }
    }

    if (url.pathname === '/api/stream' && req.method === 'GET') return openStream(req, res);

    // A market's uploaded logo as an image. The URL carries a version, so it can be cached for good.
    const logo = req.method === 'GET' ? /^\/api\/logo\/([^/]+)$/.exec(url.pathname) : null;
    if (logo) {
      let img: { type: string; bytes: Buffer } | null = null;
      try {
        img = service.logoImage(decodeURIComponent(logo[1]));
      } catch {
        /* bad id */
      }
      if (!img) return send(res, 404, { error: 'not_found', message: 'No logo.' });
      res.writeHead(200, { 'content-type': img.type, 'cache-control': 'public, max-age=31536000, immutable', 'content-length': img.bytes.length });
      return res.end(img.bytes);
    }

    const match = routes
      // HEAD is answered like GET (Node sends the headers only): uptime monitors check with HEAD.
      .map((r) => ({ r, m: r.method === (req.method === 'HEAD' ? 'GET' : req.method) ? r.pattern.exec(url.pathname) : null }))
      .find((x) => x.m);
    if (!match || !match.m) return send(res, 404, { error: 'not_found', message: 'Unknown endpoint.' });

    const params: Record<string, string> = {};
    try {
      match.r.keys.forEach((k, i) => (params[k] = decodeURIComponent(match.m![i + 1])));
    } catch {
      return send(res, 400, { error: 'bad_path', message: 'Invalid path.' });
    }

    let userMemo: UserRow | null | undefined;
    const ctx: Ctx = {
      req,
      res,
      url,
      params,
      body: () => readBody(req),
      optionalUser: () => (userMemo === undefined ? (userMemo = service.userForSession(sessionToken(req))) : userMemo),
      user: () => {
        const u = ctx.optionalUser();
        if (!u) throw new AppError(401, 'auth_required', 'Log in to continue.');
        return u;
      },
      requireAdmin: (min: AdminLevel = 'admin') => {
        // Wrong keys are limited tightly (guessing); the right key gets room for the panel's own traffic.
        const given = String(req.headers['x-admin-key'] ?? '');
        // After too many wrong keys, every key from that visitor is refused for a while (the right one
        // too), so guessing gets no answer at all.
        const bad = given ? hits.get(`admin-bad:${visitor(req)}`) : undefined;
        if (bad && bad.reset >= Date.now() && bad.count >= 20) throw new AppError(429, 'rate_limited', 'Too many wrong admin keys. Try again in a minute.');
        const keyOk =
          Boolean(given) &&
          opts.adminKey &&
          Buffer.byteLength(given) === Buffer.byteLength(opts.adminKey) &&
          timingSafeEqual(Buffer.from(given), Buffer.from(opts.adminKey));
        // No key: an owner or team account signed in on this browser.
        const level: AdminLevel | null = keyOk ? 'owner' : given ? null : accountLevel(req, ctx.optionalUser());
        if (level && LEVEL_RANK[level] < LEVEL_RANK[min]) throw new AppError(403, 'not_allowed', 'Your team role can’t do this. Ask the owner for more access.');
        if (!level) {
          rateLimit(`admin-bad:${visitor(req)}`, 20, 60_000);
          throw new AppError(403, 'forbidden', 'Admin key required.');
        }
        rateLimit(`admin:${visitor(req)}`, 600, 60_000);
        return level;
      },
    };

    try {
      rateLimit(`ip:${visitor(req)}`, 300);
      if (req.method === 'POST' && req.headers.origin) {
        const expected = opts.publicUrl ? new URL(opts.publicUrl).origin : `http://${req.headers.host}`;
        if (req.headers.origin !== expected) throw new AppError(403, 'bad_origin', 'Request origin is not allowed.');
      }
      if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new AppError(415, 'json_required', 'Requests must use Content-Type: application/json.');
      }
      // While handing over to a new deploy nothing may be saved, not even by admins: it would be lost.
      if (req.method === 'POST' && service.handingOff !== null && url.pathname !== '/api/auth/logout') {
        throw new AppError(503, 'maintenance', service.maintenance().message);
      }
      // Maintenance: players can read but not write; admins (key or admin account) can still test.
      if (req.method === 'POST' && !url.pathname.startsWith('/api/admin/') && url.pathname !== '/api/auth/logout' && service.maintenance().on) {
        const given = String(req.headers['x-admin-key'] ?? '');
        const isAdmin = (given && opts.adminKey && Buffer.byteLength(given) === Buffer.byteLength(opts.adminKey) && timingSafeEqual(Buffer.from(given), Buffer.from(opts.adminKey))) || accountLevel(req, ctx.optionalUser()) !== null;
        if (!isAdmin) throw new AppError(503, 'maintenance', service.maintenance().message || 'Firstprint is being updated. Back in a few minutes.');
      }
      // Admin tools use the smaller share of the CoinGecko budget; live-market work keeps the rest.
      const out = await (url.pathname.startsWith('/api/admin/') ? asAdmin(() => match.r.handler(ctx)) : match.r.handler(ctx));
      send(res, 200, out);
    } catch (err) {
      if (err instanceof AppError) return send(res, err.status, { error: err.code, message: err.message });
      service.log(`500 ${req.method} ${url.pathname}: ${(err as Error).stack ?? err}`);
      send(res, 500, { error: 'server_error', message: 'Something went wrong on our side. Try again.' });
    }
  });
}

/** Groups IPv6 addresses by /64 for rate limits; IPv4 (including IPv4-mapped IPv6) is used as is. */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const [head, tail = ''] = ip.split('%')[0].toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** A referral code sent with a sign-in, used only when it creates the account. */
function refOf(b: Record<string, unknown>): string | null {
  return typeof b.ref === 'string' ? b.ref.slice(0, 16) : null;
}

/** The task fields an admin form may send. */
function taskInput(b: Record<string, unknown>): Partial<TaskInput> {
  const out: Partial<TaskInput> = {};
  if (b.kind !== undefined) out.kind = String(b.kind) as TaskInput['kind'];
  if (b.title !== undefined) out.title = String(b.title);
  if (b.target !== undefined) out.target = String(b.target);
  if (b.points !== undefined) out.points = Number(b.points);
  if (b.maxCompletions !== undefined) out.maxCompletions = b.maxCompletions === null || b.maxCompletions === '' ? null : Number(b.maxCompletions);
  if (b.active !== undefined) out.active = Boolean(b.active);
  return out;
}

/** What the request accepts, noted on the response so send() can compress and answer 304s. */
/** If-None-Match can list several tags, and a proxy that compresses may have weakened ours (W/). */
function sameEtag(header: string, etag: string) {
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => t.trim() === '*' || bare(t) === bare(etag));
}

type Negotiated = ServerResponse & {
  gzipOk?: boolean;
  ifNoneMatch?: string | null;
  /** Seconds a shared cache (Cloudflare) may keep this answer: only the public API, which is the same for everyone. */
  publicMaxAge?: number;
};

const ZIPPABLE = /^(?:text\/|application\/(?:json|javascript|manifest\+json|xml)|image\/svg\+xml)/;

/** Gzips a response body when the client accepts it and it is worth it. */
function maybeGzip(res: Negotiated, type: string, data: Buffer | string): { body: Buffer | string; headers: Record<string, string> } {
  if (!res.gzipOk || !ZIPPABLE.test(type) || Buffer.byteLength(data) < 1400) return { body: data, headers: { vary: 'accept-encoding' } };
  return { body: gzipSync(data), headers: { 'content-encoding': 'gzip', vary: 'accept-encoding' } };
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  const r = res as Negotiated;
  const json = JSON.stringify(body);
  const type = 'application/json; charset=utf-8';
  // GETs that succeed carry an ETag: the 8-second refreshes then cost a few bytes when nothing changed.
  // "private, no-cache" keeps them out of shared caches but lets the browser revalidate; the public
  // API's answers are the same for everyone, so Cloudflare may keep those for a few seconds.
  if (status === 200 && r.ifNoneMatch !== null && r.ifNoneMatch !== undefined) {
    // serverTime changes every call; leave it out so an unchanged list still matches.
    const tagged = json.includes('"serverTime"') ? JSON.stringify(body, (k, v) => (k === 'serverTime' ? 0 : v)) : json;
    const etag = `W/"${createHash('sha1').update(tagged).digest('base64url').slice(0, 22)}"`;
    const headers = r.publicMaxAge
      ? { 'cache-control': `public, max-age=${r.publicMaxAge}`, etag, vary: 'accept-encoding' }
      : { 'cache-control': 'private, no-cache', etag, vary: 'accept-encoding, cookie' };
    if (r.ifNoneMatch === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const z = maybeGzip(r, type, json);
    res.writeHead(status, { 'content-type': type, ...headers, ...z.headers, vary: headers.vary });
    return res.end(z.body);
  }
  const z = maybeGzip(r, type, json);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...z.headers });
  res.end(z.body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Room for a market's logo plus its PNG copy for banners.
    if (size > 256_000) throw new AppError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'bad_json', 'Request body must be a JSON object.');
  }
}

/** Converts a public pagination value into a safe, finite database limit. */
function boundedLimit(value: string | null, fallback = 50): number {
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(200, parsed));
}

function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  throw new AppError(400, 'bad_time', 'Times must be Unix milliseconds or ISO 8601 strings.');
}

function publicUser(u: UserRow, now: number, wallets: { address: string; walletName: string | null }[]) {
  const today = new Date(now).toISOString().slice(0, 10);
  return {
    id: u.id,
    username: u.username,
    needsUsername: u.needs_username === 1,
    hasEmail: Boolean(u.email),
    wallets: wallets.map((w) => ({ address: w.address, walletName: w.walletName })),
    points: u.points,
    canClaimDaily: u.last_claim_day !== today,
    daily: dailyStatus(u, now),
    xUsername: u.x_username ?? null,
  };
}
