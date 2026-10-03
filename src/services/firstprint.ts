import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from '../auth/passwords.ts';
import { isSolanaAddress } from '../solana/base58.ts';
import { buildSiwsMessage, decodeSignature, verifyEd25519 } from '../solana/siws.ts';
import { tx, type DB } from '../db/db.ts';
import type { Clock } from '../clock.ts';
import type { Venue } from '../exchanges/types.ts';
import {
  BUCKETS,
  DEFAULT_CONFIG,
  applyCaps,
  bucketForReturn,
  computePayouts,
  emptyTotals,
  hardCapFor,
  quote as engineQuote,
  returnPct,
  settleMarket,
  twap,
  venueMedian,
  windows,
  type Bucket,
  type Candle,
  type MarketConfig,
  type Prediction,
  type SettlementResult,
} from '../engine/engine.ts';

const MINUTE = 60_000;
export const START_POINTS = 1_000;
export const DAILY_POINTS = 100;
export const MIN_STAKE = 10;

export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export const SESSION_MS = 30 * 24 * 60 * 60_000;
/** Wrong email-code guesses allowed per address per day, across all codes sent to it. */
export const EMAIL_CODE_DAILY_FAILURES = 20;

export interface UserRow {
  id: string;
  email: string | null;
  username: string;
  needs_username: number;
  password_hash: string | null;
  points: number;
  last_claim_day: string | null;
  created_at: number;
}

interface MarketRow {
  id: string;
  symbol: string;
  name: string | null;
  exchange: string;
  venues: string;
  source_url: string | null;
  announced_listing_at: number;
  listing_at: number;
  opened_at: number;
  config: string;
  scorecard: string | null;
  status: 'open' | 'locked' | 'resolved' | 'void';
  kind: 'listing' | 'live_test';
  hard_cap: number | null;
  retracted: number;
  halted_ms: number;
  created_at: number;
  mode: 'auto' | 'manual';
  published: number;
  base_price: number | null;
  note: string | null;
}

interface PredictionRow {
  id: string;
  market_id: string;
  user_id: string;
  bucket: Bucket;
  stake: number;
  placed_at: number;
  accepted: number | null;
  refund: number | null;
  weight: number | null;
  payout: number | null;
}

export interface VenueRef {
  venue: string;
  symbol: string;
}

export interface Scorecard {
  fdvUsd?: number;
  circulatingPct?: number;
  airdropPct?: number;
  unlocks?: string;
  notes?: string;
}

export interface CreateMarketInput {
  symbol: string;
  name?: string;
  exchange: string;
  venues: VenueRef[];
  sourceUrl?: string;
  announcedListingAt: number;
  listingAt: number;
  config?: Partial<MarketConfig>;
  scorecard?: Scorecard;
  kind?: 'listing' | 'live_test';
}

export interface ManualMarketInput {
  symbol: string;
  name?: string;
  /** Exchange ids, e.g. ['binance', 'okx']. */
  exchanges: string[];
  /** Optional trading pair per exchange; defaults to SYMBOLUSDT in each exchange's format. */
  pairs?: Record<string, string>;
  /** Reference price the outcome is measured against. */
  basePrice: number;
  /** When predictions stop (ms). */
  closeAt: number;
  /** When the admin expects to share the result (ms). Informational. */
  resultAt?: number;
  config?: Partial<MarketConfig>;
  note?: string;
  sourceUrl?: string;
  publish?: boolean;
}

export interface ResolveInput {
  finalPrice: number;
  /** Overrides the start price entered when the market was created. */
  basePrice?: number;
  /** Overrides the bucket implied by the prices (e.g. when the price source was disputed). */
  winningBucket?: Bucket;
  note?: string;
}

const MIN_MS = 60_000;

/** Market lengths for live test markets on tokens that already trade. */
export const LIVE_PRESETS: Record<string, { label: string; config: Partial<MarketConfig> }> = {
  quick: { label: '15 minutes', config: { baselineMs: 3 * MIN_MS, durationMs: 15 * MIN_MS, settleWindowMs: 3 * MIN_MS, minTrades: 1, minCoverage: 0.5 } },
  hour: { label: '1 hour', config: { baselineMs: 10 * MIN_MS, durationMs: 60 * MIN_MS, settleWindowMs: 10 * MIN_MS, minTrades: 1 } },
  day: { label: '24 hours', config: { baselineMs: 60 * MIN_MS, durationMs: 24 * 60 * MIN_MS, settleWindowMs: 60 * MIN_MS } },
  full: { label: '72 hours', config: {} },
};

/** Recently listed and major tokens for testing with real prices. Unavailable pairs are skipped. */
export const SUGGESTED_LIVE_TOKENS = [
  { symbol: 'HIMSB', name: 'Hims & Hers tokenized stock', note: 'Binance spot listing, Sep 9 2026' },
  { symbol: 'CRMB', name: 'Salesforce tokenized stock', note: 'Binance spot listing, Sep 9 2026' },
  { symbol: 'TMX', name: 'TermMax', note: 'Bitget listing, Aug 26 2026' },
  { symbol: 'ALIGN', name: 'Aligned', note: 'Bitget listing, Aug 21 2026' },
  { symbol: 'KII', name: 'Kiichain', note: 'Bitget listing, Aug 18 2026' },
  { symbol: 'GRVT', name: 'Grvt', note: 'OKX listing, Jul 30 2026' },
  { symbol: 'AEON', name: 'Aeon', note: 'OKX listing, Jul 27 2026' },
  { symbol: 'SOL', name: 'Solana', note: 'Major, always available' },
  { symbol: 'BTC', name: 'Bitcoin', note: 'Major, always available' },
  { symbol: 'ETH', name: 'Ethereum', note: 'Major, always available' },
];

export interface Notification {
  userId: string;
  marketId: string;
  symbol: string;
  status: 'resolved' | 'void';
  voidReason: string | null;
  winningBucket: Bucket | null;
  staked: number;
  payout: number;
  refund: number;
}

