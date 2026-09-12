import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { AppError, DAILY_POINTS, LIVE_PRESETS, MIN_STAKE, SESSION_MS, SUGGESTED_LIVE_TOKENS, type FirstprintService, type UserRow } from '../services/firstprint.ts';
import type { Scheduler } from '../workers/scheduler.ts';
import type { LiveFeed } from '../workers/liveFeed.ts';
import type { Bucket } from '../engine/engine.ts';

export interface ServerOptions {
  service: FirstprintService;
  scheduler?: Scheduler;
  live?: LiveFeed;
  adminKey: string | null;
  /** Public site URL used in wallet sign-in messages, e.g. https://firstprint.xyz */
  publicUrl?: string | null;
  solanaChain?: 'mainnet' | 'devnet' | 'testnet';
  /** Send cookies with the Secure flag (enable behind HTTPS). */
  secureCookies: boolean;
  webDir: string;
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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

export function createApiServer(opts: ServerOptions): Server {
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

  function sessionToken(req: IncomingMessage): string {
    const auth = req.headers.authorization ?? '';
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const cookies = req.headers.cookie ?? '';
    for (const part of cookies.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return decodeURIComponent(v.join('='));
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
  function rateLimit(key: string, limit = 30, windowMs = 10_000) {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 50_000) hits.clear();
      return;
    }
    if (++h.count > limit) throw new AppError(429, 'rate_limited', 'Too many requests. Try again in a few seconds.');
  }

  // --- Public routes -------------------------------------------------------------

  route('GET', '/api/health', () => ({ ok: true, time: service.clock.now() }));

  route('GET', '/api/config', () => ({
    minStake: MIN_STAKE,
    dailyPoints: DAILY_POINTS,
    solanaChain: opts.solanaChain ?? 'mainnet',
  }));

  // --- Solana wallet sign-in -----------------------------------------------------

  function siteFor(req: IncomingMessage) {
    const url = opts.publicUrl ? new URL(opts.publicUrl) : new URL(`http://${req.headers.host ?? 'localhost'}`);
    return { domain: url.host, uri: url.origin, chainId: opts.solanaChain ?? 'mainnet' };
  }

  route('GET', '/api/auth/wallet/challenge', ({ req, url }) => {
    rateLimit(`challenge:${req.socket.remoteAddress}`, 20, 60_000);
    return service.walletChallenge(String(url.searchParams.get('address') ?? ''), siteFor(req));
  });

  route('POST', '/api/auth/wallet/verify', async ({ req, res, body }) => {
    rateLimit(`wallet:${req.socket.remoteAddress}`, 20, 60_000);
    const b = await body();
    const { user, created } = service.walletSignIn({
      address: String(b.address ?? ''),
      message: String(b.message ?? ''),
      signature: String(b.signature ?? ''),
      walletName: b.walletName ? String(b.walletName).slice(0, 40) : undefined,
    });
    const session = service.createSession(user.id);
    setSessionCookie(res, session.token, SESSION_MS);
    return { user: publicUser(user, service.clock.now(), service.walletsFor(user.id)), created, token: session.token };
  });

  route('POST', '/api/auth/signup', async ({ req, res, body }) => {
    rateLimit(`signup:${req.socket.remoteAddress}`, 5, 60_000);
    const b = await body();
    const user = await service.createUser({
      email: String(b.email ?? ''),
      username: String(b.username ?? ''),
      password: String(b.password ?? ''),
    });
    const session = service.createSession(user.id);
    setSessionCookie(res, session.token, SESSION_MS);
    return { user: publicUser(user, service.clock.now(), []), token: session.token };
  });

  route('POST', '/api/auth/login', async ({ req, res, body }) => {
    const b = await body();
    rateLimit(`login:${req.socket.remoteAddress}`, 10, 60_000);
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
    listings: service.detections({ status: 'all', limit: Number(url.searchParams.get('limit') ?? 50) }).filter((d) => d.status !== 'ignored'),
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

  route('GET', '/api/me/predictions', ({ user }) => ({ predictions: service.myPredictions(user().id) }));

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
      presets: Object.entries(LIVE_PRESETS).map(([id, p]) => ({ id, label: p.label })),
      suggestedTokens: SUGGESTED_LIVE_TOKENS,
    };
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

  route('POST', '/api/admin/markets/:id/cancel', ({ params, requireAdmin }) => {
    requireAdmin();
    return service.cancelMarket(params.id);
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

  async function serveStatic(res: ServerResponse, pathname: string) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(webRoot, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(webRoot)) return send(res, 404, { error: 'not_found', message: 'Not found.' });
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(webRoot, 'index.html'); // SPA fallback
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(data);
    } catch {
      send(res, 404, { error: 'not_found', message: 'Not found.' });
    }
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

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
      return serveStatic(res, url.pathname);
    }

    if (url.pathname === '/api/stream' && req.method === 'GET') return openStream(req, res);

    const match = routes
      .map((r) => ({ r, m: r.method === req.method ? r.pattern.exec(url.pathname) : null }))
      .find((x) => x.m);
    if (!match || !match.m) return send(res, 404, { error: 'not_found', message: 'Unknown endpoint.' });

    const params: Record<string, string> = {};
    match.r.keys.forEach((k, i) => (params[k] = decodeURIComponent(match.m![i + 1])));

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
        const given = String(req.headers['x-admin-key'] ?? '');
        const ok =
          opts.adminKey &&
          given.length === opts.adminKey.length &&
          timingSafeEqual(Buffer.from(given), Buffer.from(opts.adminKey));
        if (!ok) throw new AppError(403, 'forbidden', 'Admin key required.');
      },
    };

    try {
      rateLimit(`ip:${req.socket.remoteAddress}`, 300);
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
  };
}
