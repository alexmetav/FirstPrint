export interface AppConfig {
  port: number;
  dbPath: string;
  adminKey: string | null;
  secureCookies: boolean;
  /** Reverse proxies in front of the app; 1 for Render/Vercel/Cloudflare. */
  trustProxy: number;
  publicUrl: string | null;
  /** Static root to serve. Defaults to web/; set to .deploy/ to serve site + app. */
  webDir: string | null;
  solanaChain: 'mainnet' | 'devnet' | 'testnet';
  tickMs: number;
  liveMs: number;
  trackVenues: string[];
  trackEveryMs: number;
  autoCreateMarkets: boolean;
  sim: boolean;
}

const ALL_VENUES = ['binance', 'mexc', 'bybit', 'okx', 'gate', 'bitget', 'kucoin'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === 'production';
  const chain = (env.SOLANA_CHAIN ?? 'mainnet') as AppConfig['solanaChain'];
  const cfg: AppConfig = {
    port: Number(env.PORT ?? 8787),
    dbPath: env.DB_PATH ?? './data/firstprint.db',
    adminKey: env.ADMIN_KEY || null,
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === '1' : production,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    publicUrl: env.PUBLIC_URL || null,
    webDir: env.WEB_DIR || null,
    solanaChain: ['mainnet', 'devnet', 'testnet'].includes(chain) ? chain : 'mainnet',
    tickMs: Number(env.TICK_MS ?? 5_000),
    liveMs: Number(env.LIVE_MS ?? 5_000),
    trackVenues: env.TRACK_VENUES === undefined ? ALL_VENUES : env.TRACK_VENUES.split(',').map((s) => s.trim()).filter(Boolean),
    trackEveryMs: Number(env.TRACK_EVERY_MS ?? 120_000),
    autoCreateMarkets: env.AUTO_CREATE_MARKETS === '1',
    sim: env.SIM === '1',
  };
  if (production && (!cfg.adminKey || cfg.adminKey.length < 24)) {
    throw new Error('Set ADMIN_KEY to a random string of at least 24 characters in production.');
  }
  if (production && !cfg.publicUrl) throw new Error('Set PUBLIC_URL (e.g. https://firstprint.xyz) in production for wallet sign-in.');
  if (production && cfg.sim) throw new Error('SIM must be off in production.');
  if (production && env.TRUST_PROXY === undefined) {
    throw new Error(
      'Set TRUST_PROXY in production: the number of reverse proxies in front of the app. ' +
        'Use 1 on Render or Vercel or behind Cloudflare, and 0 only if the server is exposed directly. ' +
        'Too low and every visitor shares one rate-limit bucket; too high and callers can forge their own IP.',
    );
  }
  return cfg;
}

/**
 * Trusted proxy hop count. Deliberately strict: a typo that silently became 0
 * would put the whole site in one rate-limit bucket, and one that silently
 * became non-zero would let callers forge their IP via X-Forwarded-For.
 */
function parseTrustProxy(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    throw new Error(`TRUST_PROXY must be a whole number from 0 to 10, got "${raw}".`);
  }
  return n;
}
