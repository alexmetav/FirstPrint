export interface AppConfig {
  port: number;
  dbPath: string;
  adminKey: string | null;
  secureCookies: boolean;
  publicUrl: string | null;
  solanaChain: 'mainnet' | 'devnet' | 'testnet';
  tickMs: number;
  liveMs: number;
  trackVenues: string[];
  trackEveryMs: number;
  autoCreateMarkets: boolean;
  sim: boolean;
  /** Admin-run markets only: no exchange scanning or live price feeds. */
  manualOnly: boolean;
  googleClientId: string | null;
  resendApiKey: string | null;
  mailFrom: string | null;
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
    publicUrl: env.PUBLIC_URL || null,
    solanaChain: ['mainnet', 'devnet', 'testnet'].includes(chain) ? chain : 'mainnet',
    tickMs: Number(env.TICK_MS ?? 5_000),
    liveMs: Number(env.LIVE_MS ?? 5_000),
    trackVenues: env.TRACK_VENUES === undefined ? ALL_VENUES : env.TRACK_VENUES.split(',').map((s) => s.trim()).filter(Boolean),
    trackEveryMs: Number(env.TRACK_EVERY_MS ?? 120_000),
    autoCreateMarkets: env.AUTO_CREATE_MARKETS === '1',
    sim: env.SIM === '1',
    manualOnly: env.MANUAL_ONLY !== '0',
    googleClientId: env.GOOGLE_CLIENT_ID || null,
    resendApiKey: env.RESEND_API_KEY || null,
    mailFrom: env.MAIL_FROM || null,
  };
  if (production && (!cfg.adminKey || cfg.adminKey.length < 24)) {
    throw new Error('Set ADMIN_KEY to a random string of at least 24 characters in production.');
  }
  if (production && !cfg.publicUrl) throw new Error('Set PUBLIC_URL (e.g. https://firstprint.xyz) in production for wallet sign-in.');
  if (production && cfg.sim) throw new Error('SIM must be off in production.');
  return cfg;
}
