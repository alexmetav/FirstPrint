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
  allowedBuckets,
  applyCaps,
  bucketFor,
  isBinary,
  computePayouts,
  emptyTotals,
  hardCapFor,
  quote as engineQuote,
  returnPct,
  settleMarket,
  twap,
  venueMedian,
  windows,
  summarizeRecord,
  type Bucket,
  type Candle,
  type MarketConfig,
  type Prediction,
  type SettlementResult,
} from '../engine/engine.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const START_POINTS = 1_000;
/** Daily claim: 50 points on day 1 of a streak, 25 more each day after, up to 200 from day 7. */
export const DAILY_MIN = 50;
export const DAILY_STEP = 25;
export const DAILY_MAX = 200;
export const DAILY_POINTS = DAILY_MIN;
export const dailyReward = (streakDay: number) => Math.min(DAILY_MAX, DAILY_MIN + DAILY_STEP * (Math.max(1, streakDay) - 1));
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Where a player's daily streak stands. The streak is alive if they claimed today or yesterday (UTC);
 * claiming today continues it, and missing a day starts again at day 1.
 */
export function dailyStatus(u: { last_claim_day: string | null; streak?: number | null }, now: number) {
  const today = utcDay(now);
  const yesterday = utcDay(now - 86_400_000);
  const claimedToday = u.last_claim_day === today;
  const alive = claimedToday || u.last_claim_day === yesterday;
  const streak = alive ? Math.max(1, u.streak ?? 1) : 0;
  // Claimed today: what tomorrow brings. Otherwise: what claiming now gives (day 1 after a missed day).
  const nextDay = streak + 1;
  return { streak, claimedToday, nextDay, next: dailyReward(nextDay), max: DAILY_MAX };
}
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
  streak?: number;
  created_at: number;
  x_username?: string | null;
  referral_code?: string | null;
  referred_by?: string | null;
  /** Two-letter country seen at sign-in (CF-IPCountry), for analytics. */
  country?: string | null;
}

export interface MarketRow {
  id: string;
  symbol: string;
  name: string | null;
  exchange: string;
  venues: string;
  source_url: string | null;
  logo_url?: string | null;
  /** A PNG copy of the logo for Telegram banners (the image library can't read WebP). */
  logo_png?: string | null;
  /** In light reads (lightCols): when the uploaded logo changed, and whether the PNG copy exists. */
  logo_ver?: string | null;
  has_logo_png?: number;
  /** Upcoming token scheduled to open by itself: when trading is due to start (ms). */
  auto_open_at?: number | null;
  /** The last thing the auto-open or opening-price check found (shown to the admin). */
  auto_open_note?: string | null;
  /** When the admin was told the result is due (once per market). */
  result_alerted_at?: number | null;
  /** 1 when the opening price couldn't be read from the exchange and the admin was told to add it. */
  opening_price_failed?: number;
  /** 1 when the start price is the price at the moment predictions close (read by the server then). */
  start_at_close?: number;
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
  /** Allow a listing that has already started, while its start-price hour is still running. */
  allowStarted?: boolean;
}

/** Predictions on a token that is already trading stay open at most three days. */
export const MAX_OPEN_MS = 72 * 60 * 60_000;

export interface ManualMarketInput {
  symbol: string;
  name?: string;
  /** Exchange ids, e.g. ['binance', 'okx']. */
  exchanges: string[];
  /** Optional trading pair per exchange; defaults to SYMBOLUSDT in each exchange's format. */
  pairs?: Record<string, string>;
  /**
   * Reference price the outcome is measured against. Null for a token that isn't trading yet:
   * the admin enters its opening price once trading starts (before or with the result).
   */
  basePrice: number | null;
  /**
   * The start price is the live price when predictions close, read by the server at that moment
   * (basePrice is then left empty). Watching the chart while predictions are open gives no edge,
   * because the move is measured from the close.
   */
  startAtClose?: boolean;
  /** When predictions stop (ms). */
  closeAt: number;
  /** When the admin expects to share the result (ms). Informational. */
  resultAt?: number;
  config?: Partial<MarketConfig>;
  note?: string;
  sourceUrl?: string;
  /** Token logo: an https image URL or a small data:image (png, jpeg, webp, gif) the admin uploaded. Empty string removes it. */
  logoUrl?: string;
  publish?: boolean;
  /**
   * An upcoming token the admin has checked: the market stays a draft and opens by itself once
   * trading starts (ms), with the live exchange price as its start price. Null to stop it.
   */
  autoOpenAt?: number | null;
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

/**
 * Token symbols: letters and digits in any script, so tickers like 币安人生 (listed on MEXC) work too.
 * Latin-only symbols need at least 2 characters; a single Chinese character can be a whole ticker.
 */
export function validSymbol(symbol: string) {
  return /^[\p{L}\p{N}]{1,15}$/u.test(symbol) && (symbol.length >= 2 || /[^\x00-\x7f]/.test(symbol));
}
const SYMBOL_RULE = 'Token symbol must be 1–15 letters or digits with no spaces, e.g. SOL or 币安人生.';
/** Market ids stay plain ASCII so links never need decoding; a non-Latin symbol becomes "token". */
const idSlug = (symbol: string) => symbol.toLowerCase().replace(/[^a-z0-9]/g, '') || 'token';

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
  /** 'binary' for a Yes/No market. */
  outcomes?: string;
}

const as = <T>(v: unknown) => v as T;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** A short fingerprint of a logo, so its URL changes when the logo does. */
/**
 * Changes when an uploaded logo changes (for its /api/logo link, so browsers fetch the new one): the
 * length plus samples from the middle and the end. Kept in step with logo_ver in lightCols, which
 * works it out in SQL so lists never load the image.
 */
function logoVersion(s: string) {
  const mid = s.slice(Math.floor(s.length / 2) - 1, Math.floor(s.length / 2) + 11);
  return `${s.length}-${Buffer.from(mid + s.slice(-12)).toString('hex').toUpperCase()}`;
}

export class FirstprintService {
  db: DB;
  clock: Clock;
  venues: Map<string, Venue>;
  log: (msg: string) => void;
  /** Latest live ticker per market, filled by LiveFeed. */
  livePrices = new Map<string, { price: number; ts: number }>();
  /** Event hook for live updates (SSE). */
  onEvent: (type: 'market' | 'price' | 'listing', data: Record<string, unknown>) => void = () => {};
  /** A market just went live for players, or just got its result (for the public Telegram channel). */
  onAnnounce: (kind: 'live' | 'result', marketId: string) => void = () => {};
  /** Markets whose predictions just closed, however the close happened (timer tick or an admin preview). */
  onClosed: (marketIds: string[]) => void = () => {};
  /**
   * Every points movement, inside its transaction (the rewards service mirrors stakes, payouts and
   * refunds on chain as TestFPT). `ledgerId` is the ledger row, unique per movement.
   */
  onLedger: (userId: string, delta: number, reason: string, ref: string | null, ledgerId: number) => void = () => {};
  /** A daily streak claim went through (the rewards service mints it on chain as TestFPT). */
  onDailyClaimed: (userId: string, day: string, amount: number) => void = () => {};
  private announce(kind: 'live' | 'result', marketId: string) {
    queueMicrotask(() => {
      try {
        this.onAnnounce(kind, marketId);
      } catch (err) {
        this.log(`announce failed ${marketId}: ${(err as Error).message}`);
      }
    });
  }
  /**
   * True when points are claimed to wallets as TestFPT. New accounts then get their welcome
   * points as a reward to claim instead of straight into their balance.
   */
  rewardsOnChain: () => boolean = () => false;
  /** Problems for Admin → Errors (set by main; tests may leave it unset). */
  errors: import('./errorLog.ts').ErrorLog | null = null;
  /** Called inside the transaction after a prediction is placed (referral rewards hook in here). */
  onPredicted: (userId: string) => void = () => {};

  constructor(db: DB, clock: Clock, venues: Venue[], log: (msg: string) => void = () => {}) {
    this.db = db;
    this.clock = clock;
    this.venues = new Map(venues.map((v) => [v.id, v]));
    this.log = log;
  }

  // --- Users & points ------------------------------------------------------

  /** Adds points to a balance with a ledger entry. Call inside a transaction. */
  addPoints(userId: string, amount: number, reason: string, ref: string | null) {
    this.credit(userId, amount, reason, ref);
  }