const as = <T>(v: unknown) => v as T;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FirstprintService {
  db: DB;
  clock: Clock;
  venues: Map<string, Venue>;
  log: (msg: string) => void;
  /** Latest live ticker per market, filled by LiveFeed. */
  livePrices = new Map<string, { price: number; ts: number }>();
  /** Event hook for live updates (SSE). */
  onEvent: (type: 'market' | 'price' | 'listing', data: Record<string, unknown>) => void = () => {};

  constructor(db: DB, clock: Clock, venues: Venue[], log: (msg: string) => void = () => {}) {
    this.db = db;
    this.clock = clock;
    this.venues = new Map(venues.map((v) => [v.id, v]));
    this.log = log;
  }

  // --- Users & points ------------------------------------------------------

  private credit(userId: string, delta: number, reason: string, ref: string | null) {
    if (delta === 0) return;
    const res = this.db
      .prepare('UPDATE users SET points = points + ? WHERE id = ? AND points + ? >= 0')
      .run(delta, userId, delta);
    if (res.changes !== 1) throw new AppError(400, 'insufficient_points', 'Not enough points for this prediction.');
    this.db
      .prepare('INSERT INTO ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, delta, reason, ref, this.clock.now());
  }

  /** Creates an account. Omit password for system accounts that can't log in. */
  async createUser(input: { email?: string | null; username: string; password?: string }): Promise<UserRow> {
    const username = String(input.username ?? '').trim();
    const email = input.email ? String(input.email).trim().toLowerCase() : null;
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      throw new AppError(400, 'bad_username', 'Username must be 3–20 letters, numbers, or underscores.');
    }
    if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError(400, 'bad_email', 'Enter a valid email address.');
    }
    if (input.password !== undefined && (input.password.length < 8 || input.password.length > 200)) {
      throw new AppError(400, 'bad_password', 'Password must be at least 8 characters.');
    }
    const passwordHash = input.password !== undefined ? await hashPassword(input.password) : null;

    return tx(this.db, () => {
      const taken = as<{ email: string | null; username: string } | undefined>(
        this.db.prepare('SELECT email, username FROM users WHERE email = ? OR username = ? COLLATE NOCASE').get(email, username),
      );
      if (taken) {
        if (email && taken.email === email) throw new AppError(409, 'email_taken', 'An account with this email already exists. Log in instead.');
        throw new AppError(409, 'username_taken', 'That username is taken. Try another.');
      }
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO users (id, email, username, password_hash, points, created_at) VALUES (?, ?, ?, ?, 0, ?)')
        .run(id, email, username, passwordHash, this.clock.now());
      this.credit(id, START_POINTS, 'signup', null);
      return this.getUser(id);
    });
  }

  async authenticate(email: string, password: string): Promise<UserRow> {
    const u = as<UserRow | undefined>(
      this.db.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? '').trim().toLowerCase()),
    );
    // Always run a hash comparison so response time doesn't reveal which emails exist.
    const ok = await verifyPassword(String(password ?? ''), u?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AA==');
    if (!u || !ok) throw new AppError(401, 'bad_credentials', 'Email or password is incorrect.');
    return u;
  }

  // --- Email codes and identity sign-in (Google, email) --------------------------

  /**
   * Creates a one-time sign-in code for an email address. The caller sends it.
   * Replaces any earlier code and refuses to issue a new one within 30 seconds.
   */
  startEmailLogin(emailInput: string): { email: string; code: string; expiresAt: number } {
    const email = String(emailInput ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
      throw new AppError(400, 'bad_email', 'Enter a valid email address.');
    }
    const now = this.clock.now();
    const prev = as<{ created_at: number } | undefined>(this.db.prepare('SELECT created_at FROM email_codes WHERE email = ?').get(email));
    if (prev && now - prev.created_at < 30_000) {
      throw new AppError(429, 'code_recently_sent', 'We just sent a code. Wait a few seconds to request another.');
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = now + 10 * MINUTE;
    this.db.prepare('DELETE FROM email_codes WHERE expires_at < ?').run(now - MINUTE);
    this.db.prepare('DELETE FROM email_code_failures WHERE window_start < ?').run(now - 24 * 60 * MINUTE);
    this.db
      .prepare('INSERT OR REPLACE INTO email_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(email, sha256(`${email}:${code}`), expiresAt, now);
    return { email, code, expiresAt };
  }

  /** Checks an emailed code (single use, 5 tries) and signs in, creating the account on first use. */
  verifyEmailCode(emailInput: string, codeInput: string): { user: UserRow; created: boolean } {
    const email = String(emailInput ?? '').trim().toLowerCase();
    const code = String(codeInput ?? '').replace(/\s/g, '');
    const bad = () => new AppError(401, 'bad_code', 'That code is wrong or has expired. Check it and try again, or request a new one.');
    const now = this.clock.now();
    const failures = as<{ failures: number; window_start: number } | undefined>(
      this.db.prepare('SELECT failures, window_start FROM email_code_failures WHERE email = ?').get(email),
    );
    if (failures && now - failures.window_start < 24 * 60 * MINUTE && failures.failures >= EMAIL_CODE_DAILY_FAILURES) {
      throw new AppError(429, 'too_many_attempts', 'Too many wrong codes for this email. Try again tomorrow, or sign in with Google or a wallet.');
    }
    // A wrong guess must be counted even though it fails, so the failure is thrown
    // after the transaction commits instead of rolling the counter back.
    const outcome = tx(this.db, () => {
      const row = as<{ code_hash: string; expires_at: number; attempts: number } | undefined>(
        this.db.prepare('SELECT * FROM email_codes WHERE email = ?').get(email),
      );
      if (!row || row.expires_at < now || row.attempts >= 5) return null;
      const given = Buffer.from(sha256(`${email}:${code}`));
      const want = Buffer.from(row.code_hash);
      if (!/^\d{6}$/.test(code) || !timingSafeEqual(given, want)) {
        this.db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
        this.db
          .prepare(
            `INSERT INTO email_code_failures (email, failures, window_start) VALUES (?, 1, ?)
             ON CONFLICT(email) DO UPDATE SET
               failures = CASE WHEN ? - window_start >= ? THEN 1 ELSE failures + 1 END,
               window_start = CASE WHEN ? - window_start >= ? THEN excluded.window_start ELSE window_start END`,
          )
          .run(email, now, now, 24 * 60 * MINUTE, now, 24 * 60 * MINUTE);
        return null;
      }
      this.db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
      this.db.prepare('DELETE FROM email_code_failures WHERE email = ?').run(email);
      return this.findOrCreateByEmail(email, null);
    });
    if (!outcome) throw bad();
    return outcome;
  }

  /**
   * Signs in a person whose email has been verified (by an emailed code or by
   * Google). The same email always reaches the same account, so someone can log
   * in with Google one day and an email code the next. Existing password
   * accounts are matched by email too.
   */
  signInWithVerifiedEmail(email: string, name: string | null): { user: UserRow; created: boolean } {
    return tx(this.db, () => this.findOrCreateByEmail(email, name));
  }

  private findOrCreateByEmail(email: string, name: string | null): { user: UserRow; created: boolean } {
    const found = as<UserRow | undefined>(this.db.prepare('SELECT * FROM users WHERE email = ?').get(email));
    if (found?.password_hash) {
      // Password accounts were created without proving the email belonged to whoever signed up.
      // The first verified sign-in takes the account over: the password, other sessions and linked
      // wallets are dropped, so someone who registered another person's email loses all access.
      this.db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(found.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(found.id);
      this.db.prepare('DELETE FROM wallets WHERE user_id = ?').run(found.id);
      this.log(`email verified for password account ${found.id}: password, sessions and wallets cleared`);
      return { user: this.getUser(found.id), created: false };
    }
    if (found) return { user: found, created: false };
    const base = (name ?? email.split('@')[0]).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) || 'player';
    let username = base.length >= 3 ? base : `${base}_user`.slice(0, 16);
    for (let i = 2; this.db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username); i++) {
      username = `${base.slice(0, 16)}${i}`;
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO users (id, email, username, needs_username, password_hash, points, created_at) VALUES (?, ?, ?, 1, NULL, 0, ?)')
      .run(id, email, username, this.clock.now());
    this.credit(id, START_POINTS, 'signup', null);
    this.log(`email sign-up ${email}`);
    return { user: this.getUser(id), created: true };
  }

  // --- Solana wallets ----------------------------------------------------------

  /** Issues a one-time Sign-In With Solana message for this address. */
  walletChallenge(address: string, site: { domain: string; uri: string; chainId?: 'mainnet' | 'devnet' | 'testnet' }) {
    if (!isSolanaAddress(address)) throw new AppError(400, 'bad_address', 'That is not a valid Solana address.');
    const now = this.clock.now();
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = now + 5 * 60_000;
    const message = buildSiwsMessage({
      domain: site.domain,
      address,
      statement: 'Sign in to Firstprint. This request will not trigger a transaction or cost any fees.',
      uri: site.uri,
      chainId: site.chainId,
      nonce,
      issuedAt: new Date(now).toISOString(),
      expirationTime: new Date(expiresAt).toISOString(),
    });
    this.db.prepare('DELETE FROM auth_nonces WHERE expires_at < ?').run(now);
    this.db.prepare('INSERT INTO auth_nonces (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)').run(nonce, address, message, expiresAt);
    return { message, nonce, expiresAt };
  }

  /** Checks the signed challenge and marks it used. Throws if anything is off. */
  private consumeChallenge(address: string, message: string, signature: string) {
    if (!isSolanaAddress(address)) throw new AppError(400, 'bad_address', 'That is not a valid Solana address.');
    const nonce = /\nNonce: ([0-9a-f]{32})\n/.exec(String(message ?? ''))?.[1];
    const row = nonce
      ? as<{ address: string; message: string; expires_at: number; used: number } | undefined>(
          this.db.prepare('SELECT * FROM auth_nonces WHERE nonce = ?').get(nonce),
        )
      : undefined;
    const invalid = () => new AppError(401, 'bad_signature', 'Wallet sign-in failed. Try connecting again.');
    if (!row || row.used || row.address !== address || row.message !== message) throw invalid();
    if (row.expires_at < this.clock.now()) throw new AppError(401, 'challenge_expired', 'The sign-in request expired. Try again.');
    const sig = decodeSignature(signature);
    if (!sig || !verifyEd25519(address, new TextEncoder().encode(message), sig)) throw invalid();
    const res = this.db.prepare('UPDATE auth_nonces SET used = 1 WHERE nonce = ? AND used = 0').run(nonce!);
    if (res.changes !== 1) throw invalid();
  }

  /** Signs in with a wallet, creating an account on first use. */
  walletSignIn(input: { address: string; message: string; signature: string; walletName?: string }): { user: UserRow; created: boolean } {
    return tx(this.db, () => {
      this.consumeChallenge(input.address, input.message, input.signature);
      const now = this.clock.now();
      const existing = as<{ user_id: string } | undefined>(this.db.prepare('SELECT user_id FROM wallets WHERE address = ?').get(input.address));
      if (existing) {
        this.db.prepare('UPDATE wallets SET last_login = ?, wallet_name = COALESCE(?, wallet_name) WHERE address = ?').run(now, input.walletName ?? null, input.address);
        return { user: this.getUser(existing.user_id), created: false };
      }
      const base = `sol_${input.address.slice(0, 6)}`;
      let username = base;
      for (let i = 2; this.db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username); i++) username = `${base}${i}`;
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO users (id, email, username, needs_username, password_hash, points, created_at) VALUES (?, NULL, ?, 1, NULL, 0, ?)')
        .run(id, username, now);
      this.credit(id, START_POINTS, 'signup', input.address);
      this.db
        .prepare('INSERT INTO wallets (address, user_id, wallet_name, verified_at, last_login) VALUES (?, ?, ?, ?, ?)')
        .run(input.address, id, input.walletName ?? null, now, now);
      this.log(`wallet sign-up ${input.address}`);
      return { user: this.getUser(id), created: true };
    });
  }

  /** Links a wallet to an existing signed-in account. */
  linkWallet(userId: string, input: { address: string; message: string; signature: string; walletName?: string }) {
    return tx(this.db, () => {
      this.consumeChallenge(input.address, input.message, input.signature);
      const owner = as<{ user_id: string } | undefined>(this.db.prepare('SELECT user_id FROM wallets WHERE address = ?').get(input.address));
      if (owner && owner.user_id !== userId) throw new AppError(409, 'wallet_taken', 'This wallet is already linked to another account.');
      if (!owner) {
        this.db
          .prepare('INSERT INTO wallets (address, user_id, wallet_name, verified_at) VALUES (?, ?, ?, ?)')
          .run(input.address, userId, input.walletName ?? null, this.clock.now());
      }
      return this.walletsFor(userId);
    });
  }

  walletsFor(userId: string) {
    return as<{ address: string; wallet_name: string | null; verified_at: number }[]>(
      this.db.prepare('SELECT address, wallet_name, verified_at FROM wallets WHERE user_id = ? ORDER BY verified_at').all(userId),
    ).map((w) => ({ address: w.address, walletName: w.wallet_name, verifiedAt: w.verified_at }));
  }

  setUsername(userId: string, username: string) {
    username = String(username ?? '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      throw new AppError(400, 'bad_username', 'Username must be 3–20 letters, numbers, or underscores.');
    }
    const taken = this.db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id <> ?').get(username, userId);
    if (taken) throw new AppError(409, 'username_taken', 'That username is taken. Try another.');
    this.db.prepare('UPDATE users SET username = ?, needs_username = 0 WHERE id = ?').run(username, userId);
    return this.getUser(userId);
  }

  createSession(userId: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const expiresAt = now + SESSION_MS;
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, expiresAt, now);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    return { token, expiresAt };
  }

  userForSession(token: string): UserRow | null {
    if (!token) return null;
    const row = as<{ user_id: string; expires_at: number } | undefined>(
      this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)),
    );
    if (!row || row.expires_at < this.clock.now()) return null;
    return this.getUser(row.user_id);
  }

  deleteSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  getUser(id: string): UserRow {
    const u = as<UserRow | undefined>(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    if (!u) throw new AppError(404, 'user_not_found', 'User not found.');
    return u;
  }

  claimDaily(userId: string) {
    return tx(this.db, () => {
      const day = new Date(this.clock.now()).toISOString().slice(0, 10);
      const u = this.getUser(userId);
      if (u.last_claim_day === day) {
        throw new AppError(409, 'already_claimed', 'Daily points already claimed. Come back tomorrow (UTC).');
      }
      this.db.prepare('UPDATE users SET last_claim_day = ? WHERE id = ?').run(day, userId);
      this.credit(userId, DAILY_POINTS, 'daily', day);
      return this.getUser(userId);
    });
  }

  // --- Markets: admin -------------------------------------------------------

  createMarket(input: CreateMarketInput): string {
    const symbol = String(input.symbol ?? '').toUpperCase();
    if (!/^[A-Z0-9]{2,15}$/.test(symbol)) throw new AppError(400, 'bad_symbol', 'Symbol must be 2–15 letters or digits.');
    if (!input.exchange) throw new AppError(400, 'bad_exchange', 'Exchange is required.');
    if (!Array.isArray(input.venues) || input.venues.length === 0) {
      throw new AppError(400, 'bad_venues', 'At least one price venue is required.');
    }
    for (const v of input.venues) {
      if (!this.venues.has(v.venue)) throw new AppError(400, 'unknown_venue', `Unknown venue "${v.venue}".`);
      if (!v.symbol) throw new AppError(400, 'bad_venues', 'Each venue needs a trading symbol, e.g. XYZUSDT.');
    }
    const now = this.clock.now();
    if (!Number.isFinite(input.listingAt) || input.listingAt <= now) {
      throw new AppError(400, 'bad_listing_time', 'Listing time must be in the future.');
    }
    if (!Number.isFinite(input.announcedListingAt)) {
      throw new AppError(400, 'bad_listing_time', 'Announced listing time is required.');
    }

    const cfg = mergeConfig(input.config);
    const id = `${symbol.toLowerCase()}-${input.exchange.toLowerCase()}-${randomUUID().slice(0, 6)}`;
    this.db
      .prepare(
        `INSERT INTO markets (id, symbol, name, exchange, venues, source_url, announced_listing_at, listing_at,
          opened_at, config, scorecard, status, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        id,
        symbol,
        input.name ?? null,
        input.exchange,
        JSON.stringify(input.venues),
        input.sourceUrl ?? null,
        input.announcedListingAt,
        input.listingAt,
        now,
        JSON.stringify(cfg),
        input.scorecard ? JSON.stringify(input.scorecard) : null,
        input.kind ?? 'listing',
        now,
      );
    this.log(`market created ${id}`);
    return id;
  }

  /**
   * Creates a test market on a token that already trades, using real exchange
   * prices. Every requested exchange is checked for a live USDT price first;
   * the market uses all exchanges that respond (volume-weighted median).
   */
  async createLiveMarket(input: { symbol: string; name?: string; exchanges?: string[]; startsInMs?: number; preset?: string }) {
    const symbol = String(input.symbol ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,15}$/.test(symbol)) throw new AppError(400, 'bad_symbol', 'Symbol must be 2–15 letters or digits, e.g. SOL.');
    const preset = LIVE_PRESETS[input.preset ?? 'quick'];
    if (!preset) throw new AppError(400, 'bad_preset', `Length must be one of: ${Object.keys(LIVE_PRESETS).join(', ')}.`);
    const startsInMs = Math.max(MIN_MS, Math.min(24 * 60 * MIN_MS, Number(input.startsInMs ?? 2 * MIN_MS)));

    const candidates = (input.exchanges?.length ? input.exchanges : [...this.venues.keys()].filter((v) => v !== 'sim'))
      .map((id) => this.venues.get(id))
      .filter((v): v is Venue => Boolean(v));
    if (candidates.length === 0) throw new AppError(400, 'bad_exchanges', 'Choose at least one supported exchange.');

    const checks = await Promise.all(
      candidates.map(async (venue) => {
        const pair = venue.pair(symbol);
        try {
          const t = await Promise.race([
            venue.fetchTicker(pair),
            new Promise<null>((_, rej) => setTimeout(() => rej(new Error('timed out')), 8_000)),
          ]);
          return { venue, pair, price: t?.price ?? null, error: t ? null : 'no price' };
        } catch (err) {
          return { venue, pair, price: null, error: (err as Error).message };
        }
      }),
    );
    const live = checks.filter((c) => c.price !== null && c.price > 0);
    if (live.length === 0) {
      const detail = checks.map((c) => `${c.venue.name}: ${c.error}`).join('; ');
      throw new AppError(422, 'not_trading', `${symbol}/USDT has no live price on the selected exchanges (${detail}).`);
    }

    const listingAt = this.clock.now() + startsInMs;
    const marketId = this.createMarket({
      symbol,
      name: input.name,
      exchange: live.length === 1 ? live[0].venue.name : `${live[0].venue.name} +${live.length - 1}`,
      venues: live.map((c) => ({ venue: c.venue.id, symbol: c.pair })),
      announcedListingAt: listingAt,
      listingAt,
      config: preset.config,
      kind: 'live_test',
    });
    return {
      marketId,
      exchanges: live.map((c) => ({ id: c.venue.id, name: c.venue.name, pair: c.pair, price: c.price })),
      skipped: checks.filter((c) => c.price === null).map((c) => ({ id: c.venue.id, name: c.venue.name, reason: c.error })),
    };
  }

  /** Cancels a market immediately and refunds every stake. */
  cancelMarket(marketId: string) {
    return tx(this.db, () => {
      const m = this.row(marketId);
      if (m.status === 'resolved' || m.status === 'void') throw new AppError(409, 'already_settled', 'This market has already settled.');
      const rows = this.predictions(marketId);
      for (const p of rows) {
        const alreadyRefunded = p.refund ?? 0;
        const give = p.stake - alreadyRefunded;
        if (give > 0) this.credit(p.user_id, give, 'refund', p.id);
        this.db.prepare('UPDATE predictions SET refund = ?, payout = 0 WHERE id = ?').run(p.stake, p.id);
      }
      const result = {
        pool: rows.reduce((s, p) => s + p.stake, 0),
        fee: 0,
        netPool: 0,
        dust: 0,
        voidReason: 'retracted',
        payouts: rows.map((p) => ({ predictionId: p.id, userId: p.user_id, bucket: p.bucket, accepted: p.accepted ?? p.stake, refund: p.stake, payout: 0, weight: p.weight ?? 1 })),
        baseline: { start: m.listing_at, end: m.listing_at, price: null, venues: [] },
        final: { start: m.listing_at, end: m.listing_at, price: null, venues: [] },
        returnPct: null,
        winningBucket: null,
      };
      const now = this.clock.now();
      this.db
        .prepare('INSERT INTO settlements (market_id, result, data_hash, settled_at) VALUES (?, ?, ?, ?)')
        .run(marketId, JSON.stringify(result), createHash('sha256').update(`cancelled:${marketId}:${now}`).digest('hex'), now);
      this.db.prepare("UPDATE markets SET status = 'void', retracted = 1 WHERE id = ?").run(marketId);
      this.livePrices.delete(marketId);
      queueMicrotask(() => this.onEvent('market', { marketId }));
      this.log(`market cancelled ${marketId}`);
      return { ok: true, refunded: rows.length };
    });
  }

  /** Calls every real exchange adapter once and reports what works. */
  async checkExchanges() {
    const results = [];
    for (const venue of this.venues.values()) {
      if (venue.id === 'sim') continue;
      const pair = venue.pair('BTC');
      const run = async <T>(fn: () => Promise<T>) => {
        const t0 = Date.now();
        try {
          const value = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 15s')), 15_000))]);
          return { ok: true, ms: Date.now() - t0, value, error: null as string | null };
        } catch (err) {
          return { ok: false, ms: Date.now() - t0, value: null, error: (err as Error).message };
        }
      };
      const now = Date.now();
      const ticker = await run(() => venue.fetchTicker(pair));
      const candles = await run(() => venue.fetchCandles(pair, now - 15 * MIN_MS, now));
      const pairs = await run(() => venue.listPairs());
      const anns = venue.fetchAnnouncements ? await run(() => venue.fetchAnnouncements!()) : null;
      results.push({
        id: venue.id,
        name: venue.name,
        ticker: { ok: ticker.ok && Boolean(ticker.value), ms: ticker.ms, detail: ticker.value ? `BTC ${ticker.value.price}` : ticker.error ?? 'no price' },
        candles: { ok: candles.ok && (candles.value?.length ?? 0) >= 5, ms: candles.ms, detail: candles.ok ? `${candles.value!.length} candles in last 15 min` : candles.error },
        pairs: { ok: pairs.ok && (pairs.value?.length ?? 0) > 10, ms: pairs.ms, detail: pairs.ok ? `${pairs.value!.length} USDT pairs` : pairs.error },
        announcements: anns
          ? { ok: anns.ok && (anns.value?.length ?? 0) > 0, ms: anns.ms, detail: anns.ok ? `${anns.value!.length} items, latest: ${anns.value![0]?.title ?? 'none'}` : anns.error }
          : { ok: null, ms: 0, detail: 'Not offered by this exchange' },
      });
    }
    return results;
  }

  adminMarkets() {
    const rows = as<MarketRow[]>(this.db.prepare('SELECT * FROM markets ORDER BY created_at DESC LIMIT 200').all());
    return rows.map((r) => this.view(r));
  }

  venueList() {
    return [...this.venues.values()].map((v) => ({ id: v.id, name: v.name, announcements: Boolean(v.fetchAnnouncements) }));
  }

  /** Records the actual trading start (T0) if it differs from the announcement. */
  setListingTime(marketId: string, listingAt: number) {
    const m = this.row(marketId);
    const now = this.clock.now();
    if (m.status !== 'open' || now >= m.listing_at) {
      throw new AppError(409, 'too_late', 'Listing time can only change before trading starts.');
    }
    if (!(listingAt > now)) throw new AppError(400, 'bad_listing_time', 'Listing time must be in the future.');
    this.db.prepare('UPDATE markets SET listing_at = ? WHERE id = ?').run(listingAt, marketId);
  }

  retract(marketId: string) {
    this.db.prepare('UPDATE markets SET retracted = 1 WHERE id = ?').run(marketId);
  }

  addHalt(marketId: string, ms: number) {
    this.db.prepare('UPDATE markets SET halted_ms = halted_ms + ? WHERE id = ?').run(Math.max(0, ms), marketId);
  }

  // --- Markets: manual (admin-run) ---------------------------------------------
  //
  // An admin creates a draft, publishes it, and users predict until the close
  // time. The market then waits (status "locked", phase "awaiting_result")
  // until the admin enters the final price, which picks the winning bucket and
  // pays the pool out. No exchange data is fetched.

  exchangeSettings() {
    const off = this.disabledExchanges();
    return [...this.venues.values()].map((v) => ({ id: v.id, name: v.name, enabled: !off.has(v.id) }));
  }

  setExchangeEnabled(id: string, enabled: boolean) {
    if (!this.venues.has(id)) throw new AppError(404, 'unknown_venue', `Unknown exchange "${id}".`);
    const off = this.disabledExchanges();
    if (enabled) off.delete(id);
    else off.add(id);
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('exchanges_disabled', JSON.stringify([...off]));
    return this.exchangeSettings();
  }

  private disabledExchanges(): Set<string> {
    const r = as<{ value: string } | undefined>(this.db.prepare("SELECT value FROM settings WHERE key = 'exchanges_disabled'").get());
    return new Set(r ? (JSON.parse(r.value) as string[]) : []);
  }

  private manualFields(input: ManualMarketInput, now: number) {
    const symbol = String(input.symbol ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,15}$/.test(symbol)) throw new AppError(400, 'bad_symbol', 'Token symbol must be 2–15 letters or digits.');
    const exchanges = [...new Set((input.exchanges ?? []).map(String))];
    if (exchanges.length === 0) throw new AppError(400, 'bad_exchanges', 'Choose at least one exchange.');
    const off = this.disabledExchanges();
    for (const id of exchanges) {
      if (!this.venues.has(id)) throw new AppError(400, 'unknown_venue', `Unknown exchange "${id}".`);
      if (off.has(id)) throw new AppError(400, 'exchange_off', `${this.venues.get(id)!.name} is switched off in Admin → Exchanges.`);
    }
    const basePrice = Number(input.basePrice);
    if (!(basePrice > 0) || !Number.isFinite(basePrice)) throw new AppError(400, 'bad_price', 'Start price must be a number above 0.');
    const closeAt = Number(input.closeAt);
    if (!Number.isFinite(closeAt)) throw new AppError(400, 'bad_close_time', 'Prediction close time is required.');
    const resultAt = input.resultAt === undefined || input.resultAt === null ? closeAt + 24 * 60 * MINUTE : Number(input.resultAt);
    if (!(resultAt > closeAt)) throw new AppError(400, 'bad_result_time', 'Expected result time must be after the close time.');
    const cfg = mergeConfig({
      ...input.config,
      baselineMs: 0,
      durationMs: resultAt - closeAt,
      settleWindowMs: 0,
    });
    const pairs = input.pairs ?? {};
    const venues: VenueRef[] = exchanges.map((id) => ({ venue: id, symbol: pairs[id] || this.venues.get(id)!.pair(symbol) }));
    const exchangeLabel = exchanges.map((id) => this.venues.get(id)!.name).join(', ');
    const name = input.name ? String(input.name).trim().slice(0, 80) : null;
    const note = input.note ? String(input.note).trim().slice(0, 2000) : null;
    const sourceUrl = input.sourceUrl ? String(input.sourceUrl).trim().slice(0, 500) : null;
    void now;
    return { symbol, name, venues, exchangeLabel, basePrice, closeAt, cfg, note, sourceUrl };
  }

  /** Creates a draft (hidden from users) or, with publish: true, an open market. */
  createManualMarket(input: ManualMarketInput): string {
    const now = this.clock.now();
    const f = this.manualFields(input, now);
    if (f.closeAt <= now) throw new AppError(400, 'bad_close_time', 'Prediction close time must be in the future.');
    const id = `${f.symbol.toLowerCase()}-m-${randomUUID().slice(0, 6)}`;
    this.db
      .prepare(
        `INSERT INTO markets (id, symbol, name, exchange, venues, source_url, announced_listing_at, listing_at,
          opened_at, config, scorecard, status, kind, created_at, mode, published, base_price, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', 'listing', ?, 'manual', ?, ?, ?)`,
      )
      .run(id, f.symbol, f.name, f.exchangeLabel, JSON.stringify(f.venues), f.sourceUrl, f.closeAt, f.closeAt, now, JSON.stringify(f.cfg), now, input.publish ? 1 : 0, f.basePrice, f.note);
    this.log(`manual market ${input.publish ? 'published' : 'drafted'} ${id}`);
    if (input.publish) this.onEvent('market', { marketId: id });
    return id;
  }

  /**
   * Edits a manual market that has not closed. Once users have predicted, the
   * rules they predicted under (price, thresholds, fee, caps) are locked and
   * the close time can only move later.
   */
  updateManualMarket(marketId: string, patch: Partial<ManualMarketInput>): string {
    const m = this.manualRow(marketId);
    const now = this.clock.now();
    if (m.status !== 'open') throw new AppError(409, 'not_editable', 'Only markets that are still taking predictions can be edited.');
    const hasPredictions = this.predictions(marketId).length > 0;
    const cfg = parseConfig(m);
    const current: ManualMarketInput = {
      symbol: m.symbol,
      name: m.name ?? undefined,
      exchanges: (JSON.parse(m.venues) as VenueRef[]).map((v) => v.venue),
      pairs: Object.fromEntries((JSON.parse(m.venues) as VenueRef[]).map((v) => [v.venue, v.symbol])),
      basePrice: m.base_price ?? 0,
      closeAt: m.listing_at,
      resultAt: m.listing_at + cfg.durationMs,
      config: cfg,
      note: m.note ?? undefined,
      sourceUrl: m.source_url ?? undefined,
    };
    if (m.published === 1 && hasPredictions) {
      const locked = ['symbol', 'basePrice', 'config'] as const;
      for (const k of locked) {
        if (patch[k] !== undefined) throw new AppError(409, 'locked_field', `"${k}" can't change after users have predicted. Cancel and refund the market instead.`);
      }
      if (patch.closeAt !== undefined && Number(patch.closeAt) < m.listing_at) {
        throw new AppError(409, 'locked_field', 'The close time can only be moved later once users have predicted.');
      }
    }
    const merged: ManualMarketInput = { ...current, ...patch, config: { ...current.config, ...patch.config } };
    // A new exchange list must produce new pairs, not keep the old ones.
    if (patch.exchanges && !patch.pairs) merged.pairs = {};
    const f = this.manualFields(merged, now);
    if (f.closeAt <= now) throw new AppError(400, 'bad_close_time', 'Prediction close time must be in the future.');
    this.db
      .prepare(
        `UPDATE markets SET symbol = ?, name = ?, exchange = ?, venues = ?, source_url = ?, announced_listing_at = ?,
          listing_at = ?, config = ?, base_price = ?, note = ? WHERE id = ?`,
      )
      .run(f.symbol, f.name, f.exchangeLabel, JSON.stringify(f.venues), f.sourceUrl, f.closeAt, f.closeAt, JSON.stringify(f.cfg), f.basePrice, f.note, marketId);
    if (m.published === 1) this.onEvent('market', { marketId }); // drafts stay private
    return marketId;
  }

  publishMarket(marketId: string) {
    const m = this.manualRow(marketId);
    const now = this.clock.now();
    if (m.status !== 'open') throw new AppError(409, 'not_editable', 'This market is no longer open.');
    if (m.published === 1) return;
    if (m.listing_at <= now) throw new AppError(409, 'bad_close_time', 'The prediction close time has passed. Edit it before publishing.');
    this.db.prepare('UPDATE markets SET published = 1, opened_at = ? WHERE id = ?').run(now, marketId);
    this.onEvent('market', { marketId });
    this.log(`manual market published ${marketId}`);
  }

  /** Pulls a published market back to draft. Only possible while nobody has predicted. */
  unpublishMarket(marketId: string) {
    const m = this.manualRow(marketId);
    if (m.status !== 'open' || m.published === 0) return;
    if (this.predictions(marketId).length > 0) {
      throw new AppError(409, 'has_predictions', 'Users have already predicted. Cancel and refund the market instead.');
    }
    this.db.prepare('UPDATE markets SET published = 0 WHERE id = ?').run(marketId);
    this.onEvent('market', { marketId });
  }

  deleteDraft(marketId: string) {
    const m = this.manualRow(marketId);
    if (m.published === 1 || this.predictions(marketId).length > 0) {
      throw new AppError(409, 'not_a_draft', 'Only unpublished drafts can be deleted. Cancel a published market to refund it.');
    }
    this.db.prepare('DELETE FROM markets WHERE id = ?').run(marketId);
  }

  /** Shows what resolving would do (winning bucket, winners, payouts) without paying anything. */
  previewResolution(marketId: string, input: ResolveInput) {
    const { m, plan } = this.planResolution(marketId, input);
    return this.describeResolution(m, plan);
  }

  /** Records the admin's result and pays the pool out. Returns user notifications. */
  resolveManualMarket(marketId: string, input: ResolveInput): { summary: ReturnType<FirstprintService['describeResolution']>; notes: Notification[] } {
    const { m, plan, rows } = this.planResolution(marketId, input);
    const now = this.clock.now();
    const stored = {
      ...plan.result,
      manual: { resolvedBy: 'admin', note: plan.note, overridden: plan.overridden, basePrice: plan.base, finalPrice: plan.final },
    };
    const dataHash = sha256(JSON.stringify({ marketId, base: plan.base, final: plan.final, bucket: plan.result.winningBucket, note: plan.note, at: now }));
    const notes = this.commitSettlement(m, rows, stored, dataHash, now);
    return { summary: this.describeResolution(m, plan, true), notes };
  }

  private manualRow(marketId: string): MarketRow {
    const m = this.row(marketId);
    if (m.mode !== 'manual') throw new AppError(409, 'not_manual', 'This market is settled automatically from exchange data.');
    return m;
  }

  private planResolution(marketId: string, input: ResolveInput) {
    let m = this.manualRow(marketId);
    // The scheduler locks markets on its next tick; don't make the admin wait for it.
    if (m.status === 'open' && m.published === 1 && this.clock.now() >= m.listing_at) {
      this.closeDueMarkets();
      m = this.manualRow(marketId);
    }
    if (m.status === 'open') throw new AppError(409, 'still_open', 'Predictions are still open. Results can be entered after the close time.');
    if (m.status !== 'locked') throw new AppError(409, 'already_settled', 'This market has already been settled.');

    const cfg = parseConfig(m);
    const final = Number(input.finalPrice);
    if (!(final >= 0) || !Number.isFinite(final)) throw new AppError(400, 'bad_price', 'Final price must be a number.');
    const base = input.basePrice === undefined || input.basePrice === null || input.basePrice === ('' as never) ? (m.base_price ?? 0) : Number(input.basePrice);
    if (!(base > 0) || !Number.isFinite(base)) throw new AppError(400, 'bad_price', 'Start price must be a number above 0.');

    const ret = returnPct(base, final);
    const computed = bucketForReturn(ret, cfg.thresholds);
    let bucket = computed;
    if (input.winningBucket !== undefined && input.winningBucket !== null && (input.winningBucket as string) !== '') {
      if (!BUCKETS.includes(input.winningBucket)) throw new AppError(400, 'bad_bucket', 'Choose Crash, Down, Flat, Up, or Moon.');
      bucket = input.winningBucket;
    }

    const rows = this.predictions(marketId);
    const accepted = rows.map((r) => ({ ...toEnginePrediction(r), accepted: r.accepted ?? 0, refund: r.refund ?? 0, weight: r.weight ?? 1 }));
    const pool = computePayouts(accepted, bucket, cfg);
    const w = windows(cfg, m.listing_at);
    const result: SettlementResult = {
      ...pool,
      baseline: { start: m.opened_at, end: w.closeAt, price: base, venues: [] },
      final: { start: w.closeAt, end: w.settleAt, price: final, venues: [] },
      returnPct: ret,
      winningBucket: pool.voidReason ? null : bucket,
    };
    const note = input.note ? String(input.note).trim().slice(0, 2000) : null;
    return { m, rows, plan: { base, final, ret, computed, overridden: bucket !== computed, bucket, result, note } };
  }

  private describeResolution(m: MarketRow, plan: ReturnType<FirstprintService['planResolution']>['plan'], includeAll = false) {
    const usernames = new Map(
      as<{ id: string; username: string }[]>(
        this.db.prepare('SELECT DISTINCT u.id, u.username FROM predictions p JOIN users u ON u.id = p.user_id WHERE p.market_id = ?').all(m.id),
      ).map((r) => [r.id, r.username]),
    );
    const winners = plan.result.payouts
      .filter((p) => p.payout > 0)
      .sort((a, b) => b.payout - a.payout)
      .map((p) => ({ username: usernames.get(p.userId) ?? 'user', bucket: p.bucket, stake: p.accepted, payout: p.payout }));
    return {
      marketId: m.id,
      symbol: m.symbol,
      basePrice: plan.base,
      finalPrice: plan.final,
      returnPct: plan.ret,
      computedBucket: plan.computed,
      winningBucket: plan.result.winningBucket,
      overridden: plan.overridden,
      voidReason: plan.result.voidReason,
      pool: plan.result.pool,
      fee: plan.result.fee,
      netPool: plan.result.netPool,
      winnerCount: winners.length,
      totalPaid: winners.reduce((s, w) => s + w.payout, 0),
      winners: includeAll ? winners : winners.slice(0, 50),
      resolved: includeAll,
    };
  }

  // --- Points history and admin log ----------------------------------------------

  /** A user's points movements, newest first, with the market each one belongs to. */
  ledgerFor(userId: string, limit = 50) {
    const rows = as<{ id: number; delta: number; reason: string; created_at: number; symbol: string | null; market_id: string | null }[]>(
      this.db
        .prepare(
          `SELECT l.id, l.delta, l.reason, l.created_at, m.symbol, m.id AS market_id
           FROM ledger l
           LEFT JOIN predictions p ON p.id = l.ref
           LEFT JOIN markets m ON m.id = p.market_id
           WHERE l.user_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
        )
        .all(userId, Math.min(200, Math.max(1, Math.floor(limit)))),
    );
    return rows.map((r) => ({ id: r.id, delta: r.delta, reason: r.reason, at: r.created_at, symbol: r.symbol, marketId: r.market_id }));
  }

  logAdmin(action: string, target: string | null = null, detail: string | null = null, ip: string | null = null) {
    this.db
      .prepare('INSERT INTO admin_log (at, action, target, detail, ip) VALUES (?, ?, ?, ?, ?)')
      .run(this.clock.now(), action, target, detail ? detail.slice(0, 500) : null, ip);
  }

  adminLog(limit = 30) {
    const rows = as<{ id: number; at: number; action: string; target: string | null; detail: string | null; ip: string | null }[]>(
      this.db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT ?').all(Math.min(200, Math.max(1, Math.floor(limit)))),
    );
    return rows.map((r) => ({ id: r.id, at: r.at, action: r.action, target: r.target, detail: r.detail, ip: r.ip }));
  }

  // --- Predictions -----------------------------------------------------------

  placePrediction(marketId: string, userId: string, bucket: Bucket, stake: number) {
    if (!BUCKETS.includes(bucket)) throw new AppError(400, 'bad_bucket', 'Choose Crash, Down, Flat, Up, or Moon.');
    if (!Number.isInteger(stake) || stake < MIN_STAKE) {
      throw new AppError(400, 'bad_stake', `Stake must be a whole number of at least ${MIN_STAKE} points.`);
    }

    return tx(this.db, () => {
      const m = this.row(marketId);
      const cfg = parseConfig(m);
      const { closeAt } = windows(cfg, m.listing_at);
      const now = this.clock.now();
      if (m.published === 0) throw new AppError(404, 'market_not_found', 'Market not found.');
      if (m.status !== 'open' || now >= closeAt) {
        throw new AppError(409, 'market_closed', 'Predictions for this market are closed.');
      }

      const sums = as<{ pool: number; mine: number }>(
        this.db
          .prepare(
            `SELECT COALESCE(SUM(stake), 0) AS pool,
                    COALESCE(SUM(CASE WHEN user_id = ? THEN stake END), 0) AS mine
             FROM predictions WHERE market_id = ?`,
          )
          .get(userId, marketId),
      );
      if (sums.pool + stake > cfg.softCap) {
        throw new AppError(409, 'pool_full', `This pool is full. Up to ${cfg.softCap - sums.pool} points can still be added.`);
      }
      const userCap = Math.floor(cfg.softCap * cfg.perUserCapPct);
      if (sums.mine + stake > userCap) {
        throw new AppError(
          409,
          'user_cap',
          `You can stake up to ${userCap} points per market. You have ${Math.max(0, userCap - sums.mine)} left.`,
        );
      }

      const id = randomUUID();
      this.credit(userId, -stake, 'stake', id);
      this.db
        .prepare('INSERT INTO predictions (id, market_id, user_id, bucket, stake, placed_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, marketId, userId, bucket, stake, now);
      queueMicrotask(() => this.onEvent('market', { marketId }));
      return { id, balance: this.getUser(userId).points };
    });
  }

  quote(marketId: string, bucket: Bucket, stake: number) {
    if (!BUCKETS.includes(bucket)) throw new AppError(400, 'bad_bucket', 'Choose Crash, Down, Flat, Up, or Moon.');
    const m = this.publicRow(marketId);
    const cfg = parseConfig(m);
    const { closeAt } = windows(cfg, m.listing_at);
    const preds = this.predictions(marketId).map(toEnginePrediction);
    return engineQuote(preds, bucket, Math.max(0, Math.floor(stake) || 0), this.clock.now(), cfg, m.opened_at, closeAt);
  }

  // --- Lifecycle ---------------------------------------------------------------

  /** Pulls new 1-minute candles for every market that has started trading. */
  async ingestPrices() {
    const now = this.clock.now();
    const nowFloor = Math.floor(now / MINUTE) * MINUTE;
    const markets = as<MarketRow[]>(
      this.db.prepare("SELECT * FROM markets WHERE mode = 'auto' AND status IN ('open', 'locked') AND listing_at <= ?").all(now),
    );
    for (const m of markets) {
      const cfg = parseConfig(m);
      const { settleAt } = windows(cfg, m.listing_at);
      for (const ref of JSON.parse(m.venues) as VenueRef[]) {
        const venue = this.venues.get(ref.venue);
        if (!venue) continue;
        const last = as<{ ts: number | null }>(
          this.db.prepare('SELECT MAX(ts) AS ts FROM candles WHERE market_id = ? AND venue = ?').get(m.id, ref.venue),
        );
        const from = last.ts === null ? m.listing_at : last.ts + MINUTE;
        const to = Math.min(nowFloor, settleAt);
        if (from >= to) continue;
        try {
          const candles = await venue.fetchCandles(ref.symbol, from, to);
          const insert = this.db.prepare(
            'INSERT OR IGNORE INTO candles (market_id, venue, ts, close, volume, trades) VALUES (?, ?, ?, ?, ?, ?)',
          );
          tx(this.db, () => {
            for (const c of candles) insert.run(m.id, ref.venue, c.ts, c.close, c.volume, c.trades ?? null);
          });
        } catch (err) {
          this.log(`ingest failed ${m.id} ${ref.venue}: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Locks markets whose prediction window ended and applies pool caps. */
  closeDueMarkets(): string[] {
    const now = this.clock.now();
    const closed: string[] = [];
    const markets = as<MarketRow[]>(this.db.prepare("SELECT * FROM markets WHERE status = 'open' AND published = 1").all());
    for (const m of markets) {
      const cfg = parseConfig(m);
      const w = windows(cfg, m.listing_at);
      if (now < w.closeAt) continue;

      tx(this.db, () => {
        const candles = this.candlesByVenue(m.id);
        const baselineVolume = Object.values(candles).reduce(
          (s, list) => s + twap(list, w.baseline.start, w.baseline.end).volume,
          0,
        );
        const hardCap = hardCapFor(cfg, baselineVolume);
        const accepted = applyCaps(this.predictions(m.id).map(toEnginePrediction), hardCap, cfg, m.opened_at, w.closeAt);
        const update = this.db.prepare('UPDATE predictions SET accepted = ?, refund = ?, weight = ? WHERE id = ?');
        for (const p of accepted) {
          update.run(p.accepted, p.refund, p.weight, p.id);
          if (p.refund > 0) this.credit(p.userId, p.refund, 'refund', p.id);
        }
        this.db.prepare("UPDATE markets SET status = 'locked', hard_cap = ? WHERE id = ?").run(hardCap, m.id);
      });
      closed.push(m.id);
      this.onEvent('market', { marketId: m.id });
      this.log(`market closed ${m.id}`);
    }
    return closed;
  }

  /** Settles locked markets whose 72-hour window has ended. */
  settleDueMarkets(): Notification[] {
    const now = this.clock.now();
    const notes: Notification[] = [];
    const markets = as<MarketRow[]>(this.db.prepare("SELECT * FROM markets WHERE mode = 'auto' AND status = 'locked'").all());

    for (const m of markets) {
      const cfg = parseConfig(m);
      const w = windows(cfg, m.listing_at);
      if (now < w.settleAt) continue;

      const rows = this.predictions(m.id);
      const accepted = rows.map((r) => ({
        ...toEnginePrediction(r),
        accepted: r.accepted ?? 0,
        refund: r.refund ?? 0,
        weight: r.weight ?? 1,
      }));
      const candles = this.candlesByVenue(m.id);
      const input = {
        cfg,
        announcedListingAt: m.announced_listing_at,
        listingAt: m.listing_at,
        openedAt: m.opened_at,
        retracted: m.retracted === 1,
        haltedMs: m.halted_ms,
        candles,
        accepted,
      };
      const result = settleMarket(input);
      const dataHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      notes.push(...this.commitSettlement(m, rows, result, dataHash, now));
    }
    return notes;
  }


  /** Pays out (or refunds) a settled market, stores the audit record, and returns per-user notifications. */
  private commitSettlement(m: MarketRow, rows: PredictionRow[], result: SettlementResult, dataHash: string, now: number): Notification[] {
    const status = result.voidReason ? 'void' : 'resolved';
    const notes: Notification[] = [];
    tx(this.db, () => {
      const update = this.db.prepare('UPDATE predictions SET payout = ?, refund = ? WHERE id = ?');
      const perUser = new Map<string, Notification>();
      for (const p of result.payouts) {
        const row = rows.find((r) => r.id === p.predictionId)!;
        const alreadyRefunded = row.refund ?? 0;
        const extraRefund = p.refund - alreadyRefunded;
        update.run(p.payout, p.refund, p.predictionId);
        if (extraRefund > 0) this.credit(p.userId, extraRefund, 'refund', p.predictionId);
        if (p.payout > 0) this.credit(p.userId, p.payout, 'payout', p.predictionId);

        const n = perUser.get(p.userId) ?? {
          userId: p.userId,
          marketId: m.id,
          symbol: m.symbol,
          status,
          voidReason: result.voidReason,
          winningBucket: result.winningBucket,
          staked: 0,
          payout: 0,
          refund: 0,
        };
        n.staked += row.stake;
        n.payout += p.payout;
        n.refund += p.refund;
        perUser.set(p.userId, n);
      }
      this.db
        .prepare('INSERT INTO settlements (market_id, result, data_hash, settled_at) VALUES (?, ?, ?, ?)')
        .run(m.id, JSON.stringify(result), dataHash, now);
      this.db.prepare('UPDATE markets SET status = ? WHERE id = ?').run(status, m.id);
      for (const n of perUser.values()) notes.push(n);
    });
    this.livePrices.delete(m.id);
    this.onEvent('market', { marketId: m.id });
    this.log(`market ${status} ${m.id}${result.voidReason ? ` (${result.voidReason})` : ` → ${result.winningBucket}`}`);
    return notes;
  }

  // --- Detected listings ---------------------------------------------------------

  /** Stores a detection once (by dedupe key). Returns true if it was new. */
  recordDetection(d: {
    exchange: string;
    symbol: string | null;
    pair: string | null;
    source: 'announcement' | 'symbol_diff';
    title: string | null;
    url: string | null;
    listingAt: number | null;
    publishedAt: number | null;
    dedupeKey: string;
  }): number | null {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO detected_listings (exchange, symbol, pair, source, title, url, listing_at, published_at, detected_at, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.exchange, d.symbol, d.pair, d.source, d.title, d.url, d.listingAt, d.publishedAt, this.clock.now(), d.dedupeKey);
    if (res.changes !== 1) return null;
    const id = Number(res.lastInsertRowid);
    this.onEvent('listing', { id, exchange: d.exchange, symbol: d.symbol });
    return id;
  }

  knownPairs(venue: string): Set<string> {
    return new Set(as<{ symbol: string }[]>(this.db.prepare('SELECT symbol FROM known_symbols WHERE venue = ?').all(venue)).map((r) => r.symbol));
  }

  rememberPairs(venue: string, pairs: string[]) {
    const now = this.clock.now();
    const stmt = this.db.prepare('INSERT OR IGNORE INTO known_symbols (venue, symbol, first_seen) VALUES (?, ?, ?)');
    tx(this.db, () => {
      for (const p of pairs) stmt.run(venue, p, now);
    });
  }

  detections(opts: { status?: 'pending' | 'approved' | 'ignored' | 'all'; limit?: number } = {}) {
    const status = opts.status ?? 'all';
    const rows = as<Record<string, unknown>[]>(
      this.db
        .prepare(
          `SELECT * FROM detected_listings ${status === 'all' ? '' : 'WHERE status = ?'}
           ORDER BY COALESCE(published_at, detected_at) DESC LIMIT ?`,
        )
        .all(...(status === 'all' ? [] : [status]), Math.min(200, opts.limit ?? 50)),
    );
    return rows.map((r) => ({
      id: r.id as number,
      exchange: r.exchange as string,
      exchangeName: this.venues.get(r.exchange as string)?.name ?? (r.exchange as string),
      symbol: r.symbol as string | null,
      pair: r.pair as string | null,
      source: r.source as string,
      title: r.title as string | null,
      url: r.url as string | null,
      listingAt: r.listing_at as number | null,
      publishedAt: r.published_at as number | null,
      detectedAt: r.detected_at as number,
      status: r.status as string,
      marketId: r.market_id as string | null,
    }));
  }

  /** Turns a detection into a market. Listing time and symbol can be corrected here. */
  approveDetection(id: number, input: { symbol?: string; name?: string; listingAt?: number; config?: Partial<MarketConfig> } = {}) {
    const d = as<Record<string, unknown> | undefined>(this.db.prepare('SELECT * FROM detected_listings WHERE id = ?').get(id));
    if (!d) throw new AppError(404, 'detection_not_found', 'Detected listing not found.');
    if (d.status === 'approved') throw new AppError(409, 'already_approved', 'This listing already has a market.');
    const venue = this.venues.get(d.exchange as string);
    if (!venue) throw new AppError(400, 'unknown_venue', `No price adapter for ${d.exchange}.`);
    const symbol = String(input.symbol ?? d.symbol ?? '').toUpperCase();
    if (!symbol) throw new AppError(400, 'bad_symbol', 'Add the token symbol before approving.');
    const listingAt = input.listingAt ?? (d.listing_at as number | null);
    if (!listingAt) throw new AppError(400, 'bad_listing_time', 'Add the trading start time before approving.');

    const marketId = this.createMarket({
      symbol,
      name: input.name,
      exchange: venue.name,
      venues: [{ venue: venue.id, symbol: (d.pair as string | null) && !input.symbol ? (d.pair as string) : venue.pair(symbol) }],
      sourceUrl: (d.url as string | null) ?? undefined,
      announcedListingAt: listingAt,
      listingAt,
      config: input.config,
    });
    this.db.prepare("UPDATE detected_listings SET status = 'approved', market_id = ?, symbol = ?, listing_at = ? WHERE id = ?").run(marketId, symbol, listingAt, id);
    return marketId;
  }

  ignoreDetection(id: number) {
    this.db.prepare("UPDATE detected_listings SET status = 'ignored' WHERE id = ? AND status = 'pending'").run(id);
  }

  /** Markets that have started trading and haven't settled: the live feed polls these. */
  tradingMarkets() {
    const now = this.clock.now();
    return as<{ id: string; venues: string }[]>(
      this.db.prepare("SELECT id, venues FROM markets WHERE mode = 'auto' AND status IN ('open', 'locked') AND listing_at <= ?").all(now),
    ).map((m) => ({ id: m.id, venues: JSON.parse(m.venues) as VenueRef[] }));
  }

  // --- Read models ------------------------------------------------------------

  listMarkets(filter: 'open' | 'live' | 'settled' | 'all', userId?: string) {
    const where =
      filter === 'open'
        ? "status = 'open'"
        : filter === 'live'
          ? "status = 'locked'"
          : filter === 'settled'
            ? "status IN ('resolved', 'void')"
            : '1 = 1';
    const order = filter === 'settled' ? 'listing_at DESC' : 'listing_at ASC';
    const rows = as<MarketRow[]>(this.db.prepare(`SELECT * FROM markets WHERE published = 1 AND ${where} ORDER BY ${order} LIMIT 50`).all());
    return rows.map((r) => this.view(r, userId));
  }

  /** Public read. Unpublished drafts are only visible to the admin panel (asAdmin). */
  getMarket(id: string, userId?: string, asAdmin = false) {
    const m = this.row(id);
    if (m.published === 0 && !asAdmin) throw new AppError(404, 'market_not_found', 'Market not found.');
    return this.view(m, userId);
  }

  settlement(id: string) {
    const s = as<{ result: string; data_hash: string; settled_at: number } | undefined>(
      this.db.prepare('SELECT * FROM settlements WHERE market_id = ?').get(id),
    );
    if (!s) throw new AppError(404, 'not_settled', 'This market has not settled yet.');
    return { marketId: id, settledAt: s.settled_at, dataHash: s.data_hash, result: JSON.parse(s.result) as SettlementResult };
  }

  /** Downsampled price series for charts. */
  chart(id: string, points = 120) {
    const m = this.publicRow(id);
    const byVenue = this.candlesByVenue(m.id);
    const primary = Object.entries(byVenue).sort(
      (a, b) => b[1].reduce((s, c) => s + c.volume, 0) - a[1].reduce((s, c) => s + c.volume, 0),
    )[0];
    if (!primary) return { venue: null, series: [] as [number, number][] };
    const list = primary[1];
    const step = Math.max(1, Math.ceil(list.length / points));
    const series: [number, number][] = [];
    for (let i = 0; i < list.length; i += step) series.push([list[i].ts, list[i].close]);
    if (list.length && series[series.length - 1][0] !== list[list.length - 1].ts) {
      const last = list[list.length - 1];
      series.push([last.ts, last.close]);
    }
    return { venue: primary[0], series };
  }

  /** Recent predictions on a market, newest first. */
  activity(marketId: string, limit = 30) {
    this.publicRow(marketId);
    const rows = as<{ username: string; bucket: Bucket; stake: number; placed_at: number }[]>(
      this.db
        .prepare(
          `SELECT u.username, p.bucket, p.stake, p.placed_at FROM predictions p
           JOIN users u ON u.id = p.user_id WHERE p.market_id = ? ORDER BY p.placed_at DESC LIMIT ?`,
        )
        .all(marketId, limit),
    );
    return rows.map((r) => ({ username: r.username, bucket: r.bucket, stake: r.stake, placedAt: r.placed_at }));
  }

  myPredictions(userId: string) {
    const rows = as<(PredictionRow & { symbol: string; exchange: string; status: string; mode: string })[]>(
      this.db
        .prepare(
          `SELECT p.*, m.symbol, m.exchange, m.status, m.mode FROM predictions p
           JOIN markets m ON m.id = p.market_id
           WHERE p.user_id = ? ORDER BY p.placed_at DESC LIMIT 100`,
        )
        .all(userId),
    );
    return rows.map((r) => ({
      id: r.id,
      marketId: r.market_id,
      symbol: r.symbol,
      exchange: r.exchange,
      marketStatus: r.status,
      mode: r.mode,
      bucket: r.bucket,
      stake: r.stake,
      accepted: r.accepted,
      refund: r.refund,
      payout: r.payout,
      placedAt: r.placed_at,
    }));
  }

  leaderboard(userId?: string) {
    const start = weekStart(this.clock.now());
    const rows = as<{ user_id: string; name: string | null; profit: number; wins: number; total: number }[]>(
      this.db
        .prepare(
          `SELECT p.user_id, u.username AS name,
                  SUM(COALESCE(p.payout, 0) - COALESCE(p.accepted, 0)) AS profit,
                  SUM(CASE WHEN p.payout > 0 THEN 1 ELSE 0 END) AS wins,
                  COUNT(*) AS total
           FROM predictions p
           JOIN markets m ON m.id = p.market_id
           JOIN settlements s ON s.market_id = m.id
           JOIN users u ON u.id = p.user_id
           WHERE m.status = 'resolved' AND s.settled_at >= ? AND COALESCE(p.accepted, 0) > 0
           GROUP BY p.user_id
           ORDER BY profit DESC, wins DESC
           LIMIT 100`,
        )
        .all(start),
    );
    const ranked = rows.map((r, i) => ({ rank: i + 1, userId: r.user_id, name: r.name, profit: r.profit, wins: r.wins, total: r.total }));
    return {
      seasonStart: start,
      seasonEnd: start + 7 * 24 * 60 * MINUTE,
      entries: ranked.slice(0, 50).map(({ userId: _u, ...rest }) => ({ ...rest, isMe: _u === userId })),
      me: userId ? (ranked.find((r) => r.userId === userId) ?? null) : null,
    };
  }

  // --- Helpers ------------------------------------------------------------------

  private publicRow(id: string): MarketRow {
    const m = this.row(id);
    if (m.published === 0) throw new AppError(404, 'market_not_found', 'Market not found.');
    return m;
  }

  private row(id: string): MarketRow {
    const m = as<MarketRow | undefined>(this.db.prepare('SELECT * FROM markets WHERE id = ?').get(id));
    if (!m) throw new AppError(404, 'market_not_found', 'Market not found.');
    return m;
  }

  private predictions(marketId: string): PredictionRow[] {
    return as<PredictionRow[]>(
      this.db.prepare('SELECT * FROM predictions WHERE market_id = ? ORDER BY placed_at, id').all(marketId),
    );
  }

  private candlesByVenue(marketId: string): Record<string, Candle[]> {
    const rows = as<{ venue: string; ts: number; close: number; volume: number; trades: number | null }[]>(
      this.db.prepare('SELECT venue, ts, close, volume, trades FROM candles WHERE market_id = ? ORDER BY ts').all(marketId),
    );
    const out: Record<string, Candle[]> = {};
    for (const r of rows) {
      (out[r.venue] ??= []).push({ ts: r.ts, close: r.close, volume: r.volume, trades: r.trades ?? undefined });
    }
    return out;
  }

  private manualResultExtras(marketId: string, s: SettlementResult & { manual?: { note: string | null } }) {
    const winners = as<{ username: string; bucket: Bucket; accepted: number; payout: number }[]>(
      this.db
        .prepare(
          `SELECT u.username, p.bucket, p.accepted, p.payout FROM predictions p
           JOIN users u ON u.id = p.user_id WHERE p.market_id = ? AND p.payout > 0 ORDER BY p.payout DESC LIMIT 25`,
        )
        .all(marketId),
    );
    return { note: s.manual?.note ?? null, winners: winners.map((w) => ({ username: w.username, bucket: w.bucket, stake: w.accepted, payout: w.payout })) };
  }

  private view(m: MarketRow, userId?: string) {
    const cfg = parseConfig(m);
    const w = windows(cfg, m.listing_at);
    const now = this.clock.now();
    const preds = this.predictions(m.id);
    const afterClose = m.status !== 'open';

    const totals = emptyTotals();
    const users = new Set<string>();
    for (const p of preds) {
      totals[p.bucket] += afterClose ? (p.accepted ?? 0) : p.stake;
      users.add(p.user_id);
    }
    const pool = Object.values(totals).reduce((s, n) => s + n, 0);

    const manual = m.mode === 'manual';
    const phase = manual
      ? m.published === 0
        ? 'draft'
        : m.status === 'open'
          ? 'baseline'
          : m.status === 'locked'
            ? 'awaiting_result'
            : m.status
      : m.status === 'open'
        ? now < m.listing_at
          ? 'pre_listing'
          : 'baseline'
        : m.status === 'locked'
          ? 'running'
          : m.status;

    let live: null | { basePrice: number | null; lastPrice: number | null; returnPct: number | null; projectedBucket: Bucket | null; provisional: boolean } = null;
    if (!manual && (m.status === 'open' || m.status === 'locked') && now >= m.listing_at) {
      const byVenue = this.candlesByVenue(m.id);
      const baseEnd = Math.min(w.baseline.end, Math.floor(now / MINUTE) * MINUTE);
      const base = venueMedian(
        Object.entries(byVenue).map(([venue, list]) => {
          const s = twap(list, w.baseline.start, baseEnd);
          return { venue, price: s.twap, volume: s.volume };
        }),
      );
      const last = venueMedian(
        Object.entries(byVenue).map(([venue, list]) => {
          const c = list[list.length - 1];
          const s = twap(list, Math.max(w.baseline.start, (c?.ts ?? 0) - 60 * MINUTE), (c?.ts ?? 0) + MINUTE);
          return { venue, price: c ? c.close : null, volume: s.volume };
        }),
      );
      const tick = this.livePrices.get(m.id);
      const lastCandleTs = Math.max(0, ...Object.values(byVenue).map((l) => l[l.length - 1]?.ts ?? 0));
      const lastPrice = tick && tick.ts > lastCandleTs + MINUTE ? tick.price : last;
      const r = base && lastPrice ? returnPct(base, lastPrice) : null;
      live = {
        basePrice: base,
        lastPrice,
        returnPct: r,
        projectedBucket: r === null ? null : bucketForReturn(r, cfg.thresholds),
        provisional: m.status === 'open',
      };
    }

    let result = null;
    if (m.status === 'resolved' || m.status === 'void') {
      const s = this.settlement(m.id).result;
      result = {
        winningBucket: s.winningBucket,
        returnPct: s.returnPct,
        voidReason: s.voidReason,
        basePrice: s.baseline.price,
        finalPrice: s.final.price,
        pool: s.pool,
        fee: s.fee,
        ...(manual ? this.manualResultExtras(m.id, s as SettlementResult & { manual?: { note: string | null } }) : {}),
      };
    }

    const mine = userId
      ? preds
          .filter((p) => p.user_id === userId)
          .map((p) => ({
            id: p.id,
            bucket: p.bucket,
            stake: p.stake,
            accepted: p.accepted,
            refund: p.refund,
            payout: p.payout,
            weight: p.weight,
            placedAt: p.placed_at,
          }))
      : [];

    return {
      id: m.id,
      mode: m.mode ?? 'auto',
      published: m.published !== 0,
      basePrice: m.base_price,
      note: m.note,
      kind: m.kind ?? 'listing',
      symbol: m.symbol,
      name: m.name,
      exchange: m.exchange,
      venues: (JSON.parse(m.venues) as VenueRef[]).map((v) => ({ id: v.venue, name: this.venues.get(v.venue)?.name ?? v.venue, pair: v.symbol })),
      sourceUrl: m.source_url,
      status: m.status,
      phase,
      announcedListingAt: m.announced_listing_at,
      listingAt: m.listing_at,
      openedAt: m.opened_at,
      closeAt: w.closeAt,
      settleAt: w.settleAt,
      thresholds: cfg.thresholds,
      feeBps: cfg.feeBps,
      earlyBirdK: cfg.earlyBirdK,
      softCap: cfg.softCap,
      userCap: Math.floor(cfg.softCap * cfg.perUserCapPct),
      minStake: MIN_STAKE,
      pool,
      totals,
      predictors: users.size,
      live,
      result,
      scorecard: m.scorecard ? (JSON.parse(m.scorecard) as Scorecard) : null,
      mine,
      serverTime: now,
    };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function toEnginePrediction(r: PredictionRow): Prediction {
  return { id: r.id, userId: r.user_id, bucket: r.bucket, stake: r.stake, placedAt: r.placed_at };
}

function parseConfig(m: MarketRow): MarketConfig {
  return JSON.parse(m.config) as MarketConfig;
}

const NUMERIC_KEYS = [
  'earlyBirdK',
  'feeBps',
  'softCap',
  'perUserCapPct',
  'baselineMs',
  'durationMs',
  'settleWindowMs',
  'minCoverage',
  'minTrades',
  'maxListingDelayMs',
  'maxHaltMs',
] as const;

export function mergeConfig(overrides: Partial<MarketConfig> = {}): MarketConfig {
  const cfg: MarketConfig = { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds } };
  for (const key of NUMERIC_KEYS) {
    const v = overrides[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new AppError(400, 'bad_config', `Config "${key}" must be a non-negative number.`);
    }
    cfg[key] = v;
  }
  if (overrides.volumeCapRatio !== undefined) cfg.volumeCapRatio = overrides.volumeCapRatio;
  if (overrides.thresholds) cfg.thresholds = { ...cfg.thresholds, ...overrides.thresholds };

  const t = cfg.thresholds;
  if (!(t.crash < t.down && t.down < 0 && 0 < t.up && t.up < t.moon)) {
    throw new AppError(400, 'bad_config', 'Thresholds must satisfy crash < down < 0 < up < moon.');
  }
  if (cfg.baselineMs + cfg.settleWindowMs > cfg.durationMs) {
    throw new AppError(400, 'bad_config', 'Baseline and settlement windows must fit inside the market duration.');
  }
  if (cfg.feeBps > 2_000) throw new AppError(400, 'bad_config', 'Fee cannot exceed 20%.');
  return cfg;
}

/** Monday 00:00 UTC of the current week. */
export function weekStart(now: number): number {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}
