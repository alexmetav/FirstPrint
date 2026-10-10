// In-browser demo backend. Uses the real market engine with simulated prices,
// so the site can be previewed without a server. Same methods as createApi().

import {
  BUCKETS,
  DEFAULT_CONFIG,
  DEFAULT_REVERT_RULES,
  applyCaps,
  bucketForReturn,
  emptyTotals,
  quote,
  returnPct,
  revertQuote,
  settleMarket,
  summarizeRecord,
  twap,
  venueMedian,
  windows,
} from './engine.js';
import { ApiError } from './api.js';
import { b58encode } from './wallet.js';

const D3_MIN = 60_000;
const D3_HOUR = 60 * D3_MIN;
const DEMO_EMAIL = 'demo@firstprint.app';
const DEMO_PASSWORD = 'demo-password';

const FAST_CFG = { ...DEFAULT_CONFIG, baselineMs: 2 * D3_MIN, durationMs: 10 * D3_MIN, settleWindowMs: 2 * D3_MIN, minTrades: 1 };
const REAL_CFG = { ...DEFAULT_CONFIG };

function demoHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

function demoPrice(m, ts) {
  const p = m.profile;
  const f = Math.max(0, (ts - m.listingAt) / m.cfg.durationMs);
  const trend = p.startPrice * Math.pow(1 + p.target, Math.min(f, 1.2));
  const noise = (demoHash(`${m.symbol}:${ts}`) - 0.5) * 2 * p.noise;
  return Math.max(1e-9, trend * (1 + noise));
}

const BOT_NAMES = ['moonmaxi', 'rektless', 'gridqueen', 'deltaneutral', 'unlockwatcher', 'airdropdan', 'thetaburn', 'bidwall', 'fdvfinder', 'cexhunter'];

// Markets relative to page load. `at` is minutes from now until listing.
const DEMO_MARKETS = [
  { symbol: 'KORA', name: 'Kora Network', exchange: 'MEXC', at: 3, fast: true, target: -0.36, bots: 8, scorecard: { fdvUsd: 180e6, circulatingPct: 14, airdropPct: 8, unlocks: 'Team and investors: 6-month cliff, then monthly.' } },
  { symbol: 'BRINE', name: 'Brine Finance', exchange: 'Bybit', at: -1, fast: true, target: 0.74, bots: 7, scorecard: { fdvUsd: 42e6, circulatingPct: 31, airdropPct: 22, unlocks: 'Airdrop fully unlocked at listing.' } },
  { symbol: 'LUMA', name: 'Luma Compute', exchange: 'Binance', at: 5 * 60 + 12, fast: false, target: 0.18, bots: 9, scorecard: { fdvUsd: 950e6, circulatingPct: 11, airdropPct: 5, unlocks: 'Linear monthly unlocks from month 4.' } },
  { symbol: 'FERRO', name: 'Ferro Pay', exchange: 'Bitget', at: 26 * 60, fast: false, target: -0.12, bots: 5, scorecard: { fdvUsd: 64e6, circulatingPct: 22, airdropPct: 12, unlocks: 'No vesting schedule published.' } },
  { symbol: 'OTTO', name: 'Otto Agents', exchange: 'Binance', at: -4, fast: true, target: 0.3, bots: 9, mine: { bucket: 'up', stake: 150, before: 10 }, scorecard: { fdvUsd: 610e6, circulatingPct: 9, airdropPct: 4, unlocks: 'Linear monthly unlocks from month 3.' } },
  { symbol: 'SABLE', name: 'Sable DEX', exchange: 'OKX', at: -20 * 60, fast: false, target: -0.28, bots: 10, scorecard: { fdvUsd: 120e6, circulatingPct: 26, airdropPct: 15, unlocks: '10% unlock at month 1.' } },
  { symbol: 'PEBL', name: 'Pebble', exchange: 'OKX', at: -30, fast: true, target: -0.64, bots: 9, mine: { bucket: 'crash', stake: 200, before: 20 }, scorecard: { fdvUsd: 12.5e6, circulatingPct: 58, airdropPct: 35, unlocks: 'No vesting disclosed.' } },
  { symbol: 'NIMBUS', name: 'Nimbus AI', exchange: 'MEXC', at: -45, fast: true, target: 1.1, bots: 10, mine: { bucket: 'up', stake: 100, before: 15 }, scorecard: { fdvUsd: 75e6, circulatingPct: 18, airdropPct: 6, unlocks: 'Team tokens locked 12 months.' } },
  { symbol: 'GLINT', name: 'Glint Games', exchange: 'Gate', at: -60, fast: true, target: 0.03, bots: 8, scorecard: { fdvUsd: 30e6, circulatingPct: 40, airdropPct: 20, unlocks: 'Monthly unlocks from month 2.' } },
  { symbol: 'VANTA', name: 'Vanta Chain', exchange: 'Bybit', at: -50, fast: true, target: 0.4, bots: 2, oneSided: 'moon', scorecard: { fdvUsd: 220e6, circulatingPct: 12, airdropPct: 3, unlocks: 'Investor cliff 9 months.' } },
];

