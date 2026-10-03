import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { AppError, DAILY_POINTS, LIVE_PRESETS, MIN_STAKE, SESSION_MS, SUGGESTED_LIVE_TOKENS, type FirstprintService, type UserRow } from '../services/firstprint.ts';
import type { Scheduler } from '../workers/scheduler.ts';
import type { LiveFeed } from '../workers/liveFeed.ts';
import { cachedGoogleJwks, verifyGoogleIdToken, type JwksFetcher } from '../auth/google.ts';
import type { Mailer } from '../auth/mailer.ts';
import type { Bucket } from '../engine/engine.ts';
import { linkSiteToApp } from '../site/links.ts';
import type { RewardsService, TaskInput } from '../services/rewards.ts';

export interface ServerOptions {
  service: FirstprintService;
  scheduler?: Scheduler;
  live?: LiveFeed;
  adminKey: string | null;
  /** How many proxies sit between visitors and this server (0 = none). Used to find the visitor's address for rate limits. */
  trustProxyHops?: number;
  /** Google OAuth client ID (public). Enables "Continue with Google". */
  googleClientId?: string | null;
  /** Override for tests: where Google's signing keys come from. */
  googleJwks?: JwksFetcher;
  /** Sends sign-in codes. Without one, email sign-in is off. */
  mailer?: Mailer | null;
  /** Return the code in the API response (development only, when no real mailer is configured). */
  devEmailCodes?: boolean;
  /** Database backup health, shown in the admin panel. */
  backupStatus?: () => { enabled: boolean; lastOkAt: number | null; lastError: string | null };
  /** True when exchange auto-detection and live prices are off and admins run every market. */
  manualOnly?: boolean;
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
  requireAdmin: () => void;
}