  private credit(userId: string, delta: number, reason: string, ref: string | null) {
    if (delta === 0) return;
    const res = this.db
      .prepare('UPDATE users SET points = points + ? WHERE id = ? AND points + ? >= 0')
      .run(delta, userId, delta);
    if (res.changes !== 1) throw new AppError(400, 'insufficient_points', 'Not enough points for this prediction.');
    const row = this.db
      .prepare('INSERT INTO ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, delta, reason, ref, this.clock.now());
    this.onLedger(userId, delta, reason, ref, Number(row.lastInsertRowid));
  }

  /**
   * Starting points for a new account, and who referred them. With TestFPT on, the points wait
   * as a reward the player claims to their wallet; otherwise they go straight to the balance.
   */
  private welcome(userId: string, refCode?: string | null, ledgerRef: string | null = null) {
    if (this.rewardsOnChain()) {
      this.db
        .prepare("INSERT INTO rewards (user_id, kind, ref, amount, created_at) VALUES (?, 'welcome', 'welcome', ?, ?)")
        .run(userId, START_POINTS, this.clock.now());
    } else {
      this.credit(userId, START_POINTS, 'signup', ledgerRef);
    }
    const code = String(refCode ?? '').trim().toUpperCase();
    if (/^[A-Z0-9]{6,12}$/.test(code)) {
      const referrer = as<{ id: string } | undefined>(this.db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code));
      if (referrer && referrer.id !== userId) this.db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(referrer.id, userId);
    }
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
  verifyEmailCode(emailInput: string, codeInput: string, ref?: string | null): { user: UserRow; created: boolean } {
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
      return this.findOrCreateByEmail(email, null, ref);
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
  signInWithVerifiedEmail(email: string, name: string | null, ref?: string | null): { user: UserRow; created: boolean } {
    return tx(this.db, () => this.findOrCreateByEmail(email, name, ref));
  }

  private findOrCreateByEmail(email: string, name: string | null, ref?: string | null): { user: UserRow; created: boolean } {
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
    // Without a name (an email code sign-up), a random one: never part of the email address, which
    // would show on public pages (leaderboard, profiles) until the player picks a name.
    const base = (name ?? '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) || `player_${randomBytes(3).toString('hex')}`;
    let username = base.length >= 3 ? base : `${base}_user`.slice(0, 16);
    for (let i = 2; this.db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username); i++) {
      username = `${base.slice(0, 16)}${i}`;
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO users (id, email, username, needs_username, password_hash, points, created_at) VALUES (?, ?, ?, 1, NULL, 0, ?)')
      .run(id, email, username, this.clock.now());
    this.welcome(id, ref);
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
  walletSignIn(input: { address: string; message: string; signature: string; walletName?: string; ref?: string | null }): { user: UserRow; created: boolean } {
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
      this.welcome(id, input.ref, input.address);
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

  /** `via` is how the user proved who they are; an email only counts for admin access after an email code or Google. */
  /** Records the player's country (two letters) the first time it's known; later sign-ins don't change it. */
  noteCountry(userId: string, country: string | null) {
    if (!country) return;
    this.db.prepare('UPDATE users SET country = ? WHERE id = ? AND country IS NULL').run(country, userId);
  }

  createSession(userId: string, via: 'email' | 'google' | 'wallet' | 'password' | null = null): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const expiresAt = now + SESSION_MS;
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, via) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), userId, expiresAt, now, via);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    return { token, expiresAt };
  }

  /** How a live session signed in, or null. */
  sessionVia(token: string): string | null {
    if (!token) return null;
    const row = as<{ via: string | null; expires_at: number } | undefined>(this.db.prepare('SELECT via, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)));
    return row && row.expires_at >= this.clock.now() ? row.via : null;
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

  /** The daily streak and which days were claimed, for the streak calendar (the last 42 days). */
  dailyCalendar(userId: string) {
    const u = this.getUser(userId);
    const now = this.clock.now();
    const since = utcDay(now - 41 * 86_400_000);
    const days = as<{ ref: string; delta: number }[]>(
      this.db.prepare("SELECT ref, delta FROM ledger WHERE user_id = ? AND reason = 'daily' AND ref >= ? ORDER BY ref").all(userId, since),
    ).map((r) => ({ day: r.ref, points: r.delta }));
    return { ...dailyStatus(u, now), today: utcDay(now), days, schedule: [1, 2, 3, 4, 5, 6, 7].map(dailyReward) };
  }

  getUser(id: string): UserRow {
    const u = as<UserRow | undefined>(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    if (!u) throw new AppError(404, 'user_not_found', 'User not found.');
    return u;
  }

  claimDaily(userId: string) {
    return tx(this.db, () => {
      const now = this.clock.now();
      const day = utcDay(now);
      const u = this.getUser(userId);
      if (u.last_claim_day === day) {
        throw new AppError(409, 'already_claimed', 'Daily points already claimed. Come back tomorrow (UTC).');
      }
      const { nextDay } = dailyStatus(u, now);
      const reward = dailyReward(nextDay);
      this.db.prepare('UPDATE users SET last_claim_day = ?, streak = ? WHERE id = ?').run(day, nextDay, userId);
      this.credit(userId, reward, 'daily', day);
      this.onDailyClaimed(userId, day, reward);
      return this.getUser(userId);
    });
  }

  // --- Markets: admin -------------------------------------------------------

  createMarket(input: CreateMarketInput): string {
    const symbol = String(input.symbol ?? '').toUpperCase();
    if (!validSymbol(symbol)) throw new AppError(400, 'bad_symbol', SYMBOL_RULE);
    if (!input.exchange) throw new AppError(400, 'bad_exchange', 'Exchange is required.');
    if (!Array.isArray(input.venues) || input.venues.length === 0) {
      throw new AppError(400, 'bad_venues', 'At least one price venue is required.');
    }
    for (const v of input.venues) {
      if (!this.venues.has(v.venue)) throw new AppError(400, 'unknown_venue', `Unknown venue "${v.venue}".`);
      if (!v.symbol) throw new AppError(400, 'bad_venues', 'Each venue needs a trading symbol, e.g. XYZUSDT.');
    }
    const now = this.clock.now();
    const cfg = mergeConfig(input.config);
    const startedOk = input.allowStarted && Number.isFinite(input.listingAt) && now < input.listingAt + cfg.baselineMs;
    if (!Number.isFinite(input.listingAt) || (input.listingAt <= now && !startedOk)) {
      throw new AppError(400, 'bad_listing_time', 'Listing time must be in the future.');
    }
    if (!Number.isFinite(input.announcedListingAt)) {
      throw new AppError(400, 'bad_listing_time', 'Announced listing time is required.');
    }

    const id = `${idSlug(symbol)}-${input.exchange.toLowerCase()}-${randomUUID().slice(0, 6)}`;
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
        input.sourceUrl && /^https:\/\/\S+$/i.test(input.sourceUrl) ? input.sourceUrl : null,
        input.announcedListingAt,
        input.listingAt,
        now,
        JSON.stringify(cfg),
        input.scorecard ? JSON.stringify(input.scorecard) : null,
        input.kind ?? 'listing',
        now,
      );
    this.log(`market created ${id}`);
    if ((input.kind ?? 'listing') === 'listing') this.announce('live', id);
    return id;
  }

  /**
   * Creates a test market on a token that already trades, using real exchange
   * prices. Every requested exchange is checked for a live USDT price first;
   * the market uses all exchanges that respond (volume-weighted median).
   */
  async createLiveMarket(input: { symbol: string; name?: string; exchanges?: string[]; startsInMs?: number; preset?: string }) {
    const symbol = String(input.symbol ?? '').trim().toUpperCase();
    if (!validSymbol(symbol)) throw new AppError(400, 'bad_symbol', SYMBOL_RULE);
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
      const perUser = new Map<string, Notification>();
      for (const p of rows) {
        const n = perUser.get(p.user_id) ?? { userId: p.user_id, marketId, symbol: m.symbol, status: 'void' as const, voidReason: 'retracted', winningBucket: null, staked: 0, payout: 0, refund: 0 };
        n.staked += p.stake;
        n.refund += p.stake;
        perUser.set(p.user_id, n);
      }
      this.storeNotifications([...perUser.values()], parseConfig(m).outcomes ?? 'ladder', now);
      this.livePrices.delete(marketId);
      queueMicrotask(() => this.marketChanged(marketId));
      this.log(`market cancelled ${marketId}`);
      return { ok: true, refunded: rows.length };
    });
  }

  /** Calls every real exchange adapter once and reports what works. */
  /** Live price of a symbol on each chosen exchange; price is null where it doesn't trade or the exchange didn't answer. */
  /**
   * Live prices kept for a minute, so the admin's checks don't use up CoinGecko's small free allowance
   * (one Markets page used to ask it once per open market, and the next price check then failed).
   */
  private priceCache = new Map<string, { at: number; price: number }>();

  async exchangePrices(symbol: string, exchanges: string[], pairs: Record<string, string> = {}) {
    const sym = String(symbol ?? '').trim().toUpperCase();
    if (!validSymbol(sym)) throw new AppError(400, 'bad_symbol', SYMBOL_RULE);
    const ids = [...new Set((exchanges ?? []).map(String))].filter((id) => this.venues.has(id) && id !== 'sim').slice(0, 10);
    return Promise.all(
      ids.map(async (id) => {
        const venue = this.venues.get(id)!;
        const pair = pairs[id] || venue.pair(sym);
        const cached = this.priceCache.get(`${id}:${pair}`);
        if (cached && Date.now() - cached.at < 60_000) return { id, name: venue.name, pair, price: cached.price, error: null as string | null };
        try {
          const t = await Promise.race([venue.fetchTicker(pair), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no answer within 8s')), 8_000))]);
          const price = t && t.price > 0 ? t.price : null;
          if (price !== null) this.priceCache.set(`${id}:${pair}`, { at: Date.now(), price });
          return { id, name: venue.name, pair, price, error: null as string | null };
        } catch (err) {
          const msg = (err as Error).message;
          return { id, name: venue.name, pair, price: null, error: /\b429\b/.test(msg) ? 'busy (rate limit), try again in a minute' : msg.slice(0, 120) };
        }
      }),
    );
  }

  /** Fills the price cache for many pairs of one source in a single call, where the source allows it. */
  private async prefetchPrices(refs: { venue: string; symbol: string }[]) {
    const byVenue = new Map<string, string[]>();
    for (const r of refs) {
      const v = this.venues.get(r.venue);
      if (!v?.fetchTickers) continue;
      const c = this.priceCache.get(`${r.venue}:${r.symbol}`);
      if (c && Date.now() - c.at < 60_000) continue;
      byVenue.set(r.venue, [...(byVenue.get(r.venue) ?? []), r.symbol]);
    }
    await Promise.all(
      [...byVenue].map(async ([id, list]) => {
        try {
          const got = await this.venues.get(id)!.fetchTickers!(list);
          for (const [pair, t] of Object.entries(got)) if (t && t.price > 0) this.priceCache.set(`${id}:${pair}`, { at: Date.now(), price: t.price });
        } catch {
          /* the single lookups report the error */
        }
      }),
    );
  }

  /**
   * Checks every open manual market against live exchange prices and returns plain-language warnings:
   * an "upcoming" token that is already trading, a start price far from the live price, and
   * predictions that stay open for days while the price is visible.
   */
  async marketChecks() {
    const now = this.clock.now();
    const rows = as<MarketRow[]>(this.db.prepare(`SELECT ${this.lightCols} FROM markets WHERE mode = 'manual' AND status = 'open'`).all());
    const fmt = (n: number) => `$${Number(n.toPrecision(4))}`;
    // A market priced at the close needs no live price until its close is near.
    const needsPrice = (m: MarketRow) => m.start_at_close !== 1 || m.listing_at - now < 6 * 3_600_000;
    await this.prefetchPrices(rows.filter(needsPrice).flatMap((m) => JSON.parse(m.venues) as VenueRef[]));
    return Promise.all(
      rows.map(async (m) => {
        const venues = JSON.parse(m.venues) as VenueRef[];
        if (!needsPrice(m)) return { id: m.id, symbol: m.symbol, published: m.published === 1, startPrice: m.base_price, livePrice: null, prices: [], warnings: [] };
        const prices = await this.exchangePrices(m.symbol, venues.map((v) => v.venue), Object.fromEntries(venues.map((v) => [v.venue, v.symbol])));
        const live = prices.filter((p) => p.price !== null);
        const sorted = live.map((p) => p.price!).sort((a, b) => a - b);
        const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
        const where = live.map((p) => p.name).join(', ');
        const warnings: { level: 'high' | 'medium'; text: string }[] = [];
        const atClose = m.start_at_close === 1;
        // A market priced at the close is meant to be trading while predictions are open.
        if (median !== null && m.base_price === null && !atClose) {
          warnings.push({ level: 'high', text: `${m.symbol} is already trading on ${where} at about ${fmt(median)}, but predictions are still open. Players can see the price before they pick. Close predictions now, or give the market a start price.` });
        }
        if (median !== null && m.base_price !== null) {
          const diff = (median - m.base_price) / m.base_price;
          if (Math.abs(diff) > 0.2) {
            const pct = Math.round(Math.abs(diff) * 100);
            warnings.push({ level: Math.abs(diff) > 0.5 ? 'high' : 'medium', text: `Start price ${fmt(m.base_price)} is ${pct}% ${diff > 0 ? 'below' : 'above'} the live price ${fmt(median)} on ${where}. Players can already see which outcome is winning.` });
          }
        }
        if (median === null && atClose && m.listing_at - now < 6 * 3_600_000) {
          const names = prices.map((p) => p.name).join(', ');
          warnings.push({ level: 'medium', text: `Couldn't get a live price for ${m.symbol} from ${names || 'its sources'}. Its start price is read from them when predictions close; if they don't answer then, you'll be asked for it.` });
        }
        if (median === null && m.base_price !== null) {
          const names = prices.map((p) => p.name).join(', ');
          const busy = prices.length > 0 && prices.every((p) => p.error);
          warnings.push({
            level: 'medium',
            text: busy
              ? `${names || 'Its price source'} didn't answer just now (${prices[0].error}), so ${m.symbol}'s fixed start price couldn't be checked. Taking the start price at the close removes the need to check it.`
              : `Couldn't find a live price for ${m.symbol} on ${names || 'its exchanges'}. If it already trades, check the start price yourself, or take the start price at the close.`,
          });
        }
        const left = m.listing_at - now;
        if (median !== null && !atClose && left > 48 * 3_600_000) {
          warnings.push({ level: 'medium', text: `Predictions stay open ${Math.round(left / 86_400_000)} more days against a fixed start price while ${m.symbol} is trading, so late players can follow the trend. Take the start price at the close instead.` });
        }
        // A fixed start price nobody has predicted against yet can switch to the price at the close.
        const canUseClose = m.start_at_close !== 1 && m.base_price !== null && this.predictions(m.id).length === 0;
        return { id: m.id, symbol: m.symbol, published: m.published === 1, startPrice: m.base_price, livePrice: median, prices, warnings, canUseClose };
      }),
    );
  }

  /**
   * Calls every exchange from this server (live price, recent candles, pair list, announcements)
   * and says whether new listings could be tracked from here. Exchanges are checked side by side
   * so the whole check stays under about 15 seconds.
   */
  async checkExchanges() {
    const run = async <T>(fn: () => Promise<T>) => {
      const t0 = Date.now();
      try {
        const value = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 15s')), 15_000))]);
        return { ok: true, ms: Date.now() - t0, value, error: null as string | null };
      } catch (err) {
        return { ok: false, ms: Date.now() - t0, value: null, error: (err as Error).message };
      }
    };
    const venues = [...this.venues.values()].filter((v) => v.id !== 'sim' && !v.priceOnly);
    return Promise.all(
      venues.map(async (venue) => {
        const pair = venue.pair('BTC');
        const now = Date.now();
        const [ticker, candles, pairs, anns] = await Promise.all([
          run(() => venue.fetchTicker(pair)),
          run(() => venue.fetchCandles(pair, now - 15 * MIN_MS, now)),
          run(() => venue.listPairs()),
          venue.fetchAnnouncements ? run(() => venue.fetchAnnouncements!()) : Promise.resolve(null),
        ]);
        const cells = {
          ticker: { ok: ticker.ok && Boolean(ticker.value), ms: ticker.ms, detail: ticker.value ? `BTC ${ticker.value.price}` : ticker.error ?? 'no price' },
          candles: { ok: candles.ok && (candles.value?.length ?? 0) >= 5, ms: candles.ms, detail: candles.ok ? `${candles.value!.length} candles in last 15 min` : candles.error },
          pairs: { ok: pairs.ok && (pairs.value?.length ?? 0) > 10, ms: pairs.ms, detail: pairs.ok ? `${pairs.value!.length} USDT pairs` : pairs.error },
          announcements: anns
            ? { ok: anns.ok && (anns.value?.length ?? 0) > 0, ms: anns.ms, detail: anns.ok ? `${anns.value!.length} items, latest: ${anns.value![0]?.title ?? 'none'}` : anns.error }
            : { ok: null, ms: 0, detail: 'Not offered by this exchange' },
        };
        // 451 and 403 are how exchanges refuse servers in countries they don't serve.
        const blocked = [ticker, candles, pairs].some((r) => /\b(451|403)\b|restricted location|forbidden/i.test(r.error ?? ''));
        const works = cells.ticker.ok && cells.candles.ok && cells.pairs.ok;
        const verdict: 'works' | 'blocked' | 'partial' | 'down' = works ? 'works' : blocked ? 'blocked' : cells.ticker.ok || cells.pairs.ok ? 'partial' : 'down';
        return { id: venue.id, name: venue.name, verdict, ...cells };
      }),
    );
  }

  /**
   * New accounts made from one network (the visitor's IP, or its /64 for IPv6) in the last day, for
   * the sign-up limit. Networks are stored only as a salted hash, never the address itself, and the
   * rows are cleared after two days.
   */
  newAccountsFrom(network: string): number {
    return as<{ n: number }>(
      this.db.prepare('SELECT COUNT(*) AS n FROM signups WHERE network = ? AND at > ?').get(this.networkKey(network), this.clock.now() - 24 * 60 * MINUTE),
    ).n;
  }

  noteNewAccount(network: string) {
    this.db.prepare('INSERT INTO signups (network, at) VALUES (?, ?)').run(this.networkKey(network), this.clock.now());
  }

  private networkKey(network: string) {
    let salt = this.getSetting('signup_salt');
    if (!salt) {
      salt = randomBytes(16).toString('hex');
      this.setSetting('signup_salt', salt);
    }
    return sha256(`${salt}:${network}`).slice(0, 32);
  }

  /**
   * Clears out old rows nobody needs any more, so the database (and every backup copy of it) stops
   * growing with them: result notifications after 90 days, the admin log after a year, and sign-up
   * counts after two days. Run once a day. Returns how many rows went.
   */
  pruneOld() {
    const now = this.clock.now();
    const day = 24 * 60 * MINUTE;
    let n = 0;
    n += Number(this.db.prepare('DELETE FROM notifications WHERE created_at < ?').run(now - 90 * day).changes);
    n += Number(this.db.prepare('DELETE FROM admin_log WHERE at < ?').run(now - 365 * day).changes);
    n += Number(this.db.prepare('DELETE FROM signups WHERE at < ?').run(now - 2 * day).changes);
    if (n) this.log(`cleaned up ${n} old row${n === 1 ? '' : 's'}`);
    return n;
  }

  /**
   * Every market column, but without the uploaded logo images (up to a few hundred KB each), for the
   * lists and background checks that read many markets at once and never need the image itself:
   * logo_url keeps only its start (enough to tell an uploaded image from a link), logo_ver tells when
   * it changed (for the /api/logo link), and has_logo_png whether the banner copy exists.
   */
  private lightColsSql: string | null = null;
  private get lightCols() {
    if (this.lightColsSql) return this.lightColsSql;
    const cols = as<{ name: string }[]>(this.db.prepare('PRAGMA table_info(markets)').all())
      .map((c) => c.name)
      .filter((n) => n !== 'logo_url' && n !== 'logo_png');
    this.lightColsSql = [
      ...cols.map((c) => `"${c}"`),
      "CASE WHEN logo_url LIKE 'data:%' THEN substr(logo_url, 1, 40) ELSE logo_url END AS logo_url",
      "CASE WHEN logo_url LIKE 'data:%' THEN length(logo_url) || '-' || hex(substr(logo_url, length(logo_url) / 2, 12) || substr(logo_url, -12)) END AS logo_ver",
      '(logo_png IS NOT NULL) AS has_logo_png',
    ].join(', ');
    return this.lightColsSql;
  }

  adminMarkets() {
    const rows = as<MarketRow[]>(this.db.prepare('SELECT * FROM markets ORDER BY created_at DESC LIMIT 200').all());
    return rows.map((r) => this.view(r, undefined, true));
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
    return [...this.venues.values()].map((v) => ({ id: v.id, name: v.name, enabled: !off.has(v.id), ...(v.priceOnly ? { priceOnly: true } : {}) }));
  }

  setExchangeEnabled(id: string, enabled: boolean) {
    if (!this.venues.has(id)) throw new AppError(404, 'unknown_venue', `Unknown exchange "${id}".`);
    const off = this.disabledExchanges();
    if (enabled) off.delete(id);
    else off.add(id);
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('exchanges_disabled', JSON.stringify([...off]));
    return this.exchangeSettings();
  }

  exchangeEnabled(id: string) {
    return !this.disabledExchanges().has(id);
  }

  private disabledExchanges(): Set<string> {
    const r = as<{ value: string } | undefined>(this.db.prepare("SELECT value FROM settings WHERE key = 'exchanges_disabled'").get());
    return new Set(r ? (JSON.parse(r.value) as string[]) : []);
  }

  private manualFields(input: ManualMarketInput, now: number) {
    const symbol = String(input.symbol ?? '').trim().toUpperCase();
    if (!validSymbol(symbol)) throw new AppError(400, 'bad_symbol', SYMBOL_RULE);
    const exchanges = [...new Set((input.exchanges ?? []).map(String))];
    if (exchanges.length === 0) throw new AppError(400, 'bad_exchanges', 'Choose at least one exchange.');
    const off = this.disabledExchanges();
    for (const id of exchanges) {
      if (!this.venues.has(id)) throw new AppError(400, 'unknown_venue', `Unknown exchange "${id}".`);
      if (off.has(id)) throw new AppError(400, 'exchange_off', `${this.venues.get(id)!.name} is switched off in Admin → Exchanges.`);
    }
    const startAtClose = Boolean(input.startAtClose);
    const noPrice = startAtClose || input.basePrice === undefined || input.basePrice === null || (input.basePrice as unknown) === '';
    const basePrice = noPrice ? null : Number(input.basePrice);
    if (basePrice !== null && (!(basePrice > 0) || !Number.isFinite(basePrice))) throw new AppError(400, 'bad_price', 'Start price must be a number above 0.');
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
    // Only plain ids are kept (a CoinGecko coin id like pudgy-penguins, or an exchange pair).
    const pairs = Object.fromEntries(Object.entries(input.pairs ?? {}).filter(([, v]) => typeof v === 'string' && /^[a-z0-9_-]{1,100}$/i.test(v))) as Record<string, string>;
    for (const id of exchanges) {
      if (this.venues.get(id)!.priceOnly && !pairs[id]) throw new AppError(400, 'missing_coin', `${this.venues.get(id)!.name} needs the coin id: make the market from Find tokens.`);
    }
    const venues: VenueRef[] = exchanges.map((id) => ({ venue: id, symbol: pairs[id] || this.venues.get(id)!.pair(symbol) }));
    const exchangeLabel = exchanges.map((id) => this.venues.get(id)!.name).join(', ');
    const name = input.name ? String(input.name).trim().slice(0, 80) : null;
    const note = input.note ? String(input.note).trim().slice(0, 2000) : null;
    const sourceUrl = input.sourceUrl ? String(input.sourceUrl).trim().slice(0, 500) : null;
    if (sourceUrl && !/^https:\/\/\S+$/i.test(sourceUrl)) throw new AppError(400, 'bad_source_url', 'The source link must start with https://');
    const logoUrl = cleanLogo(input.logoUrl);
    void now;
    return { symbol, name, venues, exchangeLabel, basePrice, startAtClose, closeAt, cfg, note, sourceUrl, logoUrl };
  }

  /** Creates a draft (hidden from users) or, with publish: true, an open market. */
  createManualMarket(input: ManualMarketInput): string {
    const now = this.clock.now();
    const f = this.manualFields(input, now);
    if (f.closeAt <= now) throw new AppError(400, 'bad_close_time', 'Prediction close time must be in the future.');
    const autoOpenAt = this.checkAutoOpen(input.autoOpenAt, f, now);
    if (autoOpenAt !== null) {
      // Opens once trading has started, so its start price is taken at the close like any other.
      input = { ...input, publish: false };
      f.basePrice = null;
      f.startAtClose = true;
    }
    this.checkOpenWindow(f, autoOpenAt ?? now, autoOpenAt !== null);
    const id = `${idSlug(f.symbol)}-m-${randomUUID().slice(0, 6)}`;
    this.db
      .prepare(
        `INSERT INTO markets (id, symbol, name, exchange, venues, source_url, announced_listing_at, listing_at,
          opened_at, config, scorecard, status, kind, created_at, mode, published, base_price, note, logo_url, start_at_close)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', 'listing', ?, 'manual', ?, ?, ?, ?, ?)`,
      )
      .run(id, f.symbol, f.name, f.exchangeLabel, JSON.stringify(f.venues), f.sourceUrl, f.closeAt, f.closeAt, now, JSON.stringify(f.cfg), now, input.publish ? 1 : 0, f.basePrice, f.note, f.logoUrl, f.startAtClose ? 1 : 0);
    if (autoOpenAt !== null) this.db.prepare('UPDATE markets SET auto_open_at = ?, auto_open_note = NULL WHERE id = ?').run(autoOpenAt, id);
    this.log(`manual market ${input.publish ? 'published' : autoOpenAt !== null ? 'scheduled to open by itself' : 'drafted'} ${id}`);
    if (input.publish) {
      this.marketChanged(id);
      this.announce('live', id);
    }
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
      basePrice: m.base_price,
      startAtClose: m.start_at_close === 1,
      closeAt: m.listing_at,
      resultAt: m.listing_at + cfg.durationMs,
      config: cfg,
      note: m.note ?? undefined,
      sourceUrl: m.source_url ?? undefined,
      logoUrl: m.logo_url ?? undefined,
    };
    if (m.published === 1 && hasPredictions) {
      const locked = ['symbol', 'basePrice', 'startAtClose', 'config'] as const;
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
    const autoOpenAt = this.checkAutoOpen(patch.autoOpenAt === undefined ? (m.published === 1 ? null : (m.auto_open_at ?? null)) : patch.autoOpenAt, f, now, m.published === 1);
    if (autoOpenAt !== null) {
      f.basePrice = null;
      f.startAtClose = true;
    }
    // Older markets with long windows can still be edited; a new close time must fit the limit.
    if (f.closeAt !== m.listing_at || autoOpenAt !== (m.auto_open_at ?? null)) this.checkOpenWindow(f, autoOpenAt ?? now, autoOpenAt !== null);
    this.db.prepare('UPDATE markets SET auto_open_at = ?, auto_open_note = CASE WHEN ? IS NULL THEN NULL ELSE auto_open_note END WHERE id = ?').run(autoOpenAt, autoOpenAt, marketId);
    this.db
      .prepare(
        `UPDATE markets SET symbol = ?, name = ?, exchange = ?, venues = ?, source_url = ?, announced_listing_at = ?,
          listing_at = ?, config = ?, base_price = ?, start_at_close = ?, note = ?,
          logo_png = CASE WHEN COALESCE(logo_url, '') = COALESCE(?, '') THEN logo_png ELSE NULL END, logo_url = ? WHERE id = ?`,
      )
      .run(f.symbol, f.name, f.exchangeLabel, JSON.stringify(f.venues), f.sourceUrl, f.closeAt, f.closeAt, JSON.stringify(f.cfg), f.basePrice, f.startAtClose ? 1 : 0, f.note, f.logoUrl, f.logoUrl, marketId);
    if (m.published === 1) this.marketChanged(marketId); // drafts stay private
    return marketId;
  }

  /**
   * Checks an auto-open schedule. The admin has already checked the market, so it only needs to
   * be complete: a logo, a trading start ahead, and predictions open for at least 30 minutes
   * after it. Returns the time, or null when the market is not scheduled.
   */
  private checkAutoOpen(at: number | null | undefined, f: { closeAt: number; logoUrl: string | null }, now: number, published = false): number | null {
    if (at === undefined || at === null || (at as unknown) === '') return null;
    const t = Number(at);
    if (published) throw new AppError(409, 'already_published', 'This market is already open, so it can’t be scheduled.');
    if (!Number.isFinite(t) || t <= now) throw new AppError(400, 'bad_open_time', 'Trading start must be in the future to open the market by itself.');
    if (!f.logoUrl) throw new AppError(400, 'logo_required', 'Add the token’s logo first: markets that open by themselves need one.');
    if (f.closeAt < t + 30 * MINUTE) throw new AppError(400, 'bad_close_time', 'Predictions must stay open at least 30 minutes after trading starts.');
    return t;
  }

  /**
   * Predictions stay open at most three days (from now, or from the trading start of a market that
   * opens by itself). An upcoming token that isn't trading yet is exempt: it closes when it lists.
   */
  private checkOpenWindow(f: { basePrice: number | null; startAtClose: boolean; closeAt: number }, from: number, scheduled: boolean) {
    const upcoming = f.basePrice === null && !f.startAtClose && !scheduled;
    if (upcoming) return;
    if (f.closeAt - from > MAX_OPEN_MS + 5 * MINUTE) {
      throw new AppError(400, 'open_too_long', 'Predictions can stay open at most 3 days. Choose 24, 48 or 72 hours.');
    }
  }

  /**
   * Closes predictions on a published market now (or in a few hours), keeping its result date. For
   * markets made before the three-day limit that would otherwise stay open for days.
   */
  closePredictions(marketId: string, inMs = 0) {
    const m = this.manualRow(marketId);
    const now = this.clock.now();
    if (m.status !== 'open' || m.published !== 1) throw new AppError(409, 'not_open', 'Only published markets that are taking predictions can be closed.');
    const ms = Math.max(0, Math.min(Number(inMs) || 0, MAX_OPEN_MS));
    const closeAt = now + ms;
    if (closeAt >= m.listing_at) throw new AppError(409, 'closes_sooner', 'Predictions already close by then.');
    const cfg = parseConfig(m);
    const settleAt = m.listing_at + cfg.durationMs;
    // The result date stays where the players saw it; only the close moves earlier.
    const next = { ...cfg, durationMs: settleAt - closeAt };
    this.db.prepare('UPDATE markets SET listing_at = ?, announced_listing_at = ?, config = ?, reminded_at = NULL WHERE id = ?').run(closeAt, closeAt, JSON.stringify(next), marketId);
    this.log(`predictions ${ms ? `set to close in ${Math.round(ms / 60_000)} min` : 'closed now'} ${marketId}`);
    if (ms === 0) this.closeDueMarkets();
    else this.marketChanged(marketId);
    return marketId;
  }

  /**
   * Switches a market with a fixed start price to taking it when predictions close. Only while nobody
   * has predicted: players who did picked against the fixed price, so for them it stays.
   */
  useCloseStart(marketId: string) {
    const m = this.manualRow(marketId);
    if (m.status !== 'open') throw new AppError(409, 'not_open', 'Only markets taking predictions can change their start price.');
    if (m.start_at_close === 1) return marketId;
    if (this.predictions(marketId).length > 0) {
      throw new AppError(409, 'has_predictions', 'Players have already predicted against the fixed start price, so it stays. Close the market early instead.');
    }
    this.db.prepare('UPDATE markets SET base_price = NULL, start_at_close = 1 WHERE id = ?').run(marketId);
    if (m.published === 1) this.marketChanged(marketId);
    this.log(`start price set to the close ${marketId}`);
    return marketId;
  }

  /** Drafts scheduled to open by themselves whose trading start has come. */
  autoOpenDue(now = this.clock.now()) {
    return as<MarketRow[]>(
      this.db.prepare("SELECT * FROM markets WHERE mode = 'manual' AND status = 'open' AND published = 0 AND auto_open_at IS NOT NULL AND auto_open_at <= ? ORDER BY auto_open_at").all(now),
    );
  }

  /**
   * Published upcoming-token markets whose predictions have closed (trading is due) and that still
   * have no start price: the server reads the opening price from the exchange.
   */
  awaitingOpeningPrice(now = this.clock.now()) {
    return as<MarketRow[]>(
      this.db
        .prepare("SELECT * FROM markets WHERE mode = 'manual' AND published = 1 AND status = 'locked' AND base_price IS NULL AND opening_price_failed = 0 AND listing_at <= ? ORDER BY listing_at")
        .all(now),
    );
  }

  /** The opening price could not be read: stop trying, so the admin adds it. */
  openingPriceFailed(marketId: string, note: string) {
    this.db.prepare('UPDATE markets SET opening_price_failed = 1, auto_open_note = ? WHERE id = ?').run(note.slice(0, 300), marketId);
  }

  /**
   * Upcoming-token markets whose opening price is in and whose result time has come, where the
   * admin hasn't been asked for the result yet. (Markets with a start price from the start are
   * announced as soon as predictions close.)
   */
  resultAlertsDue(now = this.clock.now()) {
    return as<MarketRow[]>(
      this.db
        .prepare("SELECT * FROM markets WHERE mode = 'manual' AND published = 1 AND status = 'locked' AND result_alerted_at IS NULL AND base_price IS NOT NULL")
        .all(),
    ).filter((m) => m.listing_at + parseConfig(m).durationMs <= now);
  }

  markResultAlerted(marketId: string) {
    this.db.prepare('UPDATE markets SET result_alerted_at = ? WHERE id = ?').run(this.clock.now(), marketId);
  }

  /** Records what the auto-open check found; with giveUp, the schedule is cleared and the market stays a draft. */
  noteAutoOpen(marketId: string, note: string, giveUp = false) {
    this.db.prepare(`UPDATE markets SET auto_open_note = ?${giveUp ? ', auto_open_at = NULL' : ''} WHERE id = ?`).run(note.slice(0, 300), marketId);
  }

  /**
   * Opens a scheduled market once its token is trading (startPrice is the live price that showed it).
   * A market priced at the close keeps no start price yet: it is read when predictions close.
   */
  autoOpen(marketId: string, startPrice: number, note: string) {
    const m = this.manualRow(marketId);
    const now = this.clock.now();
    if (m.status !== 'open' || m.published === 1 || !m.auto_open_at) throw new AppError(409, 'not_scheduled', 'This market is not waiting to open.');
    if (!(startPrice > 0) || !Number.isFinite(startPrice)) throw new AppError(400, 'bad_price', 'Start price must be a number above 0.');
    if (m.listing_at < now + 15 * MINUTE) throw new AppError(409, 'too_late', 'Predictions would close in under 15 minutes.');
    this.db
      .prepare('UPDATE markets SET base_price = ?, published = 1, opened_at = ?, auto_open_at = NULL, auto_open_note = ? WHERE id = ?')
      .run(m.start_at_close === 1 ? null : startPrice, now, note.slice(0, 300), marketId);
    this.marketChanged(marketId);
    this.announce('live', marketId);
    this.log(`market opened by itself ${marketId} at ${startPrice}`);
  }

  /**
   * Sets the opening price of a market created before its token traded. Allowed once, while the
   * market is open or waiting for its result; after that the result form can still override it.
   */
  setStartPrice(marketId: string, price: number) {
    const m = this.manualRow(marketId);
    if (m.status !== 'open' && m.status !== 'locked') throw new AppError(409, 'not_editable', 'This market has already been settled.');
    if (m.base_price !== null) throw new AppError(409, 'price_set', 'This market already has a start price.');
    if (m.start_at_close === 1 && m.status === 'open') throw new AppError(409, 'start_at_close', 'This market’s start price is the price when predictions close. It is set then.');
    const p = Number(price);
    if (!(p > 0) || !Number.isFinite(p)) throw new AppError(400, 'bad_price', 'Opening price must be a number above 0.');
    this.db.prepare('UPDATE markets SET base_price = ? WHERE id = ?').run(p, marketId);
    if (m.published === 1) this.marketChanged(marketId);
    this.log(`opening price set ${marketId} ${p}`);
    return marketId;
  }

  publishMarket(marketId: string) {
    const m = this.manualRow(marketId);
    const now = this.clock.now();
    if (m.status !== 'open') throw new AppError(409, 'not_editable', 'This market is no longer open.');
    if (m.published === 1) return;
    if (m.listing_at <= now) throw new AppError(409, 'bad_close_time', 'The prediction close time has passed. Edit it before publishing.');
    this.checkOpenWindow({ basePrice: m.base_price, startAtClose: m.start_at_close === 1, closeAt: m.listing_at }, now, false);
    this.db.prepare('UPDATE markets SET published = 1, opened_at = ?, auto_open_at = NULL WHERE id = ?').run(now, marketId);
    this.marketChanged(marketId);
    // Unpublished and published again: it was already posted to the channel.
    if (!(m as MarketRow & { announced_at?: number | null }).announced_at) this.announce('live', marketId);
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
    this.marketChanged(marketId);
  }

  deleteDraft(marketId: string) {
    const m = this.manualRow(marketId);
    if (m.published === 1 || this.predictions(marketId).length > 0) {
      throw new AppError(409, 'not_a_draft', 'Only unpublished drafts can be deleted. Cancel a published market to refund it.');
    }
    this.deleteMarket(marketId);
  }

  /**
   * Whether a market can be removed for good: nobody predicted on it, or it was cancelled and every
   * stake refunded. A settled market with players stays, so their winnings keep their history.
   */
  deletable(m: { status: string }, predictions: number) {
    if (predictions === 0) return { ok: true as const };
    if (m.status === 'void') return { ok: true as const };
    if (m.status === 'resolved') return { ok: false as const, why: 'This market is settled and players were paid, so it stays for their history.' };
    return { ok: false as const, why: 'Players have predicted on this market. Cancel and refund it first, then delete it.' };
  }

  /** Removes a market and everything stored for it. Drafts made from the New listings queue go back to the queue. */
  deleteMarket(marketId: string) {
    const m = as<MarketRow | undefined>(this.db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId));
    if (!m) throw new AppError(404, 'market_not_found', 'Market not found');
    const check = this.deletable(m, this.predictions(marketId).length);
    if (!check.ok) throw new AppError(409, 'not_deletable', check.why);
    tx(this.db, () => {
      this.db.prepare(`UPDATE detected_listings SET status = ${m.published === 1 ? "'ignored'" : "'pending'"}, market_id = NULL WHERE market_id = ?`).run(marketId);
      for (const table of ['notifications', 'predictions', 'candles', 'settlements']) this.db.prepare(`DELETE FROM ${table} WHERE market_id = ?`).run(marketId);
      this.db.prepare('DELETE FROM markets WHERE id = ?').run(marketId);
    });
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
    if (!(base > 0) || !Number.isFinite(base)) {
      throw new AppError(400, 'bad_price', m.base_price === null ? 'Enter the opening price: this market had no start price when it opened.' : 'Start price must be a number above 0.');
    }

    const ret = returnPct(base, final);
    const computed = bucketFor(ret, cfg);
    let bucket = computed;
    if (input.winningBucket !== undefined && input.winningBucket !== null && (input.winningBucket as string) !== '') {
      if (!allowedBuckets(cfg).includes(input.winningBucket)) throw new AppError(400, 'bad_bucket', isBinary(cfg) ? 'Choose Yes or No.' : 'Choose Crash, Down, Flat, Up, or Moon.');
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
      outcomes: parseConfig(m).outcomes ?? 'ladder',
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

  // --- Result notifications ---------------------------------------------------------

  private storeNotifications(notes: readonly Notification[], outcomes: string, now: number) {
    const insert = this.db.prepare(
      `INSERT INTO notifications (user_id, market_id, symbol, status, void_reason, winning_bucket, outcomes, staked, payout, refund, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const n of notes) insert.run(n.userId, n.marketId, n.symbol, n.status, n.voidReason, n.winningBucket, outcomes, n.staked, n.payout, n.refund, now);
  }

  /** A player's latest results, newest first, and how many they haven't seen. */
  notificationsFor(userId: string, limit = 30) {
    const rows = as<{ id: number; market_id: string; symbol: string; status: string; void_reason: string | null; winning_bucket: Bucket | null; outcomes: string; staked: number; payout: number; refund: number; created_at: number; read_at: number | null }[]>(
      this.db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(userId, limit),
    );
    return {
      unread: this.unreadNotifications(userId),
      notifications: rows.map((r) => ({
        id: r.id,
        marketId: r.market_id,
        symbol: r.symbol,
        status: r.status,
        voidReason: r.void_reason,
        winningBucket: r.winning_bucket,
        outcomes: r.outcomes,
        staked: r.staked,
        payout: r.payout,
        refund: r.refund,
        won: r.payout > 0,
        at: r.created_at,
        read: r.read_at !== null,
      })),
    };
  }

  unreadNotifications(userId: string): number {
    return as<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId)).n;
  }

  markNotificationsRead(userId: string) {
    this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(this.clock.now(), userId);
    return { unread: 0 };
  }

  // --- Points history and admin log ----------------------------------------------

  /** A user's points movements, newest first, with the market each one belongs to. */
  /** One page of the player's points history (newest first), with how many pages there are. */
  ledgerPage(userId: string, page = 1, perPage = 10) {
    const per = Math.min(50, Math.max(1, Math.floor(perPage) || 10));
    const total = as<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE user_id = ?').get(userId)).n;
    const pages = Math.max(1, Math.ceil(total / per));
    const p = Math.min(pages, Math.max(1, Math.floor(page) || 1));
    return { entries: this.ledgerFor(userId, per, (p - 1) * per), page: p, pages, total };
  }

  ledgerFor(userId: string, limit = 50, offset = 0) {
    const rows = as<{ id: number; delta: number; reason: string; created_at: number; symbol: string | null; market_id: string | null }[]>(
      this.db
        .prepare(
          `SELECT l.id, l.delta, l.reason, l.created_at, m.symbol, m.id AS market_id
           FROM ledger l
           LEFT JOIN predictions p ON p.id = l.ref
           LEFT JOIN markets m ON m.id = p.market_id
           WHERE l.user_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
        )
        .all(userId, Math.min(200, Math.max(1, Math.floor(limit))), Math.max(0, Math.floor(offset))),
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
    if (!BUCKETS.includes(bucket)) throw new AppError(400, 'bad_bucket', 'Choose an outcome.');
    if (!Number.isInteger(stake) || stake < MIN_STAKE) {
      throw new AppError(400, 'bad_stake', `Stake must be a whole number of at least ${MIN_STAKE} points.`);
    }

    return tx(this.db, () => {
      const m = this.row(marketId);
      const cfg = parseConfig(m);
      const { closeAt } = windows(cfg, m.listing_at);
      const now = this.clock.now();
      if (m.published === 0) throw new AppError(404, 'market_not_found', 'Market not found.');
      if (!allowedBuckets(cfg).includes(bucket)) throw new AppError(400, 'bad_bucket', 'Choose Yes or No.');
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
      this.onPredicted(userId);
      queueMicrotask(() => this.marketChanged(marketId));
      return { id, balance: this.getUser(userId).points };
    });
  }

  quote(marketId: string, bucket: Bucket, stake: number) {
    if (!BUCKETS.includes(bucket)) throw new AppError(400, 'bad_bucket', 'Choose an outcome.');
    const m = this.publicRow(marketId);
    const cfg = parseConfig(m);
    if (!allowedBuckets(cfg).includes(bucket)) throw new AppError(400, 'bad_bucket', 'Choose Yes or No.');
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
      this.db.prepare(`SELECT ${this.lightCols} FROM markets WHERE mode = 'auto' AND status IN ('open', 'locked') AND listing_at <= ?`).all(now),
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
    const markets = as<MarketRow[]>(this.db.prepare(`SELECT ${this.lightCols} FROM markets WHERE status = 'open' AND published = 1`).all());
    for (const m of markets) {
      // One broken market must never hold up the others: it is skipped (and reported) each time.
      try {
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
        this.marketChanged(m.id);
        this.log(`market closed ${m.id}`);
      } catch (err) {
        this.reportStuck(m.id, 'close', err);
      }
    }
    if (closed.length) {
      queueMicrotask(() => {
        try {
          this.onClosed(closed);
        } catch (err) {
          this.log(`close alert failed: ${(err as Error).message}`);
        }
      });
    }
    return closed;
  }

  /** Settles locked markets whose 72-hour window has ended. */
  settleDueMarkets(): Notification[] {
    const now = this.clock.now();
    const notes: Notification[] = [];
    const markets = as<MarketRow[]>(this.db.prepare(`SELECT ${this.lightCols} FROM markets WHERE mode = 'auto' AND status = 'locked'`).all());

    for (const m of markets) {
      try {
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
      } catch (err) {
        this.reportStuck(m.id, 'settle', err);
      }
    }
    return notes;
  }

  private stuckLogged = new Map<string, number>();

  /** A market failed to close or settle: logged (at most every 10 minutes per market) and skipped. */
  private reportStuck(marketId: string, action: string, err: unknown) {
    const key = `${action}:${marketId}`;
    const at = Date.now();
    if (at - (this.stuckLogged.get(key) ?? 0) < 10 * MINUTE) return;
    if (this.stuckLogged.size > 500) this.stuckLogged.clear();
    this.stuckLogged.set(key, at);
    this.log(`market ${marketId} couldn't ${action}, skipped for now: ${(err as Error)?.message ?? err}`);
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
      const outcomes = parseConfig(m).outcomes ?? 'ladder';
      for (const n of perUser.values()) notes.push({ ...n, outcomes });
      this.storeNotifications(notes, outcomes, now);
    });
    this.livePrices.delete(m.id);
    this.marketChanged(m.id);
    if (status === 'resolved' && m.published === 1) this.announce('result', m.id);
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
    name?: string | null;
  }): number | null {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO detected_listings (exchange, symbol, pair, source, title, url, listing_at, published_at, detected_at, dedupe_key, name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.exchange, d.symbol, d.pair, d.source, d.title, d.url, d.listingAt, d.publishedAt, this.clock.now(), d.dedupeKey, d.name ?? null);
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
      name: (r.name as string | null) ?? null,
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
  approveDetection(id: number, input: { symbol?: string; name?: string; listingAt?: number; config?: Partial<MarketConfig>; allowStarted?: boolean } = {}) {
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
      allowStarted: input.allowStarted,
    });
    this.db.prepare("UPDATE detected_listings SET status = 'approved', market_id = ?, symbol = ?, listing_at = ? WHERE id = ?").run(marketId, symbol, listingAt, id);
    return marketId;
  }

  /** Listing markets created since a time (automatic ones count toward the daily limit). */
  listingMarketsSince(since: number): number {
    return as<{ n: number }>(this.db.prepare("SELECT COUNT(*) AS n FROM markets WHERE mode = 'auto' AND kind = 'listing' AND created_at >= ?").get(since)).n;
  }

  /** Whether a market for this token is open or waiting for its result (any kind, including drafts). */
  hasActiveMarket(symbol: string): boolean {
    // A draft whose close time has passed was abandoned: it doesn't block a new listing of the same token.
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM markets WHERE symbol = ? AND status IN ('open', 'locked') AND NOT (published = 0 AND listing_at < ?) LIMIT 1")
        .get(symbol.toUpperCase(), this.clock.now()),
    );
  }