const DEMO_TASKS = [
  { id: 'demo-follow', kind: 'follow', title: 'Follow @firstprint on X', points: 50, url: 'https://x.com/intent/follow?screen_name=firstprint' },
  { id: 'demo-share', kind: 'share', title: 'Share Firstprint on X', points: 75, url: 'https://x.com/intent/tweet?text=Calling%20new%20listings%20on%20Firstprint&url=https%3A%2F%2Fwww.firstprint.fun' },
];

export class DemoBackend {
  constructor() {
    this.demo = true;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.seq = 0;
    this.users = new Map();
    this.accounts = new Map(); // email → { userId, password }
    this.marketList = [];
    const now = Date.now();

    const bots = BOT_NAMES.map((name) => this.addUser(name, 5_000));
    const me = this.addUser('you', 1_000);
    me.wallets.push({ address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', walletName: 'Phantom' });
    this.accounts.set(DEMO_EMAIL, { userId: me.id, password: DEMO_PASSWORD });
    this.challenges = new Map();
    this.walletOwners = new Map([[me.wallets[0].address, me.id]]);
    this.detected = this.demoDetections(now);
    this.sessionUserId = me.id;

    for (const d of DEMO_MARKETS) {
      const cfg = d.fast ? FAST_CFG : REAL_CFG;
      const listingAt = now + d.at * D3_MIN;
      const openedAt = listingAt - (d.fast ? 30 * D3_MIN : 36 * D3_HOUR);
      const m = {
        id: `${d.symbol.toLowerCase()}-${d.exchange.toLowerCase()}`,
        symbol: d.symbol,
        name: d.name,
        exchange: d.exchange,
        listingAt,
        announcedListingAt: listingAt,
        openedAt,
        cfg,
        scorecard: d.scorecard,
        status: 'open',
        predictions: [],
        result: null,
        profile: { startPrice: +(0.02 + demoHash(d.symbol) * 1.5).toFixed(4), target: d.target, noise: 0.025, volume: 5_000 },
      };
      const { closeAt } = windows(cfg, listingAt);
      const lastBetAt = Math.min(now, closeAt - 1_000);
      for (let i = 0; i < d.bots; i++) {
        const bot = bots[(i + d.symbol.length) % bots.length];
        const bucket = d.oneSided ?? BUCKETS[Math.floor(demoHash(`${d.symbol}:b:${i}`) * 5)];
        const stake = [25, 50, 100, 150, 250, 400][Math.floor(demoHash(`${d.symbol}:s:${i}`) * 6)];
        const placedAt = openedAt + (lastBetAt - openedAt) * demoHash(`${d.symbol}:t:${i}`) * 0.95;
        this.addPrediction(m, bot.id, bucket, stake, placedAt);
      }
      if (d.mine) this.addPrediction(m, me.id, d.mine.bucket, d.mine.stake, Math.min(lastBetAt, listingAt - d.mine.before * D3_MIN));
      this.marketList.push(m);
    }
    this.advance();
  }

  // --- Internals ---------------------------------------------------------------

  now() {
    return Date.now() + this.offset;
  }

  addUser(username, points) {
    const u = { id: `u${++this.seq}`, username, points, lastClaimDay: null, needsUsername: false, hasEmail: true, wallets: [] };
    this.users.set(u.id, u);
    return u;
  }

  addPrediction(m, userId, bucket, stake, placedAt) {
    const u = this.users.get(userId);
    u.points -= stake;
    const p = { id: `p${++this.seq}`, userId, bucket, stake, placedAt, accepted: null, refund: null, weight: null, payout: null };
    m.predictions.push(p);
    return p;
  }

  /** Completed 1-minute candles aligned to the listing time, within [start, end). */
  candles(m, start, end) {
    const out = [];
    const now = this.now();
    const k0 = Math.max(0, Math.ceil((start - m.listingAt) / D3_MIN));
    for (let ts = m.listingAt + k0 * D3_MIN; ts < end && ts + D3_MIN <= now; ts += D3_MIN) {
      out.push({ ts, close: demoPrice(m, ts), volume: m.profile.volume, trades: 12 });
    }
    return out;
  }

  advance() {
    const now = this.now();
    for (const m of this.marketList) {
      const w = windows(m.cfg, m.listingAt);
      if (m.status === 'open' && now >= w.closeAt) {
        const accepted = applyCaps(m.predictions, m.cfg.softCap, m.cfg, m.openedAt, w.closeAt);
        for (const a of accepted) {
          const p = m.predictions.find((x) => x.id === a.id);
          Object.assign(p, { accepted: a.accepted, refund: a.refund, weight: a.weight });
          this.users.get(p.userId).points += a.refund;
        }
        m.status = 'locked';
      }
      if (m.status === 'locked' && now >= w.settleAt) {
        const candles = [...this.candles(m, w.baseline.start, w.baseline.end), ...this.candles(m, w.final.start, w.final.end)];
        const result = settleMarket({
          cfg: m.cfg,
          announcedListingAt: m.announcedListingAt,
          listingAt: m.listingAt,
          openedAt: m.openedAt,
          retracted: false,
          haltedMs: 0,
          candles: { sim: candles },
          accepted: m.predictions.map((p) => ({ ...p })),
        });
        for (const r of result.payouts) {
          const p = m.predictions.find((x) => x.id === r.predictionId);
          const u = this.users.get(p.userId);
          u.points += r.refund - (p.refund ?? 0) + r.payout;
          p.refund = r.refund;
          p.payout = r.payout;
        }
        m.result = result;
        m.settledAt = now;
        m.status = result.voidReason ? 'void' : 'resolved';
      }
    }
  }

  me_() {
    const u = this.sessionUserId && this.users.get(this.sessionUserId);
    if (!u) throw new ApiError(401, 'auth_required', 'Log in to continue.');
    return u;
  }

  publicUser(u) {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    return {
      id: u.id,
      username: u.username,
      needsUsername: u.needsUsername,
      hasEmail: u.hasEmail,
      wallets: u.wallets,
      points: u.points,
      canClaimDaily: u.lastClaimDay !== today,
      daily: this.dailyStatus(u),
    };
  }

  /** Same streak rules as the server: 50 on day 1, +25 a day, 200 from day 7; a missed day resets. */
  dailyStatus(u) {
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    const today = day(this.now());
    const claimedToday = u.lastClaimDay === today;
    const alive = claimedToday || u.lastClaimDay === day(this.now() - 86_400_000);
    const streak = alive ? Math.max(1, u.streak ?? 1) : 0;
    return { streak, claimedToday, nextDay: streak + 1, next: Math.min(200, 50 + 25 * streak), max: 200 };
  }

  daily() {
    return this.run(() => {
      const u = this.me_();
      return { ...this.dailyStatus(u), today: new Date(this.now()).toISOString().slice(0, 10), days: u.claims ?? [], schedule: [50, 75, 100, 125, 150, 175, 200] };
    });
  }

  demoDetections(now) {
    const H = 60 * D3_MIN;
    const rows = [
      ['binance', 'Binance', 'LUMA', 'Binance Will List Luma Compute (LUMA) with Seed Tag Applied', 5 * H + 12 * D3_MIN, 'luma-binance', -3 * H],
      ['bitget', 'Bitget', 'FERRO', 'Bitget Will List Ferro Pay (FERRO) in the Innovation Zone', 26 * H, 'ferro-bitget', -9 * H],
      ['bybit', 'Bybit', 'ARCO', 'New Listing: ARCO/USDT — Grab a Share of 400,000 ARCO', 30 * H, null, -40 * D3_MIN],
      ['okx', 'OKX', 'TIDE', 'OKX to list Tide Protocol (TIDE) for spot trading', 44 * H, null, -2 * H],
      ['kucoin', 'KuCoin', 'MOSS', 'Moss Network (MOSS) Gets Listed on KuCoin!', 52 * H, null, -5 * H],
      ['gate', 'Gate', 'QUILL', 'QUILL/USDT pair added on Gate', 3 * H, null, -20 * D3_MIN],
      ['mexc', 'MEXC', 'KORA', 'KORA/USDT pair added on MEXC', 3 * D3_MIN, 'kora-mexc', -30 * D3_MIN],
    ];
    return rows.map(([exchange, exchangeName, symbol, title, inMs, marketId, ago], i) => ({
      id: i + 1,
      exchange,
      exchangeName,
      symbol,
      pair: `${symbol}USDT`,
      source: title.includes('pair added') ? 'symbol_diff' : 'announcement',
      title,
      url: title.includes('pair added') ? null : `https://example.com/announcements/${symbol.toLowerCase()}`,
      listingAt: now + inMs,
      publishedAt: now + ago,
      detectedAt: now + ago,
      status: marketId ? 'approved' : 'pending',
      marketId,
    }));
  }

  find(id) {
    const m = this.marketList.find((x) => x.id === id);
    if (!m) throw new ApiError(404, 'market_not_found', 'Market not found.');
    return m;
  }

  view(m) {
    const now = this.now();
    const w = windows(m.cfg, m.listingAt);
    const afterClose = m.status !== 'open';
    const totals = emptyTotals();
    const users = new Set();
    let volume24h = 0;
    for (const p of m.predictions) {
      totals[p.bucket] += afterClose ? (p.accepted ?? 0) : p.stake;
      users.add(p.userId);
      if (p.placedAt > now - 24 * D3_HOUR) volume24h += p.stake;
    }
    const pool = Object.values(totals).reduce((s, n) => s + n, 0);
    const phase = m.status === 'open' ? (now < m.listingAt ? 'pre_listing' : 'baseline') : m.status === 'locked' ? 'running' : m.status;

    let live = null;
    if ((m.status === 'open' || m.status === 'locked') && now >= m.listingAt + D3_MIN) {
      const baseEnd = Math.min(w.baseline.end, now);
      const base = twap(this.candles(m, w.baseline.start, baseEnd), w.baseline.start, baseEnd).twap;
      const lastTs = now - D3_MIN;
      const last = venueMedian([{ venue: 'sim', price: demoPrice(m, lastTs), volume: 1 }]);
      const r = base && last ? returnPct(base, last) : null;
      live = { basePrice: base, lastPrice: last, returnPct: r, projectedBucket: r === null ? null : bucketForReturn(r, m.cfg.thresholds), provisional: m.status === 'open' };
    }

    const result = m.result
      ? {
          winningBucket: m.result.winningBucket,
          returnPct: m.result.returnPct,
          voidReason: m.result.voidReason,
          basePrice: m.result.baseline.price,
          finalPrice: m.result.final.price,
          pool: m.result.pool,
          fee: m.result.fee,
        }
      : null;

    const mine = m.predictions
      .filter((p) => p.userId === this.sessionUserId)
      .map((p) => ({ id: p.id, bucket: p.bucket, stake: p.stake, accepted: p.accepted, refund: p.refund, payout: p.payout, weight: p.weight, placedAt: p.placedAt }));

    return {
      id: m.id,
      symbol: m.symbol,
      name: m.name,
      exchange: m.exchange,
      sourceUrl: null,
      logoUrl: m.logoUrl ?? null,
      status: m.status,
      phase,
      announcedListingAt: m.announcedListingAt,
      listingAt: m.listingAt,
      openedAt: m.openedAt,
      closeAt: w.closeAt,
      settleAt: w.settleAt,
      outcomes: 'ladder',
      thresholds: m.cfg.thresholds,
      feeBps: m.cfg.feeBps,
      earlyBirdK: m.cfg.earlyBirdK,
      softCap: m.cfg.softCap,
      userCap: Math.floor(m.cfg.softCap * m.cfg.perUserCapPct),
      minStake: 10,
      pool,
      totals,
      predictors: users.size,
      volume24h,
      live,
      result,
      scorecard: m.scorecard,
      mine,
      earlyPot: m.status === 'open' || m.status === 'locked' ? (m.earlyPot ?? 0) : 0,
      revert: DEFAULT_REVERT_RULES,
      serverTime: now,
    };
  }

  async run(fn) {
    await new Promise((r) => setTimeout(r, 60)); // feel like a network call
    this.advance();
    return structuredClone(fn());
  }

  // --- Public API (matches createApi) ----------------------------------------------

  config() {
    return this.run(() => ({ minStake: 10, dailyPoints: 50, dailyMax: 200, demo: true, manualOnly: false, signIn: { google: null, email: true } }));
  }

  me() {
    return this.run(() => ({ ...this.publicUser(this.me_()), unreadNotifications: 0 }));
  }

  /** Practice mode keeps no result notifications. */
  notifications() {
    return this.run(() => ({ unread: 0, notifications: [] }));
  }

  markNotificationsRead() {
    return this.run(() => ({ unread: 0 }));
  }

  signup({ email, username, password }) {
    return this.run(() => {
      email = String(email ?? '').trim().toLowerCase();
      username = String(username ?? '').trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new ApiError(400, 'bad_username', 'Username must be 3–20 letters, numbers, or underscores.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'bad_email', 'Enter a valid email address.');
      if (String(password ?? '').length < 8) throw new ApiError(400, 'bad_password', 'Password must be at least 8 characters.');
      if (this.accounts.has(email)) throw new ApiError(409, 'email_taken', 'An account with this email already exists. Log in instead.');
      if ([...this.users.values()].some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        throw new ApiError(409, 'username_taken', 'That username is taken. Try another.');
      }
      const u = this.addUser(username, 1_000);
      this.accounts.set(email, { userId: u.id, password });
      this.sessionUserId = u.id;
      return { user: this.publicUser(u) };
    });
  }

  /** Practice mode has no mail server: the code is always shown on screen. */
  emailStart(email) {
    return this.run(() => {
      email = String(email ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'bad_email', 'Enter a valid email address.');
      return { ok: true, devCode: '123456' };
    });
  }

  emailVerify(email, code) {
    return this.run(() => {
      email = String(email ?? '').trim().toLowerCase();
      if (String(code ?? '').trim() !== '123456') throw new ApiError(401, 'bad_code', 'That code is wrong. In practice mode it is 123456.');
      let acc = this.accounts.get(email);
      const created = !acc;
      if (!acc) {
        const base = (email.split('@')[0].replace(/[^A-Za-z0-9_]+/g, '_').slice(0, 16) || 'player').padEnd(3, '_');
        let username = base;
        for (let i = 2; [...this.users.values()].some((u) => u.username.toLowerCase() === username.toLowerCase()); i++) username = `${base}${i}`;
        const u = this.addUser(username, 1_000);
        acc = { userId: u.id, password: null };
        this.accounts.set(email, acc);
      }
      this.sessionUserId = acc.userId;
      return { user: this.publicUser(this.users.get(acc.userId)), created };
    });
  }

  login({ email, password }) {
    return this.run(() => {
      const acc = this.accounts.get(String(email ?? '').trim().toLowerCase());
      if (!acc || acc.password !== password) throw new ApiError(401, 'bad_credentials', 'Email or password is incorrect.');
      this.sessionUserId = acc.userId;
      return { user: this.publicUser(this.users.get(acc.userId)) };
    });
  }

  logout() {
    return this.run(() => {
      this.sessionUserId = null;
      return { ok: true };
    });
  }

  /** Practice mode: sample tasks, honour-based like the real ones; points go straight to the balance. */
  rewards() {
    return this.run(() => {
      const u = this.me_();
      u.tasks ??= {};
      const code = 'PRACTICE';
      return {
        onChain: false,
        cluster: null,
        mint: null,
        mintUrl: null,
        faucetUrl: 'https://faucet.solana.com',
        claimable: 0,
        welcomeClaimed: true,
        xUsername: u.xUsername ?? null,
        xConnectPoints: 100,
        referral: { code, link: `${location.origin}/?ref=${code}`, invited: 0, rewarded: 0, points: 0, limit: 25, perReferral: 200 },
        rewards: [],
        claims: [],
        tasks: DEMO_TASKS.map((t) => ({ ...t, done: Boolean(u.tasks[t.id]?.done), startedAt: u.tasks[t.id]?.startedAt ?? null, remaining: null })),
      };
    });
  }

  connectX(username) {
    return this.run(() => {
      const u = this.me_();
      const name = String(username ?? '').trim().replace(/^@/, '');
      if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) throw new ApiError(400, 'bad_x_username', 'Enter your X username, like @firstprint (letters, numbers and _ only).');
      const first = !u.xUsername;
      u.xUsername = name;
      if (first) u.points += 100;
      return { xUsername: name, rewarded: first ? 100 : 0 };
    });
  }

  startTask(taskId) {
    return this.run(() => {
      const u = this.me_();
      u.tasks ??= {};
      u.tasks[taskId] ??= { startedAt: Date.now(), done: false };
      return { ok: true };
    });
  }

  verifyTask(taskId) {
    return this.run(() => {
      const u = this.me_();
      const t = DEMO_TASKS.find((x) => x.id === taskId);
      const mine = u.tasks?.[taskId];
      if (!t) throw new ApiError(404, 'task_not_found', 'This task is no longer available.');
      if (t.kind !== 'link' && !u.xUsername) throw new ApiError(409, 'x_required', 'Link your X username first, so we know which account did it.');
      if (!mine) throw new ApiError(409, 'task_not_started', 'Open the task first, then come back to confirm it.');
      if (mine.done) throw new ApiError(409, 'task_done', 'You already completed this task.');
      if (Date.now() - mine.startedAt < 8_000) throw new ApiError(429, 'task_too_fast', 'Give it a few seconds: finish the task on X, then confirm.');
      mine.done = true;
      u.points += t.points;
      return { points: t.points, onChain: false };
    });
  }

  startClaim() {
    return this.run(() => {
      throw new ApiError(409, 'token_off', 'In practice mode points go straight to your balance. TestFPT claims are in the full app.');
    });
  }

  claimDaily() {
    return this.run(() => {
      const u = this.me_();
      const today = new Date(this.now()).toISOString().slice(0, 10);
      if (u.lastClaimDay === today) throw new ApiError(409, 'already_claimed', 'Daily points already claimed. Come back tomorrow (UTC).');
      const { nextDay } = this.dailyStatus(u);
      const reward = Math.min(200, 50 + 25 * (nextDay - 1));
      u.lastClaimDay = today;
      u.streak = nextDay;
      u.points += reward;
      (u.claims ??= []).push({ day: today, points: reward });
      return this.publicUser(u);
    });
  }

  markets(filter) {
    return this.run(() => {
      const pick = { open: ['open'], live: ['locked'], settled: ['resolved', 'void'], all: ['open', 'locked', 'resolved', 'void'] }[filter];
      const list = this.marketList.filter((m) => pick.includes(m.status));
      list.sort((a, b) => (filter === 'settled' ? b.listingAt - a.listingAt : a.listingAt - b.listingAt));
      return { markets: list.map((m) => this.view(m)), serverTime: this.now() };
    });
  }

  market(id) {
    return this.run(() => this.view(this.find(id)));
  }

  quote(id, bucket, stake) {
    return this.run(() => {
      const m = this.find(id);
      const { closeAt } = windows(m.cfg, m.listingAt);
      return quote(m.predictions, bucket, Math.max(0, Math.floor(stake) || 0), this.now(), m.cfg, m.openedAt, closeAt);
    });
  }

  predict(id, bucket, stake) {
    return this.run(() => {
      const u = this.me_();
      const m = this.find(id);
      const { closeAt } = windows(m.cfg, m.listingAt);
      if (!BUCKETS.includes(bucket)) throw new ApiError(400, 'bad_bucket', 'Choose Crash, Down, Flat, Up, or Moon.');
      if (!Number.isInteger(stake) || stake < 10) throw new ApiError(400, 'bad_stake', 'Stake must be a whole number of at least 10 points.');
      if (m.status !== 'open' || this.now() >= closeAt) throw new ApiError(409, 'market_closed', 'Predictions for this market are closed.');
      if (u.points < stake) throw new ApiError(400, 'insufficient_points', 'Not enough points for this prediction.');
      const userCap = Math.floor(m.cfg.softCap * m.cfg.perUserCapPct);
      const mine = m.predictions.filter((p) => p.userId === u.id).reduce((s, p) => s + p.stake, 0);
      if (mine + stake > userCap) throw new ApiError(409, 'user_cap', `You can stake up to ${userCap} points per market. You have ${userCap - mine} left.`);
      const p = this.addPrediction(m, u.id, bucket, stake, this.now());
      return { id: p.id, balance: u.points };
    });
  }

  /** Finds one of the player's predictions on an open market, with what taking it back costs now. */
  revertTarget(pid) {
    const u = this.me_();
    const m = this.marketList.find((x) => x.predictions.some((p) => p.id === pid));
    const p = m?.predictions.find((x) => x.id === pid);
    if (!p || p.userId !== u.id) throw new ApiError(404, 'prediction_not_found', 'Prediction not found.');
    const { closeAt } = windows(m.cfg, m.listingAt);
    if (m.status !== 'open' || this.now() >= closeAt) throw new ApiError(409, 'market_closed', 'Predictions for this market are closed.');
    return { u, m, p, closeAt, q: revertQuote(p.stake, p.placedAt, this.now(), m.openedAt, closeAt, DEFAULT_REVERT_RULES) };
  }

  revertQuote(pid) {
    return this.run(() => {
      const { p, q, closeAt } = this.revertTarget(pid);
      return { predictionId: p.id, stake: p.stake, ...q, lockAt: closeAt - DEFAULT_REVERT_RULES.lockMs };
    });
  }

  revert(pid) {
    return this.run(() => {
      const { u, m, p, q } = this.revertTarget(pid);
      if (!q.allowed) throw new ApiError(409, 'revert_locked', 'Predictions can’t be taken back this close to the close.');
      m.predictions = m.predictions.filter((x) => x.id !== p.id);
      m.earlyPot = (m.earlyPot ?? 0) + q.toEarly;
      u.points += q.back;
      return { id: p.id, back: q.back, fee: q.fee, burned: q.burn, toEarly: q.toEarly, free: q.free, balance: u.points };
    });
  }

  chart(id) {
    return this.run(() => {
      const m = this.find(id);
      const { settleAt } = windows(m.cfg, m.listingAt);
      const end = Math.min(this.now(), settleAt);
      if (end <= m.listingAt) return { venue: null, series: [] };
      const span = end - m.listingAt;
      const step = Math.max(D3_MIN, Math.ceil(span / 120 / D3_MIN) * D3_MIN);
      const series = [];
      for (let ts = m.listingAt; ts < end; ts += step) series.push([ts, demoPrice(m, ts)]);
      return { venue: 'sim', series };
    });
  }

  activity(id) {
    return this.run(() => {
      const m = this.find(id);
      const activity = [...m.predictions]
        .sort((a, b) => b.placedAt - a.placedAt)
        .slice(0, 30)
        .map((p) => ({ username: this.users.get(p.userId).username, bucket: p.bucket, stake: p.stake, placedAt: p.placedAt }));
      return { activity };
    });
  }

  /** Practice mode keeps no points history. */
  ledger() {
    return this.run(() => ({ entries: [] }));
  }

  myPredictions() {
    return this.run(() => {
      const u = this.me_();
      const out = [];
      for (const m of this.marketList) {
        for (const p of m.predictions) {
          if (p.userId !== u.id) continue;
          out.push({ id: p.id, marketId: m.id, symbol: m.symbol, exchange: m.exchange, marketStatus: m.status, bucket: p.bucket, stake: p.stake, accepted: p.accepted, refund: p.refund, payout: p.payout, placedAt: p.placedAt });
        }
      }
      return { predictions: out.sort((a, b) => b.placedAt - a.placedAt) };
    });
  }

  /** A player's record, worked out the same way as on the server. */
  recordFor(userId) {
    const rows = [];
    const profit = new Map();
    for (const m of this.marketList) {
      for (const p of m.predictions) {
        if (m.status === 'resolved' && p.accepted) profit.set(p.userId, (profit.get(p.userId) ?? 0) + (p.payout ?? 0) - p.accepted);
        if (p.userId !== userId) continue;
        rows.push({
          marketId: m.id, symbol: m.symbol, status: m.status, settledAt: m.settledAt ?? null,
          winningBucket: m.status === 'resolved' ? (m.result?.winningBucket ?? null) : null,
          bucket: p.bucket, stake: p.stake, accepted: p.accepted ?? null, refund: p.refund ?? null, payout: p.payout ?? null,
        });
      }
    }
    const record = summarizeRecord(rows);
    const mine = profit.get(userId);
    return {
      ...record,
      rank: mine === undefined ? null : 1 + [...profit.values()].filter((v) => v > mine).length,
      players: profit.size,
    };
  }

  stats() {
    return this.run(() => this.recordFor(this.me_().id));
  }

  profile(name) {
    return this.run(() => {
      const u = [...this.users.values()].find((x) => x.username.toLowerCase() === String(name).toLowerCase());
      if (!u) throw new ApiError(404, 'user_not_found', 'No player with that username.');
      const positions = [];
      for (const m of this.marketList) {
        if (m.status !== 'open' && m.status !== 'locked') continue;
        const by = new Map();
        for (const p of m.predictions) if (p.userId === u.id) by.set(p.bucket, (by.get(p.bucket) ?? 0) + p.stake);
        for (const [bucket, stake] of by) positions.push({ marketId: m.id, symbol: m.symbol, name: m.name, marketStatus: m.status, outcomes: 'ladder', bucket, stake });
      }
      const stats = this.recordFor(u.id);
      return { username: u.username, joinedAt: this.now() - 30 * 24 * D3_HOUR, isMe: u.id === this.sessionUserId, stats: { ...stats, history: stats.history.slice(0, 30) }, positions };
    });
  }

  holders(id) {
    return this.run(() => {
      const m = this.find(id);
      const settled = m.status === 'resolved' || m.status === 'void';
      const by = new Map();
      for (const p of m.predictions) {
        const username = this.users.get(p.userId).username;
        const h = by.get(username) ?? { username, total: 0, payout: 0, picks: new Map() };
        h.total += p.stake;
        h.payout += p.payout ?? 0;
        h.picks.set(p.bucket, (h.picks.get(p.bucket) ?? 0) + p.stake);
        by.set(username, h);
      }
      const holders = [...by.values()]
        .sort((a, b) => b.total - a.total || a.username.localeCompare(b.username))
        .slice(0, 20)
        .map((h) => ({ username: h.username, total: h.total, payout: settled ? h.payout : null, picks: [...h.picks].map(([bucket, stake]) => ({ bucket, stake })).sort((a, b) => b.stake - a.stake) }));
      return { holders, total: by.size };
    });
  }

  odds(id) {
    return this.run(() => {
      const m = this.find(id);
      const totals = emptyTotals();
      let pool = 0;
      const series = [...m.predictions]
        .sort((a, b) => a.placedAt - b.placedAt)
        .map((p) => {
          totals[p.bucket] += p.stake;
          pool += p.stake;
          return { t: p.placedAt, shares: Object.fromEntries(BUCKETS.map((b) => [b, Math.round((totals[b] / pool) * 1000) / 1000])) };
        });
      return { outcomes: 'ladder', buckets: BUCKETS, openedAt: m.openedAt, series };
    });
  }

  leaderboard(period = 'week') {
    return this.run(() => {
      const d = new Date(this.now());
      const DAY = 24 * D3_HOUR;
      const week = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const range = {
        day: [day, day + DAY],
        week: [week, week + 7 * DAY],
        month: [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)],
        all: [0, null],
      }[period] ?? [week, week + 7 * DAY];
      const rows = new Map();
      for (const m of this.marketList) {
        if (m.status !== 'resolved' || (m.settledAt ?? this.now()) < range[0]) continue;
        for (const p of m.predictions) {
          if (!p.accepted) continue;
          const r = rows.get(p.userId) ?? { userId: p.userId, name: this.users.get(p.userId).username, profit: 0, wins: 0, total: 0 };
          r.profit += (p.payout ?? 0) - p.accepted;
          r.wins += p.payout > 0 ? 1 : 0;
          r.total += 1;
          rows.set(p.userId, r);
        }
      }
      const ranked = [...rows.values()].sort((a, b) => b.profit - a.profit || b.wins - a.wins).map((r, i) => ({ ...r, rank: i + 1 }));
      return {
        period,
        seasonStart: range[0],
        seasonEnd: range[1],
        entries: ranked.map(({ userId, ...r }) => ({ ...r, isMe: userId === this.sessionUserId })),
        me: ranked.find((r) => r.userId === this.sessionUserId) ?? null,
      };
    });
  }

  results(page = 1) {
    return this.run(() => {
      const done = this.marketList.filter((m) => (m.status === 'resolved' || m.status === 'void') && m.predictions.length).sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
      const per = 10;
      const pages = Math.max(1, Math.ceil(done.length / per));
      const pg = Math.min(pages, Math.max(1, page));
      return {
        page: pg,
        pages,
        total: done.length,
        results: done.slice((pg - 1) * per, pg * per).map((m) => {
          const byUser = this.resultRows(m);
          return {
            marketId: m.id,
            symbol: m.symbol,
            name: m.name,
            outcomes: 'ladder',
            status: m.status,
            winningBucket: m.status === 'resolved' ? (m.result?.winningBucket ?? null) : null,
            voidReason: m.status === 'void' ? (m.result?.voidReason ?? 'refunded') : null,
            settledAt: m.settledAt ?? null,
            logoUrl: m.logoUrl ?? null,
            players: byUser.length,
            winners: byUser.filter((r) => r.won).length,
            pool: m.predictions.reduce((s, p) => s + (p.accepted ?? p.stake), 0),
            paid: byUser.reduce((s, r) => s + r.payout, 0),
            sample: byUser.slice(0, 4).map((r) => r.name),
          };
        }),
      };
    });
  }

  resultPlayers(marketId, page = 1) {
    return this.run(() => {
      const m = this.marketList.find((x) => x.id === marketId);
      if (!m) throw new ApiError(404, 'market_not_found', 'Market not found.');
      const rows = this.resultRows(m);
      const per = 20;
      const pages = Math.max(1, Math.ceil(rows.length / per));
      const pg = Math.min(pages, Math.max(1, page));
      return { marketId, status: m.status, page: pg, pages, total: rows.length, players: rows.slice((pg - 1) * per, pg * per) };
    });
  }

  /** One row per player of a settled market, winners first. */
  resultRows(m) {
    const by = new Map();
    for (const p of m.predictions) {
      const r = by.get(p.userId) ?? { name: this.users.get(p.userId).username, buckets: [], stake: 0, accepted: 0, payout: 0, refund: 0, at: p.placedAt };
      if (!r.buckets.includes(p.bucket)) r.buckets.push(p.bucket);
      r.stake += p.stake;
      r.accepted += p.accepted ?? 0;
      r.payout += p.payout ?? 0;
      r.refund += p.refund ?? 0;
      by.set(p.userId, r);
    }
    return [...by.values()]
      .sort((a, b) => b.payout - a.payout || a.at - b.at)
      .map(({ at: _at, accepted, ...r }) => ({ ...r, profit: m.status === 'resolved' ? r.payout - accepted : 0, won: r.payout > 0 }));
  }

  walletChallenge(address) {
    return this.run(() => {
      const nonce = b58encode(crypto.getRandomValues(new Uint8Array(12)));
      const message = [
        `${location.host || 'firstprint.demo'} wants you to sign in with your Solana account:`,
        address,
        '',
        'Sign in to Firstprint. This request will not trigger a transaction or cost any fees.',
        '',
        `URI: ${location.origin || 'https://firstprint.demo'}`,
        'Version: 1',
        `Nonce: ${nonce}`,
        `Issued At: ${new Date(this.now()).toISOString()}`,
      ].join('\n');
      this.challenges.set(address, message);
      return { message, nonce, expiresAt: this.now() + 5 * D3_MIN };
    });
  }

  // Demo mode accepts any signature; the real server verifies ed25519 signatures.
  walletVerify({ address, message, walletName }) {
    return this.run(() => {
      if (this.challenges.get(address) !== message) throw new ApiError(401, 'bad_signature', 'Wallet sign-in failed. Try connecting again.');
      this.challenges.delete(address);
      let created = false;
      let userId = this.walletOwners.get(address);
      if (!userId) {
        const u = this.addUser(`sol_${address.slice(0, 6)}`, 1_000);
        u.needsUsername = true;
        u.hasEmail = false;
        u.wallets.push({ address, walletName: walletName ?? null });
        this.walletOwners.set(address, u.id);
        userId = u.id;
        created = true;
      }
      this.sessionUserId = userId;
      return { user: this.publicUser(this.users.get(userId)), created };
    });
  }

  linkWallet({ address, message, walletName }) {
    return this.run(() => {
      const u = this.me_();
      if (this.challenges.get(address) !== message) throw new ApiError(401, 'bad_signature', 'Wallet sign-in failed. Try connecting again.');
      const owner = this.walletOwners.get(address);
      if (owner && owner !== u.id) throw new ApiError(409, 'wallet_taken', 'This wallet is already linked to another account.');
      if (!owner) {
        u.wallets.push({ address, walletName: walletName ?? null });
        this.walletOwners.set(address, u.id);
      }
      return { wallets: u.wallets };
    });
  }

  setUsername(username) {
    return this.run(() => {
      const u = this.me_();
      username = String(username ?? '').trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new ApiError(400, 'bad_username', 'Username must be 3–20 letters, numbers, or underscores.');
      if ([...this.users.values()].some((x) => x.id !== u.id && x.username.toLowerCase() === username.toLowerCase())) {
        throw new ApiError(409, 'username_taken', 'That username is taken. Try another.');
      }
      u.username = username;
      u.needsUsername = false;
      return this.publicUser(u);
    });
  }

  /** A random address and signature standing in for a real wallet in demo mode. */
  demoWallet() {
    return b58encode(crypto.getRandomValues(new Uint8Array(32)));
  }

  detectedListings() {
    return this.run(() => ({ listings: this.detected }));
  }

  /** Simulated live stream: price ticks for trading markets every 3 seconds. */
  subscribe(onEvent, onStatus = () => {}) {
    onStatus(true);
    const timer = setInterval(() => {
      this.advance();
      for (const m of this.marketList) {
        if (!(m.status === 'open' || m.status === 'locked') || this.now() < m.listingAt + D3_MIN) continue;
        const v = this.view(m);
        if (!v.live) continue;
        const wobble = 1 + (Math.random() - 0.5) * 0.01;
        const price = v.live.lastPrice * wobble;
        const r = v.live.basePrice ? returnPct(v.live.basePrice, price) : null;
        onEvent('price', {
          marketId: m.id,
          price,
          ts: this.now(),
          basePrice: v.live.basePrice,
          returnPct: r,
          projectedBucket: r === null ? null : bucketForReturn(r, m.cfg.thresholds),
        });
      }
    }, 3_000);
    return () => clearInterval(timer);
  }

  // --- Demo controls ----------------------------------------------------------------

  skip(ms) {
    this.offset += ms;
    this.advance();
  }
}

export const DEMO_LOGIN = { email: DEMO_EMAIL, password: DEMO_PASSWORD };