/**
 * No inline scripts and no third-party scripts except Google sign-in, so an injected tag can't run
 * (the admin key sits in sessionStorage). Inline styles stay allowed: the UI sets CSS variables in style="".
 * Images may come from any https host (exchange and token logos). Keep in step with vercel.json.
 */
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
    const direct = req.socket.remoteAddress ?? 'unknown';
    if (proxyHops === 0) return direct;
    const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return chain.length >= proxyHops ? chain[chain.length - proxyHops] : direct;
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

  // --- Public routes -------------------------------------------------------------

  route('GET', '/api/health', () => {
    service.db.prepare('SELECT 1').get();
    return { ok: true, time: service.clock.now() };
  });

  route('GET', '/api/config', () => ({
    minStake: MIN_STAKE,
    dailyPoints: DAILY_POINTS,
    solanaChain: opts.solanaChain ?? 'mainnet',
    // What the sign-in popup offers. Email codes need a mailer (or dev mode); Google needs a client ID.
    signIn: { google: opts.googleClientId ?? null, email: Boolean(opts.mailer) },
    // Markets are run from the admin panel, so exchange-detection pages have nothing to show.
    manualOnly: opts.manualOnly ?? false,
    // Points as TestFPT on a Solana test network, and where to get test SOL for the fee.
    rewards: opts.rewards ? { onChain: opts.rewards.ready(), cluster: opts.rewards.cluster(), faucetUrl: 'https://faucet.solana.com' } : null,
  }));

  // --- Earn: rewards, tasks, referrals, TestFPT claims --------------------------------

  const rewardsOn = () => {
    if (!opts.rewards) throw new AppError(404, 'not_found', 'Rewards are not enabled.');
    return opts.rewards;
  };

  route('GET', '/api/me/rewards', ({ user }) => rewardsOn().summary(user().id));

  route('POST', '/api/me/x', async ({ req, user, body }) => {
    rateLimit(`x:${visitor(req)}`, 10, 60_000);
    const b = await body();
    return rewardsOn().connectX(user().id, String(b.username ?? ''));
  });

  route('POST', '/api/tasks/:id/start', ({ user, params }) => rewardsOn().startTask(user().id, params.id));

  route('POST', '/api/tasks/:id/verify', ({ req, user, params }) => {
    rateLimit(`task:${visitor(req)}`, 20, 60_000);
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
      await opts.mailer.send(email, `${code} is your Firstprint code`, `Your Firstprint sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`);
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
    const { user, created } = service.verifyEmailCode(String(b.email ?? ''), String(b.code ?? ''), refOf(b));
    const session = service.createSession(user.id);
    setSessionCookie(res, session.token, SESSION_MS);
    return { user: publicUser(user, service.clock.now(), service.walletsFor(user.id)), created, token: session.token };
  });

  route('POST', '/api/auth/google', async ({ req, res, body }) => {
    if (!opts.googleClientId) throw new AppError(503, 'google_off', 'Google sign-in isn’t set up yet.');
    rateLimit(`google:${visitor(req)}`, 20, 10 * 60_000);
    const b = await body();
    const who = await verifyGoogleIdToken(String(b.credential ?? ''), opts.googleClientId, opts.googleJwks ?? (googleJwks ??= cachedGoogleJwks()));
    if (!who) throw new AppError(401, 'bad_google_token', 'Google sign-in failed. Try again.');
    const { user, created } = service.signInWithVerifiedEmail(who.email, who.name, refOf(b));
    const session = service.createSession(user.id);
    setSessionCookie(res, session.token, SESSION_MS);
    return { user: publicUser(user, service.clock.now(), service.walletsFor(user.id)), created, token: session.token };
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
    const { user, created } = service.walletSignIn({
      address: String(b.address ?? ''),
      message: String(b.message ?? ''),
      signature: String(b.signature ?? ''),
      walletName: b.walletName ? String(b.walletName).slice(0, 40) : undefined,
      ref: refOf(b),
    });
    const session = service.createSession(user.id);
    setSessionCookie(res, session.token, SESSION_MS);
    return { user: publicUser(user, service.clock.now(), service.walletsFor(user.id)), created, token: session.token };
  });

  route('POST', '/api/auth/login', async ({ req, res, body }) => {
    const b = await body();
    rateLimit(`login:${visitor(req)}`, 10, 60_000);
    rateLimit(`login:${String(b.email ?? '').toLowerCase()}`, 10, 10 * 60_000);
    const user = await service.authenticate(String(b.email ?? ''), String(b.password ?? ''));
    const session = service.createSession(user.id);
    setSessionCookie(res, session.token, SESSION_MS);
    return { user: publicUser(user, service.clock.now(), service.walletsFor(user.id)), token: session.token };
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
    return { markets: service.listMarkets(filter, optionalUser()?.id), serverTime: service.clock.now() };
  });

  route('GET', '/api/markets/:id', ({ params, optionalUser }) => service.getMarket(params.id, optionalUser()?.id));

  route('GET', '/api/markets/:id/quote', ({ params, url }) =>
    service.quote(params.id, url.searchParams.get('bucket') as Bucket, Number(url.searchParams.get('stake'))),
  );

  route('GET', '/api/markets/:id/chart', ({ params }) => service.chart(params.id));

  route('GET', '/api/markets/:id/settlement', ({ params }) => service.settlement(params.id));

  route('GET', '/api/markets/:id/activity', ({ params }) => ({ activity: service.activity(params.id) }));

  route('GET', '/api/listings/detected', ({ url }) => ({
    listings: service.detections({ status: 'all', limit: boundedLimit(url.searchParams.get('limit')) }).filter((d) => d.status !== 'ignored'),
  }));

  route('GET', '/api/leaderboard', ({ optionalUser }) => service.leaderboard(optionalUser()?.id));

  // --- User routes ----------------------------------------------------------------

  route('GET', '/api/me', ({ user }) => {
    const u = user();
    return publicUser(u, service.clock.now(), service.walletsFor(u.id));
  });

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

  route('GET', '/api/me/ledger', ({ user }) => ({ entries: service.ledgerFor(user().id) }));

  route('GET', '/api/me/predictions', ({ user }) => ({ predictions: service.myPredictions(user().id) }));

  route('GET', '/api/me/stats', ({ user }) => service.myStats(user().id));

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
    basePrice: b.basePrice === undefined ? (undefined as never) : Number(b.basePrice),
    closeAt: b.closeAt === undefined ? (undefined as never) : toMs(b.closeAt),
    resultAt: b.resultAt === undefined || b.resultAt === '' ? undefined : toMs(b.resultAt),
    config: b.config as never,
    note: b.note as string | undefined,
    sourceUrl: b.sourceUrl as string | undefined,
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

  route('POST', '/api/admin/manual-markets', async ({ req, body, requireAdmin }) => {
    requireAdmin();
    const b = await body();
    const id = service.createManualMarket({ ...manualBody(b), publish: b.publish === true });
    audit(req, b.publish === true ? 'market_published' : 'market_drafted', id, `${String(b.symbol ?? '').toUpperCase()} start price ${b.basePrice}`);
    return service.getMarket(id, undefined, true);
  });

  route('POST', '/api/admin/manual-markets/:id', async ({ req, params, body, requireAdmin }) => {
    requireAdmin();
    const b = await body();
    const patch = Object.fromEntries(Object.entries(manualBody(b)).filter(([, v]) => v !== undefined));
    service.updateManualMarket(params.id, patch);
    audit(req, 'market_edited', params.id, Object.keys(patch).join(', '));
    return service.getMarket(params.id, undefined, true);
  });

  route('POST', '/api/admin/manual-markets/:id/publish', ({ req, params, requireAdmin }) => {
    requireAdmin();
    service.publishMarket(params.id);
    audit(req, 'market_published', params.id);
    return service.getMarket(params.id, undefined, true);
  });

  route('POST', '/api/admin/manual-markets/:id/unpublish', ({ req, params, requireAdmin }) => {
    requireAdmin();
    service.unpublishMarket(params.id);
    audit(req, 'market_unpublished', params.id);
    return service.getMarket(params.id, undefined, true);
  });

  route('POST', '/api/admin/manual-markets/:id/delete', ({ req, params, requireAdmin }) => {
    requireAdmin();
    service.deleteDraft(params.id);
    audit(req, 'draft_deleted', params.id);
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
    requireAdmin();
    const status = (url.searchParams.get('status') ?? 'pending') as 'pending' | 'approved' | 'ignored' | 'all';
    return { detected: service.detections({ status, limit: 200 }) };
  });

  route('POST', '/api/admin/detected/:id/approve', async ({ params, body, requireAdmin }) => {
    requireAdmin();
    const b = await body();
    const marketId = service.approveDetection(Number(params.id), {
      symbol: b.symbol as string | undefined,
      name: b.name as string | undefined,
      listingAt: b.listingAt === undefined ? undefined : toMs(b.listingAt),
      config: b.config as never,
    });
    return service.getMarket(marketId);
  });

  route('POST', '/api/admin/detected/:id/ignore', ({ params, requireAdmin }) => {
    requireAdmin();
    service.ignoreDetection(Number(params.id));
    return { ok: true };
  });

  route('POST', '/api/admin/track', async ({ requireAdmin }) => {
    requireAdmin();
    await opts.scheduler?.track();
    return { detected: service.detections({ status: 'pending', limit: 200 }) };
  });

  route('GET', '/api/admin/ping', ({ requireAdmin }) => {
    requireAdmin();
    return {
      ok: true,
      venues: service.venueList(),
      exchanges: service.exchangeSettings(),
      manualOnly: opts.manualOnly ?? false,
      backup: opts.backupStatus?.() ?? { enabled: false, lastOkAt: null, lastError: null },
      presets: Object.entries(LIVE_PRESETS).map(([id, p]) => ({ id, label: p.label })),
      suggestedTokens: SUGGESTED_LIVE_TOKENS,
    };
  });

  // --- Admin: TestFPT token and tasks ---------------------------------------------

  route('GET', '/api/admin/token', ({ requireAdmin }) => {
    requireAdmin();
    return opts.rewards ? opts.rewards.tokenStatus() : { enabled: false };
  });

  route('POST', '/api/admin/token/:step', async ({ req, params, requireAdmin }) => {
    requireAdmin();
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

  route('GET', '/api/admin/tasks', ({ requireAdmin }) => {
    requireAdmin();
    return { tasks: rewardsOn().listTasksAdmin() };
  });

  route('POST', '/api/admin/tasks', async ({ req, body, requireAdmin }) => {
    requireAdmin();
    const b = await body();
    const id = rewardsOn().createTask(taskInput(b) as TaskInput);
    audit(req, 'task_created', id, `${b.kind} ${b.points} pts`);
    return { id };
  });

  route('POST', '/api/admin/tasks/:id', async ({ req, params, body, requireAdmin }) => {
    requireAdmin();
    const b = await body();
    rewardsOn().updateTask(params.id, taskInput(b));
    audit(req, 'task_updated', params.id, JSON.stringify(b).slice(0, 200));
    return { ok: true };
  });

  route('GET', '/api/admin/log', ({ requireAdmin }) => {
    requireAdmin();
    return { log: service.adminLog(40) };
  });

  route('GET', '/api/admin/markets', ({ requireAdmin }) => {
    requireAdmin();
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
  const LINKED_SITE_FILES = new Set(['index.html', join('assets', 'site.js')]);

  async function serveStatic(res: ServerResponse, root: string, pathname: string, linkToApp = false) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(root)) return send(res, 404, { error: 'not_found', message: 'Not found.' });
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(root, 'index.html'); // SPA fallback
    }
    try {
      let data: Buffer | string = await readFile(file);
      if (linkToApp && LINKED_SITE_FILES.has(file.slice(root.length + 1))) {
        data = linkSiteToApp(data.toString('utf8'), APP_PREFIX, file);
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(data);
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

  function openStream(req: IncomingMessage, res: ServerResponse) {
    if (!opts.live) return send(res, 404, { error: 'not_found', message: 'Live updates are not enabled.' });
    if (opts.live.connections >= 5_000) return send(res, 503, { error: 'busy', message: 'Too many live connections. Try again soon.' });
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
    });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
    res.setHeader('content-security-policy', CSP);
    if (opts.secureCookies) res.setHeader('strict-transport-security', 'max-age=63072000');

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
      try { return await servePage(res, url); }
      catch { return send(res, 400, { error: 'bad_path', message: 'Invalid path.' }); }
    }

    if (url.pathname === '/api/stream' && req.method === 'GET') return openStream(req, res);

    const match = routes
      .map((r) => ({ r, m: r.method === req.method ? r.pattern.exec(url.pathname) : null }))
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
      requireAdmin: () => {
        rateLimit(`admin:${visitor(req)}`, 30, 60_000);
        const given = String(req.headers['x-admin-key'] ?? '');
        const ok =
          opts.adminKey &&
          Buffer.byteLength(given) === Buffer.byteLength(opts.adminKey) &&
          timingSafeEqual(Buffer.from(given), Buffer.from(opts.adminKey));
        if (!ok) throw new AppError(403, 'forbidden', 'Admin key required.');
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
      const out = await match.r.handler(ctx);
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

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new AppError(413, 'body_too_large', 'Request body is too large.');
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
    xUsername: u.x_username ?? null,
  };
}