  /** Automatic markets for new listings: on unless an admin switched them off. */
  autoListingsEnabled(): boolean {
    const r = as<{ value: string } | undefined>(this.db.prepare("SELECT value FROM settings WHERE key = 'auto_listings'").get());
    return r?.value !== '0';
  }

  setAutoListings(enabled: boolean) {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('auto_listings', enabled ? '1' : '0');
    return this.autoListingsEnabled();
  }

  // --- Team: admin-console access given from Settings -------------------------------

  teamList() {
    return as<{ id: number; kind: 'email' | 'wallet'; value: string; role: 'admin' | 'listings' | 'tasks'; added_at: number }[]>(
      this.db.prepare('SELECT id, kind, value, role, added_at FROM team_members ORDER BY added_at').all(),
    ).map((r) => ({ id: r.id, kind: r.kind, value: r.value, role: r.role, addedAt: r.added_at }));
  }

  /** Gives an email or a Solana wallet admin, listings (markets and tasks) or tasks-only access; adding it again changes the role. */
  teamAdd(input: { value: string; role: string }) {
    const raw = String(input.value ?? '').trim();
    const role = (['admin', 'listings', 'tasks'] as const).find((r) => r === input.role) ?? null;
    if (!role) throw new AppError(400, 'bad_role', 'Choose a role: Admin, Listings and tasks, or Tasks only.');
    let kind: 'email' | 'wallet';
    let value: string;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      kind = 'email';
      value = raw.toLowerCase();
    } else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) {
      kind = 'wallet';
      value = raw;
    } else throw new AppError(400, 'bad_member', 'Enter an email address or a Solana wallet address.');
    this.db
      .prepare('INSERT INTO team_members (kind, value, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(value) DO UPDATE SET role = excluded.role')
      .run(kind, value, role, this.clock.now());
    return this.teamList();
  }

  teamRemove(id: number) {
    this.db.prepare('DELETE FROM team_members WHERE id = ?').run(Number(id));
    return this.teamList();
  }

  /** The strongest team role for an account: by email (when proved this session) or by a linked wallet. */
  teamRoleFor(email: string | null, wallets: string[]): 'admin' | 'listings' | 'tasks' | null {
    const values = [...(email ? [email.toLowerCase()] : []), ...wallets];
    if (!values.length) return null;
    const rows = as<{ role: string }[]>(
      this.db.prepare(`SELECT role FROM team_members WHERE value IN (${values.map(() => '?').join(', ')})`).all(...values),
    );
    for (const role of ['admin', 'listings', 'tasks'] as const) if (rows.some((r) => r.role === role)) return role;
    return null;
  }

  // --- Public Telegram channel ------------------------------------------------------

  /** Each token's own banner on channel posts. On unless an admin switched it off in Settings. */
  tokenBannersEnabled() {
    return this.getSetting('telegram_token_banners') !== '0';
  }

  setTokenBanners(enabled: boolean) {
    this.setSetting('telegram_token_banners', enabled ? '1' : '0');
    return this.tokenBannersEnabled();
  }

  /** Stores the PNG copy of a market's logo used on its Telegram banners. */
  setLogoPng(marketId: string, png: string | null) {
    if (png !== null && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png) || png.length > 300_000)) {
      throw new AppError(400, 'bad_logo', 'The banner logo must be a PNG under 200 KB.');
    }
    const r = this.db.prepare('UPDATE markets SET logo_png = ? WHERE id = ?').run(png, marketId);
    if (!r.changes) throw new AppError(404, 'market_not_found', 'Market not found.');
  }

  logoPng(marketId: string): string | null {
    return as<{ logo_png: string | null } | undefined>(this.db.prepare('SELECT logo_png FROM markets WHERE id = ?').get(marketId))?.logo_png ?? null;
  }

  markAnnounced(marketId: string) {
    this.db.prepare('UPDATE markets SET announced_at = ? WHERE id = ?').run(this.clock.now(), marketId);
  }

  /** Open, published markets that were never posted to the channel (e.g. made before it was set up). */
  unannouncedOpenMarkets(): string[] {
    return this.channelMarkets(true);
  }

  /** Open, published markets for the channel, soonest to close first; only never-posted ones if asked. */
  channelMarkets(unpostedOnly = false): string[] {
    return as<{ id: string }[]>(
      this.db
        .prepare(`SELECT id FROM markets WHERE status = 'open' AND published = 1 AND kind = 'listing' ${unpostedOnly ? 'AND announced_at IS NULL' : ''} ORDER BY listing_at`)
        .all(),
    ).map((r) => r.id);
  }

  /**
   * Open markets whose predictions close within the next hour and haven't had a reminder yet.
   * Markets that were only open for two hours or less are skipped: their "new market" post is recent enough.
   */
  marketsClosingSoon(withinMs = 60 * MINUTE): string[] {
    const now = this.clock.now();
    const rows = as<MarketRow[]>(this.db.prepare(`SELECT ${this.lightCols} FROM markets WHERE status = 'open' AND published = 1 AND reminded_at IS NULL AND kind = 'listing'`).all());
    return rows
      .filter((m) => {
        const { closeAt } = windows(parseConfig(m), m.listing_at);
        return closeAt > now && closeAt - now <= withinMs && closeAt - m.opened_at > 2 * withinMs;
      })
      .map((m) => m.id);
  }

  markReminded(marketId: string) {
    this.db.prepare('UPDATE markets SET reminded_at = ? WHERE id = ?').run(this.clock.now(), marketId);
  }

  /** Listings left in the review queue for days are no longer worth a market. */
  expireDetections(before: number) {
    this.db
      .prepare("UPDATE detected_listings SET status = 'ignored' WHERE status = 'pending' AND ((listing_at IS NOT NULL AND listing_at < ?) OR (listing_at IS NULL AND detected_at < ?))")
      .run(before, before);
  }

  /** Marks a detected listing as done once the admin has made a market for it from the review queue. */
  linkDetection(id: number, marketId: string) {
    this.db.prepare("UPDATE detected_listings SET status = 'approved', market_id = ? WHERE id = ? AND status = 'pending'").run(marketId, id);
  }

  /**
   * Maintenance mode, for deploying big changes safely: players can't write (sign up, predict,
   * claim) and the background workers pause, so the copy a new server starts from has everything.
   * Stored in the database, so a freshly deployed server starts in maintenance too.
   */
  /**
   * Set while this server hands over to a newly deployed one (memory only, never saved): it works
   * like maintenance mode, for admins too, since anything saved here now would be lost.
   */
  handingOff: number | null = null;

  maintenance(): { on: boolean; message: string; since: number | null } {
    if (this.handingOff !== null) return { on: true, message: 'Firstprint is updating. Back in about a minute.', since: this.handingOff };
    try {
      const v = JSON.parse(this.getSetting('maintenance') ?? 'null') as { message?: string; since?: number } | null;
      if (v) return { on: true, message: String(v.message ?? ''), since: Number(v.since) || null };
    } catch {
      /* a broken value counts as off */
    }
    return { on: false, message: '', since: null };
  }

  setMaintenance(on: boolean, message = '') {
    const text = String(message ?? '').trim().slice(0, 200);
    this.setSetting('maintenance', on ? JSON.stringify({ message: text, since: this.maintenance().since ?? this.clock.now() }) : null);
    this.log(`maintenance ${on ? 'on' : 'off'}`);
    return this.maintenance();
  }

  getSetting(key: string): string | null {
    return as<{ value: string } | undefined>(this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key))?.value ?? null;
  }

  setSetting(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  /** Skips every listing still waiting for review. Returns how many were skipped. */
  ignoreAllDetections() {
    return Number(this.db.prepare("UPDATE detected_listings SET status = 'ignored' WHERE status = 'pending'").run().changes);
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

  /**
   * Published markets for the public lists. `limit` caps how many come back (guests get a short
   * list; players a larger one), and `total` says how many there are, so the page can offer more.
   * Open markets that close soonest come first, so a short list shows the most urgent ones.
   */
  /**
   * How long (ms) a public market list is reused before it's built again. Every open page asks for
   * the lists, and building one reads every prediction of every market in it, so the server builds
   * each list once for everyone and only adds each player's own picks. 0 (tests) builds it every time.
   */
  listCacheMs = 0;

  /** A market changed: rebuild the lists on the next request, and tell open pages (live updates). */
  private marketChanged(marketId: string) {
    this.listCache.clear();
    this.boardCache.clear();
    this.onEvent('market', { marketId });
  }
  private listCache = new Map<string, { at: number; markets: ReturnType<FirstprintService['view']>[]; total: number }>();

  listMarketsPage(filter: 'open' | 'live' | 'settled' | 'all', userId: string | undefined, limit: number) {
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    const key = `${filter}:${n}`;
    const at = Date.now();
    let hit = this.listCache.get(key);
    if (!hit || at - hit.at >= this.listCacheMs) {
      const where = this.listWhere(filter);
      // listing_at is when predictions close (manual markets) or trading starts (listings).
      const order = filter === 'settled' ? 'listing_at DESC' : 'listing_at ASC';
      const rows = as<MarketRow[]>(this.db.prepare(`SELECT ${this.lightCols} FROM markets WHERE published = 1 AND ${where} ORDER BY ${order} LIMIT ?`).all(n));
      const total = as<{ n: number }>(this.db.prepare(`SELECT COUNT(*) AS n FROM markets WHERE published = 1 AND ${where}`).get()).n;
      hit = { at, markets: rows.map((r) => this.view(r)), total };
      if (this.listCacheMs > 0) this.listCache.set(key, hit);
    }
    if (!userId || !hit.markets.length) return { markets: hit.markets, total: hit.total };
    // The player's own picks are always fresh: one query for the whole list.
    const ids = hit.markets.map((m) => m.id);
    const own = as<PredictionRow[]>(
      this.db
        .prepare(`SELECT * FROM predictions WHERE user_id = ? AND market_id IN (${ids.map(() => '?').join(', ')}) ORDER BY placed_at, id`)
        .all(userId, ...ids),
    );
    const byMarket = new Map<string, PredictionRow[]>();
    for (const p of own) byMarket.set(p.market_id, [...(byMarket.get(p.market_id) ?? []), p]);
    return { markets: hit.markets.map((m) => (byMarket.has(m.id) ? { ...m, mine: byMarket.get(m.id)!.map(minePick) } : m)), total: hit.total };
  }

  private listWhere(filter: 'open' | 'live' | 'settled' | 'all') {
    return filter === 'open' ? "status = 'open'" : filter === 'live' ? "status = 'locked'" : filter === 'settled' ? "status IN ('resolved', 'void')" : '1 = 1';
  }

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
    const rows = as<MarketRow[]>(this.db.prepare(`SELECT ${this.lightCols} FROM markets WHERE published = 1 AND ${where} ORDER BY ${order} LIMIT 50`).all());
    return rows.map((r) => this.view(r, userId));
  }

  /** Public read. Unpublished drafts are only visible to the admin panel (asAdmin). */
  getMarket(id: string, userId?: string, asAdmin = false) {
    const m = this.row(id);
    if (m.published === 0 && !asAdmin) throw new AppError(404, 'market_not_found', 'Market not found.');
    return this.view(m, userId, asAdmin);
  }

  /**
   * An uploaded logo (stored as a data: URL) as image bytes, for /api/logo/:id. Public lists link to
   * it instead of carrying the image in every response, so browsers and the CDN cache it.
   */
  logoImage(id: string): { type: string; bytes: Buffer } | null {
    const r = as<{ logo_url: string | null; published: number } | undefined>(this.db.prepare('SELECT logo_url, published FROM markets WHERE id = ?').get(id));
    const m = r?.published === 1 ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(r.logo_url ?? '') : null;
    return m ? { type: m[1], bytes: Buffer.from(m[2], 'base64') } : null;
  }

  settlement(id: string) {
    this.publicRow(id);
    return this.settlementOf(id);
  }

  private settlementOf(id: string) {
    const s = as<{ result: string; data_hash: string; settled_at: number } | undefined>(
      this.db.prepare('SELECT * FROM settlements WHERE market_id = ?').get(id),
    );
    if (!s) throw new AppError(404, 'not_settled', 'This market has not settled yet.');
    // Public: players' internal ids are left out (the hash still proves the stored result).
    return { marketId: id, settledAt: s.settled_at, dataHash: s.data_hash, result: JSON.parse(s.result, (k, v) => (k === 'userId' ? undefined : v)) as SettlementResult };
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
    const rows = as<(PredictionRow & { symbol: string; exchange: string; status: string; mode: string; config: string })[]>(
      this.db
        .prepare(
          `SELECT p.*, m.symbol, m.exchange, m.status, m.mode, m.config FROM predictions p
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
      outcomes: (JSON.parse(r.config) as MarketConfig).outcomes ?? 'ladder',
      bucket: r.bucket,
      stake: r.stake,
      accepted: r.accepted,
      refund: r.refund,
      payout: r.payout,
      placedAt: r.placed_at,
    }));
  }

  /** The signed-in player's record for the dashboard, plus their all-time rank by net points won. */
  myStats(userId: string) {
    return this.statsFor(userId);
  }

  private statsFor(userId: string) {
    const rows = as<{ market_id: string; symbol: string; status: string; config: string; settled_at: number | null; result: string | null; bucket: Bucket; stake: number; accepted: number | null; refund: number | null; payout: number | null }[]>(
      this.db
        .prepare(
          `SELECT p.market_id, m.symbol, m.status, m.config, s.settled_at, s.result, p.bucket, p.stake, p.accepted, p.refund, p.payout
           FROM predictions p
           JOIN markets m ON m.id = p.market_id
           LEFT JOIN settlements s ON s.market_id = m.id
           WHERE p.user_id = ?`,
        )
        .all(userId),
    );
    const winning = (result: string | null): Bucket | null => {
      try {
        return result ? ((JSON.parse(result) as { winningBucket?: Bucket | null }).winningBucket ?? null) : null;
      } catch {
        return null;
      }
    };
    const record = summarizeRecord(
      rows.map((r) => ({
        marketId: r.market_id,
        symbol: r.symbol,
        status: r.status,
        settledAt: r.settled_at,
        winningBucket: r.status === 'resolved' ? winning(r.result) : null,
        bucket: r.bucket,
        stake: r.stake,
        accepted: r.accepted,
        refund: r.refund,
        payout: r.payout,
        binary: isBinary(JSON.parse(r.config) as MarketConfig),
      })),
    );
    const profits = as<{ user_id: string; profit: number }[]>(
      this.db
        .prepare(
          `SELECT p.user_id, SUM(COALESCE(p.payout, 0) - COALESCE(p.accepted, 0)) AS profit
           FROM predictions p JOIN markets m ON m.id = p.market_id
           WHERE m.status = 'resolved' AND COALESCE(p.accepted, 0) > 0
           GROUP BY p.user_id`,
        )
        .all(),
    );
    const mine = profits.find((p) => p.user_id === userId);
    return {
      ...record,
      history: record.history.slice(0, 100),
      rank: mine ? 1 + profits.filter((p) => p.profit > mine.profit).length : null,
      players: profits.length,
    };
  }

  /**
   * One player's result on one settled market, for the shareable PnL card. Only what is already
   * public (the market, the username and their record on the public profile) is included.
   */
  pnlCard(marketId: string, username: string) {
    const u = as<{ id: string; username: string } | undefined>(
      this.db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(String(username ?? '').trim()),
    );
    if (!u) throw new AppError(404, 'user_not_found', 'No player with that username.');
    const h = this.statsFor(u.id).history.find((x) => x.marketId === marketId);
    if (!h) throw new AppError(404, 'no_result', 'This player has no settled prediction on that market.');
    const m = this.getMarket(marketId);
    if (!m.published) throw new AppError(404, 'market_not_found', 'Market not found.');
    return {
      username: u.username,
      marketId,
      symbol: m.symbol,
      name: m.name,
      exchange: m.exchange,
      outcomes: m.outcomes,
      picks: h.buckets,
      winningBucket: h.winningBucket,
      returnPct: m.result?.returnPct ?? null,
      staked: h.staked,
      payout: h.payout,
      profit: h.profit,
      won: h.won,
      settledAt: h.settledAt,
    };
  }

  /**
   * A player's public page: username, record and current positions. Usernames and predictions are
   * already public on markets and the leaderboard; email, wallets and X are never included.
   */
  publicProfile(username: string, viewerId?: string) {
    const u = as<{ id: string; username: string; created_at: number } | undefined>(
      this.db.prepare('SELECT id, username, created_at FROM users WHERE username = ? COLLATE NOCASE').get(String(username ?? '').trim()),
    );
    if (!u) throw new AppError(404, 'user_not_found', 'No player with that username.');
    const stats = this.statsFor(u.id);
    const open = as<{ market_id: string; symbol: string; name: string | null; status: string; config: string; bucket: Bucket; stake: number }[]>(
      this.db
        .prepare(
          `SELECT p.market_id, m.symbol, m.name, m.status, m.config, p.bucket, SUM(p.stake) AS stake
           FROM predictions p JOIN markets m ON m.id = p.market_id
           WHERE p.user_id = ? AND m.published = 1 AND m.status IN ('open', 'locked')
           GROUP BY p.market_id, p.bucket
           ORDER BY MAX(p.placed_at) DESC LIMIT 50`,
        )
        .all(u.id),
    );
    return {
      username: u.username,
      joinedAt: u.created_at,
      isMe: u.id === viewerId,
      stats: { ...stats, history: stats.history.slice(0, 30) },
      positions: open.map((r) => ({
        marketId: r.market_id,
        symbol: r.symbol,
        name: r.name,
        marketStatus: r.status,
        outcomes: (JSON.parse(r.config) as MarketConfig).outcomes ?? 'ladder',
        bucket: r.bucket,
        stake: r.stake,
      })),
    };
  }

  /** Who has the most points on a market, with what they picked. Usernames only. */
  holders(marketId: string, limit = 20) {
    const m = this.publicRow(marketId);
    const settled = m.status === 'resolved' || m.status === 'void';
    const rows = as<{ username: string; bucket: Bucket; stake: number; payout: number | null }[]>(
      this.db
        .prepare(
          `SELECT u.username, p.bucket, SUM(p.stake) AS stake, SUM(COALESCE(p.payout, 0)) AS payout
           FROM predictions p JOIN users u ON u.id = p.user_id
           WHERE p.market_id = ? GROUP BY p.user_id, p.bucket`,
        )
        .all(marketId),
    );
    const byUser = new Map<string, { username: string; total: number; payout: number; picks: { bucket: Bucket; stake: number }[] }>();
    for (const r of rows) {
      const h = byUser.get(r.username) ?? { username: r.username, total: 0, payout: 0, picks: [] };
      h.total += r.stake;
      h.payout += r.payout ?? 0;
      h.picks.push({ bucket: r.bucket, stake: r.stake });
      byUser.set(r.username, h);
    }
    const holders = [...byUser.values()]
      .sort((a, b) => b.total - a.total || a.username.localeCompare(b.username))
      .slice(0, limit)
      .map((h) => ({ ...h, picks: h.picks.sort((a, b) => b.stake - a.stake), payout: settled ? h.payout : null }));
    return { holders, total: byUser.size };
  }

  /**
   * How the crowd's split changed over time: each outcome's share of the pool after every
   * prediction, thinned to at most `points` steps (the latest always kept).
   */
  odds(marketId: string, points = 120) {
    const m = this.publicRow(marketId);
    const cfg = parseConfig(m);
    const buckets = allowedBuckets(cfg);
    const totals = emptyTotals();
    let pool = 0;
    const steps: { t: number; shares: Partial<Record<Bucket, number>> }[] = [];
    for (const p of this.predictions(marketId)) {
      totals[p.bucket] += p.stake;
      pool += p.stake;
      steps.push({ t: p.placed_at, shares: Object.fromEntries(buckets.map((b) => [b, Math.round((totals[b] / pool) * 1000) / 1000])) });
    }
    const every = Math.max(1, Math.ceil(steps.length / points));
    const series = steps.filter((_, i) => i % every === 0 || i === steps.length - 1);
    return { outcomes: cfg.outcomes ?? 'ladder', buckets, openedAt: m.opened_at, series };
  }

  /** How long (ms) a leaderboard is reused; any market change rebuilds it sooner. 0 (tests) builds it every time. */
  leaderboardCacheMs = 0;
  private boardCache = new Map<string, { at: number; rows: { user_id: string; name: string | null; profit: number; wins: number; total: number }[] }>();

  leaderboard(userId?: string, period: LeaderboardPeriod = 'week') {
    const now = this.clock.now();
    const { start, end } = periodRange(period, now);
    const key = `${period}:${start}`;
    const at = Date.now();
    const hit = this.boardCache.get(key);
    const rows = hit && at - hit.at < this.leaderboardCacheMs ? hit.rows : this.leaderboardRows(start);
    if (this.leaderboardCacheMs > 0 && rows !== hit?.rows) {
      if (this.boardCache.size > 20) this.boardCache.clear();
      this.boardCache.set(key, { at, rows });
    }
    const ranked = rows.map((r, i) => ({ rank: i + 1, userId: r.user_id, name: r.name, profit: r.profit, wins: r.wins, total: r.total }));
    return {
      period,
      seasonStart: start,
      seasonEnd: end,
      entries: ranked.slice(0, 50).map(({ userId: _u, ...rest }) => ({ ...rest, isMe: _u === userId })),
      me: userId ? (ranked.find((r) => r.userId === userId) ?? null) : null,
    };
  }

  private leaderboardRows(start: number) {
    return as<{ user_id: string; name: string | null; profit: number; wins: number; total: number }[]>(
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

  /**
   * Predictions for drawing a market, reused for up to 2 seconds while nothing has been written:
   * every refresh of every visitor's list would otherwise re-read every prediction of every market.
   * Any write on this connection (total_changes) makes it read afresh. Points logic never uses this.
   */
  private viewCache = new Map<string, { gen: number; at: number; rows: readonly PredictionRow[] }>();
  private predictionsForView(marketId: string): readonly PredictionRow[] {
    const gen = (this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const at = Date.now();
    const hit = this.viewCache.get(marketId);
    if (hit && hit.gen === gen && at - hit.at < 2_000) return hit.rows;
    const rows = this.predictions(marketId);
    if (this.viewCache.size > 1_000) this.viewCache.clear();
    this.viewCache.set(marketId, { gen, at, rows });
    return rows;
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

  private view(m: MarketRow, userId?: string, rawLogo = false) {
    const cfg = parseConfig(m);
    const w = windows(cfg, m.listing_at);
    const now = this.clock.now();
    const preds = this.predictionsForView(m.id);
    const afterClose = m.status !== 'open';

    const totals = emptyTotals();
    const users = new Set<string>();
    let volume24h = 0;
    for (const p of preds) {
      totals[p.bucket] += afterClose ? (p.accepted ?? 0) : p.stake;
      users.add(p.user_id);
      if (p.placed_at > now - DAY) volume24h += p.stake;
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
        projectedBucket: r === null ? null : bucketFor(r, cfg),
        provisional: m.status === 'open',
      };
    }

    let result = null;
    if (m.status === 'resolved' || m.status === 'void') {
      const s = this.settlementOf(m.id).result;
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

    const mine = userId ? preds.filter((p) => p.user_id === userId).map(minePick) : [];

    return {
      id: m.id,
      mode: m.mode ?? 'auto',
      published: m.published !== 0,
      basePrice: m.base_price,
      startAtClose: m.start_at_close === 1,
      note: m.note,
      kind: m.kind ?? 'listing',
      symbol: m.symbol,
      name: m.name,
      exchange: m.exchange,
      venues: (JSON.parse(m.venues) as VenueRef[]).map((v) => ({ id: v.venue, name: this.venues.get(v.venue)?.name ?? v.venue, pair: v.symbol })),
      sourceUrl: m.source_url,
      // Uploaded logos are served from /api/logo/:id (versioned, cached) instead of inline in every list.
      logoUrl: m.logo_url && !rawLogo && /^data:image\/(png|jpeg|webp|gif);/.test(m.logo_url) ? `/api/logo/${encodeURIComponent(m.id)}?v=${m.logo_ver ?? logoVersion(m.logo_url)}` : (m.logo_url ?? null),
      hasLogoPng: Boolean(m.logo_png ?? m.has_logo_png),
      autoOpenAt: m.auto_open_at ?? null,
      autoOpenNote: m.auto_open_note ?? null,
      status: m.status,
      phase,
      announcedListingAt: m.announced_listing_at,
      listingAt: m.listing_at,
      openedAt: m.opened_at,
      closeAt: w.closeAt,
      settleAt: w.settleAt,
      outcomes: cfg.outcomes ?? 'ladder',
      thresholds: cfg.thresholds,
      feeBps: cfg.feeBps,
      earlyBirdK: cfg.earlyBirdK,
      softCap: cfg.softCap,
      userCap: Math.floor(cfg.softCap * cfg.perUserCapPct),
      minStake: MIN_STAKE,
      pool,
      totals,
      predictors: users.size,
      volume24h,
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

/** One of the player's own predictions, as shown with a market. */
function minePick(p: PredictionRow) {
  return { id: p.id, bucket: p.bucket, stake: p.stake, accepted: p.accepted, refund: p.refund, payout: p.payout, weight: p.weight, placedAt: p.placed_at };
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
  if (overrides.outcomes !== undefined) {
    if (overrides.outcomes !== 'ladder' && overrides.outcomes !== 'binary') throw new AppError(400, 'bad_config', 'Market type must be "ladder" or "binary".');
    cfg.outcomes = overrides.outcomes;
  }
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

export type LeaderboardPeriod = 'day' | 'week' | 'month' | 'all';
export const LEADERBOARD_PERIODS: readonly LeaderboardPeriod[] = ['day', 'week', 'month', 'all'];

/** The window a leaderboard covers: today, this week (from Monday), this month (all UTC), or all time. */
export function periodRange(period: LeaderboardPeriod, now: number): { start: number; end: number | null } {
  const d = new Date(now);
  if (period === 'day') {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return { start, end: start + DAY };
  }
  if (period === 'month') return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
  if (period === 'all') return { start: 0, end: null };
  const start = weekStart(now);
  return { start, end: start + 7 * DAY };
}

/** Monday 00:00 UTC of the current week. */
export function weekStart(now: number): number {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

const LOGO_DATA = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const MAX_LOGO = 40_000;

/** Accepts an https image URL or a small base64 image; empty means no logo. */
function cleanLogo(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  if (s.length > MAX_LOGO) throw new AppError(400, 'bad_logo', 'The logo is too large. Use an image under 25 KB or a link to one.');
  if (LOGO_DATA.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new AppError(400, 'bad_logo', 'The logo must be an https:// image link or an uploaded PNG, JPG, WebP or GIF.');
  }
  if (url.protocol !== 'https:') throw new AppError(400, 'bad_logo', 'The logo link must start with https://');
  return url.toString();
}
