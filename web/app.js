// Firstprint website. Vanilla ES modules, no build step.

import { bucketRangeLabel, revertQuote, weightFor } from './engine.js';
import { ApiError, backendAvailable, captureReferral, createAdminApi, createApi, serverClock, wake } from './api.js';
import { DemoBackend } from './demo.js';
import { OUTCOME_ICONS, ico } from './icons.js';
import { INSTALL_LINKS, WALLET_LOGOS, connectAndSign, disconnectWallets, isMobileDevice, listWallets, mobileWalletLinks, onWalletsChanged, shortAddress, signTransactionWith } from './wallet.js';

const LADDER = ['moon', 'up', 'flat', 'down', 'crash'];
const NAMES = { crash: 'Crash', down: 'Down', flat: 'Flat', up: 'Up', moon: 'Moon' };
/**
 * Yes/No markets store Yes as the 'up' outcome and No as 'down'. These helpers give each outcome
 * its name, colour and icon for either kind of market.
 */
const isYesNo = (m) => m?.outcomes === 'binary';
const YES_NO = ['up', 'down'];
const bucketsOf = (m) => (isYesNo(m) ? YES_NO : LADDER);
const oName = (b, yn = false) => (yn ? (b === 'up' ? 'Yes' : 'No') : NAMES[b]);
const oVar = (b, yn = false) => (yn ? (b === 'up' ? 'var(--up)' : 'var(--crash)') : `var(--${b})`);
const icon = (b, yn = false) => ico(yn ? (b === 'up' ? 'check' : 'cross') : OUTCOME_ICONS[b], 'oc-ico');
const VOID_REASONS = {
  listing_delayed: 'the listing was delayed by more than 24 hours',
  retracted: 'the market was cancelled',
  trading_halted: 'trading was halted for too long',
  insufficient_baseline_data: 'there was not enough trading right after listing',
  insufficient_settlement_data: 'there was not enough trading at the end',
  one_sided_pool: 'everyone picked the same outcome',
  no_winners: 'nobody picked the winning outcome',
  empty_pool: 'nobody made a prediction',
};
const isManual = (m) => m.mode === 'manual';

const S = {
  api: null,
  me: null,
  skew: 0,
  route: { name: 'home' },
  filter: 'trending',
  sort: 'predictors',
  heroIdx: 0,
  lbPeriod: 'week',
  query: '',
  lists: { open: [], live: [], settled: [] },
  /** Predictor counts as last drawn on each card, to float "+N" when more people join. */
  cardSeen: new Map(),
  market: null,
  chart: null,
  activity: [],
  trade: { bucket: null, stake: 100, quote: null, seq: 0, busy: false },
  tradeKey: '',
  sheetOpen: false,
  modal: null,
  modalBusy: false,
  refreshing: false,
  live: false,
  /** Earn-page data for the signed-in player: rewards, tasks, referral, claims. */
  rewards: null,
  claimBusy: false,
};

// Errors players hit (crashes in the page, failures nothing else caught) go to Admin → Errors.
// The same error is sent once per page load, and at most 15 a load, so a loop can't flood it.
const reportedErrors = new Set();
function reportClientError(code, message, detail = null) {
  if (S.api?.demo || reportedErrors.size >= 15) return;
  const key = `${code}|${message}`;
  if (reportedErrors.has(key)) return;
  reportedErrors.add(key);
  fetch('/api/client-error', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, message: String(message ?? '').slice(0, 400), where: `${location.pathname}${location.hash}`.slice(0, 200), detail: detail ? String(detail).slice(0, 3000) : null }),
  }).catch(() => {});
}
window.addEventListener('error', (e) => {
  if (!e.message) return; // a broken image or script tag, not a crash
  reportClientError('app_crash', e.message, `${e.filename ?? ''}:${e.lineno ?? ''}:${e.colno ?? ''}\n${e.error?.stack ?? ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  // Answers from our server are recorded there already (5xx) or are the player's own mistakes (4xx).
  if (r && typeof r.status === 'number') return;
  reportClientError('app_crash', r?.message ?? String(r), r?.stack ?? null);
});

// ------------------------------------------------------------------ Utilities

const $ = (sel, root = document) => root.querySelector(sel);
const now = () => Date.now() + S.skew;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
// Number and date formats are built once: toLocaleString makes a new formatter on every call, and
// a page draws hundreds of numbers and dates.
const NUM_FMT = new Intl.NumberFormat('en-US');
const PRICE_FMT_2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PRICE_FMT_4 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DAY_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const fmtNum = (n) => NUM_FMT.format(Math.round(n ?? 0));
const fmtPts = (n) => `${fmtNum(n)} pts`;
/** The early bonus a prediction placed right now would get. */
const bonusNow = (m) => weightFor(now(), m.openedAt, m.closeAt, m.earlyBirdK ?? 0);
/** What taking a prediction back would cost right now (the server has the final word). */
const revertNow = (m, p) => (m.revert ? revertQuote(p.stake, p.placedAt, now(), m.openedAt, m.closeAt, m.revert) : null);
const pctText = (bps) => `${Math.round(bps / 10) / 10}%`;

/** A number that counts smoothly to its new value when it changes (see the ticker observer below). */
const tick = (key, n) => `<span class="tick" data-tick="${esc(key)}" data-val="${Number(n) || 0}">${fmtNum(n)}</span>`;

/** Payout multiple for one outcome as the pool stands now, after the fee. */
const poolMultiple = (m, b) => (m.totals[b] ? (m.pool * (1 - m.feeBps / 10_000)) / m.totals[b] : null);

function fmtPct(r, digits = 1) {
  if (r === null || r === undefined) return '–';
  const v = Math.abs(r * 100).toFixed(digits);
  if (Number(v) === 0) return `0.${'0'.repeat(digits)}%`;
  return `${r > 0 ? '+' : '−'}${v}%`;
}

function fmtPrice(p) {
  if (!p) return '–';
  if (p < 1) return `$${p.toPrecision(4)}`;
  return `$${(p >= 100 ? PRICE_FMT_2 : PRICE_FMT_4).format(p)}`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function fmtSpan(ms) {
  const h = ms / 3_600_000;
  if (h >= 1) return `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`;
  const m = Math.round(ms / 60_000);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 'Invalid Date' : DATE_FMT.format(d);
}

const until = (ts) => `<span data-until="${ts}">${fmtDur(ts - now())}</span>`;
/** "Oct 10, 6:00 PM" with the countdown beside it, so the exact time the admin set is always shown. */
const atAndIn = (ts) => `${fmtDate(ts)} <span class="feat-sub">in ${until(ts)}</span>`;
/** "Oct 10" with the countdown under it: the short form for cards (the market page has the exact time). */
const dayAndIn = (ts) => `<span title="${esc(fmtDate(ts))}">${DAY_FMT.format(ts)}</span> <span class="feat-sub">in ${until(ts)}</span>`;
const outcome = (b, yn = false) => `<b class="oc" style="--c:${oVar(b, yn)}">${icon(b, yn)}${oName(b, yn)}</b>`;
const rangeLabel = (b, t) => bucketRangeLabel(b, t).replace(/-/g, '−');
/** The price range an outcome covers, for either kind of market. */
/** A market created before its token traded has no start price yet: it's the opening price. */
const hasStart = (m) => m.basePrice != null;
/** A token that isn't trading yet: predictions close when it lists, and its opening price is the start. */
const isUpcoming = (m) => m.mode === 'manual' && !hasStart(m) && !m.startAtClose && m.status === 'open' && m.phase !== 'awaiting_result' && m.closeAt > now();
/** The start price before it is known: the price when predictions close, or an upcoming token's opening price. */
const startText = (m, short = false) => (hasStart(m) ? fmtPrice(m.basePrice) : m.startAtClose ? (short ? 'close price' : 'its price when predictions close') : short ? 'opening price' : 'its opening price');
/** Short label for an unknown start price, for fact rows. */
const startLater = (m) => (m.startAtClose ? 'At the close' : 'At listing');
const rangeOf = (m, b) => (isYesNo(m) ? (b === 'up' ? `At or above ${hasStart(m) ? fmtPrice(m.basePrice) : m.startAtClose ? 'close' : 'open'}` : `Below ${hasStart(m) ? fmtPrice(m.basePrice) : m.startAtClose ? 'close' : 'open'}`) : rangeLabel(b, m.thresholds));
const userLink = (name, cls = '') => `<a class="user-link${cls ? ` ${cls}` : ''}" href="#/u/${encodeURIComponent(name)}">${esc(name)}</a>`;
const share = (m, b) => (m.pool ? m.totals[b] / m.pool : 0);

function estMultiple(m, b, stake = 100) {
  const net = (m.pool + stake) * (1 - m.feeBps / 10_000);
  return net / (m.totals[b] + stake);
}

function leader(m) {
  if (!m.pool) return null;
  const list = bucketsOf(m);
  return list.reduce((best, b) => (m.totals[b] > m.totals[best] ? b : best), list[0]);
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/**
 * The toast after a prediction: the token, the pick in its colour and the stake leaving the
 * balance in red. Small and quiet, so it confirms without covering the market.
 */
function pickToast(m, bucket, stake, payout) {
  const el = $('#toast');
  const yn = isYesNo(m);
  const said = `You picked ${oName(bucket, yn)} on ${m.symbol} for ${fmtPts(stake)}.${payout ? ` Win about ${fmtPts(payout)}.` : ''}`;
  el.innerHTML = `
    <span class="sr-only">${esc(said)}</span>
    <span class="pt" aria-hidden="true">
      ${tokenAvatar(m, 'pt-logo')}
      <span class="pt-body">
        <b class="pt-sym">${esc(m.symbol)}</b>
        ${payout ? `<span class="pt-win">Win ~${fmtPts(payout)}</span>` : ''}
      </span>
      <span class="pt-side">
        <span class="pt-pick" style="--c:${oVar(bucket, yn)}">${icon(bucket, yn)}${oName(bucket, yn)}</span>
        <b class="pt-amt">−${fmtPts(stake)}</b>
      </span>
    </span>`;
  el.className = 'pick';
  void el.offsetWidth; // restart the entrance
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

/**
 * The toast for earned points, in the same quiet style as the prediction toast: a small coin,
 * what it was for (and one short line under it), and the amount arriving in green on the right.
 */
function rewardToast({ amount, unit = 'pts', title = 'Points added', sub = '' }) {
  const el = $('#toast');
  const said = [`+${fmtNum(amount)} ${unit}`, title, sub].filter(Boolean).join('. ');
  el.innerHTML = `
    <span class="sr-only">${esc(said)}</span>
    <span class="pt" aria-hidden="true">
      <span class="pt-coin">${ico('coins')}</span>
      <span class="pt-body">
        <b class="pt-sym">${esc(title)}</b>
        ${sub ? `<span class="pt-win">${esc(sub)}</span>` : ''}
      </span>
      <b class="pt-amt pt-gain">+${fmtNum(amount)} ${esc(unit)}</b>
    </span>`;
  el.className = 'pick';
  void el.offsetWidth; // restart the entrance
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function syncClock(serverTime) {
  // The live server: its Date header (a cached body's serverTime can be old). The demo: its serverTime.
  if (!S.api?.demo && serverClock.skew !== null) S.skew = serverClock.skew;
  else if (typeof serverTime === 'number') S.skew = serverTime - Date.now();
}

// ------------------------------------------------------------------ Data

async function refreshMe() {
  try {
    S.me = await S.api.me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) S.me = null;
    else throw err;
  }
  await refreshRewards();
  renderTop();
  if (S.me?.unreadNotifications) maybeCelebrate();
}

/** Rewards, tasks and the referral link for the signed-in player (nothing for visitors). */
async function refreshRewards() {
  S.rewards = S.me && S.api.rewards ? await S.api.rewards().catch(() => null) : null;
  S.claimsPage = null; // back to the newest claims
}

async function loadHome() {
  const [open, live, settled] = await Promise.all(['open', 'live', 'settled'].map((f) => S.api.markets(f)));
  syncClock(open.serverTime);
  S.lists = { open: open.markets, live: live.markets, settled: settled.markets };
  // Guests get a short list from the server; the totals say how many there really are.
  S.totals = { open: open.total ?? open.markets.length, live: live.total ?? live.markets.length, settled: settled.total ?? settled.markets.length };
  S.stats = open.stats ?? null;
  S.limited = Boolean(open.limited || live.limited || settled.limited);
  const featured = featuredMarket();
  const [odds, leaders] = await Promise.all([
    featured && S.api.odds ? S.api.odds(featured.id).catch(() => null) : null,
    S.api.leaderboard ? S.api.leaderboard('week').catch(() => null) : null,
  ]);
  S.featuredOdds = featured ? { id: featured.id, odds } : null;
  S.weekLeaders = leaders?.entries?.slice(0, 5) ?? [];
}

async function loadMarket(id) {
  const m = await S.api.market(id);
  syncClock(m.serverTime);
  const [chart, activity, odds, holders] = await Promise.all([
    m.phase === 'pre_listing' || isManual(m) ? Promise.resolve(null) : S.api.chart(id),
    S.api.activity(id),
    S.api.odds ? S.api.odds(id).catch(() => null) : null,
    S.api.holders ? S.api.holders(id).catch(() => null) : null,
  ]);
  if (S.market?.id !== id) {
    S.trade = { bucket: null, stake: 100, quote: null, seq: 0, busy: false };
    S.tradeKey = '';
  }
  S.market = m;
  S.chart = chart;
  S.activity = activity.activity;
  S.odds = odds;
  S.holders = holders;
}

async function refresh() {
  // Admin and the partner stats page load their own data; redrawing them would close open tables and tooltips.
  if (S.refreshing || S.modal || S.route.name === 'admin' || S.route.name === 'stats') return;
  S.refreshing = true;
  S.refreshedAt = Date.now();
  try {
    if (S.me) await refreshMe();
    await loadRoute(false);
  } catch (err) {
    console.error(err);
  } finally {
    S.refreshing = false;
  }
}

// ------------------------------------------------------------------ Routing

function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/^\/market\/([^/]+)$/);
  if (m) return { name: 'market', id: decodeURIComponent(m[1]) };
  if (h === '/leaderboard') return { name: 'leaderboard' };
  const u = h.match(/^\/u\/([^/]+)$/);
  if (u) return { name: 'profile', id: decodeURIComponent(u[1]) };
  if (h === '/portfolio' || h === '/dashboard') return { name: 'portfolio' };
  if (h === '/radar') return { name: 'radar' };
  if (h === '/earn') return { name: 'earn' };
  if (h === '/admin') return { name: 'admin' };
  const st = h.match(/^\/stats\/(.*)$/);
  if (st) return { name: 'stats', key: st[1] };
  return { name: 'home' };
}

/** Placeholders shaped like the page that is loading, instead of a spinner. */
/** The Firstprint mark with its five bars rising and falling like a volume meter: "loading". */
const loaderMark = (label = 'Loading') => `<div class="fp-loader" role="status" aria-label="${esc(label)}"><span class="ld-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span></div>`;

function skeletonView(name) {
  const card = '<div class="sk-card"><div class="sk-row"><i class="sk sk-circle"></i><span class="sk-col"><i class="sk sk-line w40"></i><i class="sk sk-line w25"></i></span></div><i class="sk sk-line w70"></i><i class="sk sk-bar"></i><i class="sk sk-line w50"></i></div>';
  const grid = `<div class="sk-grid">${card.repeat(6)}</div>`;
  if (name === 'home') return `${loaderMark('Loading markets')}<div class="skeleton" aria-busy="true" aria-label="Loading markets"><div class="sk-hero"><i class="sk sk-line w30"></i><i class="sk sk-title"></i><i class="sk sk-line w50"></i></div>${grid}</div>`;
  if (name === 'portfolio') return `${loaderMark('Loading your dashboard')}<div class="skeleton" aria-busy="true" aria-label="Loading your dashboard"><div class="sk-row"><i class="sk sk-circle lg"></i><span class="sk-col"><i class="sk sk-line w20"></i><i class="sk sk-title w30"></i></span></div><div class="sk-grid two"><div class="sk-card tall"></div><div class="sk-card tall"></div></div><div class="sk-card block"></div></div>`;
  return `${loaderMark()}<div class="skeleton" aria-busy="true" aria-label="Loading"><i class="sk sk-title w40"></i><i class="sk sk-line w60"></i><div class="sk-card block"></div></div>`;
}

/**
 * A short fade-and-rise when a new page appears (not on live updates of the same page). Run with the
 * Web Animations API on the first few blocks only: opacity and transform stay on the compositor, and
 * nothing forces a layout or restyles the whole page (a class toggle on #view did both).
 */
function enterView() {
  const view = $('#view');
  if (!view?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  [...view.children].slice(0, 4).forEach((el, i) =>
    el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], {
      duration: 340,
      delay: Math.min(i, 2) * 40,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'backwards',
    }),
  );
}

// --- Maintenance -------------------------------------------------------------------
// While an admin deploys a big change, players see a quiet screen (and can't write); admins keep
// using the site, with a banner reminding them it's on. Pages check every 20 seconds and come back
// by themselves when it ends.

const isAdminViewer = () => Boolean(readAdminKey()) || Boolean(S.me?.isAdmin);

function applyMaintenance(m) {
  const was = Boolean(S.maint?.on);
  S.maint = m?.on ? { on: true, message: m.message ?? '', since: m.since ?? null } : { on: false };
  const blocked = S.maint.on && !isAdminViewer() && S.route.name !== 'admin';
  let screen = $('#maint');
  if (blocked) {
    if (!screen) {
      screen = document.createElement('div');
      screen.id = 'maint';
      screen.setAttribute('role', 'alertdialog');
      screen.setAttribute('aria-modal', 'true');
      document.body.append(screen);
    }
    const note = S.maint.message || 'We’re making Firstprint better. Back in a few minutes.';
    screen.innerHTML = `<div class="maint-card">
      <span class="maint-ico">${ico('sliders')}</span>
      <h1>Updating Firstprint</h1>
      <p>${esc(note)}</p>
      <p class="muted">Your points and predictions are safe. This page comes back by itself.</p>
      <span class="maint-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    </div>`;
    document.documentElement.classList.add('in-maint');
  } else {
    screen?.remove();
    document.documentElement.classList.remove('in-maint');
  }
  let bar = $('#maint-admin');
  if (S.maint.on && isAdminViewer()) {
    if (!bar) {
      bar = document.createElement('a');
      bar.id = 'maint-admin';
      bar.href = '#/admin';
      document.body.append(bar);
    }
    bar.innerHTML = `${ico('alert')}<span>Maintenance is on: players see the update screen. Turn it off in Admin → Settings.</span>`;
  } else bar?.remove();
  // Back from maintenance: reload what's on screen, so prices, pools and balances are current.
  if (was && !S.maint.on) {
    toast('Firstprint is back. Thanks for waiting.');
    void loadRoute();
  }
}

function watchMaintenance() {
  clearInterval(watchMaintenance.timer);
  watchMaintenance.timer = setInterval(async () => {
    if (document.hidden || !S.api.status) return;
    try {
      const { maintenance } = await S.api.status();
      if (Boolean(maintenance?.on) !== Boolean(S.maint?.on) || (maintenance?.on && maintenance.message !== S.maint.message)) applyMaintenance(maintenance);
    } catch {
      /* offline or waking: try again next round */
    }
  }, 20_000);
}

async function onRoute() {
  const next = parseRoute();
  if (S.maint?.on) queueMicrotask(() => applyMaintenance(S.maint));
  const changed = next.name !== S.route.name || next.id !== S.route.id;
  S.route = next;
  // Opening a page fresh starts its long lists on their first page; refreshes keep the page shown.
  if (changed) S.pg = {};
  S.menuOpen = false;
  S.streakOpen = false;
  if (changed) {
    closeSheet();
    // Overlays that belong to the page being left (the tour, results inbox, PnL card) close with it.
    if (['tour', 'inbox', 'pnl'].includes(S.modal) && !S.modalBusy) closeModal();
    $('#view').innerHTML = skeletonView(next.name);
    window.scrollTo(0, 0);
  }
  renderTop();
  await loadRoute(changed);
  if (changed) enterView();
  if (changed && document.activeElement?.id !== 'market-search') $('#view').focus({ preventScroll: true });
}

/**
 * Writes a page into an element only when it changed. The 8-second refresh redraws the page, and
 * rebuilding a few thousand unchanged nodes costs a slow phone a noticeable pause, so an identical
 * page (countdown text aside, which the 1-second ticker keeps current) is left alone.
 */
function setHtml(el, html) {
  const key = html.replace(/(data-until="\d+">)[^<]*/g, '$1');
  if (el.__html === key && el.firstElementChild && el.firstElementChild === el.__first) return;
  // A redraw (new odds, "1m ago") must not snap shut a section the reader opened.
  const tag = (d, i) => `${d.className}#${i}`;
  const opened = new Set([...el.querySelectorAll('details')].map((d, i) => (d.open ? tag(d, i) : '')).filter(Boolean));
  el.innerHTML = html;
  if (opened.size) el.querySelectorAll('details').forEach((d, i) => opened.has(tag(d, i)) && (d.open = true));
  el.__html = key;
  el.__first = el.firstElementChild;
}

async function loadRoute() {
  const view = $('#view');
  // Quick taps from page to page: only the latest page may draw, so a slow earlier one can't
  // land on top of it (or leave the screen blank) when its data finally arrives.
  const seq = (S.routeSeq = (S.routeSeq ?? 0) + 1);
  const stale = () => seq !== S.routeSeq;
  try {
    if (S.route.name === 'home') {
      await loadHome();
      await heroFlipDone();
      if (stale()) return;
      setHtml(view, homeView());
      animateCounts();
    } else if (S.route.name === 'market') {
      await loadMarket(S.route.id);
      const pending = S.pendingPick;
      if (pending?.id === S.route.id) {
        S.pendingPick = null;
        if (S.market.status === 'open' && bucketsOf(S.market).includes(pending.bucket)) S.trade.bucket = pending.bucket;
      }
      if (stale()) return;
      renderMarket();
      if (pending?.id === S.route.id && S.trade.bucket) {
        requestQuote();
        if (isMobile()) openSheet();
        else setTimeout(() => $('#stake')?.focus({ preventScroll: true }), 50);
      }
    } else if (S.route.name === 'leaderboard') {
      const lb = await S.api.leaderboard(S.lbPeriod);
      if (stale()) return;
      setHtml(view, leaderboardView(lb));
    } else if (S.route.name === 'profile') {
      S.profile = await S.api.profile(S.route.id);
      if (stale()) return;
      setHtml(view, profileView(S.profile));
    } else if (S.route.name === 'admin') {
      await renderAdmin();
    } else if (S.route.name === 'stats') {
      if (!S.api.publicAnalytics) {
        view.innerHTML = '<div class="empty"><p>Stats aren’t available in practice mode.</p></div>';
      } else {
        const dead = (msg) => `<div class="empty"><div class="empty-art">${ico('chart')}</div><p><strong>${msg}</strong><br />Ask Firstprint for a new link.</p></div>`;
        if (!/^[A-Za-z0-9_-]{10,64}$/.test(S.route.key)) {
          view.innerHTML = dead('This stats link isn’t complete.');
        } else {
          try {
            const data = await S.api.publicAnalytics(S.route.key, S.vizDays ?? 30);
            if (stale()) return;
            view.innerHTML = analyticsView(data, { shared: true });
          } catch (err) {
    if (stale()) return;
            view.innerHTML =
              err.status === 404
                ? dead('This stats link is no longer active.')
                : `<div class="empty"><div class="empty-art">${ico('chart')}</div><p><strong>Couldn’t load the stats.</strong><br />${esc(err.message)}</p><button class="btn btn-solid" data-action="viz-retry">${ico('refresh')}Try again</button></div>`;
          }
        }
      }
    } else if (S.route.name === 'radar' && S.cfg?.manualOnly) {
      location.replace('#/');
      return;
    } else if (S.route.name === 'radar') {
      const { listings } = await S.api.detectedListings();
      if (stale()) return;
      setHtml(view, radarView(listings));
    } else if (S.route.name === 'earn') {
      await Promise.all([refreshRewards(), loadDaily()]);
      if (stale()) return;
      setHtml(view, earnView());
    } else if (S.route.name === 'portfolio') {
      const preds = S.me ? (await S.api.myPredictions()).predictions : [];
      // Long lists come a page at a time (the page shown stays put when the dashboard refreshes).
      S.pg ??= {};
      const history = S.me && S.api.ledger ? await S.api.ledger(S.pg.ledger ?? 1).catch(() => ({ entries: [] })) : { entries: [] };
      const stats = S.me && S.api.stats ? await S.api.stats().catch(() => null) : null;
      const chain = S.me && S.api.chain ? await S.api.chain(S.pg.chain ?? 1).catch(() => null) : null;
      // Open markets give the active positions their crowd share, payout and closing time.
      if (S.me && preds.some((p) => p.marketStatus === 'open' || p.marketStatus === 'locked')) {
        const [open, live] = await Promise.all(['open', 'live'].map((f) => S.api.markets(f).catch(() => null)));
        if (open) S.lists.open = open.markets;
        if (live) S.lists.live = live.markets;
      }
      S.dashData = [preds, history, stats, chain];
      if (stale()) return;
      setHtml(view, portfolioView(preds, history, stats, chain));
    }
    document.title = titleFor();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && S.route.name === 'profile') {
      view.innerHTML = `<div class="empty"><div class="empty-art">${ico('user')}</div><p>There’s no player called “${esc(S.route.id)}”.</p><a class="btn" href="#/leaderboard">See the leaderboard</a></div>`;
    } else if (err instanceof ApiError && err.status === 404) {
      view.innerHTML = `<div class="empty"><p>This market doesn’t exist or was removed.</p><a class="btn" href="#/">Browse markets</a></div>`;
    } else {
      view.innerHTML = `<div class="empty"><p>${esc(err.message || 'Something went wrong.')}</p><button class="btn" data-action="retry">Try again</button></div>`;
    }
  }
}

function titleFor() {
  if (S.route.name === 'market' && S.market) return `${S.market.symbol} on ${S.market.exchange}: Firstprint`;
  if (S.route.name === 'leaderboard') return 'Leaderboard: Firstprint';
  if (S.route.name === 'profile') return `${S.profile?.username ?? S.route.id}: Firstprint`;
  if (S.route.name === 'radar') return 'Listing radar: Firstprint';
  if (S.route.name === 'admin') return 'Admin: Firstprint';
  if (S.route.name === 'portfolio') return 'Your dashboard: Firstprint';
  if (S.route.name === 'earn') return 'Earn points: Firstprint';
  if (S.route.name === 'stats') return 'Live stats: Firstprint';
  return 'Firstprint: predict crypto prices';
}

/** A market's token logo, falling back to the letter circle. Takes a market, or a row with symbol + marketId. */
function tokenAvatar(m, cls = '') {
  const logo = m.logoUrl ?? logoOf(m.marketId);
  if (!logo) return avatar(m.symbol, cls);
  return `<span class="avatar avatar-img${cls ? ` ${cls}` : ''}" aria-hidden="true"><img class="tok-logo" src="${esc(logo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-sym="${esc(m.symbol)}" /></span>`;
}

/** Looks up a logo from the loaded market lists (portfolio and history rows carry only the id). */
function logoOf(id) {
  if (!id || !S.lists) return null;
  for (const list of [S.lists.open, S.lists.live, S.lists.settled]) {
    const hit = (list ?? []).find((x) => x.id === id);
    if (hit) return hit.logoUrl ?? null;
  }
  return null;
}

// ------------------------------------------------------------------ Top bar

/** Navigation: the same pages in the top bar (wide screens) and the tab bar (phones). */
const NAV_ICONS = { home: 'grid', radar: 'radar', earn: 'gift', leaderboard: 'trophy', portfolio: 'dashboard' };

/** A coloured circle with the first letter of a name or symbol; the colour is stable per name. */
function avatar(name, cls = '') {
  const text = String(name || '?');
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `<span class="avatar${cls ? ` ${cls}` : ''}" style="--h:${h}" aria-hidden="true">${esc(text.replace(/^@/, '').slice(0, 1).toUpperCase())}</span>`;
}

/** The theme in use: the saved choice, else the device setting. */
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('fp:theme', theme);
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
  syncThemeColor();
  renderTop();
}

/** Keeps the browser's address-bar colour in step with the theme. */
function syncThemeColor() {
  const color = currentTheme() === 'light' ? '#f5f5f7' : '#09090b';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute('content', color);
    m.removeAttribute('media');
  });
}

function themeButton() {
  const light = currentTheme() === 'light';
  return `<button class="chip theme-toggle" data-action="theme" aria-label="Switch to ${light ? 'dark' : 'light'} mode" title="Switch to ${light ? 'dark' : 'light'} mode">${ico(light ? 'moon' : 'sun')}</button>`;
}

function renderTop() {
  // Keep typing in the search box when the bar redraws (e.g. after jumping to Markets).
  const typing = document.activeElement?.id === 'market-search' ? document.activeElement : null;
  const caret = typing ? [typing.selectionStart, typing.selectionEnd] : null;
  drawTop();
  if (typing) {
    const input = $('#market-search');
    input.focus();
    input.setSelectionRange(...caret);
  }
}

/** Something to collect on the Earn page: today's claim, or a task not done yet (and for visitors, always). */
function earnWaiting() {
  if (!S.me) return true;
  if (S.daily && !S.daily.claimedToday) return true;
  return Boolean(S.rewards?.tasks?.some((t) => !t.done && t.remaining !== 0));
}

function drawTop() {
  const cur = (name) => (S.route.name === name || (name === 'home' && S.route.name === 'market') ? ' aria-current="page"' : '');
  // Earn glows next to Markets, so it's where the eye goes next; a dot when there's something to collect.
  const navCls = (name) => (name === 'earn' ? ` class="nav-earn${earnWaiting() ? ' has-more' : ''}"` : '');
  const wallet = S.me?.wallets?.[0]?.address;
  const pages = [
    ['home', '#/', 'Markets', 'Markets'],
    ...(S.cfg?.manualOnly ? [] : [['radar', '#/radar', 'Listing radar', 'Radar']]),
    ['earn', '#/earn', 'Earn', 'Earn'],
    ['leaderboard', '#/leaderboard', 'Leaderboard', 'Ranks'],
    ['portfolio', '#/portfolio', 'Dashboard', 'Me'],
  ];
  setHtml(
    $('#tabbar'),
    pages.map(([name, href, , short]) => `<a href="${href}"${cur(name)}${navCls(name)}>${ico(NAV_ICONS[name])}<span>${short}</span></a>`).join(''),
  );
  setHtml(
    $('#topbar'),
    `
    <div class="topbar-inner">
      <a class="wordmark" href="#/" aria-label="Firstprint home"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="word">Firstprint</span></a>
      <label class="top-search">${ico('search')}<input id="market-search" type="search" placeholder="Search a token or name" value="${esc(S.query ?? '')}" autocomplete="off" aria-label="Search markets by token or name" /><kbd aria-hidden="true">/</kbd></label>
      <div class="account">
        ${
          S.me
            ? `<button class="chip bell${S.me.unreadNotifications ? ' has-new' : ''}" data-action="inbox" aria-label="Your results${S.me.unreadNotifications ? `, ${S.me.unreadNotifications} new` : ''}">${ico('bell')}${S.me.unreadNotifications ? `<span class="bell-n">${S.me.unreadNotifications > 9 ? '9+' : S.me.unreadNotifications}</span>` : ''}</button>
               ${streakChip()}
               ${claimChip()}
               <a class="chip points" href="#/portfolio" title="Your points balance">${ico('coins')}${tick('me:points:top', S.me.points)}<span class="unit">pts</span></a>
               <a class="chip wallet-chip" href="#/portfolio" title="Signed in as ${esc(S.me.username)}">${avatar(S.me.username, 'avatar-sm')}<span>${wallet ? esc(shortAddress(wallet)) : esc(S.me.username)}</span></a>`
            : `<a class="top-link hide-sm" href="#/" data-action="how">${ico('info')}How it works</a><button class="btn btn-gold" data-action="connect">Log in</button>`
        }
        <button class="chip menu-btn" data-action="menu" aria-label="Menu" aria-haspopup="true" aria-expanded="${S.menuOpen ? 'true' : 'false'}" aria-controls="top-menu">${ico('menu')}</button>
      </div>
      ${S.menuOpen ? menuView(pages) : ''}
      ${S.streakOpen && S.me ? streakPop() : ''}
    </div>
    <nav class="subnav" aria-label="Main">
      ${pages.map(([name, href, label]) => `<a href="${href}"${cur(name)}${navCls(name)}>${ico(NAV_ICONS[name])}${label}</a>`).join('')}
    </nav>`,
  );
}

/** With TestFPT on, the 1,000 starting points wait on the Earn page to be claimed to a wallet. */
const startPoints = () => (S.cfg?.rewards?.onChain ? '1,000 free points to claim on the Earn page' : '1,000 free points');

// --- Daily streak --------------------------------------------------------------------
const DAILY_SCHEDULE = [50, 75, 100, 125, 150, 175, 200];
const dailyReward = (day) => DAILY_SCHEDULE[Math.min(DAILY_SCHEDULE.length, Math.max(1, day)) - 1];
/** Points the next claim gives (today's if not claimed yet, otherwise tomorrow's). */
const dailyNext = () => S.me?.daily?.next ?? 50;
function dailyLine() {
  const d = S.me?.daily;
  if (!d || !d.streak) return 'Claim every day: 50 points today, growing to 200 a day by day 7.';
  return `Day ${d.nextDay} of your streak. Keep going to reach 200 a day.`;
}

/** The flame next to the bell: the streak length, glowing when today's points are waiting. */
function streakChip() {
  const d = S.me?.daily;
  if (!d) return '';
  const can = S.me.canClaimDaily;
  const label = `Daily streak: ${d.streak} day${d.streak === 1 ? '' : 's'}${can ? `. Claim +${d.next} today` : ''}`;
  return `<button class="chip streak-chip${d.streak ? ' lit' : ''}${can ? ' can-claim' : ''}" data-action="streak" aria-label="${label}" aria-haspopup="dialog" aria-expanded="${S.streakOpen ? 'true' : 'false'}" aria-controls="streak-pop">${ico('flame')}<span class="streak-n">${d.streak}</span>${can ? '<i class="streak-dot" aria-hidden="true"></i>' : ''}</button>`;
}

/**
 * TestFPT waiting to be claimed, as a small chip in the top bar. It shows up when a reward is
 * earned and goes once it is claimed (the coins fly into the points balance). Players with a
 * Firstprint wallet never see it: their rewards are sent by themselves.
 */
function claimChip() {
  const r = S.rewards;
  // Rewards sent by themselves (a Firstprint wallet, or a linked one while the server pays) need no chip.
  if (!r?.onChain || r.firstprintWallet || (r.autoSend && !r.chainPaused) || !(r.claimable > 0)) {
    S.claimChipShown = false;
    return '';
  }
  // It pops in only when it first appears, not on every redraw of the top bar.
  const fresh = !S.claimChipShown;
  S.claimChipShown = true;
  const busy = Boolean(S.claimBusy);
  return `<button class="chip claim-chip${fresh ? ' is-new' : ''}${busy ? ' is-busy' : ''}" data-action="claim-tokens"${busy ? ' disabled' : ''} title="${busy ? 'Claiming your TestFPT…' : `Claim ${fmtNum(r.claimable)} TestFPT to your wallet`}" aria-label="${busy ? 'Claiming' : `Claim ${fmtNum(r.claimable)} TestFPT`}">${busy ? '<span class="spin" aria-hidden="true"></span>' : ico('token')}<span class="claim-n">${fmtNum(r.claimable)}</span><span class="claim-word">${busy ? 'Claiming' : 'Claim'}</span></button>`;
}

/** The streak, small: seven days as circles (green once claimed) with their points, and the claim button. */
function streakPop() {
  const d = S.me.daily;
  if (!d) return '';
  const can = S.me.canClaimDaily;
  const pos = Math.min(d.claimedToday ? d.streak : d.nextDay, 7);
  const days = DAILY_SCHEDULE.map((pts, i) => {
    const n = i + 1;
    const done = n < pos || (n === pos && d.claimedToday);
    const state = done ? 'done' : n === pos ? 'today' : 'next';
    return `<li class="sp-day ${state}"><span class="sp-dot">${done ? ico('check') : ''}</span><b>+${pts}</b><small>${n === 7 ? 'Day 7+' : `Day ${n}`}</small></li>`;
  }).join('');
  return `
    <div class="streak-pop" id="streak-pop" role="dialog" aria-label="Daily streak">
      <div class="sp-head">
        <span class="sp-flame${d.streak ? ' lit' : ''}">${ico('flame')}</span>
        <div><b>${d.streak ? `${d.streak}-day streak` : 'Start a streak'}</b><small>${can ? `Today: +${d.next} points` : `Claimed today · +${d.next} tomorrow`}</small></div>
      </div>
      <ol class="sp-days">${days}</ol>
      ${can ? `<button class="btn btn-gold sp-claim" data-action="claim">${ico('gift')}Claim +${d.next}</button>` : ''}
      <p class="sp-rule">One claim a day (UTC). Miss a day and it starts again at 50.</p>
    </div>`;
}

async function loadDaily() {
  if (!S.me || !S.api.daily) return (S.daily = null);
  S.daily = await S.api.daily().catch(() => null);
}

/** Streak tiles (days 1–7 and their points) and a calendar of this month's claims. */
function streakCard(compact = false) {
  const d = S.daily;
  if (!S.me || !d) return '';
  const today = d.today;
  const cur = d.claimedToday ? d.streak : d.streak + 1; // the streak day today counts as
  const pos = Math.min(cur, 7);
  // In the side column: one small circle per day (like the streak pop-up), the points under it.
  const dots = DAILY_SCHEDULE.map((pts, i) => {
    const n = i + 1;
    const done = n < pos || (n === pos && d.claimedToday);
    const state = done ? 'done' : n === pos ? 'today' : 'next';
    return `<li class="sp-day ${state}"><span class="sp-dot" title="Day ${n === 7 ? '7+' : n}">${done ? ico('check') : ''}</span><b>+${pts}</b></li>`;
  }).join('');
  const tiles = DAILY_SCHEDULE.map((pts, i) => {
    const n = i + 1;
    const state = n < pos ? 'done' : n === pos ? (d.claimedToday ? 'done today' : 'today') : 'next';
    const label = n === 7 ? (cur > 7 ? `Day ${cur}` : 'Day 7+') : `Day ${n}`;
    return `<li class="st-day ${state}"><span class="st-n">${label}</span><b>+${pts}</b><span class="st-ico">${state.includes('done') ? ico('check') : n === pos ? ico('gift') : ''}</span></li>`;
  }).join('');
  // This month's calendar, Monday first, in UTC like the claims.
  const [y, m] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const claimed = new Map(d.days.map((x) => [x.day, x.points]));
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="cal-cell blank"></span>');
  for (let day = 1; day <= daysIn; day++) {
    const key = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const pts = claimed.get(key);
    const cls = ['cal-cell', pts ? 'hit' : '', key === today ? 'is-today' : '', key > today ? 'future' : ''].filter(Boolean).join(' ');
    cells.push(`<span class="${cls}"${pts ? ` title="+${pts} points"` : ''}>${day}</span>`);
  }
  const month = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const claimedThisMonth = d.days.filter((x) => x.day.startsWith(today.slice(0, 7))).length;
  return `
    <section class="panel streak-card${compact ? ' compact' : ''}">
      <div class="st-head">
        <span class="st-flame${d.streak ? ' lit' : ''}">${ico('flame')}</span>
        <div><span class="eyebrow">Daily streak</span><b class="st-count">${d.streak ? `${d.streak} day${d.streak === 1 ? '' : 's'}` : 'No streak yet'}</b></div>
        ${d.claimedToday ? `<span class="st-note">${ico('check')}Claimed today · +${d.next} tomorrow</span>` : `<button class="btn btn-gold btn-sm" data-action="claim">${ico('gift')}Claim +${d.next}</button>`}
      </div>
      ${compact ? `<ol class="sp-days st-dots">${dots}</ol>` : `<ol class="st-days">${tiles}</ol>`}
      <p class="st-rule muted">${compact ? 'One claim a day (UTC). Miss a day and it resets.' : 'Claim once a day (UTC): 50 points on day 1, 25 more each day, 200 a day from day 7. Miss a day and it starts again at 50.'}</p>
      ${
        compact
          ? `<details class="st-cal-more"><summary>${ico('calendar')}${month}<span class="muted">${claimedThisMonth} day${claimedThisMonth === 1 ? '' : 's'} claimed</span></summary>
              <div class="cal-grid">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w) => `<span class="cal-wd">${w}</span>`).join('')}${cells.join('')}</div>
            </details>`
          : `<div class="st-cal">
              <div class="st-cal-head"><b>${month}</b><span class="muted">${claimedThisMonth} day${claimedThisMonth === 1 ? '' : 's'} claimed</span></div>
              <div class="cal-grid">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w) => `<span class="cal-wd">${w}</span>`).join('')}${cells.join('')}</div>
            </div>`
      }
    </section>`;
}

// --- Analytics (admin, and the read-only partner link) --------------------------------------
const VIZ = { W: 640, H: 210, L: 40, R: 14, T: 14, B: 26 };
const fmtShortDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  // Steps whose half is still a round number, so the middle gridline reads cleanly.
  for (const m of [1, 2, 3, 4, 5, 6, 8, 10]) if (m * p >= v && (m * p) % 2 === 0) return m * p;
  return 10 * p;
}

/** Axis, gridlines and date labels shared by the time charts. */
function vizFrame(days, max, W = VIZ.W) {
  const { H, L, R, T, B } = VIZ;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 2, max]
    .map((v) => `<line class="viz-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="viz-axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtCompact(Math.round(v))}</text>`)
    .join('');
  const slot = (W - L - R) / days.length;
  const at = [0, Math.floor((days.length - 1) / 2), days.length - 1];
  const xl = [...new Set(at)]
    .map((i, k) => `<text class="viz-axis" x="${L + slot * (i + 0.5)}" y="${H - 6}" text-anchor="${k === 0 ? 'start' : k === at.length - 1 ? 'end' : 'middle'}">${fmtShortDay(days[i])}</text>`)
    .join('');
  return { y, slot, axes: ticks + xl };
}

/** Columns sit in half-width cards, so they draw on a narrower canvas to keep the text a readable size. */
function columnChart(days, values, label, W = 380) {
  const { H, L, B } = VIZ;
  const max = niceMax(Math.max(...values));
  const { y, slot, axes } = vizFrame(days, max, W);
  const bw = Math.max(2, Math.min(24, slot * 0.7));
  const base = H - B;
  const cols = values
    .map((v, i) => {
      const x = L + slot * i + (slot - bw) / 2;
      const top = y(v);
      const h = base - top;
      const r = Math.min(4, bw / 2, h);
      const bar = v > 0 ? `<path class="viz-bar" d="M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z"/>` : '';
      return `<g class="viz-slot" data-tip="${esc(fmtShortDay(days[i]))}|${fmtNum(v)} ${esc(label)}"><rect class="viz-hit" x="${L + slot * i}" y="0" width="${slot}" height="${H}"/>${bar}</g>`;
    })
    .join('');
  return `<svg class="viz" viewBox="0 0 ${W} ${VIZ.H}" role="img" aria-label="${esc(label)} per day">${axes}${cols}</svg>`;
}

/** Drawn twice: a wide canvas for desktop and a narrow one for phones, so the text stays readable on both. */
function lineChart(days, values, label) {
  return lineSvg(days, values, label, VIZ.W, 'viz-wide') + lineSvg(days, values, label, 380, 'viz-narrow');
}

function lineSvg(days, values, label, W, cls) {
  const { H, L, B, T } = VIZ;
  const max = niceMax(Math.max(...values));
  const { y, slot, axes } = vizFrame(days, max, W);
  const pts = values.map((v, i) => [L + slot * (i + 0.5), y(v)]);
  const line = pts.map(([x, py], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${py.toFixed(1)}`).join('');
  const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${H - B}L${pts[0][0].toFixed(1)},${H - B}Z`;
  const [ex, ey] = pts[pts.length - 1];
  const hits = values
    .map((v, i) => `<g class="viz-slot" data-tip="${esc(fmtShortDay(days[i]))}|${fmtNum(v)} ${esc(label)}"><rect class="viz-hit" x="${L + slot * i}" y="0" width="${slot}" height="${H}"/><line class="viz-guide" x1="${pts[i][0]}" x2="${pts[i][0]}" y1="${T}" y2="${H - B}"/><circle class="viz-pt" cx="${pts[i][0]}" cy="${pts[i][1]}" r="4.5"/></g>`)
    .join('');
  return `<svg class="viz ${cls}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} per day">${axes}<path class="viz-area" d="${area}"/><path class="viz-line" d="${line}"/><circle class="viz-end" cx="${ex}" cy="${ey}" r="4.5"/><text class="viz-end-label" x="${Math.min(ex, W - 4)}" y="${Math.max(ey - 12, 12)}" text-anchor="end">${fmtNum(values[values.length - 1])}</text>${hits}</svg>`;
}

/** Change against the previous period of the same length. */
function vizDelta(cur, prev) {
  if (!prev) return cur ? '<span class="viz-delta up">New</span>' : '';
  const ch = (cur - prev) / prev;
  if (Math.abs(ch) < 0.005) return '<span class="viz-delta">0%</span>';
  return `<span class="viz-delta ${ch > 0 ? 'up' : 'down'}">${ch > 0 ? '▲' : '▼'} ${Math.abs(Math.round(ch * 100))}%</span>`;
}

function hbars(rows, unit = '') {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows
    .map(
      (r) => `<div class="hbar" data-tip="${esc(r.label)}|${fmtNum(r.value)}${unit ? ` ${unit}` : ''}"><span class="hbar-label">${r.html ?? esc(r.label)}</span><span class="hbar-track"><i style="width:${Math.max(r.value ? 2 : 0, (r.value / max) * 100)}%"></i></span><b>${fmtNum(r.value)}</b></div>`,
    )
    .join('')}</div>`;
}

/** Country name and flag from a two-letter code (no code: "Unknown"). */
const REGION_NAMES = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();
const countryName = (code) => (code ? (REGION_NAMES?.of(code) ?? code) : 'Unknown');
const countryFlag = (code) => (code ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🌐');

/** Everything on the analytics page as one sheet (CSV, opens in Excel or Google Sheets): one block per section. */
function analyticsCsv(d) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [];
  const block = (title, head, body) => {
    if (rows.length) rows.push([]);
    rows.push([title]);
    rows.push(head);
    for (const r of body) rows.push(r);
  };
  const P = d.period;
  const T = d.totals;
  const C = d.onChain;
  block('Firstprint analytics', ['Item', 'Value'], [
    ['Period (UTC)', `${d.from} to ${d.to}`],
    ['Generated', new Date(d.generatedAt).toISOString()],
    ['Players (all time)', T.players],
    [`New players (${d.days} days)`, P.newPlayers],
    [`Active players (${d.days} days)`, P.active],
    ['Returning players', P.returning],
    [`Predictions (${d.days} days)`, P.predictions],
    [`Points staked (${d.days} days)`, P.staked],
    ['Predictions (all time)', T.predictions],
    ['Points staked (all time)', T.staked],
    ['Wallets linked', T.walletsLinked],
    ['Markets (open / settled / total)', `${T.marketsOpen} / ${T.marketsSettled} / ${T.marketsTotal}`],
    ['Players invited by friends', T.referred],
    ['Tasks completed', T.tasksDone],
  ]);
  block('Daily (UTC)', ['Day', 'Active', 'New players', 'Predictions', 'Points staked', 'On-chain transfers'], d.series.map((x) => [x.day, x.active, x.newPlayers, x.predictions, x.staked, x.onChain ?? 0]));
  block('Countries', ['Country', 'Code', 'Players', `New in ${d.days} days`], (d.countries ?? []).map((c) => [countryName(c.country), c.country ?? '', c.players, c.newPlayers]));
  block('Sign-in', ['Method', 'Players'], [['Google or email', d.signIn.emailOnly], ['Wallet', d.signIn.walletOnly], ['Both', d.signIn.both]]);
  block(`Most played markets (${d.days} days)`, ['Token', 'Name', 'Exchange', 'Status', 'Predictions', 'Participants', 'Points staked'], d.topMarkets.map((m) => [m.symbol, m.name ?? '', m.exchange, m.status, m.predictions, m.predictors, m.staked]));
  if (C)
    block('On chain (TestFPT, Solana ' + (d.chain?.cluster ?? 'testnet') + ')', ['Item', 'Transfers', 'TestFPT'], [
      ['All transfers', C.transfers, ''],
      [`Transfers in ${d.days} days`, C.transfersInPeriod, ''],
      ['Rewards sent', C.rewards.transfers, C.rewards.amount],
      ['Stakes', C.stakes.transfers, C.stakes.amount],
      ['Payouts', C.payouts.transfers, C.payouts.amount],
      ['Refunds', C.refunds.transfers, C.refunds.amount],
      ['Claims signed by players', C.claims.transfers, C.claims.amount],
      ['Wallets that received TestFPT', C.holders, ''],
      ['Firstprint wallets', C.firstprintWallets, ''],
      ['Waiting to send', C.waiting, ''],
      ['Failed', C.failed, ''],
      ['Mint', d.chain?.mint ?? '', ''],
    ]);
  return '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

function downloadAnalytics() {
  const d = S.vizData;
  if (!d) return;
  const blob = new Blob([analyticsCsv(d)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `firstprint-analytics-${d.to}-${d.days}d.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function analyticsView(d, { shared = false } = {}) {
  S.vizData = d;
  const P = d.period;
  const T = d.totals;
  const days = d.series.map((x) => x.day);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const tile = (label, value, sub, delta = '') => `<div class="viz-tile"><span class="viz-tile-label">${label}</span><b class="viz-tile-value">${value}</b><span class="viz-tile-sub">${delta}${sub}</span></div>`;
  const card = (title, sub, body, wide = false) => `<section class="panel viz-card${wide ? ' wide' : ''}"><div class="viz-card-head"><h3>${title}</h3><p class="muted">${sub}</p></div>${body}</section>`;
  const signIn = [
    ['Google or email', d.signIn.emailOnly, 1],
    ['Wallet', d.signIn.walletOnly, 2],
    ['Both', d.signIn.both, 3],
  ];
  const signTotal = signIn.reduce((n, [, v]) => n + v, 0);
  const seg = (action) => `<div class="tabs viz-days" role="group" aria-label="Period">${[7, 30, 90].map((n) => `<button data-action="${action}" data-days="${n}" aria-pressed="${d.days === n}" aria-selected="${d.days === n}">${n} days</button>`).join('')}</div>`;
  const range = `${fmtShortDay(d.from)} – ${fmtShortDay(d.to)}, UTC`;
  return `
    <div class="viz-page${shared ? ' shared' : ''}">
      ${
        shared
          ? `<header class="viz-head"><div><span class="eyebrow">Firstprint · live stats</span><h1 class="page-title">How Firstprint is growing</h1><p class="page-lede">A free prediction game on crypto tokens, on Solana testnet. Updated ${fmtAgo(d.generatedAt)}.</p></div></header>`
          : ''
      }
      <div class="viz-filters">${seg(shared ? 'viz-days' : 'admin-viz-days')}<span class="muted">${range}</span><button class="btn btn-sm viz-export" data-action="viz-export">${ico('download')}Download sheet</button></div>
      <div class="viz-tiles">
        ${tile('Players', fmtNum(T.players), `+${fmtNum(P.newPlayers)} in ${d.days} days`, vizDelta(P.newPlayers, P.newPlayersPrev))}
        ${tile('Active players', fmtNum(P.active), `${pct(P.returning, P.active)} came back`, vizDelta(P.active, P.activePrev))}
        ${tile('Predictions', fmtNum(P.predictions), `on ${fmtNum(P.marketsPlayed)} market${P.marketsPlayed === 1 ? '' : 's'}`, vizDelta(P.predictions, P.predictionsPrev))}
        ${tile('Points staked', fmtCompact(P.staked), 'free points, no cash value', vizDelta(P.staked, P.stakedPrev))}
        ${tile('Wallets linked', fmtNum(T.walletsLinked), `${pct(T.walletsLinked, T.players)} of players`)}
        ${tile('Markets', fmtNum(T.marketsTotal), `${fmtNum(T.marketsOpen)} open · ${fmtNum(T.marketsSettled)} settled`)}
      </div>
      <div class="viz-grid">
        ${card('Daily active players', 'Players who made a prediction or claimed daily points', lineChart(days, d.series.map((x) => x.active), 'active players'), true)}
        ${card('New players', 'Sign-ups per day', columnChart(days, d.series.map((x) => x.newPlayers), 'new players'))}
        ${card('Predictions', 'Predictions per day', columnChart(days, d.series.map((x) => x.predictions), 'predictions'))}
        ${card(
          'How players sign in',
          `${fmtNum(signTotal)} players`,
          `<div class="viz-stack" role="img" aria-label="Sign-in methods">${signIn
            .filter(([, v]) => v)
            .map(([label, v, c]) => `<i style="flex:${v};background:var(--viz-${c})" data-tip="${label}|${fmtNum(v)} players (${pct(v, signTotal)})"></i>`)
            .join('')}</div>
           <ul class="viz-legend">${signIn.map(([label, v, c]) => `<li><span class="viz-key" style="background:var(--viz-${c})"></span>${label}<b>${fmtNum(v)}</b><span class="muted">${pct(v, signTotal)}</span></li>`).join('')}</ul>`,
        )}
        ${card(
          'Daily streaks',
          'Players with a live daily streak, by length',
          hbars(d.streaks.map((x) => ({ label: x.label, value: x.count })), 'players'),
        )}
        ${card(
          'Most played markets',
          `By points staked, last ${d.days} days`,
          d.topMarkets.length
            ? hbars(
                d.topMarkets.map((m) => ({ label: `${m.symbol} on ${m.exchange}`, html: `<b>${esc(m.symbol)}</b> <span class="muted">${esc(m.exchange)} · ${fmtNum(m.predictors)} player${m.predictors === 1 ? '' : 's'}</span>`, value: m.staked })),
                'points',
              )
            : '<p class="muted">No predictions in this period yet.</p>',
          true,
        )}
        ${countriesCard(d, card)}
      </div>
      ${onChainSection(d, card, tile, days)}
      <div class="viz-extra">
        <div><b>${fmtNum(T.predictions)}</b><span>predictions all time</span></div>
        <div><b>${fmtCompact(T.staked)}</b><span>points staked all time</span></div>
        <div><b>${fmtNum(T.referred)}</b><span>players invited by friends</span></div>
        <div><b>${fmtNum(T.tasksDone)}</b><span>tasks completed</span></div>
        <div><b>${fmtNum(T.testfptClaimers)}</b><span>players claimed TestFPT (${fmtCompact(T.testfptClaimed)} total)</span></div>
        <div><b>${fmtCompact(T.burned ?? 0)}</b><span>points burned (${fmtNum(T.reverts ?? 0)} predictions taken back)</span></div>
        <div><b>${fmtCompact(T.earlyRewardsPaid ?? 0)}</b><span>points paid to early players</span></div>
      </div>
      <details class="viz-table"><summary>Daily numbers as a table</summary>
        <div class="table-wrap"><table class="table"><thead><tr><th>Day (UTC)</th><th class="right">Active</th><th class="right">New</th><th class="right">Predictions</th><th class="right">Points staked</th></tr></thead>
        <tbody>${[...d.series].reverse().map((x) => `<tr><td>${fmtShortDay(x.day)}</td><td class="right">${fmtNum(x.active)}</td><td class="right">${fmtNum(x.newPlayers)}</td><td class="right">${fmtNum(x.predictions)}</td><td class="right">${fmtNum(x.staked)}</td></tr>`).join('')}</tbody></table></div>
      </details>
      <p class="fine">Totals only: no names, emails or wallets are shown. Test accounts are left out. Points have no cash value.</p>
    </div>`;
}

/** Where players come from, by the country they first signed in from. */
function countriesCard(d, card) {
  const list = d.countries ?? [];
  const known = list.filter((c) => c.country);
  const shown = list.slice(0, 12);
  const rest = list.slice(12).reduce((n, c) => n + c.players, 0);
  return card(
    'Where players come from',
    known.length ? `${fmtNum(known.length)} countr${known.length === 1 ? 'y' : 'ies'} · by where they first signed in` : 'By where they first signed in',
    shown.length
      ? hbars(
          [
            ...shown.map((c) => ({
              label: countryName(c.country),
              html: `<span class="flag" aria-hidden="true">${countryFlag(c.country)}</span> ${esc(countryName(c.country))}${c.newPlayers ? ` <span class="muted">+${fmtNum(c.newPlayers)} new</span>` : ''}`,
              value: c.players,
            })),
            ...(rest ? [{ label: 'Other countries', value: rest }] : []),
          ],
          'players',
        )
      : '<p class="muted">No players yet.</p>',
    true,
  );
}

/** TestFPT on Solana: what the server sent and players claimed, all on the public chain. */
function onChainSection(d, card, tile, days) {
  const C = d.onChain;
  // Nothing to show on a server without TestFPT that never sent any.
  if (!C || (!d.chain && !C.transfers)) return '';
  const groups = [
    ['Rewards sent', C.rewards],
    ['Stakes', C.stakes],
    ['Payouts', C.payouts],
    ['Refunds', C.refunds],
    ['Claimed by players', C.claims],
  ];
  const mint = d.chain?.mintUrl ? `<a href="${esc(d.chain.mintUrl)}" target="_blank" rel="noopener noreferrer">${ico('external')}See the token on the explorer</a>` : '';
  return `
    <div class="viz-section-head"><h2>${ico('link')} On chain</h2><p class="muted">TestFPT on Solana ${esc(d.chain?.cluster ?? 'testnet')}: every reward, stake, payout and claim is a public transaction. ${mint}</p></div>
    <div class="viz-tiles">
      ${tile('Transfers', fmtNum(C.transfers), `${fmtNum(C.transfersInPeriod)} in ${d.days} days${C.waiting ? ` · ${fmtNum(C.waiting)} waiting` : ''}${C.failed ? ` · ${fmtNum(C.failed)} failed` : ''}`)}
      ${tile('Wallets holding TestFPT', fmtNum(C.holders), 'received at least one transfer')}
      ${tile('Firstprint wallets', fmtNum(C.firstprintWallets), 'made for email and Google players')}
    </div>
    <div class="viz-grid">
      ${card('On-chain transfers', 'Confirmed per day, sent and claimed', columnChart(days, d.series.map((x) => x.onChain ?? 0), 'transfers'))}
      ${card('By type', 'All time, TestFPT moved', hbars(groups.map(([label, g]) => ({ label, html: `${esc(label)} <span class="muted">${fmtNum(g.transfers)} tx</span>`, value: g.amount })), 'TestFPT'))}
    </div>`;
}

/** Admin: create, copy or turn off the read-only link partners use. */
function analyticsSharePanel(key) {
  const url = key ? `${location.origin}${location.pathname}#/stats/${key}` : '';
  return `
    <section class="panel viz-share">
      <div class="section-head"><span class="section-ico">${ico('share')}</span><div><h2>Share with partners</h2><p class="muted">A read-only link with totals only: no names, emails or wallets.</p></div></div>
      ${
        key
          ? `<div class="tg-channel-form"><input id="viz-share-url" value="${esc(url)}" readonly /><button class="btn btn-solid btn-sm" data-action="admin-copy-share">${ico('copy')}Copy link</button><button class="btn btn-sm" data-action="admin-analytics-share">New link</button><button class="btn btn-sm" data-action="admin-analytics-off">Turn off</button></div>
             <small class="muted">“New link” stops the old one working.</small>`
          : `<div class="admin-actions"><button class="btn btn-solid btn-sm" data-action="admin-analytics-share">${ico('share')}Create a share link</button></div>`
      }
    </section>`;
}

// One tooltip for every chart: marks carry data-tip="label|value".
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.('[data-tip]');
  let tip = document.getElementById('viz-tip');
  if (!el) {
    if (tip) tip.hidden = true;
    return;
  }
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'viz-tip';
    tip.setAttribute('role', 'status');
    document.body.append(tip);
  }
  const [label, value] = el.dataset.tip.split('|');
  const v = document.createElement('b');
  v.textContent = value ?? '';
  const l = document.createElement('span');
  l.textContent = label;
  tip.replaceChildren(v, l);
  tip.hidden = false;
});
document.addEventListener('pointermove', (e) => {
  const tip = document.getElementById('viz-tip');
  if (!tip || tip.hidden) return;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = e.clientY - tip.offsetHeight - 12 < 8 ? e.clientY + 18 : e.clientY - tip.offsetHeight - 12;
  tip.style.transform = `translate(${x}px, ${y}px)`;
});

/** The public Telegram channel where new markets and results are posted, if the admin set one. */
function telegramUrl() {
  const c = S.cfg?.telegramChannel;
  return c && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(c) ? `https://t.me/${c}` : null;
}

/** "Get new markets on Telegram" card for the dashboard. */
function telegramCard() {
  const url = telegramUrl();
  if (!url) return '';
  return `
    <section class="panel tg-card">
      <span class="tg-logo" aria-hidden="true">${ico('telegram')}</span>
      <div><b>Never miss a new market</b><p class="muted">Join @${esc(S.cfg.telegramChannel)} on Telegram. Every new market is posted the moment it opens, with a reminder in its last hour and the result when it’s in.</p></div>
      <a class="btn btn-sm tg-join" href="${url}" target="_blank" rel="noopener noreferrer">${ico('telegram')}Join on Telegram</a>
    </section>`;
}

function menuView(pages) {
  const light = currentTheme() === 'light';
  return `
    <div class="top-menu" id="top-menu" role="menu">
      ${pages.filter(([name]) => name !== 'home').map(([name, href, label]) => `<a role="menuitem" href="${href}">${ico(NAV_ICONS[name])}${label}</a>`).join('')}
      ${S.me ? `<a role="menuitem" href="#/u/${encodeURIComponent(S.me.username)}">${ico('user')}Public profile</a>` : ''}
      ${S.me?.isAdmin ? `<a role="menuitem" href="#/admin">${ico('lock')}Admin console</a>` : ''}
      ${telegramUrl() ? `<a role="menuitem" href="${telegramUrl()}" target="_blank" rel="noopener noreferrer">${ico('telegram')}Telegram alerts</a>` : ''}
      <button role="menuitemcheckbox" aria-checked="${!light}" data-action="theme" class="menu-switch">${ico('moon')}Dark mode<span class="switch-track" aria-hidden="true"><i></i></span></button>
      <hr />
      <a role="menuitem" class="menu-quiet" href="#/" data-action="how">How it works</a>
      <a role="menuitem" class="menu-quiet" href="/terms.html">Terms</a>
      <a role="menuitem" class="menu-quiet" href="/privacy.html">Privacy</a>
      ${S.me ? `<button role="menuitem" class="menu-quiet" data-action="logout">${ico('logout')}Log out</button>` : `<button role="menuitem" class="menu-quiet" data-action="connect">${ico('wallet')}Log in</button>`}
    </div>`;
}

function renderDemoBar() {
  if (!S.api.demo) return;
  $('#demo-bar').innerHTML = `
    <div class="demo-bar"><div class="demo-bar-inner">
      <p><strong>Practice mode</strong><span class="long">: simulated prices, browser-only accounts, and no real funds or persisted predictions.</span><span class="short">: fake points, simulated prices.</span></p>
      <button class="btn btn-sm" data-action="skip">${ico('forward')}<span class="long">Skip ahead </span>2 min</button>
      <button class="btn btn-sm" data-action="reset">${ico('undo')}Reset</button>
    </div></div>`;
}

// ------------------------------------------------------------------ Home

/** Home tabs: the top open markets, the newest, every open market with a sort, then waiting and settled ones. */
/** Every exchange's new listings in one list, under "Exchanges" in the side menu. */
const LISTINGS_TAB = ['listings', 'zap', 'New listings'];

const HOME_TABS = [
  ['trending', 'flame', 'Trending'],
  ['new', 'sparkles', 'New'],
  ['all', 'grid', 'All markets'],
  ['live', 'clock', 'Countdown'],
  ['settled', 'checkCircle', 'Settled'],
];

/** Most points staked in the last day first, then the most predictors and the biggest pool. */
const byTrending = (a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0) || b.predictors - a.predictors || b.pool - a.pool;

/** How many markets Trending (and the hero carousel) shows. */
const TRENDING_MAX = 10;

/** The most active open markets that people are predicting on, at most ten. */
const trendingList = () => S.lists.open.filter((m) => m.predictors > 0).sort(byTrending).slice(0, TRENDING_MAX);

/** The market shown big on the home page: the top trending one, or the newest open one. */
const featuredMarket = () => trendingList()[0] ?? [...S.lists.open].sort((a, b) => b.openedAt - a.openedAt)[0];

/** Sort choices for the All markets tab. */
const ALL_SORTS = [
  ['predictors', 'Most participants', (a, b) => b.predictors - a.predictors || b.pool - a.pool],
  ['pool', 'Biggest pool', (a, b) => b.pool - a.pool || b.predictors - a.predictors],
  ['active', 'Most active (24h)', byTrending],
  ['newest', 'Newest', (a, b) => b.openedAt - a.openedAt],
  ['oldest', 'Oldest', (a, b) => a.openedAt - b.openedAt],
  ['ending', 'Ending soon', (a, b) => a.closeAt - b.closeAt],
];

/** Exchanges a market's token trades on (not CoinGecko, which is a price source). */
const listedOn = (m) => (m.venues ?? []).filter((v) => v.id !== 'coingecko');
const isListing = (m) => listedOn(m).length > 0;
/** A small mark in the exchange's brand colour with its name: where the token is listed, at a glance. */
const EX_MARK = {
  binance: ['#F0B90B', '#181A20'],
  mexc: ['#2D7FF9', '#fff'],
  bybit: ['#F7A600', '#17181E'],
  okx: ['#e8e8e8', '#000'],
  gate: ['#2354E6', '#fff'],
  bitget: ['#00C2D1', '#fff'],
  kucoin: ['#23AF91', '#fff'],
};
function exBadge(m) {
  const on = listedOn(m);
  if (!on.length) return '';
  const [v] = on;
  const [bg, fg] = EX_MARK[v.id] ?? ['var(--surface-2)', 'var(--text)'];
  // The exchange's own logo once the server has saved it; its first letter in its colour until then.
  const logo = S.cfg?.exchangeLogos?.[v.id];
  const mark = logo
    ? `<i class="ex-logo" aria-hidden="true" style="width:16px;height:16px;overflow:hidden;background:#fff"><img src="${esc(logo)}" alt="" width="16" height="16" decoding="async" style="width:16px;height:16px;object-fit:contain;display:block" /></i>`
    : `<i style="background:${bg};color:${fg}" aria-hidden="true">${esc(v.name.slice(0, 1))}</i>`;
  return `<span class="ex-badge" title="Listed on ${esc(on.map((x) => x.name).join(', '))}">${mark}${esc(v.name)}${on.length > 1 ? `<small>+${on.length - 1}</small>` : ''}</span>`;
}

function tabList(tab) {
  // Closed markets counting down to their result, the soonest result first.
  if (tab === 'live') return [...S.lists.live].sort((a, b) => a.settleAt - b.settleAt);
  if (tab === 'settled') return [...S.lists.settled];
  const open = [...S.lists.open];
  if (tab === 'new') return open.sort((a, b) => b.openedAt - a.openedAt);
  // Tokens newly listed on an exchange, every exchange together (CoinGecko-only markets aren't listings).
  if (tab === 'listings') return open.filter(isListing).sort((a, b) => b.openedAt - a.openedAt);
  if (tab === 'all') return open.sort((ALL_SORTS.find(([id]) => id === S.sort) ?? ALL_SORTS[0])[2]);
  return trendingList();
}

/** The cards under the tabs: the chosen tab, or every market matching the search. */
/**
 * A grid of cards, in pages: signed-in players see 24 at a time with "Show more"; guests see the
 * short list the server sends, then an invitation to sign up to see every market.
 */
const PAGE = 24;
function pagedGrid(list, total = list.length) {
  if (!S.me && S.limited) {
    const more = Math.max(0, total - list.length);
    return `<div class="grid">${list.map(cardView).join('')}</div>${
      more
        ? `<div class="see-more"><button class="btn" data-action="connect" title="Sign in to see all ${fmtNum(total)} markets">Show more markets</button></div>`
        : ''
    }`;
  }
  const shown = Math.max(PAGE, S.showN ?? PAGE);
  const left = list.length - shown;
  return `<div class="grid">${list.slice(0, shown).map(cardView).join('')}</div>${
    left > 0 ? `<div class="see-more"><button class="btn" data-action="show-more">Show more markets</button></div>` : ''
  }`;
}

function marketResults() {
  const q = (S.query ?? '').trim().toLowerCase();
  if (q) {
    const all = [...[...S.lists.open].sort(byTrending), ...S.lists.live, ...S.lists.settled];
    const hits = all.filter((m) => (m.symbol.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)));
    return hits.length
      ? `<p class="results-note">${hits.length} market${hits.length === 1 ? '' : 's'} matching “${esc(S.query.trim())}”</p><div class="grid">${hits.map(cardView).join('')}</div>`
      : `<div class="empty"><div class="empty-art">${ico('search')}</div><p><strong>No markets match “${esc(S.query.trim())}”.</strong><br />Try a token symbol like BTC or a project name.</p></div>`;
  }
  const list = tabList(S.filter);
  // Trending carries on into every other open market below it, so the first screen shows all there is to predict.
  if (S.filter === 'trending') {
    const seen = new Set(list.map((m) => m.id));
    const rest = [...S.lists.open].filter((m) => !seen.has(m.id)).sort(ALL_SORTS[0][2]);
    if (!list.length && !rest.length) return `<div class="empty">${emptyText()}</div>`;
    const restTotal = S.limited ? Math.max(rest.length, (S.totals?.open ?? 0) - list.length) : rest.length;
    return `${list.length ? `<div class="grid">${list.map(cardView).join('')}</div>` : ''}${
      rest.length
        ? `<div class="home-head home-subhead"><h2>${list.length ? 'All markets' : 'Open markets'}</h2><span class="side-n">${fmtNum(restTotal)}</span></div>${pagedGrid(rest, restTotal)}`
        : ''
    }`;
  }
  const intro = S.filter === 'live' && list.length ? `<p class="results-note countdown-note">${ico('lock')}<span>Predictions are closed on these markets and their start prices are locked. Each one counts down to its result; the price then decides who wins.</span></p>` : '';
  const tabTotal = S.limited ? ({ live: S.totals?.live, settled: S.totals?.settled, all: S.totals?.open, new: S.totals?.open }[S.filter] ?? list.length) : list.length;
  return list.length ? `${intro}${pagedGrid(list, tabTotal)}` : `<div class="empty">${emptyText()}</div>`;
}

function homeView() {
  const tnCard = startChecklist();
  if (![...HOME_TABS, LISTINGS_TAB].some(([id]) => id === S.filter)) S.filter = 'trending';
  const featured = featuredMarket();
  const tot = (k) => S.totals?.[k] ?? S.lists[k].length;
  const count = (id) => (id === 'live' ? tot('live') : id === 'settled' ? tot('settled') : id === 'trending' ? trendingList().length : id === 'listings' ? S.lists.open.filter(isListing).length : tot('open'));
  const base = tabList(S.filter);
  const onlyFeatured = !S.query && featured && ['trending', 'new', 'all'].includes(S.filter) && base.length === 1 && base[0].id === featured.id && S.lists.open.length <= 1;
  const filterBtn = ([id, icon, label]) =>
    `<button data-filter="${id}" aria-current="${S.filter === id && !S.query}">${ico(icon)}<span>${label}</span><span class="side-n">${count(id)}</span></button>`;
  return `
    ${S.query ? '' : homeHero(!tnCard)}
    ${tnCard}
    <div class="home">
      <aside class="home-side" aria-label="Filter markets">
        <div class="side-group">${HOME_TABS.map(filterBtn).join('')}</div>
        <p class="side-soon" title="Creating your own market is coming soon">${ico('plusCircle')}<span>Create a market</span><span class="soon">Soon</span></p>
        <div class="side-label">Exchanges</div><div class="side-group">${filterBtn(LISTINGS_TAB)}</div>
      </aside>
      <div class="home-main">
        ${S.query ? '' : featuredDeck(featured)}
        <div class="home-head">
          ${onlyFeatured ? '' : `<h2>${S.query ? 'Search results' : ([...HOME_TABS, LISTINGS_TAB].find(([id]) => id === S.filter)?.[2] ?? 'Markets')}</h2>`}
          ${S.filter === 'all' && !S.query && !onlyFeatured ? `<label class="select home-sort">Sort <select id="market-sort">${ALL_SORTS.map(([id, label]) => `<option value="${id}"${id === (S.sort ?? 'predictors') ? ' selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}
        </div>
        <div id="market-results">${onlyFeatured ? '<p class="home-note">This is the only open market right now. New markets show up here as soon as they open.</p>' : marketResults()}</div>
      </div>
      <aside class="home-rail" aria-label="Highlights">${homeRail()}</aside>
    </div>
    ${howItWorks()}`;
}

/** Top banner: what Firstprint is, in one line, with live numbers from open markets. */
function homeHero(showLive = true) {
  const open = S.lists.open;
  const inPlay = [...open, ...S.lists.live].reduce((sum, m) => sum + (m.pool || 0), 0);
  const best = Math.max(0, ...open.flatMap((m) => bucketsOf(m).map((b) => poolMultiple(m, b) ?? 0)));
  const word = (b) => `<b style="color:${oVar(b, false)}">${oName(b, false)}</b>`;
  // Every market so far (waiting for a result and settled ones too), from the server when it says.
  const total = S.stats?.totalMarkets ?? (S.totals ? S.totals.open + S.totals.live + S.totals.settled : 0);
  // The best payout a player has actually received; before any result, the best one on offer now.
  const top = S.stats?.topPayout ?? null;
  const topStat = top
    ? ['Top payout', `<span class="hero-top" data-count="${top}" data-count-key="top">${top.toFixed(1)}×</span>`]
    : best >= 1
      ? ['Payout up to', `${best.toFixed(1)}×`]
      : null;
  const stats = [
    total ? ['Total markets', fmtNum(total)] : null,
    open.length ? ['Open markets', fmtNum(S.totals?.open ?? open.length)] : null,
    // A guest's short list would undercount the points in play, so it's left out for them.
    inPlay && !S.limited ? ['In play', `${fmtNum(inPlay)} pts`] : null,
    topStat,
  ].filter(Boolean);
  const next = [...open].filter((m) => m.phase !== 'awaiting_result').sort((a, b) => a.closeAt - b.closeAt)[0];
  return `
    <section class="home-hero" aria-labelledby="hero-title">
      <svg class="hero-art" viewBox="0 0 1200 320" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="hero-line" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity="0" /><stop offset=".35" stop-color="currentColor" stop-opacity=".5" /><stop offset="1" stop-color="currentColor" stop-opacity=".9" /></linearGradient></defs>
        <path d="M0 250 C 90 240 140 270 220 238 S 360 170 430 196 S 560 262 640 214 S 760 120 840 150 S 980 92 1040 70 S 1150 40 1200 34" fill="none" stroke="url(#hero-line)" stroke-width="2" />
        <circle cx="1040" cy="70" r="4" fill="currentColor" />
      </svg>
      <div class="hero-copy">
        ${
          showLive && testnetLive()
            ? `<a class="hero-badge hero-badge-live" href="#/earn"><span class="dot-live" aria-hidden="true"></span>Testnet live<span class="hero-badge-more"> · Claim 1,000 TestFPT</span> ${ico('arrowRight')}</a>`
            : `<p class="hero-badge">${ico('sparkles')}Crypto prediction markets<span class="hero-badge-more"> · Free to play</span></p>`
        }
        <h1 id="hero-title">Predict where crypto prices land<span class="soft"> and win the pool</span></h1>
        <p class="hero-sub">Pick one of five outcomes (${LADDER.map(word).join(', ')}) on new and trending tokens. Points only, no real money.</p>
        ${stats.length ? `<dl class="hero-stats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
      </div>
      ${
        next
          ? `<a class="hero-next" href="#/market/${encodeURIComponent(next.id)}">
        <span class="hero-next-head"><span>Closing next</span><span class="st st-live"><i aria-hidden="true"></i>Open</span></span>
        <span class="hero-next-id">${tokenAvatar(next, 'avatar-md')}<span><b>${esc(next.symbol)}</b>${next.name ? `<small>${esc(next.name)}</small>` : ''}</span></span>
        <span class="hero-next-facts"><span><small>Closes</small><b title="${esc(fmtDate(next.closeAt))}">${DAY_FMT.format(next.closeAt)}</b><small>in ${until(next.closeAt)}</small></span><span><small>Pool</small><b>${fmtNum(next.pool || 0)} pts</b></span></span>
        <span class="btn btn-gold btn-sm">Predict ${ico('arrowRight')}</span>
      </a>`
          : ''
      }
    </section>`;
}

/** The featured panel: the trending markets (up to ten) flipping one by one; S.heroIdx keeps the place across refreshes. */
function featuredDeck(fallback) {
  const deck = trendingList();
  if (deck.length < 2) return fallback ? featuredView(fallback) : '';
  const on = (S.heroIdx ?? 0) % deck.length;
  const slide = (m, i) => {
    const d = (i - on + deck.length) % deck.length;
    return `<div class="hero-slide${d === 0 ? ' is-on' : ''}${d > 2 ? ' is-far' : ''}" data-slide="${i}" style="--d:${Math.min(d, 3)}"${d === 0 ? '' : ' inert'}>${featuredView(m, i)}</div>`;
  };
  return `<div class="hero-deck feat-deck has-many" data-hero-deck aria-roledescription="carousel" aria-label="Trending markets">
      <div class="hero-slides">${deck.map(slide).join('')}</div>
      <div class="hero-dots">${deck.map((m, i) => `<button type="button" data-hero-dot="${i}" aria-label="Show ${esc(m.symbol)}" aria-current="${i === on}"></button>`).join('')}</div>
    </div>`;
}

/** Resolves once the featured card has finished flipping, so a live redraw doesn't cut the animation short. */
function heroFlipDone() {
  const left = (S.heroFlipUntil ?? 0) - Date.now();
  return left > 0 ? new Promise((r) => setTimeout(r, left)) : Promise.resolve();
}

/** Brings slide i to the front of the stack; the old front card drops away to the back. */
function showHeroSlide(i, animate = true) {
  const deck = $('[data-hero-deck]');
  if (!deck) return;
  const slides = [...deck.querySelectorAll('.hero-slide')];
  if (slides.length < 2) return;
  const n = slides.length;
  const to = ((i % n) + n) % n;
  if (animate) S.heroFlipUntil = Date.now() + 950;
  S.heroIdx = to;
  slides.forEach((el, k) => {
    const d = (k - to + n) % n;
    const leaving = el.classList.contains('is-on') && d !== 0;
    el.classList.remove('is-out');
    if (leaving && animate) {
      void el.offsetWidth;
      el.classList.add('is-out');
    }
    el.classList.toggle('is-on', d === 0);
    el.classList.toggle('is-far', d > 2);
    el.style.setProperty('--d', String(Math.min(d, 3)));
    el.inert = d !== 0;
  });
  deck.querySelectorAll('[data-hero-dot]').forEach((b) => b.setAttribute('aria-current', String(Number(b.dataset.heroDot) === to)));
}

/** Right column: this week's best players, ways to earn, and the daily claim. */
function homeRail() {
  const leaders = S.weekLeaders ?? [];
  return `
    ${S.me?.canClaimDaily ? `<section class="rail-card rail-claim"><div><b>Your daily ${dailyNext()} points</b><p>${dailyLine()}</p></div><button class="btn btn-gold btn-sm" data-action="claim">${ico('gift')}Claim</button></section>` : ''}
    <section class="rail-card">
      <div class="rail-head"><h3>Top this week</h3><a href="#/leaderboard">See all ${ico('chevronRight')}</a></div>
      ${
        leaders.length
          ? `<ol class="rail-list">${leaders.map((e) => `<li><span class="rail-rank">${e.rank}</span>${avatar(e.name, 'avatar-sm')}${userLink(e.name)}<b class="${e.profit >= 0 ? 'profit-pos' : 'profit-neg'}">${signed(e.profit)}</b></li>`).join('')}</ol>`
          : '<p class="rail-empty">No settled markets this week yet. Win one to top the board.</p>'
      }
    </section>
    <section class="rail-card rail-earn">
      <span class="rail-ico">${ico('sparkles')}</span>
      <div><b>Earn more points</b><p>Complete quick tasks and invite friends.</p></div>
      <a class="btn btn-sm" href="#/earn">Earn</a>
    </section>`;
}

function emptyText() {
  if (S.filter === 'live') return `<div class="empty-art">${ico('clock')}</div><p>Nothing is counting down yet. Markets move here once predictions close, and wait for their result.</p><button class="btn" data-filter="trending">See open markets</button>`;
  if (S.filter === 'listings') return `<div class="empty-art">${ico('zap')}</div><p>No new exchange listings open right now. Markets on tokens just listed on MEXC, Gate, Bitget and others show up here.</p><button class="btn" data-filter="trending">See open markets</button>`;
  if (S.filter === 'settled') return `<div class="empty-art">${ico('checkCircle')}</div><p>No settled markets yet. Results appear here after Firstprint posts them.</p>`;
  return `<div class="empty-art">${ico('satellite')}</div>
    <p><strong>No open markets right now.</strong><br />New markets land here as soon as Firstprint opens them.</p>
    ${S.me?.canClaimDaily ? `<button class="btn btn-solid" data-action="claim">${ico('gift')}Claim ${dailyNext()} free points meanwhile</button>` : `<a class="btn" href="#/leaderboard">${ico('trophy')}See the leaderboard</a>`}`;
}

/** The pool split as five bars, Moon on top, used by the featured market. */
function miniLadder(m) {
  if (!m.pool) {
    const yn = isYesNo(m);
    return `
    <div class="mini-ladder quiet" aria-label="Outcomes">
      <div class="mini-head"><span>Outcomes</span><span>No predictions yet</span></div>
      ${bucketsOf(m).map((b) => `<div class="mini-rung" style="--c:${oVar(b, yn)};--share:0%"><b>${icon(b, yn)}${oName(b, yn)}</b><span class="muted">${rangeOf(m, b)}</span><span></span></div>`).join('')}
    </div>`;
  }
  return `
    <div class="mini-ladder" aria-label="Pool split by outcome">
      <div class="mini-head"><span>Where the crowd is</span><span>${fmtPts(m.pool)}</span></div>
      ${bucketsOf(m).map((b) => {
        const yn = isYesNo(m);
        const pct = share(m, b) * 100;
        return `<div class="mini-rung" style="--c:${oVar(b, yn)};--share:${pct}%"><b>${icon(b, yn)}${oName(b, yn)}</b><span class="muted">${rangeOf(m, b)}</span><span class="pct">${Math.round(pct)}%</span></div>`;
      }).join('')}
    </div>`;
}

/** Pool, predictors and timing as three small facts with icons. */
function heroFacts(m, whenLabel, whenValue) {
  return `
    <dl class="hero-facts">
      ${
        m.pool
          ? `<div>${ico('coins')}<dt>Pool</dt><dd>${tick(`pool:hero:${m.id}`, m.pool)} pts</dd></div>
             <div>${ico('users')}<dt>Participants</dt><dd>${fmtNum(m.predictors)}</dd></div>`
          : isManual(m)
          ? `<div>${ico('dollar')}<dt>${isYesNo(m) ? 'Target' : 'Start price'}</dt><dd>${hasStart(m) ? fmtPrice(m.basePrice) : startLater(m)}</dd></div>`
          : ''
      }
      <div>${ico('clock')}<dt>${whenLabel}</dt><dd>${whenValue}</dd></div>
    </dl>`;
}

/** Quick-pick buttons for every outcome, tinted in each outcome's colour. */
function quickPicks(m, cls = '') {
  const yn = isYesNo(m);
  const open = m.status === 'open' && m.phase !== 'awaiting_result';
  return `<div class="qp-row${yn ? ' qp-yn' : ''} ${cls}">${bucketsOf(m)
    .map((b) => {
      const pct = m.pool ? `<b>${Math.round(share(m, b) * 100)}%</b>` : '';
      return `<button class="qp" style="--c:${oVar(b, yn)}" data-action="quick-pick" data-id="${esc(m.id)}" data-bucket="${b}"${open ? '' : ' disabled'}><span>${oName(b, yn)}</span>${pct}</button>`;
    })
    .join('')}</div>`;
}

/** The featured market's crowd odds over time, or the pool split when there is no history yet. */
function featuredSide(m) {
  const o = S.featuredOdds?.id === m.id ? S.featuredOdds.odds : null;
  if (!o || o.series.length < 2) return miniLadder(m);
  return `<div class="feat-chart">${oddsPlot(m, o)}</div>`;
}

function featuredView(m, rank = null) {
  const yn = isYesNo(m);
  const manual = isManual(m);
  const pre = m.phase === 'pre_listing' || isUpcoming(m);
  const open = m.status === 'open' && m.phase !== 'awaiting_result';
  const name = esc(m.name || m.symbol);
  const href = `#/market/${encodeURIComponent(m.id)}`;
  const question = yn
    ? `Will ${name} be at or above ${startText(m)} when the result is posted?`
    : manual
    ? `Where will ${name} be priced at the result, compared with ${startText(m)}?`
    : `Where will ${name} trade ${fmtSpan(m.settleAt - m.listingAt)} after ${m.kind === 'live_test' ? 'the market starts' : 'listing'}?`;

  const fact = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const facts = [
    manual ? fact(yn ? 'Target price' : 'Start price', hasStart(m) ? fmtPrice(m.basePrice) : m.startAtClose ? 'At the close' : 'At listing <span class="feat-sub">opening price</span>') : '',
    pre ? fact(m.kind === 'live_test' ? 'Starts' : 'Lists', dayAndIn(isUpcoming(m) ? m.closeAt : m.listingAt)) : fact('Closes', dayAndIn(m.closeAt)),
    manual && !pre ? fact('Result', `<span title="${esc(fmtDate(m.settleAt))}">${DAY_FMT.format(m.settleAt)}</span>`) : '',
    m.pool ? fact('Pool', `${tick(`pool:hero:${m.id}`, m.pool)} pts <span class="feat-sub">${fmtNum(m.predictors)} player${m.predictors === 1 ? '' : 's'}</span>`) : '',
  ].join('');

  // One list of outcomes; each row is the pick button.
  const rows = bucketsOf(m)
    .map((b) => {
      const pct = m.pool ? Math.round(share(m, b) * 100) : null;
      return `<button class="fo-row" style="--c:${oVar(b, yn)};--share:${pct ?? 0}%" data-action="quick-pick" data-id="${esc(m.id)}" data-bucket="${b}"${open ? '' : ' disabled'} aria-label="Pick ${oName(b, yn)}: ${rangeOf(m, b)}${pct === null ? '' : `, ${pct}% of the pool`}">
        <span class="fo-name">${icon(b, yn)}${oName(b, yn)}</span>
        <span class="fo-range">${rangeOf(m, b)}</span>
        <span class="fo-val">${pct === null ? `<span class="fo-pick">Pick ${ico('chevronRight')}</span>` : `${pct}%`}</span>
      </button>`;
    })
    .join('');

  return `
    <section class="feat" aria-labelledby="featured-title${rank ?? ''}">
      <div class="feat-main">
        <div class="feat-kicker"><span class="st ${pre ? 'st-soon' : 'st-live'}"><i aria-hidden="true"></i>${pre ? 'Upcoming' : 'Open'}</span><span aria-hidden="true">·</span><span>${rank === null ? 'Featured market' : `${ico('flame')}Trending #${rank + 1}`}</span></div>
        <div class="feat-id">
          ${tokenAvatar(m, 'avatar-lg')}
          <div class="feat-name"><h2 id="featured-title${rank ?? ''}">${esc(m.symbol)}</h2>${m.name ? `<p>${esc(m.name)}</p>` : ''}</div>
          <a class="btn btn-gold feat-open-btn" href="${href}" aria-label="Open market">Open<span class="feat-open-word"> market</span> ${ico('arrowRight')}</a>
        </div>
        <p class="feat-q">${question}</p>
        <dl class="feat-facts">${facts}</dl>
        ${m.pool ? '' : '<p class="feat-hint">No predictions yet. Early picks earn the biggest bonus.</p>'}
      </div>
      <div class="feat-side" role="group" aria-label="Pick an outcome">
        <div class="feat-side-head"><span>${yn ? 'Your answer' : 'Outcomes'}</span><span>${m.pool ? 'Crowd' : 'Tap to pick'}</span></div>
        ${rows}
      </div>
    </section>`;
}

/** Status pill for a market card: what is happening and how it looks. */
function cardStatus(m) {
  if (m.status === 'resolved') return '<span class="pill pill-done">Settled</span>';
  if (m.status === 'void') return '<span class="pill pill-off">Cancelled</span>';
  if (m.phase === 'awaiting_result' && m.settleAt > now()) return `<span class="pill pill-wait">${ico('clock')}Result in<span data-until="${m.settleAt}">${fmtDur(m.settleAt - now())}</span></span>`;
  if (m.phase === 'awaiting_result') return '<span class="pill pill-wait">Awaiting result</span>';
  if (m.phase === 'pre_listing' || isUpcoming(m)) return `<span class="pill pill-soon">${ico('clock')}Upcoming</span>`;
  if (m.phase === 'running') return '<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>Live</span>';
  return '<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>Open</span>';
}

/** Semicircle gauge with the leading chance, as on trading cards. */
function gauge(pct, color, label) {
  const v = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return `<span class="gauge" style="--c:${color}" role="img" aria-label="${pct === null ? 'No predictions yet' : `${label} ${pct}%`}">
    <svg viewBox="0 0 48 28" aria-hidden="true"><path class="g-track" d="M4 26 A20 20 0 0 1 44 26" pathLength="100" /><path class="g-fill" d="M4 26 A20 20 0 0 1 44 26" pathLength="100" stroke-dasharray="${v} 100" /></svg>
    <b>${pct === null ? '–' : `${pct}%`}</b><small>${esc(label)}</small></span>`;
}

/** Short note on cards for a token that isn't trading yet. */
function upcomingLine(m) {
  return `<p class="card-quiet card-soon">${ico('clock')}<span>Not trading yet. Lists on ${esc(venueNames(m))}; predict before it goes live.</span></p>`;
}

function cardView(m) {
  const yn = isYesNo(m);
  const lead = leader(m);
  const open = m.status === 'open' && m.phase !== 'awaiting_result';
  const href = `#/market/${encodeURIComponent(m.id)}`;
  const soon = m.status === 'open' && m.closeAt - now() < 15 * 60_000 && m.closeAt > now();

  // Gauge: Yes chance on Yes/No markets, the leading outcome on five-outcome markets.
  const upcoming = isUpcoming(m);
  const g = upcoming && !m.pool
    ? `<span class="card-new card-upcoming">${ico('clock')}Upcoming</span>`
    : !m.pool
    ? '<span class="card-new">New</span>'
    : yn
    ? gauge(m.pool ? Math.round(share(m, 'up') * 100) : null, 'var(--up)', 'Yes')
    : gauge(lead ? Math.round(share(m, lead) * 100) : null, lead ? oVar(lead, false) : 'var(--flat)', lead ? oName(lead, false) : 'No picks');

  let body;
  if (m.status === 'resolved') {
    body = `<p class="card-result">${yn ? `Resolved ${outcome(m.result.winningBucket, true)} at ${fmtPrice(m.result.finalPrice)}` : `Settled in ${outcome(m.result.winningBucket)} at ${fmtPct(m.result.returnPct)}`}</p>`;
  } else if (m.status === 'void') {
    body = '<p class="card-result muted">Cancelled. Points were returned.</p>';
  } else if (yn) {
    body = `${upcoming ? upcomingLine(m) : ''}${quickPicks(m, 'qp-card')}`;
  } else if (!m.pool) {
    body = `${upcoming ? upcomingLine(m) : '<p class="card-quiet">No predictions yet.</p>'}${quickPicks(m, 'qp-mini')}`;
  } else {
    // The two outcomes the crowd backs most (Up and Down before anyone predicts).
    const top = m.pool ? [...bucketsOf(m)].sort((a, b) => m.totals[b] - m.totals[a]).slice(0, 2) : ['up', 'down'];
    body = `<div class="o-rows">${top
      .map((b) => {
        const x = poolMultiple(m, b);
        const pct = m.pool ? Math.round(share(m, b) * 100) : 0;
        return `<div class="o-row" style="--c:var(--${b});--sf:${pct / 100}">
          <span class="o-name">${icon(b)}${oName(b)}</span>
          <b class="o-pct">${m.pool ? `${tick(`pct:${m.id}:${b}`, pct)}%` : '–'}</b>
          <button class="qp qp-sm" style="--c:var(--${b})" data-action="quick-pick" data-id="${esc(m.id)}" data-bucket="${b}"${open ? '' : ' disabled'} aria-label="Pick ${oName(b)} on ${esc(m.symbol)}">${x ? `${x.toFixed(1)}×` : 'Pick'}</button>
        </div>`;
      })
      .join('')}</div>`;
  }

  const state =
    m.status === 'resolved' ? '<span class="st st-done">Settled</span>'
    : m.status === 'void' ? '<span class="st st-off">Cancelled</span>'
    : m.phase === 'awaiting_result' ? `<span class="st st-wait">${m.settleAt > now() ? 'Countdown' : 'Awaiting'}</span>`
    : soon ? `<span class="st st-hot">${ico('flame')}${upcoming ? 'Listing soon' : 'Closing soon'}</span>`
    : upcoming ? '<span class="st st-soon"><i aria-hidden="true"></i>Upcoming</span>'
    : ''; // Open markets show a live dot on the token logo instead.

  // New predictors since this card was last drawn float up as "+N": real activity, never made up.
  const seen = S.cardSeen.get(m.id);
  const joined = seen === undefined ? 0 : m.predictors - seen;
  S.cardSeen.set(m.id, m.predictors);
  // When the result comes, so it's clear from the card how long a pick is held.
  const result = open && m.settleAt
    ? `<span class="card-result" title="Result ${esc(fmtDate(m.settleAt))}">${ico('calendar')}Result<b>${esc(DAY_FMT.format(m.settleAt))}</b></span>`
    : '';

  // A countdown to when predictions close (or, for an upcoming token, to its listing), so the
  // markets running out of time stand out.
  const left = m.closeAt - now();
  const toResult = m.settleAt - now();
  const timer = open && left > 0
    ? `<span class="card-timer${left < 3_600_000 ? ' urgent' : left < 86_400_000 ? ' today' : ''}" title="${upcoming ? 'Lists' : 'Predictions close'} ${esc(fmtDate(m.closeAt))}">${ico('clock')}<span data-until="${m.closeAt}">${fmtDur(left)}</span></span>`
    : m.phase === 'awaiting_result' && toResult > 0
    ? `<span class="card-timer card-timer-result" title="Result ${esc(fmtDate(m.settleAt))}">${ico('clock')}Result in<span data-until="${m.settleAt}">${fmtDur(toResult)}</span></span>`
    : '';

  // The early bonus shrinks as the close nears: show it so early players know it's worth coming now.
  const bonus = open && left > 0 && m.earlyBirdK > 0 ? bonusNow(m) : 0;
  const bonusChip = bonus >= 1.05 ? `<span class="card-bonus" title="Early bonus for a prediction placed now. It shrinks until the close.">${ico('zap')}${bonus.toFixed(1)}× bonus</span>` : '';

  return `
    <article class="card mcard${soon ? ' soon' : ''}${joined > 0 ? ' has-new' : ''}">
      ${joined > 0 ? `<span class="card-bump" aria-hidden="true">+${joined}</span>` : ''}
      <div class="card-top">
        ${open && !upcoming ? `<span class="av-live" title="Open for predictions">${tokenAvatar(m, 'avatar-md')}<i class="live-dot" aria-hidden="true"></i><span class="sr-only">Open</span></span>` : tokenAvatar(m, 'avatar-md')}
        <a class="card-link" href="${href}"><span class="sym">${esc(m.symbol)}${yn ? ' <span class="tag tag-yn">Yes / No</span>' : ''}</span><span class="card-name">${m.name ? `<span class="card-nm">${esc(m.name)}</span>` : ''}${exBadge(m)}${m.kind === 'live_test' ? ' <span class="tag tag-test">Live test</span>' : ''}</span></a>
        ${g}
      </div>
      ${body}
      <div class="card-foot"><span class="foot-l">${state}${timer}${bonusChip}</span>${result ? `<span class="foot-r">${result}</span>` : ''}</div>
    </article>`;
}

/** On a settled market: the player's own points won or lost, with the button to share it. */
function myResultRow(m) {
  const mine = (m.mine ?? []).filter((p) => p.stake - (p.refund ?? 0) > 0);
  if (m.status !== 'resolved' || !mine.length) return '';
  const profit = mine.reduce((s, p) => s + (p.payout ?? 0) - (p.stake - (p.refund ?? 0)), 0);
  return `<div class="my-result"><span>Your result <b class="${profit >= 0 ? 'profit-pos' : 'profit-neg'}">${signed(profit)} pts</b></span>${pnlButton(m.id, m.symbol, 'btn btn-sm')}</div>`;
}

/** Three friendly steps up front; the full rules stay one tap away. */
function howItWorks() {
  const steps = `
      <div class="section-head"><span class="section-ico">${ico('info')}</span><div><h2>How it works</h2><p class="muted">Free to play. Points only, no real money.</p></div><button class="btn btn-sm head-action" data-action="tour">${ico('sparkles')}Take the tour</button></div>
      <ol class="steps">
        <li><span class="step-ico" style="--c:var(--up)">${ico('target')}</span><b>Pick an outcome</b><p>Where will the price land? Five choices, from ${outcome('crash')} to ${outcome('moon')}, or a simple Yes or No.</p></li>
        <li><span class="step-ico" style="--c:var(--warn)">${ico('coins')}</span><b>Stake free points</b><p>Everyone gets ${startPoints()}, plus up to 200 more every day with a daily streak. No real money.</p></li>
        <li><span class="step-ico" style="--c:var(--text)">${ico('trophy')}</span><b>Win the pool</b><p>If you’re right, you split the pool with the other winners. Earlier picks earn more.</p></li>
      </ol>
      <details class="full-rules"><summary>Full rules</summary>`;
  if (S.cfg?.manualOnly) {
    return `
    <section class="section" id="how" style="margin-top:36px">${steps}
      <ol class="rules">
        <li>Firstprint opens markets on crypto tokens: new exchange listings, trending tokens and well-known ones. Log in with Google, email, or a Solana wallet to get ${startPoints()}.</li>
        <li>Pick one of five outcomes for where the price ends up compared with the start price, from Crash to Moon. Predictions stay open up to three days, and earlier predictions earn a bigger share.</li>
        <li>The start price is locked when predictions close, so a move while they are open doesn’t count. The market then counts down to its result, usually 7 to 30 days later.</li>
        <li>When the result is due, the final price and the winners appear on the market page.</li>
        <li>Everyone who picked the winning outcome splits the pool, minus the fee shown on the market (usually 4%). Everyone gets their points back if nobody picked the winner, everyone picked the same outcome, or the market is cancelled.</li>
      </ol></details>
    </section>`;
  }
  return `
    <section class="section" id="how" style="margin-top:36px">${steps}
      <ol class="rules">
        <li>Firstprint opens markets on crypto tokens, including new listings it spots on seven exchanges. Sign in with Google, email, or a Solana wallet to get ${startPoints()}.</li>
        <li>Pick one of five outcomes for where the price lands at the result time shown on the market, from Crash to Moon. Predictions stay open until the time shown, and earlier predictions earn a bigger share.</li>
        <li>The starting price is the average over the first hour of trading. The final price is the average over the last hour, so a single spike can’t decide a market.</li>
        <li>Everyone who picked the winning outcome splits the pool, minus the fee shown on the market (usually 4%). Everyone gets their points back if nobody picked the winner, everyone picked the same outcome, or the market is cancelled.</li>
      </ol></details>
    </section>`;
}

// ------------------------------------------------------------------ Market page

function renderMarket() {
  const m = S.market;
  const view = $('#view');
  if (!$('.market-layout', view) || view.dataset.market !== m.id) {
    view.dataset.market = m.id;
    view.innerHTML = `
      <div class="market-layout">
        <div id="market-main"></div>
        <aside class="trade" id="trade" aria-label="Make a prediction"></aside>
      </div>
      <div id="mobile-bar-root"></div>`;
    S.tradeKey = '';
  }
  setHtml($('#market-main'), marketMain(m));
  tickCountdowns();
  setHtml($('#mobile-bar-root'), mobileBar(m));
  renderTrade();
}

/**
 * A large live countdown on the market page, to seconds: to the close while predictions are open,
 * then to the result. The digits are filled in by the one-second ticker (tickCountdowns).
 */
function bigCountdown(m) {
  if (m.status === 'resolved' || m.status === 'void') return '';
  const open = m.status === 'open' && m.phase !== 'awaiting_result' && m.phase !== 'running';
  const to = open ? m.closeAt : m.settleAt;
  if (!to || to <= now()) return '';
  const label = open ? (isUpcoming(m) ? 'Lists and predictions close in' : 'Predictions close in') : 'Result in';
  const unit = (k, name) => `<span class="cd-unit"><b data-cd-part="${k}">00</b><small>${name}</small></span>`;
  const sep = '<span class="cd-sep" aria-hidden="true">:</span>';
  return `<div class="big-cd${open ? ' is-open' : ''}" data-cd="${to}" role="timer" aria-label="${label}">
    <span class="cd-label">${ico('clock')}${label}</span>
    <span class="cd-digits">${unit('d', 'days')}${sep}${unit('h', 'hours')}${sep}${unit('m', 'min')}${sep}${unit('s', 'sec')}</span>
  </div>`;
}

/** Fills in every big countdown on the page; called each second and right after a redraw. */
/** Numbers that count up once when they first appear (the home banner's top payout). */
const counted = new Set();
function animateCounts() {
  document.querySelectorAll('[data-count]').forEach((el) => {
    const to = Number(el.dataset.count);
    const key = `${el.dataset.countKey}:${to}`;
    if (!Number.isFinite(to) || counted.has(key)) return;
    counted.add(key);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 1400);
      const v = to * (1 - Math.pow(1 - k, 4));
      // The element can be replaced by a re-render; then the new one already shows the final value.
      if (!el.isConnected) return;
      el.textContent = `${v.toFixed(1)}×`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function tickCountdowns() {
  animateCounts();
  document.querySelectorAll('[data-cd]').forEach((el) => {
    const s = Math.max(0, Math.floor((Number(el.dataset.cd) - now()) / 1000));
    const parts = { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
    for (const [k, v] of Object.entries(parts)) {
      const b = el.querySelector(`[data-cd-part="${k}"]`);
      const text = String(v).padStart(2, '0');
      if (b && b.textContent !== text) b.textContent = text;
    }
    el.classList.toggle('is-last-hour', s < 3600);
  });
}

function statusLine(m) {
  switch (m.phase) {
    case 'pre_listing':
      return m.kind === 'live_test'
        ? `Starts in <strong>${until(m.listingAt)}</strong>. Predictions close ${fmtSpan(m.closeAt - m.listingAt)} after it starts.`
        : `Lists in <strong>${until(m.listingAt)}</strong>. Predictions close ${fmtSpan(m.closeAt - m.listingAt)} after trading starts.`;
    case 'baseline':
      if (isManual(m)) return `Predictions close in <strong>${until(m.closeAt)}</strong>.${m.startAtClose && !hasStart(m) ? ' The start price is the price then.' : ''} The result is expected around ${fmtDate(m.settleAt)}.`;
      return `${m.kind === 'live_test' ? 'The market has started.' : 'Trading started.'} Predictions close in <strong>${until(m.closeAt)}</strong>.`;
    case 'running':
      return `Predictions are closed. Result in <strong>${until(m.settleAt)}</strong>.`;
    case 'awaiting_result':
      if (m.settleAt > now()) return `Predictions are closed${hasStart(m) ? ` at a start price of <strong>${fmtPrice(m.basePrice)}</strong>` : ''}. Result in <strong>${until(m.settleAt)}</strong>, on ${fmtDate(m.settleAt)}.`;
      return `Predictions are closed. Waiting for Firstprint to post the final price, due <strong>${fmtDate(m.settleAt)}</strong>.`;
    case 'resolved':
      if (isYesNo(m)) return `Result posted: final price <strong>${fmtPrice(m.result.finalPrice)}</strong> against a target of ${fmtPrice(m.result.basePrice)}, so ${outcome(m.result.winningBucket, true)} wins.`;
      if (isManual(m)) return `Result posted: ${fmtPrice(m.result.basePrice)} → <strong>${fmtPrice(m.result.finalPrice)}</strong> (${fmtPct(m.result.returnPct)}), so ${outcome(m.result.winningBucket)} wins.`;
      return `Settled in ${outcome(m.result.winningBucket)} at <strong>${fmtPct(m.result.returnPct)}</strong> on ${fmtDate(m.settleAt)}.`;
    case 'void':
      return `Cancelled because ${VOID_REASONS[m.result?.voidReason] ?? 'of a data problem'}. All points were returned.`;
  }
  return '';
}

/** The rules for the early bonus and for taking a prediction back, in one place players can read. */
function earlyRules(m) {
  const r = m.revert;
  const k = m.earlyBirdK ?? 0;
  if (!r && !k) return '';
  const mins = (ms) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}`;
  const half = m.openedAt + (m.closeAt - m.openedAt) / 2;
  const burned = !r ? '' : r.burnBps >= 10_000 ? 'The whole fee is burned: those points are gone for good.' : r.burnBps <= 0 ? 'The whole fee is shared at the result among predictions placed in the early window that stayed in, by stake, whether they win or lose.' : `${pctText(r.burnBps)} of the fee is burned: those points are gone for good. The rest is shared at the result among predictions placed in the early window that stayed in, by stake, whether they win or lose.`;
  const items = [
    k ? `Early bonus: a prediction placed when the market opens counts ${+(1 + k).toFixed(1)}× when the winners split the pool, and one placed at the close counts 1×. In between it falls steadily, minute by minute. The bonus only changes how the winners share the pool; it never adds points.` : '',
    `Early window: the first half of the time between the market opening and predictions closing. For this market it runs until ${fmtDate(half)}.`,
    r ? `Taking a prediction back: you can do it until ${mins(r.lockMs)} before predictions close${m.status === 'open' ? ` (${fmtDate(m.closeAt - r.lockMs)})` : ''}. Your stake comes back minus a fee, and the prediction leaves the pool.` : '',
    r ? `The fee is ${pctText(r.baseBps)} in the early window. After that it rises, slowly at first and steeply near the close, up to ${pctText(r.maxBps)}.${r.undoMs ? ` Taking a prediction back within ${mins(r.undoMs)} of placing it, in the early window, is free.` : ''} The exact fee is shown before you confirm.` : '',
    burned,
    r ? 'Taking a prediction back also gives up its early bonus. A new prediction gets the bonus for the moment it is placed, and counts as early only if it is placed in the early window.' : '',
    r ? 'Fees are not returned, even if the market is cancelled later. If it is, the part meant for early players is burned too.' : '',
    r ? 'Firstprint may change these numbers. A change applies only to predictions taken back after it.' : '',
    'Points, burned points and early rewards have no cash value.',
  ].filter(Boolean);
  return `<details class="m-rules">
      <summary>${ico('zap')}Early bonus, taking a pick back and fees${ico('chevronRight')}</summary>
      <ol class="rules">${items.map((t) => `<li>${t}</li>`).join('')}</ol>
    </details>`;
}

/** The player's picks on an open market, each with a button to take it back. */
function myPicksBar(m) {
  if (!S.me || !m.mine.length || !m.revert) return '';
  const yn = isYesNo(m);
  return `<div class="my-picks" aria-label="Your predictions">${m.mine
    .map((p) => {
      const q = revertNow(m, p);
      const note = !q ? '' : !q.allowed ? 'Locked until the result' : q.free ? 'Free to take back now' : `Take back: ${pctText(q.bps)} fee`;
      return `<div class="my-pick" style="--c:${oVar(p.bucket, yn)}">
        <span class="my-pick-name">${icon(p.bucket, yn)}<b>${oName(p.bucket, yn)}</b> ${fmtPts(p.stake)}</span>
        <span class="my-pick-note muted">${note}</span>
        ${q?.allowed ? `<button class="icon-btn revert-btn" data-action="revert-open" data-id="${esc(p.id)}" aria-label="Take back your ${oName(p.bucket, yn)} prediction" title="Take back">${ico('undo')}</button>` : ''}
      </div>`;
    })
    .join('')}</div>`;
}

function marketMain(m) {
  const span = fmtSpan(m.settleAt - m.listingAt);
  const settled = m.status === 'resolved' || m.status === 'void';
  const canPick = m.status === 'open';
  const mineBy = {};
  for (const p of m.mine) mineBy[p.bucket] = (mineBy[p.bucket] ?? 0) + p.stake;
  const nowBucket = m.live?.projectedBucket;
  const net = m.result ? m.result.pool - m.result.fee : 0;
  const yn = isYesNo(m);
  // No predictions yet: hide crowd %, payouts and pool sizes instead of showing rows of zeros.
  const quiet = !m.pool;
  // Back on a market they predicted on: their pick stands out and the rest step back (still pickable).
  const fadeOthers = canPick && m.mine.length > 0 && !S.trade.bucket;

  const rungs = bucketsOf(m).map((b) => {
    const pct = share(m, b) * 100;
    const won = m.status === 'resolved' && m.result.winningBucket === b;
    let pays = '–';
    if (canPick && m.totals[b]) pays = `${estMultiple(m, b).toFixed(1)}×`;
    else if (canPick) pays = 'Be first';
    else if (won && m.totals[b]) pays = `${(net / m.totals[b]).toFixed(2)}×`;
    else if (!settled && m.totals[b]) pays = `${(m.pool * (1 - m.feeBps / 10_000) / m.totals[b]).toFixed(1)}×`;
    return `
      <button class="rung${won ? ' won' : ''}${yn ? ' rung-yn' : ''}${fadeOthers ? (mineBy[b] ? ' rung-mine' : ' rung-faded') : ''}" style="--c:${oVar(b, yn)};--share:${pct}%" data-bucket="${b}"
        aria-pressed="${S.trade.bucket === b}" ${canPick ? '' : 'disabled'}
        aria-label="${oName(b, yn)}, ${rangeOf(m, b)}${quiet ? '' : `, ${Math.round(pct)}% of pool`}">
        <span class="rung-name">
          <b>${icon(b, yn)}${oName(b, yn)}${mineBy[b] ? `<span class="tag tag-you">You ${fmtNum(mineBy[b])}</span>` : ''}${
            nowBucket === b ? `<span class="tag tag-now">Now ${fmtPct(m.live.returnPct)}</span>` : ''
          }${won ? '<span class="tag tag-now">Winner</span>' : ''}</b>
          <small>${rangeOf(m, b)}</small>
        </span>
        ${
          quiet
            ? `<span class="rung-cta">${canPick ? `Pick ${ico('chevronRight')}` : ''}</span>`
            : `<span class="num">${Math.round(pct)}%</span>
        <span class="num${pays === 'Be first' ? ' num-soft' : ''}">${pays}</span>
        <span class="num pool-col">${fmtNum(m.totals[b])}<small>pts</small></span>`
        }
      </button>`;
  }).join('');

  const question = yn
    ? `Will ${esc(m.name || m.symbol)} be at or above ${startText(m)} at the result?`
    : isManual(m)
    ? `Where will ${esc(m.name || m.symbol)} be priced at the result, compared with ${hasStart(m) ? `the start price of ${fmtPrice(m.basePrice)}` : m.startAtClose ? 'its price when predictions close' : 'its opening price when trading starts'}?`
    : m.kind === 'live_test'
    ? `Where will ${esc(m.name || m.symbol)} trade ${span} after this market starts?`
    : `Where will ${esc(m.name || m.symbol)} trade ${span} after listing on ${esc(m.exchange)}?`;

  // One line of facts: price, timing, where the price comes from, and the pool once it exists.
  const fact = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const facts = [
    isManual(m) ? fact(yn ? 'Target price' : 'Start price', hasStart(m) ? fmtPrice(m.basePrice) : m.startAtClose ? 'At the close' : 'Opening price') : fact(m.kind === 'live_test' ? 'Starts' : 'Listing', fmtDate(m.listingAt)),
    m.status === 'open' && m.phase !== 'awaiting_result' && m.phase !== 'running'
      ? fact(isUpcoming(m) ? 'Lists & closes' : 'Closes', `${fmtDate(m.closeAt)} <span class="muted">· in ${until(m.closeAt)}</span>`)
      : fact('Result', !settled && m.settleAt > now() ? `${fmtDate(m.settleAt)} <span class="muted">· in ${until(m.settleAt)}</span>` : fmtDate(m.settleAt)),
    settled || m.phase === 'awaiting_result' ? '' : fact('Result expected', fmtDate(m.settleAt)),
    m.pool ? fact('Pool', `${tick(`pool:page:${m.id}`, m.pool)} pts <span class="muted">· ${fmtNum(m.predictors)} participant${m.predictors === 1 ? '' : 's'}</span>`) : '',
    canPick && m.earlyBirdK > 0 && m.closeAt > now() ? fact('Early bonus now', `${bonusNow(m).toFixed(2)}× <span class="muted">· shrinks to 1× at the close</span>`) : '',
    m.earlyPot > 0 ? fact('Early rewards', `${fmtPts(m.earlyPot)} <span class="muted">· for early players who stay in</span>`) : '',
  ].join('');

  return `
    <a class="back" href="#/">${ico('arrowLeft')}All markets</a>
    <header class="m-head mh">
      <div class="m-title">${tokenAvatar(m, 'avatar-lg')}<div class="m-title-text"><div class="m-title-row"><h1 class="sym">${esc(m.symbol)}</h1>${cardStatus(m)}${
        (m.phase === 'baseline' || m.phase === 'running') && S.live && !isManual(m) ? '<span class="live-badge"><span class="live-dot" aria-hidden="true"></span>Live price</span>' : ''
      }${m.kind === 'live_test' ? '<span class="tag tag-test">Live test</span>' : ''}</div>${m.name ? `<span class="m-name">${esc(m.name)}</span>` : ''}</div><span class="m-head-actions">${telegramUrl() ? `<a class="btn btn-sm tg-join" href="${telegramUrl()}" target="_blank" rel="noopener noreferrer" aria-label="Get new markets on Telegram" title="Get new markets on Telegram">${ico('telegram')}<span class="hide-sm">Alerts</span></a>` : ''}<button class="btn btn-sm share-btn" data-action="share" aria-label="Share this market">${ico('share')}<span class="hide-sm">Share</span></button></span></div>
      <p class="m-question">${question}</p>
      ${
        isUpcoming(m)
          ? `<div class="m-upcoming">${ico('clock')}<div><b>Upcoming: ${esc(m.symbol)} isn’t trading yet</b><p>It lists on ${esc(venueNames(m))} around ${fmtDate(m.closeAt)}. Predictions close at listing, and its first trading price becomes the start price. The result is expected ${fmtDate(m.settleAt)}.</p></div></div>`
          : !hasStart(m) && isManual(m) && m.status === 'locked'
          ? m.startAtClose
            ? `<div class="m-upcoming">${ico('clock')}<div><b>Predictions closed. Locking the start price</b><p>${esc(m.symbol)}’s price at the close is being read from ${esc(venueNames(m))}. It shows here in a few minutes, and the result comes ${fmtDate(m.settleAt)}.</p></div></div>`
            : `<div class="m-upcoming">${ico('clock')}<div><b>Listed. Opening price coming soon</b><p>Predictions are closed. Firstprint posts ${esc(m.symbol)}’s opening price here, then the result after ${fmtDate(m.settleAt)}.</p></div></div>`
          : m.startAtClose && m.status === 'open' && m.phase !== 'awaiting_result'
          ? `<div class="m-upcoming m-atclose">${ico('lock')}<div><b>The start price is locked when predictions close</b><p>The result compares ${esc(m.symbol)}’s price on ${fmtDate(m.settleAt)} with its price at the close, ${fmtDate(m.closeAt)}. A move while predictions are open doesn’t count, so watching the chart now gives no edge.</p></div></div>`
          : ''
      }
      ${m.status === 'resolved' || m.status === 'void' || m.phase === 'awaiting_result' ? `<p class="m-status">${statusLine(m)}</p>` : ''}
      ${bigCountdown(m)}
      <dl class="m-facts">${facts}</dl>
      <div class="m-refs">${ico('landmark')}<span>${isManual(m) ? 'Reference' : 'Prices from'} ${esc(venueNames(m))}</span>${priceLinks(m)}</div>
    </header>

    ${isManual(m) ? manualPanel(m) : chartView(m)}

    <section class="ladder${settled ? ' settled' : ''}${yn ? ' ladder-yn' : ''}${quiet ? ' ladder-quiet' : ''}" role="group" aria-label="Outcomes">
      <div class="ladder-head"><span>${yn ? 'Your answer' : isManual(m) ? 'Final price vs start' : `Price after ${span}`}</span>${quiet ? '' : '<span>Crowd</span><span>Pays</span><span class="pool-col">Pool</span>'}</div>
      ${rungs}
    </section>
    ${canPick ? myPicksBar(m) : ''}
    ${
      canPick
        ? `<p class="fine ladder-note">${quiet ? `No predictions yet. Early picks get up to ${(1 + m.earlyBirdK).toFixed(1)}× weight when the pool is split.` : 'Pays is the current payout per point before early bonuses. Your estimate in the prediction panel includes your bonus.'}</p>`
        : ''
    }

    ${oddsView(m)}
    ${holdersView(m)}

    <details class="m-rules">
      <summary>${ico('shield')}How this market settles${ico('chevronRight')}</summary>
      ${isManual(m) ? manualRules(m) : ''}
      <ol class="rules"${isManual(m) ? ' hidden' : ''}>
        <li>Starting price: the average price over the first ${fmtSpan(m.closeAt - m.listingAt)} ${m.kind === 'live_test' ? 'after the market starts' : 'of trading'}, from ${esc(venueNames(m))}.</li>
        <li>Final price: the average over the last ${fmtSpan(m.closeAt - m.listingAt)} before ${fmtDate(m.settleAt)}. If the token trades on several exchanges, the volume-weighted median is used.</li>
        <li>Predictions close ${fmtSpan(m.closeAt - m.listingAt)} after trading starts. Earlier predictions get up to ${(1 + m.earlyBirdK).toFixed(1)}× weight when the pool is split.</li>
        <li>Winners split the pool minus a ${m.feeBps / 100}% fee. Limit ${fmtPts(m.userCap)} per person.</li>
        <li>The market is cancelled and refunded if the listing is delayed more than 24 hours, trading halts for too long, there isn’t enough trading data, nobody picks the winning outcome, or everyone picks the same outcome.</li>
      </ol>
    </details>
    ${earlyRules(m)}

    ${
      m.scorecard
        ? `<section class="section panel">
            <div class="section-head"><span class="section-ico">${ico('info')}</span><h2>About ${esc(m.symbol)}</h2></div>
            <dl class="facts">
              ${m.scorecard.fdvUsd ? `<div><dt>Valuation at listing</dt><dd>$${fmtCompact(m.scorecard.fdvUsd)}</dd></div>` : ''}
              ${m.scorecard.circulatingPct !== undefined ? `<div><dt>Circulating supply</dt><dd>${m.scorecard.circulatingPct}%</dd></div>` : ''}
              ${m.scorecard.airdropPct !== undefined ? `<div><dt>Airdrop share</dt><dd>${m.scorecard.airdropPct}%</dd></div>` : ''}
              ${m.scorecard.unlocks ? `<div style="grid-column:1/-1"><dt>Unlocks</dt><dd>${esc(m.scorecard.unlocks)}</dd></div>` : ''}
            </dl>
          </section>`
        : ''
    }

    ${
      S.activity.length
        ? `<section class="section panel">
            <div class="section-head"><span class="section-ico">${ico('activity')}</span><h2>Recent predictions</h2></div>
            <ul class="activity feed">${S.activity
              .slice(0, 12)
              .map((a) => `<li>${avatar(a.username, 'avatar-sm')}<span class="feed-main">${userLink(a.username, 'who')} picked ${outcome(a.bucket, yn)}</span><span class="muted">${fmtPts(a.stake)} · ${fmtAgo(a.placedAt)}</span></li>`)
              .join('')}</ul>
          </section>`
        : ''
    }`;
}

/** Where to see the live price of a token on each exchange (spot, against USDT). */
const TRADE_URLS = {
  binance: (b) => `https://www.binance.com/en/trade/${b}_USDT?type=spot`,
  bybit: (b) => `https://www.bybit.com/en/trade/spot/${b}/USDT`,
  okx: (b) => `https://www.okx.com/trade-spot/${b.toLowerCase()}-usdt`,
  mexc: (b) => `https://www.mexc.com/exchange/${b}_USDT`,
  gate: (b) => `https://www.gate.io/trade/${b}_USDT`,
  bitget: (b) => `https://www.bitget.com/spot/${b}USDT`,
  kucoin: (b) => `https://www.kucoin.com/trade/${b}-USDT`,
  coingecko: (b, v) => `https://www.coingecko.com/en/coins/${encodeURIComponent(v.pair || b.toLowerCase())}`,
};

function priceLinks(m) {
  const links = (m.venues ?? []).filter((v) => TRADE_URLS[v.id]);
  if (!links.length || m.status === 'resolved' || m.status === 'void') return '';
  const base = encodeURIComponent(m.symbol.toUpperCase());
  return `<div class="price-links"><span class="muted">${ico('chart')}Check the live price:</span>${links
    .map((v) => `<a class="btn btn-sm" href="${TRADE_URLS[v.id](base, v)}" target="_blank" rel="noopener noreferrer">${esc(v.name)} ${ico('external')}</a>`)
    .join('')}</div>`;
}

function venueNames(m) {
  const names = (m.venues ?? []).map((v) => v.name);
  if (!names.length) return m.exchange;
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function fmtCompact(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

function fmtAgo(ts) {
  const ms = now() - ts;
  if (ms < 60_000) return 'just now';
  return `${fmtDur(ms).split(' ')[0]} ago`;
}

function manualPanel(m) {
  const r = m.result;
  if (!r || r.finalPrice == null) {
    const closed = m.phase === 'awaiting_result';
    if (!closed) return ''; // open markets: the facts line already says when they close and settle
    const step = (state, title, when) => `<li class="${state}"><span class="step-dot" aria-hidden="true"></span><b>${title}</b><span class="muted">${when}</span></li>`;
    return `
      <ol class="timeline" aria-label="Market timeline">
        ${step('done', 'Market opened', fmtDate(m.openedAt))}
        ${step(closed ? 'done' : 'now', closed ? 'Predictions closed' : 'Predictions close', fmtDate(m.closeAt))}
        ${step(closed ? 'now' : '', 'Result', `~ ${fmtDate(m.settleAt)}`)}
      </ol>`;
  }
  const b = r.winningBucket ?? 'flat';
  const yn = isYesNo(m);
  return `
    <div class="chart">
      <div class="chart-head">
        <div><div>Result</div><div class="muted">${yn ? `Target ${fmtPrice(r.basePrice)} · final ${fmtPrice(r.finalPrice)}` : `Start ${fmtPrice(r.basePrice)} → final ${fmtPrice(r.finalPrice)}`}</div></div>
        <div class="now" style="color:${oVar(b, yn)}">${yn ? (r.winningBucket ? oName(b, true) : '–') : fmtPct(r.returnPct)}</div>
      </div>
      ${myResultRow(m)}
    </div>
    ${
      r.winners?.length
        ? `<section class="section panel"><div class="section-head"><span class="section-ico">${ico('trophy')}</span><h2>Winners</h2></div><ul class="activity feed">${r.winners
            .map((w) => `<li>${avatar(w.username, 'avatar-sm')}<span class="feed-main">${userLink(w.username, 'who')} picked ${outcome(w.bucket, yn)}</span><span class="muted">${fmtPts(w.stake)} → <b class="profit-pos">${fmtPts(w.payout)}</b></span></li>`)
            .join('')}</ul></section>`
        : ''
    }`;
}

function manualRules(m) {
  if (isYesNo(m)) {
    return `
    ${m.note ? `<p class="m-note">${esc(m.note)}</p>` : ''}
    <ol class="rules">
      <li>Yes wins if the final price is at or above ${hasStart(m) ? fmtPrice(m.basePrice) : m.startAtClose ? `${esc(m.symbol)}’s price when predictions close (posted here then)` : `the opening price when ${esc(m.symbol)} starts trading (posted here once known)`}. No wins if it is below.</li>
      <li>Predictions close ${fmtDate(m.closeAt)}. Earlier predictions get up to ${(1 + m.earlyBirdK).toFixed(1)}× weight when the pool is split.</li>
      <li>After that the market counts down to its result on ${fmtDate(m.settleAt)}, when Firstprint posts the final price. The result and winners appear on this page.</li>
      <li>Winners split the pool minus a ${m.feeBps / 100}% fee. Limit ${fmtPts(m.userCap)} per person.</li>
      <li>The market is cancelled and refunded if nobody picks the winning answer, everyone picks the same answer, or Firstprint cancels it.</li>
    </ol>`;
  }
  return `
    ${m.note ? `<p class="m-note">${esc(m.note)}</p>` : ''}
    <ol class="rules">
      <li>${hasStart(m) ? `Start price: ${fmtPrice(m.basePrice)}${m.startAtClose ? ', the price when predictions closed' : ''}.` : m.startAtClose ? `Start price: ${esc(m.symbol)}’s price on ${esc(venueNames(m))} when predictions close. It is read automatically and posted here then, so a move while predictions are open doesn’t count.` : `Start price: the opening price when ${esc(m.symbol)} starts trading on ${esc(venueNames(m))}. Firstprint posts it here once trading opens.`} The result is the final price compared with it, using the ranges shown above.</li>
      <li>Predictions close ${fmtDate(m.closeAt)}. Earlier predictions get up to ${(1 + m.earlyBirdK).toFixed(1)}× weight when the pool is split.</li>
      <li>After that the market counts down to its result on ${fmtDate(m.settleAt)}, when Firstprint posts the final price. The result and winners appear on this page.</li>
      <li>Winners split the pool minus a ${m.feeBps / 100}% fee. Limit ${fmtPts(m.userCap)} per person.</li>
      <li>The market is cancelled and refunded if nobody picks the winning outcome, everyone picks the same outcome, or Firstprint cancels it.</li>
    </ol>`;
}

/**
 * The crowd's odds over time: each outcome's share of the pool after every prediction, as step
 * lines. Yes/No markets show the Yes line only, like a "% chance" chart.
 */
function oddsView(m) {
  const o = S.odds;
  if (!o || o.series.length < 2) return '';
  return `
    <section class="section panel odds">
      <div class="section-head"><span class="section-ico">${ico('dashboard')}</span><div><h2>Crowd odds over time</h2><p class="muted">Each outcome’s share of the pool after every prediction.</p></div></div>
      ${oddsPlot(m, o)}
    </section>`;
}

/** Legend, step lines and time axis for a market's odds history. */
function oddsPlot(m, o) {
  const yn = isYesNo(m);
  const lines = yn ? ['up'] : bucketsOf(m).filter((b) => o.series.some((p) => (p.shares[b] ?? 0) > 0));
  const t0 = o.series[0].t;
  // "Now" moves on in coarse steps (a 200th of the span, at least a minute), so the chart doesn't
  // change on every refresh: each change redraws the page.
  const step = Math.max(60_000, Math.floor((Math.max(m.closeAt, now()) - t0) / 200 / 60_000) * 60_000);
  const t1 = Math.max(o.series[o.series.length - 1].t, Math.min(Math.ceil(now() / step) * step, m.closeAt));
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * 100;
  const y = (v) => 100 - v * 100;
  const last = o.series[o.series.length - 1].shares;
  const path = (b) => {
    let d = '';
    o.series.forEach((p, i) => {
      const v = y(p.shares[b] ?? 0).toFixed(2);
      d += i ? `H${x(p.t).toFixed(2)}V${v}` : `M0,${v}`;
    });
    return `${d}H${x(t1).toFixed(2)}`;
  };
  const head = yn
    ? `<div class="odds-big" style="--c:var(--up)"><b>${Math.round((last.up ?? 0) * 100)}%</b> chance of Yes</div>`
    : `<div class="odds-legend">${lines.map((b) => `<span style="--c:var(--${b})"><i></i>${oName(b)} <b>${Math.round((last[b] ?? 0) * 100)}%</b></span>`).join('')}</div>`;
  return `
      ${head}
      <div class="odds-plot">
        <div class="odds-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${yn ? `Yes is at ${Math.round((last.up ?? 0) * 100)}%` : lines.map((b) => `${oName(b)} ${Math.round((last[b] ?? 0) * 100)}%`).join(', ')}">
          <line class="odds-grid" x1="0" x2="100" y1="50" y2="50" vector-effect="non-scaling-stroke" />
          ${yn ? `<path d="${path('up')}V100H0Z" fill="color-mix(in srgb, var(--up) 14%, transparent)" />` : ''}
          ${lines.map((b) => `<path class="odds-line" d="${path(b)}" stroke="${oVar(b, yn)}" vector-effect="non-scaling-stroke" />`).join('')}
        </svg>
      </div>
      <div class="odds-time muted"><span>${fmtDate(t0)}</span><span>${t1 >= now() - 60_000 ? 'Now' : fmtDate(t1)}</span></div>`;
}

/** The players with the most points on this market and what they picked. */
function holdersView(m) {
  const h = S.holders;
  if (!h || !h.holders.length) return '';
  const yn = isYesNo(m);
  return `
    <section class="section panel panel-flush">
      <div class="section-head"><span class="section-ico">${ico('users')}</span><h2>Top participants <span class="count-badge">${fmtNum(h.total)}</span></h2></div>
      <table class="table holders"><thead><tr><th>#</th><th>Player</th><th>Picked</th><th class="right">Points</th>${h.holders.some((x) => x.payout !== null) ? '<th class="right">Won</th>' : ''}</tr></thead><tbody>
        ${h.holders
          .slice(0, 10)
          .map(
            (x, i) => `<tr${x.username === S.me?.username ? ' class="me"' : ''}>
              <td><span class="rank${i < 3 ? ` medal-${i + 1}` : ''}">${i + 1}</span></td>
              <td><span class="who-cell">${avatar(x.username, 'avatar-sm')}${userLink(x.username)}</span></td>
              <td><span class="picks">${x.picks.map((p) => `${outcome(p.bucket, yn)}${x.picks.length > 1 ? ` <span class="muted">${fmtNum(p.stake)}</span>` : ''}`).join(' ')}</span></td>
              <td class="right num-cell">${fmtNum(x.total)}</td>
              ${x.payout !== null ? `<td class="right ${x.payout > 0 ? 'profit-pos' : 'muted'}">${x.payout > 0 ? `+${fmtNum(x.payout)}` : '–'}</td>` : ''}
            </tr>`,
          )
          .join('')}
      </tbody></table>
    </section>`;
}

function chartView(m) {
  if (m.phase === 'pre_listing' || !S.chart?.series?.length) {
    return `<div class="chart"><div class="chart-empty">${
      m.kind === 'live_test' ? 'The price chart appears when the market starts.' : `The price chart starts when ${esc(m.symbol)} begins trading on ${esc(m.exchange)}.`
    }</div></div>`;
  }
  const base = m.result?.basePrice ?? m.live?.basePrice ?? null;
  const r = m.result?.returnPct ?? m.live?.returnPct ?? null;
  const b = m.result?.winningBucket ?? m.live?.projectedBucket ?? 'flat';
  const series = S.chart.series;
  const prices = series.map((p) => p[1]).concat(base ? [base] : []);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const W = 600;
  const H = 180;
  const pad = 8;
  const t0 = series[0][0];
  const t1 = Math.max(series[series.length - 1][0], m.settleAt);
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * W;
  const y = (p) => H - pad - ((p - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const d = series.map(([t, p], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(p).toFixed(1)}`).join('');
  const last = series[series.length - 1];

  return `
    <div class="chart">
      <div class="chart-head">
        <div><div>${m.status === 'resolved' ? 'Final change from starting price' : 'Change from starting price'}</div><div class="muted">Dashed line: starting price ${fmtPrice(base)}</div></div>
        <div class="now" style="color:var(--${b})">${fmtPct(r)}</div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Price since listing, ${fmtPct(r)} from the starting price">
        ${base ? `<line x1="0" x2="${W}" y1="${y(base)}" y2="${y(base)}" stroke="var(--muted)" stroke-dasharray="4 5" vector-effect="non-scaling-stroke" />` : ''}
        <path d="${d}" fill="none" stroke="var(--${b})" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
        <circle cx="${x(last[0])}" cy="${y(last[1])}" r="3.5" fill="var(--${b})" />
      </svg>
    </div>`;
}

function mobileBar(m) {
  if (m.status !== 'open') return '';
  return `
    <div class="mobile-bar">
      <p>${m.phase === 'pre_listing' ? `${m.kind === 'live_test' ? 'Starts' : 'Lists'} in ${until(m.listingAt)}` : `${isUpcoming(m) ? 'Lists' : 'Closes'} in ${until(m.closeAt)}`}</p>
      <button class="cta" data-action="open-sheet">Make a prediction</button>
    </div>`;
}

// ------------------------------------------------------------------ Trade panel

function tradeMode(m) {
  if (m.status === 'open' && now() < m.closeAt) return 'open';
  if (m.status === 'resolved' || m.status === 'void') return 'settled';
  return 'closed';
}

function renderTrade() {
  const m = S.market;
  const el = $('#trade');
  if (!el) return;
  const mode = tradeMode(m);
  const key = `${m.id}|${mode}|${S.me ? S.me.id : ''}`;

  if (key !== S.tradeKey) {
    S.tradeKey = key;
    if (mode === 'open') {
      el.innerHTML = `
        <div class="trade-card" id="trade-card">
          <button class="sheet-close" data-action="close-sheet">Close</button>
          <h2>${ico('target')}Predict ${esc(m.symbol)}</h2>
          <div class="picker" role="radiogroup" aria-label="Outcome" id="picker"></div>
          <label class="field-label" for="stake">Stake</label>
          <div class="stake-input"><input id="stake" inputmode="numeric" autocomplete="off" value="${S.trade.stake}" aria-describedby="trade-fine" /><span>pts</span></div>
          <div class="chips">
            ${[25, 50, 100, 250].map((v) => `<button type="button" data-stake="${v}">${v}</button>`).join('')}
            <button type="button" data-stake="max">Max</button>
          </div>
          <dl class="summary" id="trade-summary"></dl>
          <button class="cta" id="trade-cta" data-action="predict"></button>
          <p class="form-error" id="trade-error" role="alert"></p>
          <p class="fine" id="trade-fine"></p>
          <div id="trade-positions"></div>
        </div>`;
    } else {
      el.innerHTML = `
        <div class="trade-card">
          <button class="sheet-close" data-action="close-sheet">Close</button>
          <div id="trade-closed"></div>
          <div id="trade-positions"></div>
        </div>`;
    }
  }

  if (mode === 'open') {
    const yn = isYesNo(m);
    $('#picker').classList.toggle('picker-yn', yn);
    $('#picker').innerHTML = bucketsOf(m).map(
      (b) =>
        `<button type="button" role="radio" aria-checked="${S.trade.bucket === b}" data-pick="${b}" style="--c:${oVar(b, yn)}"><span class="pick-ico">${icon(b, yn)}</span><b>${oName(b, yn)}</b>${m.pool ? `<small>${Math.round(share(m, b) * 100)}%</small>` : ''}</button>`,
    ).join('');
    updateSummary();
  } else if (mode === 'closed') {
    $('#trade-closed').innerHTML = `<h2>Predictions closed</h2><p class="muted">${isManual(m) ? 'Result expected in' : 'Result in'} ${until(m.settleAt)}.${
      m.live?.projectedBucket ? ` Right now the price is ${fmtPct(m.live.returnPct)}, which would settle in ${outcome(m.live.projectedBucket, isYesNo(m))}.` : ''
    }</p>`;
  } else {
    $('#trade-closed').innerHTML =
      m.status === 'resolved'
        ? `<h2>${isYesNo(m) ? `Resolved ${outcome(m.result.winningBucket, true)}` : `Settled in ${outcome(m.result.winningBucket)}`}</h2><p class="muted">Final price ${fmtPrice(m.result.finalPrice)}, ${fmtPct(m.result.returnPct)} from the starting price of ${fmtPrice(m.result.basePrice)}.</p>`
        : `<h2>Market cancelled</h2><p class="muted">Cancelled because ${VOID_REASONS[m.result?.voidReason] ?? 'of a data problem'}. Every prediction was refunded.</p>`;
  }
  $('#trade-positions').innerHTML = positionsView(m, mode);
}

function positionsView(m, mode) {
  if (!S.me) return mode === 'open' ? '' : '<p class="fine">Log in to track your predictions.</p>';
  if (!m.mine.length) return mode === 'open' ? '' : '<p class="fine">You didn’t predict on this market.</p>';
  const rows = m.mine
    .map((p) => {
      let state = 'Placed';
      if (m.status === 'locked') state = p.refund ? `${fmtPts(p.refund)} refunded by pool limit` : 'In play';
      if (m.status === 'resolved') state = p.payout > 0 ? `Won ${fmtPts(p.payout)}` : 'Didn’t win';
      if (m.status === 'void') state = `Refunded ${fmtPts(p.refund ?? p.stake)}`;
      const q = m.status === 'open' ? revertNow(m, p) : null;
      const back = q?.allowed ? ` <button class="icon-btn revert-btn" data-action="revert-open" data-id="${esc(p.id)}" aria-label="Take back this prediction" title="Take back">${ico('undo')}</button>` : '';
      return `<div class="position" style="--c:${oVar(p.bucket, isYesNo(m))}"><span><b>${oName(p.bucket, isYesNo(m))}</b> ${fmtPts(p.stake)}</span><span>${state}${back}</span></div>`;
    })
    .join('');
  return `<div style="margin-top:16px"><h3 style="font-size:16px;margin-bottom:4px">Your predictions</h3>${rows}</div>`;
}

function updateSummary() {
  const m = S.market;
  const card = $('#trade-card');
  if (!card) return;
  const b = S.trade.bucket;
  const stake = S.trade.stake;
  const yn = isYesNo(m);
  card.style.setProperty('--c', b ? oVar(b, yn) : 'var(--text)');

  const q = S.trade.quote;
  const summary = $('#trade-summary');
  if (!b) {
    summary.innerHTML = '<div><dt>Pick an outcome to see your estimated payout.</dt></div>';
  } else {
    summary.innerHTML = `
      <div class="big"><dt>If ${icon(b, yn)}${oName(b, yn)} wins</dt><dd>${q ? `about ${fmtPts(q.payout)}` : '…'}</dd></div>
      <div><dt>Return on stake</dt><dd>${q && stake ? `${q.multiple.toFixed(2)}×` : '–'}</dd></div>
      <div><dt>Early bonus</dt><dd>${q ? `${q.weight.toFixed(2)}×` : '–'}</dd></div>
      <div><dt>${yn ? 'Means' : 'Price range'}</dt><dd>${rangeOf(m, b)}</dd></div>`;
  }

  const cta = $('#trade-cta');
  if (!S.me) {
    cta.textContent = 'Log in to predict';
    cta.disabled = false;
  } else if (!b) {
    cta.textContent = 'Pick an outcome';
    cta.disabled = true;
  } else {
    cta.textContent = S.trade.busy ? 'Placing prediction' : `Predict ${oName(b, yn)} for ${fmtPts(stake || 0)}`;
    cta.disabled = S.trade.busy || !stake || stake < m.minStake;
  }

  $('#trade-fine').textContent = S.me
    ? `You have ${fmtPts(S.me.points)}. Limit ${fmtPts(m.userCap)} per market. Minimum ${m.minStake} pts.`
    : `Log in to get ${startPoints()}.`;
}

let quoteTimer;
function requestQuote() {
  clearTimeout(quoteTimer);
  const m = S.market;
  const b = S.trade.bucket;
  if (!b || !m) return updateSummary();
  const seq = ++S.trade.seq;
  quoteTimer = setTimeout(async () => {
    try {
      const q = await S.api.quote(m.id, b, S.trade.stake || 0);
      if (seq === S.trade.seq) {
        S.trade.quote = q;
        updateSummary();
      }
    } catch (err) {
      console.error(err);
    }
  }, 180);
  S.trade.quote = null;
  updateSummary();
}

function pickBucket(b) {
  if (!S.market || S.market.status !== 'open') return;
  S.trade.bucket = b;
  $('#trade-error') && ($('#trade-error').textContent = '');
  document.querySelectorAll('.rung').forEach((r) => r.setAttribute('aria-pressed', String(r.dataset.bucket === b)));
  renderTrade();
  requestQuote();
}

async function submitPrediction() {
  if (!S.me) return openAuth('connect');
  const m = S.market;
  const { bucket, stake } = S.trade;
  if (!bucket || S.trade.busy) return;
  S.trade.busy = true;
  updateSummary();
  try {
    const payout = S.trade.quote?.payout;
    await S.api.predict(m.id, bucket, stake);
    celebrate(isYesNo(m) && bucket === 'down' ? 'crash' : bucket);
    pickToast(m, bucket, stake, payout);
    $('#trade-error').textContent = '';
    closeSheet();
    await refreshMe();
    await loadMarket(m.id);
    renderMarket();
    requestQuote();
  } catch (err) {
    const el = $('#trade-error');
    if (el) el.textContent = err.message;
    if (err instanceof ApiError && err.status === 401) {
      S.me = null;
      renderTop();
      openAuth('connect');
    }
  } finally {
    S.trade.busy = false;
    if ($('#trade-card')) updateSummary();
  }
}

/** A short burst of confetti in the outcome's colour. Skipped for people who prefer less motion. */
function celebrate(bucket) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = $('#confetti');
  if (!root) return;
  const colors = [`var(--${bucket})`, `var(--${bucket})`, 'var(--warn)', 'var(--up)', 'var(--text)'];
  root.innerHTML = Array.from({ length: 48 }, (_, i) => {
    const x = (Math.random() * 2 - 1) * 46; // vw from the centre
    const rot = Math.round(Math.random() * 720 - 360);
    const delay = Math.round(Math.random() * 120);
    return `<i style="--x:${x.toFixed(1)}vw;--r:${rot}deg;--d:${delay}ms;--c:${colors[i % colors.length]}"></i>`;
  }).join('');
  clearTimeout(celebrate.timer);
  celebrate.timer = setTimeout(() => (root.innerHTML = ''), 1800);
}

/**
 * Coins fly from where points were earned (a button, a card) into the points balance in the top
 * bar. With `count`, the balance counts up as each coin lands; the last one makes it pulse, ring
 * and throw a few sparks, with "+N" under it. Resolves when the last coin lands. People who
 * prefer less motion just see the balance change.
 */
function collectPoints(from, amount = 0, to = '.chip.points', { count = false } = {}) {
  const find = () => (typeof to === 'string' ? $(to) || $('.chip.points') : to);
  const target = find();
  const start = from instanceof Element ? from.getBoundingClientRect() : from;
  const tickEl = () => find()?.querySelector('[data-tick]');
  const base = Number(tickEl()?.dataset.val);
  const counting = count && amount > 0 && Number.isFinite(base);
  const showTotal = (k) => {
    const el = tickEl();
    if (el) el.textContent = fmtNum(Math.round(base + amount * k));
  };
  const settle = () => {
    if (!counting) return;
    const el = tickEl();
    if (!el) return;
    el.textContent = fmtNum(base + amount);
    el.dataset.val = String(base + amount);
    TICKS.set(el.dataset.tick, base + amount); // the next render shows it without counting again
  };
  const bump = (cls) => {
    const el = find();
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };
  const land = () => {
    const el = find();
    if (!el) return;
    bump('pts-hit');
    if (REDUCED_MOTION.matches) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + Math.min(22, r.width / 2);
    const cy = r.top + r.height / 2;
    const fx = document.createElement('span');
    fx.className = 'pts-burst';
    fx.setAttribute('aria-hidden', 'true');
    fx.style.left = `${cx}px`;
    fx.style.top = `${cy}px`;
    fx.innerHTML =
      '<i class="pb-ring"></i>' +
      Array.from({ length: 10 }, (_, i) => {
        const a = (i / 10) * Math.PI * 2 + Math.random() * 0.4;
        const d = 22 + Math.random() * 18;
        return `<i class="pb-spark" style="--dx:${(Math.cos(a) * d).toFixed(1)}px;--dy:${(Math.sin(a) * d).toFixed(1)}px"></i>`;
      }).join('');
    document.body.appendChild(fx);
    setTimeout(() => fx.remove(), 900);
    if (amount) {
      const gain = document.createElement('span');
      gain.className = 'pts-gain';
      gain.setAttribute('aria-hidden', 'true');
      gain.innerHTML = `${ico('coins')}+${fmtNum(amount)}`;
      gain.style.left = `${r.left + r.width / 2}px`;
      gain.style.top = `${r.bottom + 6}px`;
      document.body.appendChild(gain);
      setTimeout(() => gain.remove(), 1500);
    }
    navigator.vibrate?.(12);
  };
  if (!target || !start || REDUCED_MOTION.matches) {
    settle();
    land();
    return Promise.resolve();
  }
  const sx = start.left + start.width / 2;
  const sy = start.top + start.height / 2;
  // A flash where the coins come from.
  const pop = document.createElement('span');
  pop.className = 'coin-pop';
  pop.setAttribute('aria-hidden', 'true');
  pop.style.left = `${sx}px`;
  pop.style.top = `${sy}px`;
  document.body.appendChild(pop);
  setTimeout(() => pop.remove(), 700);
  const coins = Math.max(8, Math.min(14, Math.round(Math.log10(Math.max(10, amount)) * 5)));
  return new Promise((resolve) => {
    let landed = 0;
    for (let i = 0; i < coins; i++) {
      const c = document.createElement('i');
      c.className = 'coin-fly';
      c.setAttribute('aria-hidden', 'true');
      document.body.appendChild(c);
      // Spray out from the button, then sweep along a curve into the balance, spinning like a coin.
      const end = (find() || target).getBoundingClientRect();
      const ex = end.left + Math.min(22, end.width / 2);
      const ey = end.top + end.height / 2;
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const burst = 50 + Math.random() * 60;
      const bx = sx + Math.cos(a) * burst;
      const by = sy + Math.sin(a) * burst;
      const kx = (bx + ex) / 2 + (Math.random() - 0.5) * 120; // control point of the sweep
      const ky = Math.min(by, ey) - 40 - Math.random() * 60;
      const spin = 540 + Math.round(Math.random() * 360);
      const size = 0.85 + Math.random() * 0.35;
      const frames = [{ transform: `translate(${sx}px, ${sy}px) scale(0.2) rotateY(0deg)`, opacity: 0, offset: 0 }];
      frames.push({ transform: `translate(${bx}px, ${by}px) scale(${size}) rotateY(${spin * 0.3}deg)`, opacity: 1, offset: 0.28 });
      for (let k = 1; k <= 6; k++) {
        const t = k / 6;
        const x = (1 - t) ** 2 * bx + 2 * (1 - t) * t * kx + t * t * ex;
        const y = (1 - t) ** 2 * by + 2 * (1 - t) * t * ky + t * t * ey;
        const sc = size * (1 - t * 0.5);
        frames.push({ transform: `translate(${x}px, ${y}px) scale(${sc}) rotateY(${spin * (0.3 + 0.7 * t)}deg)`, opacity: 1, offset: 0.28 + 0.72 * t });
      }
      const anim = c.animate(frames, { duration: 900, delay: i * 45, easing: 'cubic-bezier(0.45, 0, 0.25, 1)', fill: 'both' });
      anim.onfinish = () => {
        c.remove();
        landed++;
        if (counting) showTotal(landed / coins);
        if (landed < coins) return bump('pts-tick');
        settle();
        land();
        resolve();
      };
    }
  });
}

function openSheet() {
  const el = $('#trade');
  if (!el) return;
  S.sheetOpen = true;
  el.classList.add('open');
  if (!$('.sheet-backdrop')) {
    const bd = document.createElement('div');
    bd.className = 'sheet-backdrop';
    bd.dataset.action = 'close-sheet';
    document.body.appendChild(bd);
  }
  ($('#picker button') || el).focus?.();
}

function closeSheet() {
  S.sheetOpen = false;
  $('#trade')?.classList.remove('open');
  $('.sheet-backdrop')?.remove();
}

const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

// ------------------------------------------------------------------ Leaderboard & portfolio

const LB_PERIODS = [
  ['day', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['all', 'All time'],
];
const LB_LEDE = {
  day: 'Points won or lost on markets settled today (UTC).',
  week: 'Points won or lost on markets settled this week. The week starts every Monday at 00:00 UTC.',
  month: 'Points won or lost on markets settled this month (UTC).',
  all: 'Points won or lost on every market since Firstprint started.',
};

function leaderboardView(lb) {
  const medal = (rank) => (rank <= 3 ? ` medal-${rank}` : '');
  const rows = lb.entries
    .map(
      (e) => `
      <tr class="${e.isMe ? 'me' : ''}">
        <td><span class="rank${medal(e.rank)}">${e.rank}</span></td>
        <td><span class="who-cell">${avatar(e.name, 'avatar-sm')}<span>${userLink(e.name)}${e.isMe ? ' <span class="tag tag-you">You</span>' : ''}</span></span></td>
        <td class="right ${e.profit >= 0 ? 'profit-pos' : 'profit-neg'}">${e.profit >= 0 ? '+' : '−'}${fmtNum(Math.abs(e.profit))}</td>
        <td class="right hide-sm">${e.wins} of ${e.total}</td>
      </tr>`,
    )
    .join('');
  const top = lb.entries.slice(0, 3);
  const podium = top.length
    ? `<ol class="podium" aria-label="Top three">${top
        .map(
          (e) => `<li class="podium-${e.rank}${e.isMe ? ' me' : ''}">
            <span class="podium-medal">${ico(e.rank === 1 ? 'trophy' : 'award')}</span>
            ${avatar(e.name, 'avatar-lg')}
            <b>${userLink(e.name)}</b>
            <span class="podium-profit ${e.profit >= 0 ? 'profit-pos' : 'profit-neg'}">${e.profit >= 0 ? '+' : '−'}${fmtNum(Math.abs(e.profit))} pts</span>
            <span class="muted">#${e.rank} · ${e.wins} of ${e.total} correct</span>
          </li>`,
        )
        .join('')}</ol>`
    : '';
  return `
    <header class="page-head">
      <span class="page-ico">${ico('trophy')}</span>
      <div><h1 class="page-title">Leaderboard</h1>
      <p class="page-lede">${LB_LEDE[lb.period ?? 'week']}</p></div>
    </header>
    <div class="tabs lb-tabs" role="tablist" aria-label="Leaderboard period">${LB_PERIODS.map(([id, label]) => `<button role="tab" aria-selected="${(lb.period ?? 'week') === id}" data-lb-period="${id}">${label}</button>`).join('')}</div>
    ${
      lb.entries.length
        ? `${podium}<div class="panel panel-flush"><table class="table"><thead><tr><th>Rank</th><th>Participant</th><th class="right">Profit</th><th class="right hide-sm">Correct</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><div class="empty-art">${ico('trophy')}</div><p>No markets have settled ${{ day: 'today', week: 'this week', month: 'this month', all: '' }[lb.period ?? 'week'] || 'yet'}${lb.period === 'all' ? '' : ' yet'}.</p></div>`
    }
    ${S.me && !lb.me ? '<p class="fine">You’ll appear here after one of your predictions settles.</p>' : ''}`;
}

const PER_PAGE = 10;

/**
 * Page numbers under a long list, like a block explorer: ‹ 1 … 4 5 6 … 12 ›. `list` names which
 * list the buttons move; nothing shows for a single page.
 */
function pager(list, page, pages) {
  if (!pages || pages <= 1) return '';
  const show = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((n) => show.add(n));
  if (page >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach((n) => show.add(n));
  const nums = [...show].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const btn = (n, label, aria, off = false) =>
    `<button class="pg-btn${n === page && !aria ? ' on' : ''}" data-action="page" data-list="${list}" data-page="${n}"${off ? ' disabled' : ''}${n === page && !aria ? ' aria-current="page"' : ''} aria-label="${aria ?? `Page ${n}`}">${label}</button>`;
  let prev = 0;
  const parts = [];
  for (const n of nums) {
    if (n - prev > 1) parts.push('<span class="pg-gap" aria-hidden="true">…</span>');
    parts.push(btn(n, String(n)));
    prev = n;
  }
  return `<nav class="pager" aria-label="Pages">${btn(page - 1, ico('chevronLeft'), 'Previous page', page <= 1)}${parts.join('')}${btn(page + 1, ico('chevronRight'), 'Next page', page >= pages)}</nav>`;
}

/** The rows of one page of a list kept in the browser, and the pager for it. */
function pageOf(list, rows) {
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const page = Math.min(pages, Math.max(1, S.pg?.[list] ?? 1));
  return { rows: rows.slice((page - 1) * PER_PAGE, page * PER_PAGE), nav: pager(list, page, pages) };
}

/** Moves a dashboard list to another page: from memory for positions and history, from the server for the rest. */
async function goPage(list, page, btn) {
  S.pg ??= {};
  const [preds, history, stats, chain] = S.dashData ?? [];
  const card = btn?.closest('[data-list-card]');
  try {
    if (list === 'claims') {
      card?.classList.add('is-loading');
      S.claimsPage = await S.api.claims(page);
      S.claimsOpen = true;
      card?.replaceWith(htmlNode(claimsList(S.rewards)));
      document.querySelector('[data-list-card="claims"]')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (list === 'adm-act') {
      A.act = { ...(A.act ?? {}), page, all: true };
      return renderAdmin();
    }
    if (list.startsWith('adm-')) {
      S.pg[list] = page;
      return renderAdmin();
    }
    if (list.startsWith('profile-')) {
      S.pg[list] = page;
      if (S.profile) $('#view').innerHTML = profileView(S.profile);
      document.querySelector(`[data-pager-anchor="${list}"]`)?.scrollIntoView({ block: 'start' });
      return;
    }
    if (list === 'positions' || list === 'past') {
      S.pg[list] = page;
      const active = preds.filter((p) => p.marketStatus === 'open' || p.marketStatus === 'locked');
      const panel = document.getElementById(list === 'positions' ? 'dp-active' : 'dp-past');
      if (panel) panel.innerHTML = list === 'positions' ? activeTable(active) : pastTable(stats);
    } else if (list === 'chain') {
      card?.classList.add('is-loading');
      const data = await S.api.chain(page);
      S.pg.chain = data.page;
      S.dashData[3] = data;
      card?.replaceWith(htmlNode(chainCard(data)));
    } else if (list === 'ledger') {
      card?.classList.add('is-loading');
      const data = await S.api.ledger(page);
      S.pg.ledger = data.page;
      S.dashData[1] = data;
      card?.replaceWith(htmlNode(historyView(data)));
    }
  } catch (err) {
    card?.classList.remove('is-loading');
    return toast(err.message, true);
  }
  // Keep the list in view when it gets shorter on its last page.
  document.querySelector(`[data-list-card="${list}"]`)?.scrollIntoView({ block: 'nearest' });
}

const htmlNode = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

function portfolioView(preds, history = { entries: [] }, stats = null, chain = null) {
  if (!S.me) {
    return `
      <header class="page-head"><span class="page-ico">${ico('dashboard')}</span><div><h1 class="page-title">Your dashboard</h1></div></header>
      <div class="empty"><div class="empty-art">${ico('dashboard')}</div>
        <p><strong>Log in to see your dashboard.</strong><br />Your points, win rate and results live here. New accounts get ${startPoints()}.</p>
        <button class="btn btn-solid" data-action="connect">${ico('wallet')}Log in</button></div>`;
  }
  const active = preds.filter((p) => p.marketStatus === 'open' || p.marketStatus === 'locked');
  const past = stats?.history ?? [];
  // Open on the tab that has something in it; remember the choice while the page is open.
  const tab = S.dashTab ?? (active.length || !past.length ? 'active' : 'past');
  const method = S.me.wallets.length ? `Wallet ${esc(shortAddress(S.me.wallets[0].address))}` : S.me.hasEmail ? 'Signed in with email' : 'Signed in';

  return `
    <div class="dash">
      <header class="dash-head">
        ${avatar(S.me.username, 'avatar-lg')}
        <div class="dash-id">
          <span class="dash-eyebrow">Dashboard</span>
          <h1 class="dash-name">${esc(S.me.username)}</h1>
          <p class="dash-meta">${method}${S.me.xUsername ? ` <span aria-hidden="true">·</span> ${ico('x')}@${esc(S.me.xUsername)}` : ''}</p>
        </div>
        <div class="dash-actions">
          <a class="btn btn-sm" href="#/u/${encodeURIComponent(S.me.username)}">${ico('user')}Public profile</a>
          <a class="btn btn-sm" href="#/earn">${ico('gift')}Earn points</a>
          <button class="link-quiet" data-action="logout">${ico('logout')}Log out</button>
        </div>
      </header>
      ${startChecklist()}
      <div class="pf-top">${portfolioCard(stats, active)}${pnlCard(stats)}</div>
      ${statStrip(stats)}
      <div class="dash-layout">
        <section class="dash-card dash-main" aria-label="Your predictions">
          <div class="dash-tabs" role="tablist">
            <button role="tab" id="dt-active" aria-controls="dp-active" aria-selected="${tab === 'active'}" tabindex="${tab === 'active' ? 0 : -1}" data-dash-tab="active">Positions${positions(active).length ? `<span class="count">${positions(active).length}</span>` : ''}</button>
            <button role="tab" id="dt-past" aria-controls="dp-past" aria-selected="${tab === 'past'}" tabindex="${tab === 'past' ? 0 : -1}" data-dash-tab="past">History${past.length ? `<span class="count">${past.length}</span>` : ''}</button>
          </div>
          <div role="tabpanel" id="dp-active" aria-labelledby="dt-active"${tab === 'active' ? '' : ' hidden'}>${activeTable(active)}</div>
          <div role="tabpanel" id="dp-past" aria-labelledby="dt-past"${tab === 'past' ? '' : ' hidden'}>${pastTable(stats)}</div>
        </section>
        <aside class="dash-side">
          ${stats ? outcomeRecord(stats.byOutcome, 'Your picks by outcome', true) : ''}
          ${telegramCard()}
          ${walletsCard(chain)}
          ${chainCard(chain)}
          ${historyView(history)}
        </aside>
      </div>
    </div>`;
}

/** Switches the dashboard between active predictions and past markets without reloading. */
function showDashTab(tab, focus = false) {
  S.dashTab = tab;
  document.querySelectorAll('[data-dash-tab]').forEach((b) => {
    const on = b.dataset.dashTab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  for (const id of ['active', 'past']) {
    const panel = document.getElementById(`dp-${id}`);
    if (panel) panel.hidden = id !== tab;
  }
}

// Arrow keys move between the two dashboard tabs, as in any tab list.
document.addEventListener('keydown', (e) => {
  if (!e.target.matches?.('[data-dash-tab]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  showDashTab(e.target.dataset.dashTab === 'active' ? 'past' : 'active', true);
});

/** A small empty state: an icon, one sentence and at most one action. */
const dashEmpty = (icon, text, action = '') => `<div class="dash-empty"><span class="dash-empty-ico">${ico(icon)}</span><p>${text}</p>${action}</div>`;

/** Points to play with and points in open markets, as one balance (like a portfolio value). */
function portfolioCard(st, active) {
  const inPlay = st?.open?.staked ?? active.reduce((sum, p) => sum + p.stake - (p.refund ?? 0), 0);
  const total = S.me.points + inPlay;
  const share = total ? Math.round((S.me.points / total) * 100) : 100;
  return `
    <section class="pf-card" aria-label="Your points">
      <div class="pf-label">${ico('coins')}Portfolio</div>
      <div class="pf-value">${tick('me:points:dash', total)}<span class="unit">pts</span></div>
      <div class="pf-bar" role="img" aria-label="${share}% available, ${100 - share}% in play"><i style="width:${share}%"></i></div>
      <dl class="pf-split">
        <div><dt><i class="pf-key avail" aria-hidden="true"></i>Available</dt><dd>${fmtNum(S.me.points)}</dd></div>
        <div><dt><i class="pf-key play" aria-hidden="true"></i>In play</dt><dd>${fmtNum(inPlay)}</dd></div>
      </dl>
      <div class="pf-actions"><a class="btn btn-gold btn-sm" href="#/">${ico('target')}Predict</a><a class="btn btn-sm" href="#/earn">${ico('gift')}Earn points</a></div>
    </section>`;
}

const PNL_RANGES = [
  ['all', 'All', null],
  ['30d', '30D', 30],
  ['7d', '7D', 7],
];

/** Net points won over a chosen range, with its line. */
function pnlCard(st) {
  const range = PNL_RANGES.find(([id]) => id === S.pnlRange) ?? PNL_RANGES[0];
  const since = range[2] ? now() - range[2] * 86_400_000 : -Infinity;
  const rows = [...(st?.history ?? [])].filter((m) => m.settledAt >= since).reverse();
  let run = 0;
  const values = [0, ...rows.map((m) => (run += m.profit))];
  const net = run;
  const tabs = PNL_RANGES.map(([id, label]) => `<button data-pnl-range="${id}" aria-pressed="${id === range[0]}">${label}</button>`).join('');
  let chart = '<div class="pnl-flat" aria-hidden="true"></div>';
  if (values.length > 1) {
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const span = hi - lo || 1;
    const x = (i) => (i / (values.length - 1)) * 100;
    const y = (v) => 96 - ((v - lo) / span) * 92;
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
    const tone = net >= 0 ? 'up' : 'crash';
    chart = `<svg class="pnl-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="pnl-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--${tone})" stop-opacity="0.28" /><stop offset="1" stop-color="var(--${tone})" stop-opacity="0" /></linearGradient></defs>
        <path d="${d}L100,100L0,100Z" fill="url(#pnl-fill)" />
        <line x1="0" x2="100" y1="${y(0).toFixed(2)}" y2="${y(0).toFixed(2)}" class="pnl-zero" vector-effect="non-scaling-stroke" />
        <path d="${d}" class="pnl-line ${tone}" vector-effect="non-scaling-stroke" />
      </svg>`;
  }
  return `
    <section class="pf-card pnl-card" aria-label="Profit and loss">
      <div class="pf-label">${ico('chart')}Profit / loss<div class="pnl-range" role="group" aria-label="Range">${tabs}</div></div>
      <div class="pf-value ${rows.length ? (net >= 0 ? 'profit-pos' : 'profit-neg') : ''}">${rows.length ? signed(net) : '0'}<span class="unit">pts</span></div>
      <p class="pf-sub">${rows.length ? `${range[0] === 'all' ? 'All time' : `Last ${range[2]} days`} · ${rows.length} settled market${rows.length === 1 ? '' : 's'}` : st?.marketsPlayed ? 'Shows once a market you predicted on settles' : 'Predict on a market to start your record'}</p>
      ${chart}
    </section>`;
}

/** The record in one line of small numbers, like a token's stats on a screener. */
function statStrip(st) {
  const na = '<span class="sum-na">—</span>';
  const settled = Boolean(st?.settled);
  const item = (label, value, sub = '') => `<div><dt>${label}</dt><dd>${value}${sub ? `<small>${sub}</small>` : ''}</dd></div>`;
  return `
    <dl class="stat-strip" aria-label="Your record">
      ${item('Win rate', settled ? `${Math.round(st.winRate * 100)}%` : na, settled ? `${st.wins}/${st.settled}` : '')}
      ${item('Markets', fmtNum(st?.marketsPlayed ?? 0))}
      ${item('Staked', fmtNum(st?.totalStaked ?? 0))}
      ${item('Best win', st?.bestWin ? `<span class="profit-pos">${signed(st.bestWin.profit)}</span>` : na, st?.bestWin ? esc(st.bestWin.symbol) : '')}
      ${item('Win streak', settled ? fmtNum(st.currentStreak) : na, settled ? `best ${st.bestStreak}` : '')}
      ${item('Rank', st?.rank ? `#${fmtNum(st.rank)}` : na, st?.rank ? `of ${fmtNum(st.players)}` : '')}
    </dl>`;
}

/** Active predictions grouped into positions: one row per market and outcome. */
function positions(active) {
  const by = new Map();
  for (const p of active) {
    const key = `${p.marketId}:${p.bucket}`;
    const cur = by.get(key) ?? { ...p, stake: 0, count: 0 };
    cur.stake += p.stake - (p.refund ?? 0);
    cur.count += 1;
    by.set(key, cur);
  }
  return [...by.values()];
}

function activeTable(active) {
  if (!active.length) return dashEmpty('target', 'No open positions. Pick an outcome on any open market to start your record.', `<a class="btn btn-sm" href="#/">${ico('grid')}Explore markets</a>`);
  const markets = new Map([...S.lists.open, ...S.lists.live].map((m) => [m.id, m]));
  const pg = pageOf('positions', positions(active));
  return `<table class="table dash-table pos-table"><thead><tr><th>Market</th><th>Your pick</th><th class="right">Stake</th><th class="right hide-sm">Crowd</th><th class="right">If it<span class="hide-sm"> </span><br class="show-sm" />wins</th><th class="right hide-sm">Status</th></tr></thead><tbody>${pg.rows
    .map((p) => {
      const m = markets.get(p.marketId);
      const yn = p.outcomes === 'binary';
      const mult = m ? poolMultiple(m, p.bucket) : null;
      const crowd = m?.pool ? `${Math.round(share(m, p.bucket) * 100)}%` : '–';
      // On a phone the column is narrow: just the time left ("23h 55m"), not "Closes in 23h 55m".
      const when = m ? (p.marketStatus === 'open' ? `<span class="hide-sm">Closes in </span>${until(m.closeAt)}` : `Result ${fmtDate(m.settleAt)}`) : '';
      const status = p.marketStatus === 'open' ? '<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>Open</span>' : `<span class="pill pill-wait">${p.mode === 'manual' ? 'Awaiting result' : 'In play'}</span>`;
      return `<tr>
        <td><a class="mkt-cell" href="#/market/${encodeURIComponent(p.marketId)}">${m ? tokenAvatar(m, 'avatar-sm') : tokenAvatar(p, 'avatar-sm')}<span>${esc(p.symbol)}${when ? `<small class="muted">${when}</small>` : ''}</span></a></td>
        <td>${outcome(p.bucket, yn)}${p.count > 1 ? `<small class="muted pos-n">${p.count} picks</small>` : ''}</td>
        <td class="right num-cell">${fmtNum(p.stake)}</td>
        <td class="right num-cell hide-sm">${crowd}</td>
        <td class="right num-cell">${mult ? `<b class="profit-pos">≈${fmtNum(Math.floor(p.stake * mult))}</b><small class="muted pos-x">${mult.toFixed(1)}×</small>` : '–'}</td>
        <td class="right hide-sm">${status}</td>
      </tr>`;
    })
    .join('')}</tbody></table>${pg.nav}<p class="fine pos-note">“If it wins” is your stake at the pool’s current payout. Earlier picks get a bonus, so yours can be higher.</p>`;
}

function pastTable(st) {
  const rows = st?.history ?? [];
  const refunds = st?.refundedMarkets ? `<p class="fine">${st.refundedMarkets} cancelled market${st.refundedMarkets === 1 ? ' was' : 's were'} refunded and ${st.refundedMarkets === 1 ? 'doesn’t' : 'don’t'} count toward your record.</p>` : '';
  if (!rows.length) return dashEmpty('history', 'No settled markets yet. Your results appear here when markets you predicted on are settled.') + refunds;
  const pg = pageOf('past', rows);
  return `<table class="table dash-table"><thead><tr><th>Market</th><th>Your pick</th><th class="hide-sm">Result</th><th class="right">Staked</th><th class="right">Points</th></tr></thead><tbody>${pg.rows
    .map(
      (m) => `<tr>
        <td><a class="mkt-cell" href="#/market/${encodeURIComponent(m.marketId)}">${tokenAvatar(m, 'avatar-sm')}<span>${esc(m.symbol)}<small class="muted">${fmtAgo(m.settledAt)}</small></span></a></td>
        <td>${m.buckets.map((b) => outcome(b, m.binary)).join(' ')}</td>
        <td class="hide-sm">${m.winningBucket ? outcome(m.winningBucket, m.binary) : '–'}</td>
        <td class="right num-cell">${fmtNum(m.staked)}</td>
        <td class="right"><b class="${m.won ? 'profit-pos' : 'profit-neg'}">${signed(m.profit)}</b>${pnlButton(m.marketId, m.symbol, 'icon-btn pnl-mini', true)}</td>
      </tr>`,
    )
    .join('')}</tbody></table>${pg.nav}${refunds}`;
}

const CHAIN_KIND = { daily: 'Daily streak', claim: 'Rewards claim', stake: 'Prediction', payout: 'Winnings', refund: 'Refund' };

/** Every TestFPT transaction made for the player, newest first, each with its explorer link. */
function chainCard(c) {
  if (!c?.onChain || (!c.activity.length && !c.wallet)) return '';
  const state = { confirmed: '', queued: 'sending…', submitted: 'confirming…', pending: 'waiting for your wallet', failed: 'failed', expired: 'expired' };
  return `
    <section class="dash-card" data-list-card="chain">
      <div class="dash-card-head"><h2>${ico('token')}On-chain activity</h2>${c.total ?? c.activity.length ? `<span class="count">${fmtNum(c.total ?? c.activity.length)}</span>` : ''}</div>
      ${
        c.activity.length
          ? `<ul class="chain-list">${c.activity
              .map(
                (a) => `<li><span><b class="${a.amount < 0 ? '' : 'profit-pos'}">${a.amount < 0 ? '−' : '+'}${fmtNum(Math.abs(a.amount))} TestFPT</b><small class="muted">${esc(CHAIN_KIND[a.kind] ?? a.kind)}${a.symbol ? ` · <a href="#/market/${encodeURIComponent(a.marketId)}">${esc(a.symbol)}</a>` : ''} · ${fmtAgo(a.at)}${state[a.status] ? ` · ${state[a.status]}` : ''}</small></span>${a.explorerUrl ? `<a class="dw-link" href="${esc(a.explorerUrl)}" target="_blank" rel="noopener noreferrer">Explorer ${ico('external')}</a>` : ''}</li>`,
              )
              .join('')}</ul>${pager('chain', c.page, c.pages)}`
          : '<p class="dash-card-text">Your daily streak, rewards, predictions and winnings move as TestFPT on chain, and each one shows up here.</p>'
      }
    </section>`;
}

function walletsCard(chain = null) {
  const ws = S.me.wallets;
  return `
    <section class="dash-card">
      <div class="dash-card-head"><h2>${ico('wallet')}Wallets</h2>${ws.length ? `<span class="count">${ws.length}</span>` : ''}</div>
      ${
        ws.length
          ? `<ul class="dash-wallets">${ws
              .map(
                (w) => {
                  const own = chain?.wallet === w.address;
                  const link = own && chain.walletUrl
                    ? `<a class="dw-link" href="${esc(chain.walletUrl)}" target="_blank" rel="noopener noreferrer" aria-label="View your Firstprint wallet on Solana Explorer">Explorer ${ico('external')}</a>`
                    : `<a class="dw-link" href="https://solscan.io/account/${encodeURIComponent(w.address)}" target="_blank" rel="noopener noreferrer" aria-label="View ${esc(shortAddress(w.address))} on Solscan">Solscan ${ico('external')}</a>`;
                  return `<li>${own ? `<span class="wallet-logo fp-wallet" aria-hidden="true">${ico('shield')}</span>` : WALLET_LOGOS[w.walletName] ? `<img class="wallet-logo" src="${WALLET_LOGOS[w.walletName]}" alt="" width="20" height="20" />` : ''}<span class="dw-main"><span class="addr" title="${esc(w.address)}">${esc(shortAddress(w.address))}</span><span class="muted">${own ? 'Firstprint wallet · made for you' : esc(w.walletName || 'Solana wallet')}</span></span>
                  <button class="dw-link" data-action="copy-text" data-text="${esc(w.address)}" aria-label="Copy address">${ico('copy')}</button>${link}</li>`;
                },
              )
              .join('')}</ul>`
          : '<p class="dash-card-text">No wallet linked. Link one to sign in with it and to claim TestFPT.</p>'
      }
      <button class="btn btn-sm dash-card-btn" data-action="link-wallet">${ico('plus')}Link ${ws.length ? 'another' : 'a Solana'} wallet</button>
    </section>`;
}

/** A player's public page: their record, what they're in now, and their past markets. */
function profileView(p) {
  const st = p.stats;
  const tile = (icon, color, label, value, sub) =>
    `<div class="stat-tile" style="--c:var(--${color})"><span class="tile-ico">${ico(icon)}</span><dt>${label}</dt><dd>${value}</dd><p>${sub}</p></div>`;
  const pct = st.winRate === null ? null : Math.round(st.winRate * 100);
  const inPlay = pageOf('profile-positions', p.positions);
  const positions = p.positions.length
    ? `<table class="table"><thead><tr><th>Market</th><th>Pick</th><th class="right">Points</th><th class="right">Status</th></tr></thead><tbody>${inPlay.rows
        .map(
          (x) => `<tr><td><a class="mkt-cell" href="#/market/${encodeURIComponent(x.marketId)}">${tokenAvatar(x, 'avatar-sm')}<span>${esc(x.symbol)}</span></a></td><td>${outcome(x.bucket, x.outcomes === 'binary')}</td><td class="right num-cell">${fmtNum(x.stake)}</td><td class="right">${
            x.marketStatus === 'open' ? '<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>Open</span>' : '<span class="pill pill-wait">Awaiting result</span>'
          }</td></tr>`,
        )
        .join('')}</tbody></table>${inPlay.nav}`
    : '<p class="muted pad">Not in any open market right now.</p>';
  return `
    <section class="profile-card">
      ${avatar(p.username, 'avatar-xl')}
      <div class="profile-main">
        <span class="eyebrow">Player</span>
        <h1 class="page-title">${esc(p.username)}</h1>
        <p class="muted">${ico('calendar')}Joined ${new Date(p.joinedAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}${st.rank ? ` · ${ico('award')}#${st.rank} of ${fmtNum(st.players)} all time` : ''}</p>
      </div>
      <div class="profile-actions">
        ${p.isMe ? `<a class="btn" href="#/portfolio">${ico('dashboard')}Your dashboard</a>` : ''}
        ${p.isMe && telegramUrl() ? `<a class="btn tg-join" href="${telegramUrl()}" target="_blank" rel="noopener noreferrer">${ico('telegram')}Telegram alerts</a>` : ''}
        <button class="btn" data-action="copy-text" data-text="${esc(location.href.split('#')[0])}#/u/${encodeURIComponent(p.username)}">${ico('share')}Copy link</button>
      </div>
    </section>
    <dl class="stat-tiles">
      ${tile('percent', 'up', 'Win rate', pct === null ? '–' : `${pct}%`, st.settled ? `${st.wins} of ${st.settled} market${st.settled === 1 ? '' : 's'} won` : 'No settled markets yet')}
      ${tile('trendUp', st.netProfit >= 0 ? 'up' : 'crash', 'Points won', `<span class="${st.netProfit >= 0 ? 'profit-pos' : 'profit-neg'}">${signed(st.netProfit)}</span>`, `${fmtNum(st.totalWon)} paid out from ${fmtNum(st.totalStaked)} staked`)}
      ${tile('star', 'warn', 'Best win', st.bestWin ? `<span class="profit-pos">${signed(st.bestWin.profit)}</span>` : '–', st.bestWin ? `on <a href="#/market/${encodeURIComponent(st.bestWin.marketId)}">${esc(st.bestWin.symbol)}</a>` : 'No wins yet')}
      ${tile('flame', 'down', 'Streak', `${st.currentStreak}`, `wins in a row · best ${st.bestStreak}`)}
      ${tile('target', 'brand', 'Markets played', fmtNum(st.marketsPlayed), `${fmtNum(st.open.markets)} still open`)}
      ${tile('flame', 'crash', 'Points burned', fmtNum(st.burned ?? 0), st.burned ? 'gone for good, from taking picks back' : 'Nothing burned yet')}
      ${tile('gift', 'up', 'Early rewards', `<span class="${st.earlyRewards ? 'profit-pos' : ''}">${st.earlyRewards ? signed(st.earlyRewards) : '0'}</span>`, st.earlyRewards ? 'earned by predicting early and staying in' : 'Predict early and stay in to earn them')}
    </dl>
    ${st.history.length >= 2 ? `<div class="dash-grid">${profitChart(st.history)}${outcomeRecord(st.byOutcome, p.isMe ? undefined : 'Picks by outcome')}</div>` : ''}
    <section class="section panel panel-flush">
      <div class="section-head" data-pager-anchor="profile-positions"><span class="section-ico">${ico('target')}</span><h2>In play${p.positions.length ? ` <span class="count-badge">${p.positions.length}</span>` : ''}</h2></div>
      ${positions}
    </section>
    ${pastMarkets(st, p.isMe)}`;
}

const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtNum(Math.abs(n))}`;

/** The headline numbers. Each tile is one fact with a short line of context. */
function statTiles(st) {
  const tile = (icon, color, label, value, sub, extra = '') =>
    `<div class="stat-tile" style="--c:var(--${color})"><span class="tile-ico">${ico(icon)}</span><dt>${label}</dt><dd>${value}</dd><p>${sub}</p>${extra}</div>`;
  const points = tile(
    'coins',
    'warn',
    'Points',
    fmtNum(S.me.points),
    st?.open.staked ? `${fmtNum(st.open.staked)} more in play` : 'Available to predict with',
    S.me.canClaimDaily ? `<button class="btn btn-solid tile-btn" data-action="claim">${ico('gift')}Claim ${dailyNext()}</button>` : '',
  );
  if (!st || !st.settled) {
    return `<dl class="stat-tiles">${points}${tile('percent', 'up', 'Win rate', '–', st?.marketsPlayed ? 'Shows up once your first market settles' : 'Make your first prediction to start your record')}</dl>`;
  }
  const pct = Math.round(st.winRate * 100);
  return `<dl class="stat-tiles">
    ${points}
    ${tile('percent', 'up', 'Win rate', `${pct}%`, `${st.wins} of ${st.settled} market${st.settled === 1 ? '' : 's'} won`, `<div class="meter" role="img" aria-label="${pct}% of markets won"><i style="width:${pct}%"></i></div>`)}
    ${tile('trendUp', st.netProfit >= 0 ? 'up' : 'crash', 'Points won', `<span class="${st.netProfit >= 0 ? 'profit-pos' : 'profit-neg'}">${signed(st.netProfit)}</span>`, `${fmtNum(st.totalWon)} paid out from ${fmtNum(st.totalStaked)} staked`)}
    ${tile('star', 'warn', 'Best win', st.bestWin ? `<span class="profit-pos">${signed(st.bestWin.profit)}</span>` : '–', st.bestWin ? `on <a href="#/market/${encodeURIComponent(st.bestWin.marketId)}">${esc(st.bestWin.symbol)}</a>` : 'Your first win shows up here')}
    ${tile('flame', 'down', 'Streak', `${st.currentStreak}`, `wins in a row · best ${st.bestStreak}`)}
    ${tile('award', 'brand', 'Rank', st.rank ? `#${st.rank}` : '–', st.rank ? `of ${fmtNum(st.players)} players, all time` : 'After your first settled market')}
  </dl>`;
}

/** Running total of points won or lost across settled markets, oldest to newest. */
function profitChart(history) {
  const pts = [...history].reverse();
  if (pts.length < 2) return '';
  const values = [0, ...pts.map((m) => m.cumulative)];
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const x = (i) => (i / (values.length - 1)) * 100;
  const y = (v) => 100 - ((v - lo) / span) * 100;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
  const last = values[values.length - 1];
  const data = pts.map((m, i) => ({ x: x(i + 1), y: y(m.cumulative), symbol: m.symbol, profit: m.profit, total: m.cumulative, at: m.settledAt }));
  return `
    <section class="section panel">
      <div class="section-head"><span class="section-ico">${ico('dashboard')}</span><h2>Points won over time</h2></div>
      <div class="pchart" data-points='${esc(JSON.stringify(data))}'>
        <div class="pchart-axis"><span>${signed(hi)}</span><span>${signed(lo)}</span></div>
        <div class="pchart-plot">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="pchart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--${last >= 0 ? 'up' : 'crash'})" stop-opacity="0.32" /><stop offset="1" stop-color="var(--${last >= 0 ? 'up' : 'crash'})" stop-opacity="0" /></linearGradient></defs>
            <path d="${d}L100,${y(lo).toFixed(2)}L0,${y(lo).toFixed(2)}Z" fill="url(#pchart-fill)" />
            <line class="pchart-zero" x1="0" x2="100" y1="${y(0).toFixed(2)}" y2="${y(0).toFixed(2)}" vector-effect="non-scaling-stroke" />
            <path class="pchart-line ${last >= 0 ? 'up' : 'down'}" d="${d}" vector-effect="non-scaling-stroke" />
          </svg>
          <span class="pchart-dot" hidden></span>
          <div class="pchart-tip" role="status" hidden></div>
        </div>
      </div>
      <p class="fine">Net points after each settled market (${pts.length} markets). Past markets lists every one.</p>
    </section>`;
}

/** How each outcome has done when you picked it. */
function outcomeRecord(byOutcome, title = 'Your picks by outcome', card = false) {
  const rows = LADDER.filter((b) => byOutcome[b].picks);
  if (!rows.length) return '';
  // In the dashboard's side column it's a card like its neighbours; on profiles a full panel.
  const head = card
    ? `<section class="dash-card"><div class="dash-card-head"><h2>${ico('target')}${title}</h2></div>`
    : `<section class="section panel"><div class="section-head"><span class="section-ico">${ico('target')}</span><h2>${title}</h2></div>`;
  return `
    ${head}
      <ul class="orec">${rows
        .map((b) => {
          const { picks, wins } = byOutcome[b];
          const pct = Math.round((wins / picks) * 100);
          return `<li style="--c:var(--${b})"><span class="orec-name">${outcome(b)}</span><span class="orec-bar" role="img" aria-label="${wins} of ${picks} won"><i style="width:${pct}%"></i></span><span class="orec-num">${wins} of ${picks} won</span></li>`;
        })
        .join('')}</ul>
    </section>`;
}

/** Every settled market, one row each, newest first. */
function pastMarkets(st, mine = false) {
  const rows = st.history;
  const pg = pageOf('profile-past', rows);
  return `
    <section class="section panel panel-flush">
      <div class="section-head" data-pager-anchor="profile-past"><span class="section-ico">${ico('history')}</span><h2>Past markets${rows.length ? ` <span class="count-badge">${rows.length}</span>` : ''}</h2></div>
      ${
        rows.length
          ? `<table class="table"><thead><tr><th>Market</th><th>Your pick</th><th class="hide-sm">Result</th><th class="right">Staked</th><th class="right">Points</th></tr></thead><tbody>${pg.rows
              .map(
                (m) => `<tr>
                  <td><a class="mkt-cell" href="#/market/${encodeURIComponent(m.marketId)}">${tokenAvatar(m, 'avatar-sm')}<span>${esc(m.symbol)}</span></a> <span class="muted hide-sm">${fmtAgo(m.settledAt)}</span></td>
                  <td>${m.buckets.map((b) => outcome(b, m.binary)).join(' ')}</td>
                  <td class="hide-sm">${m.winningBucket ? outcome(m.winningBucket, m.binary) : '–'}</td>
                  <td class="right">${fmtNum(m.staked)}</td>
                  <td class="right"><b class="${m.won ? 'profit-pos' : 'profit-neg'}">${signed(m.profit)}</b>${mine ? pnlButton(m.marketId, m.symbol, 'icon-btn pnl-mini', true) : ''}</td>
                </tr>`,
              )
              .join('')}</tbody></table>${pg.nav}`
          : '<p class="muted pad">Your results appear here after markets settle.</p>'
      }
      ${st.refundedMarkets ? `<p class="fine">${st.refundedMarkets} cancelled market${st.refundedMarkets === 1 ? ' was' : 's were'} refunded and ${st.refundedMarkets === 1 ? 'doesn’t' : 'don’t'} count toward your record.</p>` : ''}
    </section>`;
}

/** Crosshair and tooltip for the points chart: the nearest market to the pointer. */
function chartHover(e) {
  const chart = e.target.closest?.('.pchart');
  if (!chart) return;
  const plot = chart.querySelector('.pchart-plot');
  const dot = chart.querySelector('.pchart-dot');
  const tip = chart.querySelector('.pchart-tip');
  if (e.type === 'pointerleave') {
    if (e.target === chart) dot.hidden = tip.hidden = true;
    return;
  }
  const data = JSON.parse(chart.dataset.points);
  const r = plot.getBoundingClientRect();
  const fx = ((e.clientX - r.left) / r.width) * 100;
  const p = data.reduce((best, d) => (Math.abs(d.x - fx) < Math.abs(best.x - fx) ? d : best), data[0]);
  dot.style.left = tip.style.left = `${p.x}%`;
  dot.style.top = tip.style.top = `${p.y}%`;
  tip.classList.toggle('flip', p.x > 70);
  tip.classList.toggle('low', p.y > 60);
  tip.innerHTML = `<b>${esc(p.symbol)}</b> ${signed(p.profit)}<br /><span class="muted">Total ${signed(p.total)} · ${fmtAgo(p.at)}</span>`;
  dot.hidden = tip.hidden = false;
}
document.addEventListener('pointermove', chartHover);
document.addEventListener('pointerleave', chartHover, true);

const HISTORY_LABELS = {
  signup: () => 'Welcome bonus',
  welcome: () => 'Welcome TestFPT',
  x_connect: () => 'Linked your X account',
  task: () => 'Task completed',
  referral: () => 'Friend joined with your link',
  claim: () => 'TestFPT claimed to your wallet',
  daily: () => 'Daily claim',
  admin_topup: () => 'Admin test points',
  stake: (e) => `Prediction${e.symbol ? ` on ${e.symbol}` : ''}`,
  refund: (e) => `Refund${e.symbol ? ` from ${e.symbol}` : ''}`,
  payout: (e) => `Won${e.symbol ? ` on ${e.symbol}` : ''}`,
  revert: (e) => `Took back a prediction${e.symbol ? ` on ${e.symbol}` : ''}`,
  early_reward: (e) => `Early player reward${e.symbol ? ` on ${e.symbol}` : ''}`,
};

/** Every change to the balance, so points never seem to appear or vanish. */
function historyView(h) {
  const entries = Array.isArray(h) ? h : (h?.entries ?? []);
  return `
    <section class="dash-card" data-list-card="ledger">
      <div class="dash-card-head"><h2>${ico('coins')}Points history</h2>${h?.total ? `<span class="count">${fmtNum(h.total)}</span>` : ''}</div>
      ${
        entries.length
          ? `<ul class="dash-ledger">${entries
              .map((e) => {
                const label = (HISTORY_LABELS[e.reason] ?? (() => e.reason))(e);
                const name = e.marketId ? `<a href="#/market/${encodeURIComponent(e.marketId)}">${esc(label)}</a>` : esc(label);
                return `<li><span class="dl-main">${name}<small>${fmtAgo(e.at)}</small></span><b class="${e.delta >= 0 ? 'profit-pos' : 'dl-neg'}">${e.delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(e.delta))}</b></li>`;
              })
              .join('')}</ul>${pager('ledger', h?.page, h?.pages)}`
          : '<p class="dash-card-text">Every change to your balance will be listed here.</p>'
      }
    </section>`;
}

// ------------------------------------------------------------------ Earn: tasks, referrals, TestFPT

const rewardsCluster = () => S.rewards?.cluster || S.cfg?.rewards?.cluster || 'testnet';
const clusterName = () => (rewardsCluster() === 'devnet' ? 'Devnet' : 'Testnet');
const TASK_ICONS = { follow: 'userPlus', repost: 'repeat', like: 'heart', share: 'megaphone', link: 'link', telegram: 'telegram' };

/** The getting-started steps, with what's already done ticked. */
function startSteps() {
  const r = S.rewards;
  const hasWallet = Boolean(S.me?.wallets?.length);
  const step = (done, title, body, action = '') =>
    `<li class="${done ? 'done' : ''}"><span class="step-check" aria-hidden="true">${done ? ico('check') : ''}</span><div><b>${title}</b><span class="muted">${body}</span>${done ? '' : action}</div></li>`;
  return `
    <ol class="steplist">
      ${step(hasWallet, 'Link a Solana wallet', 'Phantom, Solflare or Backpack. Your TestFPT goes here.', '<button class="btn" data-action="link-wallet">Link wallet</button>')}
      ${step(Boolean(r?.welcomeClaimed), 'Claim your 1,000 TestFPT', 'They land in your wallet and in your Firstprint balance.', '<a class="btn btn-solid" href="#/earn" data-action="close-modal">Go to claim</a>')}
      ${step(false, 'Pick a market and predict', 'Choose Crash, Down, Flat, Up or Moon and stake your points.', '<a class="btn" href="#/" data-action="close-modal">See markets</a>')}
    </ol>
    <p class="fine">Earn more any time on the Earn page: link X, complete tasks and invite friends.</p>`;
}

/** A card at the top of the main pages until the player has claimed their starting points. */
/** localStorage that never throws (private windows, blocked storage). */
const readPref = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writePref = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
};
const testnetLive = () => Boolean(S.rewards?.onChain ?? S.cfg?.rewards?.onChain);

/** "Testnet is live": what TestFPT is, and the player's next step (sign in, link a wallet, claim). */
function startChecklist() {
  if (!testnetLive() || (S.me && (!S.rewards || S.rewards.welcomeClaimed))) return '';
  if (!S.me && readPref('fp:testnet-hide')) return '';
  const signedIn = Boolean(S.me);
  const wallet = Boolean(S.me?.wallets?.length);
  const steps = [
    ['Sign in', 'Google, email or wallet', signedIn],
    ['Link a wallet', 'Phantom, Solflare or Backpack', wallet],
    ['Claim TestFPT', 'Free: Firstprint pays the fee', false],
  ];
  const done = steps.filter((x) => x[2]).length;
  const cta = !signedIn
    ? `<button class="btn btn-gold" data-action="connect">Sign in to claim ${ico('arrowRight')}</button>`
    : !wallet
    ? `<button class="btn btn-gold" data-action="start-guide">Link a wallet ${ico('arrowRight')}</button>`
    : `<a class="btn btn-gold" href="#/earn">Claim 1,000 TestFPT ${ico('arrowRight')}</a>`;
  // One slim line under the hero: seen, but it doesn't push the markets down.
  return `
    <section class="tn-strip" aria-label="Testnet">
      <span class="tn-strip-coin" aria-hidden="true">${ico('token')}</span>
      <p><span class="tn-strip-live"><span class="dot-live" aria-hidden="true"></span>Testnet is live</span><b>Claim 1,000 free TestFPT</b><span class="muted tn-strip-sub"> on Solana ${clusterName()} · free, no real money${signedIn ? ` · step ${Math.min(done + 1, steps.length)} of ${steps.length}` : ''}</span></p>
      ${cta.replace('class="btn btn-gold"', 'class="btn btn-gold btn-sm"')}
      ${signedIn ? '' : `<button class="tn-close" data-action="testnet-hide" aria-label="Hide this">${ico('cross')}</button>`}
    </section>`;
}

function earnView() {
  if (!S.me) {
    return `
      <header class="page-head"><span class="page-ico">${ico('gift')}</span><div><h1 class="page-title">Earn points</h1></div></header>
      <div class="empty"><div class="empty-art">${ico('gift')}</div>
        <p><strong>Log in to earn points.</strong><br />Claim free points every day (50 on day 1, up to 200 a day with a streak), complete tasks on X, invite friends and claim your points.</p>
        <button class="btn btn-solid" data-action="connect">${ico('wallet')}Log in</button></div>`;
  }
  const r = S.rewards;
  if (!r) return '<h1 class="page-title">Earn points</h1><div class="empty"><p>Rewards aren’t available right now.</p></div>';
  return `
    <div class="earn2">
      <header class="earn2-head">
        <span class="eyebrow">Rewards</span>
        <h1 class="page-title">Earn points</h1>
        <p class="page-lede">${r.onChain ? (r.autoSend || r.firstprintWallet ? `Rewards are sent to your wallet as <b>TestFPT</b> on Solana ${clusterName()} by themselves, and go into your Firstprint balance too.` : `Rewards arrive as <b>TestFPT</b> on Solana ${clusterName()} when you claim them, and go into your Firstprint balance too.`) : 'Complete tasks and invite friends. Points go straight to your balance.'}</p>
      </header>
      <div class="earn2-grid">
        <div class="earn2-main">
          ${tasksCard(r)}
          ${r.onChain ? claimsList(r) : ''}
        </div>
        <aside class="earn2-side">
          ${streakCard(true)}
          ${referralCard(r)}
        </aside>
      </div>
    </div>`;
}

function referralCard(r) {
  const f = r.referral;
  const shareText = encodeURIComponent('I’m calling crypto prices on Firstprint. Join me and get free points:');
  return `
    <section class="earn-card">
      <div class="card-head"><span class="card-ico">${ico('userPlus')}</span><h2>Invite friends</h2><span class="pill pill-pts">+${f.perReferral} each</span></div>
      <p class="muted">You get <b>+${f.perReferral} points</b> when a friend signs up with your link and predicts on ${f.markets ?? 3} different markets (up to ${f.limit} friends).</p>
      <div class="copy-row"><input readonly value="${esc(f.link)}" aria-label="Your invite link" /><button class="btn" data-action="copy-text" data-text="${esc(f.link)}">${ico('copy')}Copy</button></div>
      <a class="btn" href="https://x.com/intent/tweet?text=${shareText}&url=${encodeURIComponent(f.link)}" target="_blank" rel="noopener noreferrer">${ico('x')}Share on X</a>
      <div class="ref-stats"><span><b>${fmtNum(f.invited)}</b> signed up</span><span><b>${fmtNum(f.rewarded)}</b> rewarded</span><span><b class="profit-pos">${signed(f.points)}</b> points</span></div>
    </section>`;
}

/** While the player waits after too many checks on X: a disabled button counting down to the next try. */
const xWait = (r) => (r.xCooldownUntil && r.xCooldownUntil > now() ? `<button class="btn" disabled>${ico('clock')}Try again in ${until(r.xCooldownUntil)}</button>` : '');

/** True once the player's X account counts for tasks (proven with a code when X checks are on). */
const xConnected = (r) => Boolean(r.xUsername && (!r.xChecks || r.xVerified));

/**
 * Connecting X, shown inside a task that needs it (or under the list to change account): the
 * username, then with X checks on the code to put in the bio and Verify. Only what the step needs.
 */
function xConnectPanel(r) {
  const form = (label, value = '') =>
    `<form id="x-form" class="inline-form" novalidate><span class="input-wrap"><span class="input-prefix">@</span><input name="x" placeholder="yourname" maxlength="16" autocomplete="off" aria-label="Your X username" value="${esc(value)}" /></span><button class="btn btn-solid" type="submit">${r.xChecks ? 'Next' : 'Connect'}</button></form>
     <p class="form-error" id="x-error" role="alert"></p>`;
  if (r.xChecks && r.xPending) {
    const p = r.xPending;
    const postText = encodeURIComponent(`Verifying my Firstprint account: ${p.code}`);
    return `<div class="x-connect">
      <p class="muted">Add this code to your X bio (or post it), then press Verify. You can remove it after.</p>
      <div class="x-code"><code>${esc(p.code)}</code><button class="btn btn-sm" data-action="copy-text" data-text="${esc(p.code)}">${ico('copy')}Copy</button><a class="btn btn-sm" href="https://x.com/intent/tweet?text=${postText}" target="_blank" rel="noopener noreferrer">${ico('x')}Post it</a></div>
      <div class="x-connect-row">${xWait(r) || `<button class="btn btn-solid" data-action="x-verify"${S.xBusy ? ' disabled' : ''}>${S.xBusy ? '<span class="spin" aria-hidden="true"></span>Checking…' : `${ico('check')}Verify @${esc(p.username)}`}</button>`}<button class="link-btn" data-action="x-restart">Different account</button></div>
      <p class="form-error" id="x-verify-error" role="alert"></p>
    </div>`;
  }
  return `<div class="x-connect">
      <p class="muted">Connect your X account first${r.xConnectPoints && !r.xUsername ? ` (<b class="pts">+${r.xConnectPoints} points</b>)` : ''}, so we can check your tasks. No password needed.</p>
      ${form(r.xChecks ? 'Next' : 'Connect', r.xUsername ?? '')}
    </div>`;
}

function tasksCard(r) {
  // Open tasks first, then finished ones, then ones that are full.
  const rank = (t) => (t.done ? 1 : t.remaining === 0 ? 2 : 0);
  const rows = [...r.tasks].sort((a, b) => rank(a) - rank(b));
  const connected = xConnected(r);
  const open = rows.filter((t) => !t.done && t.remaining !== 0).reduce((sum, t) => sum + t.points, 0);
  return `
    <section class="section panel tasks-card">
      <div class="section-head"><span class="section-ico">${ico('list')}</span><div><h2>Tasks</h2><p class="muted">Do a task, then press Verify.</p></div>${open ? `<span class="pill pill-pts head-action">+${fmtNum(open)} to earn</span>` : ''}</div>
      ${
        rows.length
          ? `<ul class="tasks">${rows
              .map((t) => {
                const full = t.remaining === 0 && !t.done;
                const needsX = X_TASKS.has(t.kind) && !connected && !t.done && !full;
                // The channel task is checked through our bot: until it knows the player, they press Start there.
                const needsBot = t.kind === 'telegram' && r.telegram && !r.telegram.linked && !t.done && !full;
                const expanded = needsX && S.xOpenTask === t.id;
                let action;
                if (t.done) action = `<span class="task-done">${ico('checkCircle')}Already claimed</span>`;
                // Everyone's spots are taken (the task had a limit): say so plainly, not just "Full".
                else if (full) action = `<span class="muted task-full">${ico('lock')}All spots claimed</span>`;
                else if (needsX) action = expanded ? '' : `<button class="btn btn-solid" data-action="task-connect" data-task="${esc(t.id)}">${ico('x')}Connect X</button>`;
                else if (t.startedAt) {
                  // Follow, repost and post tasks are checked on X: after too many misses the player waits.
                  const wait = r.xChecks && X_CHECKED.has(t.kind) ? xWait(r) : '';
                  const bot = needsBot ? `<a class="btn" href="${esc(r.telegram.botUrl)}" target="_blank" rel="noopener noreferrer">${ico('send')}Open bot</a>` : '';
                  const busy = S.verifying?.id === t.id;
                  const verify = busy
                    ? `<button class="btn btn-solid is-busy" disabled aria-live="polite"><span class="spin" aria-hidden="true"></span>Verifying<span class="verify-s" data-since="${S.verifying.at}">${Math.floor((now() - S.verifying.at) / 1000)}s</span></button>`
                    : `<button class="btn btn-solid" data-action="task-verify" data-task="${esc(t.id)}"${S.verifying ? ' disabled' : ''}>${ico('check')}Verify</button>`;
                  action = `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${ico('external')}Open</a>${bot}${wait || verify}`;
                }
                else action = `<a class="btn btn-solid" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" data-action="task-go" data-task="${esc(t.id)}">${TASK_GO[t.kind] ?? 'Start'} ${ico('chevronRight')}</a>`;
                return `<li class="task${t.done ? ' is-done' : ''}${full ? ' is-full' : ''}${expanded ? ' is-open' : ''}">
                  <span class="task-ico">${ico(TASK_ICONS[t.kind] ?? 'star')}</span>
                  <div class="task-body"><b>${esc(t.title)}</b><small><span class="pts">+${fmtNum(t.points)} points</span>${t.remaining !== null && !t.done && !full && t.remaining <= 20 ? ` · ${fmtNum(t.remaining)} left` : ''}</small>${needsBot && t.startedAt ? '<small class="task-hint">Joined? Now open our bot and press Start, so we can see it’s you. Then press Verify.</small>' : ''}</div>
                  <div class="task-actions">${action}</div>
                  ${expanded ? `<div class="task-connect">${xConnectPanel(r)}</div>` : ''}
                </li>`;
              })
              .join('')}</ul>
             ${
               connected
                 ? `<p class="fine tasks-x">${ico('x')}Checked on <b>@${esc(r.xUsername)}</b>${S.xOpenTask === 'change' ? '' : ' · <button class="link-btn" data-action="task-connect" data-task="change">Change</button>'}</p>${S.xOpenTask === 'change' ? `<div class="task-connect">${xConnectPanel({ ...r, xUsername: null })}</div>` : ''}`
                 : ''
             }`
          : `<div class="earn2-empty">${ico('list')}<p><b>No tasks right now.</b> New tasks on X show up here. Inviting friends earns points meanwhile.</p></div>`
      }
    </section>`;
}

/** Tasks whose Verify asks X (likes and links can't be checked there). */
const X_CHECKED = new Set(['follow', 'repost', 'share']);

/** What the button says before a task is opened. */
const TASK_GO = { follow: 'Follow', repost: 'Repost', like: 'Like', share: 'Post', link: 'Open', telegram: 'Join' };

/** Tasks done on X: they need the player's X account first. */
const X_TASKS = new Set(['follow', 'repost', 'like', 'share']);

function claimsList(r) {
  if (!r.claims.length) return '';
  // Page 1 comes with the rewards summary; other pages are fetched when asked for.
  const data = S.claimsPage ?? { claims: r.claims, page: 1, pages: Math.max(1, Math.ceil((r.claimsTotal ?? r.claims.length) / PER_PAGE)), total: r.claimsTotal ?? r.claims.length };
  const label = { pending: 'Waiting for wallet', submitted: 'Confirming', confirmed: 'Claimed', failed: 'Failed', expired: 'Expired' };
  return `
    <details class="section panel claims-box" data-list-card="claims"${S.claimsOpen ? ' open' : ''}>
      <summary class="section-head"><span class="section-ico">${ico('token')}</span><h2>Your claims <span class="count-badge">${fmtNum(data.total)}</span></h2><span class="claims-chev" aria-hidden="true">${ico('chevronRight')}</span></summary>
      <ul class="activity">${data.claims
        .map(
          (c) => `<li><span>${fmtNum(c.amount)} TestFPT to ${esc(shortAddress(c.wallet))} · <b class="${c.status === 'confirmed' ? 'profit-pos' : c.status === 'failed' || c.status === 'expired' ? 'profit-neg' : ''}">${label[c.status] ?? c.status}</b>${c.error && c.status !== 'confirmed' ? ` <span class="muted">${esc(c.error)}</span>` : ''}</span>
            <span class="muted">${c.explorerUrl ? `<a href="${esc(c.explorerUrl)}" target="_blank" rel="noopener noreferrer">Explorer ${ico('external')}</a> · ` : ''}${fmtAgo(c.at)}</span></li>`,
        )
        .join('')}</ul>
      ${pager('claims', data.page, data.pages)}
      ${r.mintUrl ? `<p class="fine claims-mint"><a href="${esc(r.mintUrl)}" target="_blank" rel="noopener noreferrer">TestFPT on Solana Explorer ${ico('external')}</a></p>` : ''}
    </details>`;
}

/**
 * Claim every reward to the chosen wallet. Normally Firstprint signs, sends and pays for it (no
 * pop-up); only if the server is out of test SOL does it hand back a transaction for the wallet to sign.
 */
async function claimTokens() {
  if (S.claimBusy) return;
  const wallet = S.me?.wallets?.[0]?.address;
  if (!wallet) return openAuth('link');
  S.claimBusy = true;
  renderTop();
  try {
    const c = await S.api.startClaim(wallet);
    let res = c;
    if (!c.serverPaid) {
      toast(`Approve the transaction in your wallet: it mints ${fmtNum(c.amount)} TestFPT to ${shortAddress(wallet)}.`);
      const walletName = S.me.wallets.find((w) => w.address === wallet)?.walletName;
      const signedTx = await signTransactionWith(wallet, c.transaction, c.cluster, walletName);
      res = await S.api.submitClaim(c.claimId, signedTx);
    }
    for (let i = 0; res.status === 'submitted' && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3_000));
      res = await S.api.claimStatus(c.claimId);
    }
    if (res.status === 'confirmed') {
      // The chip goes, and its coins fly into the balance, which counts up.
      const chip = $('.claim-chip');
      const from = chip?.getBoundingClientRect();
      chip?.remove();
      await collectPoints(from, res.amount, '.chip.points', { count: true });
      celebrate('moon');
      rewardToast({ amount: res.amount, unit: 'TestFPT', title: 'Claimed', sub: 'Check your wallet' });
    } else if (res.status === 'submitted') {
      toast('Still confirming on Solana. It will show up shortly.');
    } else {
      toast(res.error || 'The claim didn’t go through. Your points are still claimable.', true);
    }
  } catch (err) {
    const rejected = err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? '');
    toast(rejected ? 'Cancelled in your wallet. Your points are still claimable.' : err.message, true);
  } finally {
    S.claimBusy = false;
    await refreshMe();
    if (S.route.name === 'earn') $('#view').innerHTML = earnView();
  }
}

/** Shows the Verify button as busy (spinner and a seconds counter) while the check runs. */
function showVerifying(taskId) {
  S.verifying = taskId ? { id: taskId, at: now() } : null;
  clearInterval(S.verifyTimer);
  if (S.route.name === 'earn') $('#view').innerHTML = earnView();
  if (!taskId) return;
  S.verifyTimer = setInterval(() => {
    const el = $('.verify-s');
    if (el) el.textContent = `${Math.floor((now() - Number(el.dataset.since)) / 1000)}s`;
  }, 1000);
}

async function onTaskVerify(taskId, btn) {
  if (S.verifying) return; // one check at a time; the first click is already running
  const from = btn?.getBoundingClientRect();
  showVerifying(taskId);
  try {
    const out = await S.api.verifyTask(taskId);
    S.verifying = null;
    clearInterval(S.verifyTimer);
    // Sent straight to the wallet (or no TestFPT): the coins fly into the balance, which counts up.
    // Otherwise they wait in the claim chip.
    const direct = !out.onChain || out.sent;
    if (direct) await collectPoints(from, out.points, '.chip.points', { count: true });
    await refreshMe();
    if (S.route.name === 'earn') $('#view').innerHTML = earnView();
    if (!direct) await collectPoints(from, out.points, $('.claim-chip') ? '.claim-chip' : '.chip.points');
    rewardToast({ amount: out.points, title: 'Task done', sub: out.sent ? 'Sent to your wallet as TestFPT' : out.onChain ? 'On its way as TestFPT' : '' });
  } catch (err) {
    S.verifying = null;
    clearInterval(S.verifyTimer);
    toast(err.message, true);
    if (err.code === 'x_required' || err.code === 'x_unverified') S.xOpenTask = taskId;
    await refreshMe();
    if (S.route.name === 'earn') $('#view').innerHTML = earnView();
  }
}

async function submitX(form) {
  const err = $('#x-error');
  try {
    const out = await S.api.connectX(String(new FormData(form).get('x') ?? ''));
    if (!out.pending) {
      // Connected straight away (no X checks): the task can be started now.
      if (S.xOpenTask === 'change') S.xOpenTask = null;
      if (out.rewarded) rewardToast({ amount: out.rewarded, title: `@${out.xUsername} connected` });
    }
    await refreshMe();
    if (S.route.name === 'earn') $('#view').innerHTML = earnView();
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}

/** Checks the player's code on X and, once found, makes the X username theirs. */
async function onXVerify() {
  if (S.xBusy) return;
  S.xBusy = true;
  if (S.route.name === 'earn') $('#view').innerHTML = earnView();
  try {
    const out = await S.api.verifyX();
    S.xBusy = false;
    if (S.xOpenTask === 'change') S.xOpenTask = null;
    await refreshMe();
    if (S.route.name === 'earn') $('#view').innerHTML = earnView();
    if (out.rewarded) rewardToast({ amount: out.rewarded, title: `@${out.xUsername} connected` });
    else toast(`Verified @${out.xUsername}`);
  } catch (err) {
    S.xBusy = false;
    await refreshRewards(); // a miss can start the wait before the next check
    if (S.route.name === 'earn') $('#view').innerHTML = earnView();
    const box = $('#x-verify-error');
    if (box) box.textContent = err.message;
    else toast(err.message, true);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    prompt('Copy this', text);
  }
}

// ------------------------------------------------------------------ Listing radar

function radarView(listings) {
  const t = now();
  const sorted = [...listings].sort((a, b) => {
    const fa = a.listingAt && a.listingAt > t;
    const fb = b.listingAt && b.listingAt > t;
    if (fa !== fb) return fa ? -1 : 1;
    if (fa) return a.listingAt - b.listingAt;
    return (b.publishedAt ?? b.detectedAt) - (a.publishedAt ?? a.detectedAt);
  });
  const rows = sorted
    .map((d) => {
      const future = d.listingAt && d.listingAt > now();
      const when = !d.listingAt ? '<span class="muted">Not announced</span>' : future ? `in ${until(d.listingAt)}` : fmtDate(d.listingAt);
      const market = d.marketId
        ? `<a class="btn" href="#/market/${encodeURIComponent(d.marketId)}">Predict</a>`
        : '<span class="muted">Opening soon</span>';
      const title = d.url
        ? `<a class="radar-title" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.title || 'Announcement')}</a>`
        : `<span class="radar-title">${esc(d.title || '')}</span>`;
      return `
        <tr>
          <td><span class="radar-sym">${esc(d.symbol || '?')}</span>${title}</td>
          <td>${esc(d.exchangeName)}</td>
          <td class="hide-sm">${d.source === 'announcement' ? 'Announcement' : 'New trading pair'}<br><span class="muted">${fmtAgo(d.publishedAt ?? d.detectedAt)}</span></td>
          <td>${when}</td>
          <td class="right">${market}</td>
        </tr>`;
    })
    .join('');
  return `
    <h1 class="page-title">Listing radar</h1>
    <p class="page-lede">New listings found automatically from exchange announcements and new trading pairs on Binance, MEXC, Bybit, OKX, Gate, Bitget, and KuCoin. A market opens once the listing and its trading time are confirmed.</p>
    ${
      listings.length
        ? `<div class="table-scroll"><table class="table radar"><thead><tr><th>Token</th><th>Exchange</th><th class="hide-sm">Found from</th><th>Trading starts</th><th class="right">Market</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty"><p>No new listings found yet. The radar checks every exchange every few minutes.</p></div>'
    }`;
}

// ------------------------------------------------------------------ Connect & auth modal

function modalShell(title, lede, body) {
  return `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">${title}</h2>
        ${lede ? `<p class="muted" style="margin:0">${lede}</p>` : ''}
        ${body}
      </div>
    </div>`;
}

/** The warning before taking a prediction back: what comes back, the fee, and where it goes. */
function revertView(r) {
  const m = S.market;
  const q = r.quote;
  const yn = isYesNo(m);
  const name = `<b style="color:${oVar(r.bucket, yn)}">${oName(r.bucket, yn)}</b>`;
  const rules = m.revert;
  const split = rules.burnBps >= 10_000 ? `all ${fmtPts(q.fee)} burned` : rules.burnBps <= 0 ? `all ${fmtPts(q.fee)} to early players` : `${fmtPts(q.burn)} burned, ${fmtPts(q.toEarly)} to early players`;
  return modalShell(
    'Take back your prediction?',
    `Your ${name} prediction of ${fmtPts(q.stake)} leaves the pool.`,
    `<dl class="revert-sum">
       <div class="big"><dt>You get back</dt><dd>${fmtPts(q.back)}</dd></div>
       <div><dt>Fee</dt><dd>${q.free ? 'Free' : `${pctText(q.bps)} · ${fmtPts(q.fee)}`}</dd></div>
       ${q.fee ? `<div><dt>Where the fee goes</dt><dd>${split}</dd></div>` : ''}
     </dl>
     <ul class="revert-notes">
       ${q.free ? `<li>You placed it less than ${Math.round(rules.undoMs / 60_000)} minutes ago, so taking it back is free.</li>` : `<li>The fee rises as the close gets nearer, up to ${pctText(rules.maxBps)}. Burned points are gone for good.</li>`}
       <li>Your early bonus goes too. If you predict again, the bonus is the one for that moment.</li>
       <li>You can take predictions back until ${fmtDate(q.lockAt)}.</li>
     </ul>
     <button class="cta cta-danger" data-action="revert-confirm"${S.modalBusy ? ' disabled' : ''}>${S.modalBusy ? 'Taking it back' : `Take back for ${fmtPts(q.back)}`}</button>
     <button class="btn" style="width:100%;margin-top:10px" data-action="close-modal">Keep my prediction</button>
     <p class="form-error" id="auth-error" role="alert"></p>`,
  );
}

/** Opens the take-back warning with the server's price for it. */
async function openRevert(id) {
  const p = S.market?.mine.find((x) => x.id === id);
  if (!p || !S.api.revertQuote) return;
  try {
    const quote = await S.api.revertQuote(id);
    if (!quote.allowed) return toast('Predictions can’t be taken back this close to the close.', true);
    S.revert = { id, bucket: p.bucket, quote };
    S.modal = 'revert';
    S.modalBusy = false;
    renderAuth();
  } catch (err) {
    toast(err.message, true);
  }
}

async function confirmRevert() {
  if (!S.revert || S.modalBusy) return;
  S.modalBusy = true;
  renderAuth();
  try {
    const res = await S.api.revert(S.revert.id);
    closeModal();
    toast(res.fee ? `${fmtPts(res.back)} back. ${fmtPts(res.burned)} burned${res.toEarly ? `, ${fmtPts(res.toEarly)} to early players` : ''}.` : `${fmtPts(res.back)} back, no fee.`);
    S.revert = null;
    await refreshMe();
    S.tradeKey = '';
    return loadRoute();
  } catch (err) {
    S.modalBusy = false;
    renderAuth();
    const box = $('#auth-error');
    if (box) box.textContent = err.message;
  }
}

function walletButtons(purpose) {
  const wallets = listWallets();
  const list = wallets
    .map(
      (w, i) => `
      <button class="wallet-option" data-wallet="${i}" data-purpose="${purpose}">
        ${w.icon || WALLET_LOGOS[w.name] ? `<img src="${esc(w.icon || WALLET_LOGOS[w.name])}" alt="" width="28" height="28" />` : `<span class="wallet-fallback" aria-hidden="true">${esc(w.name[0])}</span>`}
        <span>${esc(w.name)}</span><span class="muted">Detected</span>
      </button>`,
    )
    .join('');
  if (wallets.length) return `<div class="wallet-options">${list}</div>`;
  const links = isMobileDevice() ? mobileWalletLinks() : INSTALL_LINKS;
  return `
    <div class="no-wallet">
      <p>${isMobileDevice() ? 'Open Firstprint inside your wallet app to connect.' : 'No Solana wallet found in this browser. Install one, then reload this page.'}</p>
      <div class="wallet-options">${links
        .map(
          (l) => `<a class="wallet-option" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">
            <img src="${esc(l.logo)}" alt="" width="28" height="28" />
            <span>${isMobileDevice() ? `Open in ${esc(l.name)}` : esc(l.name)}</span><span class="muted">${isMobileDevice() ? 'App' : 'Install'} ${ico('chevronRight')}</span>
          </a>`,
        )
        .join('')}</div>
    </div>`;
}

const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function openAuth(kind) {
  S.modal = kind;
  S.modalBusy = false;
  closeSheet();
  if (kind === 'connect') S.auth = { step: 'start', email: '', devCode: null, resendAt: 0 };
  renderAuth();
  if (kind === 'connect' && !S.signIn) {
    // The server says which sign-in options are switched on. Show the defaults until it answers.
    S.api
      .config()
      .then((c) => (S.signIn = c.signIn ?? { google: null, email: true }))
      .catch(() => (S.signIn = { google: null, email: true }))
      .then(() => S.modal === 'connect' && S.auth.step === 'start' && renderAuth());
  }
}

function renderAuth() {
  const kind = S.modal;
  let html;
  if (kind === 'link') {
    html = modalShell(
      'Link a Solana wallet',
      'Sign a message to prove you own the wallet. It’s free and sends no transaction.',
      `${walletButtons('link')}
       ${S.api.demo ? `<button class="btn" style="width:100%;margin-top:10px" data-action="demo-wallet" data-purpose="link">Use a demo wallet</button>` : ''}
       <p class="form-error" id="auth-error" role="alert"></p>
       <p class="fine" id="auth-status"></p>`,
    );
  } else if (kind === 'username') {
    const xPts = S.rewards?.xConnectPoints;
    html = modalShell(
      'Complete your profile',
      'Your username is how you appear on the leaderboard and in market activity.',
      `<form id="username-form" novalidate>
         <label><span class="field-label">Username</span><input name="username" value="${esc(S.me?.username ?? '')}" minlength="3" maxlength="20" autocomplete="username" required /></label>
         ${
           S.rewards && !S.rewards.xUsername
             ? `<label><span class="field-label">X username <span class="muted">(optional${xPts ? `, +${xPts} points` : ''})</span></span><input name="x" placeholder="@yourname" maxlength="16" autocomplete="off" /></label>`
             : ''
         }
         <button class="cta" style="--c:var(--text)" type="submit">Save and continue</button>
         <p class="form-error" id="auth-error" role="alert"></p>
       </form>
       <p class="fine"><button class="switch" data-action="profile-skip">Skip for now</button></p>`,
    );
  } else if (kind === 'inbox') {
    html = modalShell('Your results', 'What happened on the markets you predicted.', inboxView());
  } else if (kind === 'win') {
    html = winView(S.win);
  } else if (kind === 'revert') {
    html = revertView(S.revert);
  } else if (kind === 'pnl') {
    html = modalShell('Share your result', 'Your PnL card for this market. Post it on X, or save the image.', pnlView(S.pnl));
  } else if (kind === 'tour') {
    html = tourView();
  } else if (kind === 'start') {
    html = modalShell('Start predicting in 3 steps', 'Your 1,000 starting points are TestFPT tokens. Claim them to your wallet, then use them to predict.', startSteps());
  } else if (S.auth.step === 'code') {
    html = modalShell(
      'Check your email',
      `We sent a 6-digit code to <b>${esc(S.auth.email)}</b>. It expires in 10 minutes.`,
      `<form id="auth-code-form" novalidate>
         <label><span class="field-label">Code</span>
           <input id="auth-code" name="code" class="code-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="000000" required /></label>
         <button class="cta" style="--c:var(--text)" type="submit">Continue</button>
         <p class="form-error" id="auth-error" role="alert"></p>
       </form>
       ${S.auth.devCode ? `<p class="fine dev-code">No email provider is connected here, so your code is <b>${esc(S.auth.devCode)}</b>.</p>` : ''}
       <p class="fine"><button class="switch" data-action="auth-resend" id="auth-resend">Send a new code</button> · <button class="switch" data-action="auth-change-email">Use a different email</button></p>`,
    );
  } else {
    const si = S.signIn ?? { google: null, email: true };
    html = modalShell(
      'Log in or sign up',
      `New accounts get ${startPoints()}. Use any option below. They all lead to the same account.`,
      `${si.google ? '<div id="google-button" class="google-slot" aria-label="Continue with Google"></div>' : ''}
       ${
         si.email
           ? `${si.google ? '<div class="or"><span>or</span></div>' : ''}
              <form id="auth-email-form" novalidate>
                <label><span class="field-label">Email</span><input name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${esc(S.auth.email)}" required /></label>
                <button class="cta" style="--c:var(--text)" type="submit">Continue with email</button>
              </form>`
           : ''
       }
       <div class="or"><span>${si.google || si.email ? 'or connect a wallet' : 'connect a wallet'}</span></div>
       ${walletButtons('connect')}
       ${S.api.demo ? `<button class="btn" style="width:100%;margin-top:10px" data-action="demo-wallet" data-purpose="connect">Use a demo wallet</button>` : ''}
       <p class="form-error" id="auth-error" role="alert"></p>
       <p class="fine" id="auth-status"></p>
       <p class="fine">Points are for play and have no cash value.</p>`,
    );
  }
  $('#modal-root').innerHTML = html;
  ($('#modal-root input') || $('#modal-root button.wallet-option') || $('#modal-root button'))?.focus();
  if (kind === 'connect' && S.auth.step === 'start' && S.signIn?.google) mountGoogleButton(S.signIn.google);
  if (kind === 'connect' && S.auth.step === 'code') tickResend();
}

/** Loads Google's sign-in script once and draws its official button. Falls back quietly if blocked. */
function mountGoogleButton(clientId) {
  const draw = () => {
    const slot = $('#google-button');
    if (!slot || !window.google?.accounts?.id) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (r) => googleSignIn(r.credential),
      ux_mode: 'popup',
      auto_select: false,
    });
    window.google.accounts.id.renderButton(slot, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'center', width: Math.min(360, slot.clientWidth || 340) });
  };
  if (window.google?.accounts?.id) return draw();
  if (document.querySelector(`script[src="${GOOGLE_SCRIPT}"]`)) return;
  const el = document.createElement('script');
  el.src = GOOGLE_SCRIPT;
  el.async = true;
  el.onload = draw;
  el.onerror = () => {
    const slot = $('#google-button');
    if (slot) slot.innerHTML = '<p class="fine">Google sign-in couldn’t load. Use email or a wallet.</p>';
  };
  document.head.appendChild(el);
}

async function googleSignIn(credential) {
  if (S.modalBusy) return;
  S.modalBusy = true;
  try {
    const out = await S.api.googleSignIn(credential);
    await afterSignIn(out.user, out.created);
  } catch (err) {
    const e = $('#auth-error');
    if (e) e.textContent = err.message;
    S.modalBusy = false;
  }
}

async function submitEmail(form) {
  const email = String(new FormData(form).get('email') || '').trim().toLowerCase();
  const err = $('#auth-error');
  if (!EMAIL_RE.test(email)) return err && (err.textContent = 'Enter a valid email address.');
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const out = await S.api.emailStart(email);
    S.auth = { step: 'code', email, devCode: out.devCode ?? null, resendAt: Date.now() + 30_000 };
    renderAuth();
  } catch (e) {
    if (err) err.textContent = e.message;
    btn.disabled = false;
  }
}

async function submitCode(form) {
  if (S.modalBusy) return;
  const code = String(new FormData(form).get('code') || '').replace(/\D/g, '');
  const err = $('#auth-error');
  if (code.length !== 6) return err && (err.textContent = 'Enter the 6-digit code.');
  S.modalBusy = true;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const out = await S.api.emailVerify(S.auth.email, code);
    S.modalBusy = false;
    await afterSignIn(out.user, out.created);
  } catch (e) {
    S.modalBusy = false;
    if (err) err.textContent = e.message;
    btn.disabled = false;
    const input = $('#auth-code');
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

async function resendCode() {
  if (Date.now() < S.auth.resendAt) return;
  const err = $('#auth-error');
  try {
    const out = await S.api.emailStart(S.auth.email);
    S.auth.devCode = out.devCode ?? null;
    S.auth.resendAt = Date.now() + 30_000;
    renderAuth();
    toast('New code sent');
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}

/** Disables "Send a new code" for 30 seconds after each send and shows the countdown. */
function tickResend() {
  const btn = $('#auth-resend');
  if (!btn || S.modal !== 'connect' || S.auth.step !== 'code') return;
  const left = Math.ceil((S.auth.resendAt - Date.now()) / 1000);
  btn.disabled = left > 0;
  btn.textContent = left > 0 ? `Send a new code (${left}s)` : 'Send a new code';
  if (left > 0) setTimeout(tickResend, 1000);
}

// ------------------------------------------------------------------ Results inbox, win popup, first-time tour

// ------------------------------------------------------------------ Shareable PnL card

/** A button that opens the PnL card for one of the player's settled markets. */
function pnlButton(marketId, symbol, cls, iconOnly = false, label = 'Share your PnL') {
  if (!S.me?.username || S.api.demo) return '';
  return `<button class="${cls}" data-action="pnl-open" data-id="${esc(marketId)}" data-symbol="${esc(symbol)}"${iconOnly ? ` aria-label="Share your ${esc(symbol)} PnL" title="Share PnL"` : ''}>${ico('share')}${iconOnly ? '' : esc(label)}</button>`;
}

function pnlLinks(p) {
  const path = `/share/pnl/${encodeURIComponent(p.marketId)}/${encodeURIComponent(S.me.username)}`;
  return { page: `${location.origin}${path}`, png: `${path}.png` };
}

function pnlView(p) {
  const l = pnlLinks(p);
  const text = encodeURIComponent(`My ${p.symbol} call on Firstprint. Think you can call the next listing?`);
  const file = `firstprint-${String(p.symbol).replace(/[^A-Za-z0-9]/g, '') || 'token'}-pnl.png`;
  return `
    <div class="pnl-card"><img src="${esc(l.png)}" alt="Your ${esc(p.symbol)} PnL card" width="1200" height="630" /></div>
    <div class="pnl-actions">
      <a class="btn btn-solid" href="https://x.com/intent/post?text=${text}&url=${encodeURIComponent(l.page)}" target="_blank" rel="noopener noreferrer">${ico('x')}Post on X</a>
      <a class="btn" href="${esc(l.png)}" download="${esc(file)}">${ico('download')}Save image</a>
      ${navigator.canShare ? `<button class="btn" data-action="pnl-native">${ico('share')}Share…</button>` : ''}
      <button class="btn" data-action="pnl-copy">${ico('link')}Copy link</button>
    </div>
    <p class="fine">The X post shows this card as its preview. Points have no cash value.</p>
    <button class="btn" style="width:100%;margin-top:6px" data-action="close-modal">Close</button>`;
}

async function pnlNativeShare() {
  const p = S.pnl;
  const l = pnlLinks(p);
  try {
    const blob = await (await fetch(l.png)).blob();
    const file = new File([blob], `firstprint-${p.symbol}.png`, { type: 'image/png' });
    const data = { files: [file], text: `My ${p.symbol} call on Firstprint`, url: l.page };
    if (navigator.canShare(data)) await navigator.share(data);
    else await navigator.share({ text: data.text, url: l.page });
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Couldn’t open sharing here. Save the image or copy the link instead.', true);
  }
}

/** What one result means for the player, in a sentence. */
function resultLine(n) {
  const yn = n.outcomes === 'binary';
  if (n.status === 'void') return { icon: 'undo', tone: 'flat', title: `${esc(n.symbol)} was cancelled`, body: `${fmtPts(n.refund)} refunded to your balance.` };
  const win = n.winningBucket ? outcome(n.winningBucket, yn) : 'the result';
  if (n.won) return { icon: 'trophy', tone: 'warn', title: `You won ${fmtPts(n.payout)} on ${esc(n.symbol)}`, body: `It settled ${yn ? 'as' : 'in'} ${win}. You staked ${fmtPts(n.staked)}.` };
  return { icon: 'cross', tone: 'crash', title: `${esc(n.symbol)} settled ${yn ? 'as' : 'in'} ${win}`, body: `Your pick didn’t win this time${n.refund ? `; ${fmtPts(n.refund)} came back from the pool limit` : ''}.` };
}

function inboxView() {
  const list = S.inbox?.notifications ?? [];
  if (!list.length) return `<div class="inbox-empty">${ico('bell')}<p>No results yet. When a market you predicted on settles, you’ll see it here.</p></div><button class="btn" style="width:100%;margin-top:14px" data-action="close-modal">Close</button>`;
  return `
    <ul class="inbox">${list
      .map((n) => {
        const r = resultLine(n);
        return `<li class="${n.read ? '' : 'unread'}" style="--c:var(--${r.tone})">
          <span class="inbox-ico">${ico(r.icon)}</span>
          <a href="#/market/${encodeURIComponent(n.marketId)}" data-action="close-modal"><b>${r.title}</b><span>${r.body}</span><small>${fmtAgo(n.at)}</small></a>
          ${n.status === 'resolved' && n.staked > 0 ? pnlButton(n.marketId, n.symbol, 'icon-btn pnl-mini', true) : ''}
        </li>`;
      })
      .join('')}</ul>
    <button class="btn" style="width:100%;margin-top:14px" data-action="close-modal">Close</button>`;
}

async function openInbox() {
  try {
    S.inbox = await S.api.notifications();
  } catch (err) {
    return toast(err.message, true);
  }
  S.modal = 'inbox';
  renderAuth();
  if (S.inbox.unread) markResultsRead();
}

async function markResultsRead() {
  try {
    await S.api.markNotificationsRead();
  } catch {
    /* the badge stays until the next try */
  }
  if (S.me) S.me.unreadNotifications = 0;
  renderTop();
}

/** A big moment for a win the player hasn't seen yet. Shown once, then the results are marked read. */
async function maybeCelebrate() {
  if (S.modal || S.celebrating || !S.api.notifications) return;
  S.celebrating = true;
  try {
    const { notifications } = await S.api.notifications();
    const win = notifications.find((n) => !n.read && n.won);
    if (win && !S.modal) {
      S.win = win;
      S.modal = 'win';
      renderAuth();
      celebrate('moon');
    }
  } catch {
    /* no popup this time */
  } finally {
    S.celebrating = false;
  }
}

function winView(n) {
  const yn = n.outcomes === 'binary';
  const text = encodeURIComponent(`I called ${n.symbol} on Firstprint and won ${fmtNum(n.payout)} points. Think you can call the next one?`);
  const url = encodeURIComponent(`${location.origin}${location.pathname}#/market/${encodeURIComponent(n.marketId)}`);
  return `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal win-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <span class="win-ico">${ico('trophy')}</span>
        <h2 id="modal-title">You called it!</h2>
        <p class="win-amount">+${fmtNum(n.payout)} <small>pts</small></p>
        <p class="muted">${esc(n.symbol)} settled ${yn ? 'as' : 'in'} ${n.winningBucket ? outcome(n.winningBucket, yn) : 'your pick'}. You staked ${fmtPts(n.staked)}.</p>
        <div class="win-actions">
          ${S.me?.username && !S.api.demo ? pnlButton(n.marketId, n.symbol, 'btn btn-gold btn-lg', false, 'Share your win') : `<a class="btn btn-gold btn-lg" href="https://x.com/intent/tweet?text=${text}&url=${url}" target="_blank" rel="noopener noreferrer">${ico('x')}Share on X</a>`}
          <a class="btn btn-lg" href="#/market/${encodeURIComponent(n.marketId)}" data-action="win-close">See the market</a>
        </div>
        <button class="switch" data-action="win-close">Close</button>
      </div>
    </div>`;
}

function closeWin() {
  closeModal();
}

/** Three short screens for new players: outcomes, points, timing. */
const TOUR = [
  {
    icon: 'target',
    title: 'Pick where the price lands',
    body: `Every market asks one question about a token’s price. Pick an outcome, from ${outcome('crash')} to ${outcome('moon')}, or simply ${outcome('up', true)} or ${outcome('down', true)} on Yes/No markets.`,
  },
  {
    icon: 'coins',
    title: 'Play with free points',
    body: 'You get 1,000 starting points (with TestFPT on, you claim them on the Earn page) and up to 200 more every day: claim daily to grow your streak. Points have no cash value, so there’s nothing to lose. Earn more on the Earn page.',
  },
  {
    icon: 'trophy',
    title: 'Call it early, win the pool',
    body: 'Everyone who picked the right outcome splits the pool. Earlier picks earn up to 1.5× more, so the sooner you call it, the better. You’ll get a notification when a result is posted.',
  },
];

function tourView() {
  const i = S.tourStep ?? 0;
  const t = TOUR[i];
  const last = i === TOUR.length - 1;
  return `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal tour-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="tour-dots" aria-hidden="true">${TOUR.map((_, j) => `<i class="${j === i ? 'on' : ''}"></i>`).join('')}</div>
        <span class="tour-ico">${ico(t.icon)}</span>
        <p class="eyebrow">Step ${i + 1} of ${TOUR.length}</p>
        <h2 id="modal-title">${t.title}</h2>
        <p class="tour-body">${t.body}</p>
        <div class="tour-actions">
          ${i ? '<button class="btn btn-lg" data-action="tour-back">Back</button>' : '<button class="btn btn-lg" data-action="tour-done">Skip</button>'}
          <button class="btn ${last ? 'btn-gold' : 'btn-solid'} btn-lg" data-action="${last ? 'tour-done' : 'tour-next'}">${last ? 'Let’s go' : 'Next'}</button>
        </div>
      </div>
    </div>`;
}

const TOUR_SEEN = 'fp:toured';

function openTour() {
  S.tourStep = 0;
  S.modal = 'tour';
  renderAuth();
}

function finishTour() {
  try {
    localStorage.setItem(TOUR_SEEN, '1');
  } catch {
    /* storage unavailable */
  }
  if (S.me && needsClaimSteps()) return openAuth('start');
  closeModal();
}

/** First visit: show the tour once to people who haven't signed in yet. */
function maybeTourVisitor() {
  let seen = false;
  try {
    seen = localStorage.getItem(TOUR_SEEN) === '1';
  } catch {
    seen = true;
  }
  if (!seen && !S.me && !S.modal && S.route.name === 'home' && !S.api.demo) setTimeout(() => !S.modal && !S.me && openTour(), 1200);
}

function closeModal() {
  if (S.modal === 'win') markResultsRead();
  if (S.modal === 'tour') {
    try {
      localStorage.setItem(TOUR_SEEN, '1');
    } catch {
      /* storage unavailable */
    }
  }
  S.modal = null;
  S.modalBusy = false;
  $('#modal-root').innerHTML = '';
}

async function afterSignIn(user, created) {
  closeModal();
  await refreshMe();
  const claimFirst = needsClaimSteps();
  toast(created ? (claimFirst ? 'Account created. Claim your 1,000 TestFPT to start.' : 'Account created. 1,000 points added.') : `Signed in as ${S.me.username}`);
  S.tradeKey = '';
  await loadRoute();
  // New players: complete the profile (or skip), take the short tour, then see how to get started.
  S.newPlayer = Boolean(created);
  if (created || user?.needsUsername) openAuth('username');
  else if (claimFirst) openAuth('start');
}

/** Players with their own wallet claim the welcome bonus themselves; a Firstprint wallet gets it by itself. */
const needsClaimSteps = () => Boolean(S.rewards?.onChain && !S.rewards.welcomeClaimed && !S.rewards.firstprintWallet);

/** After the profile step, new players see the getting-started steps if they still have to claim. */
function afterProfile() {
  if (S.newPlayer) {
    S.newPlayer = false;
    return openTour();
  }
  if (needsClaimSteps()) openAuth('start');
  else closeModal();
}

async function walletFlow(purpose, entry) {
  if (S.modalBusy) return;
  S.modalBusy = true;
  const status = $('#auth-status');
  const error = $('#auth-error');
  error.textContent = '';
  status.textContent = entry ? `Approve the request in ${entry.name}.` : 'Signing in with a demo wallet.';
  document.querySelectorAll('.wallet-option').forEach((b) => (b.disabled = true));
  try {
    const getMessage = async (address) => (await S.api.walletChallenge(address)).message;
    let signed;
    if (entry) {
      signed = await connectAndSign(entry, getMessage);
    } else {
      const address = S.api.demoWallet();
      signed = { address, message: await getMessage(address), signature: 'demo', walletName: 'Demo wallet' };
    }
    if (purpose === 'link') {
      await S.api.linkWallet(signed);
      closeModal();
      await refreshMe();
      toast('Wallet linked');
      await loadRoute();
    } else {
      const out = await S.api.walletVerify(signed);
      await afterSignIn(out.user, out.created);
    }
  } catch (err) {
    const rejected = err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? '');
    if (error) error.textContent = rejected ? 'The request was cancelled in your wallet.' : err.message || 'Wallet connection failed.';
    if (status) status.textContent = '';
    document.querySelectorAll('.wallet-option').forEach((b) => (b.disabled = false));
    S.modalBusy = false;
  }
}

async function submitUsername(form) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  const data = new FormData(form);
  try {
    S.me = await S.api.setUsername(data.get('username'));
    const x = String(data.get('x') ?? '').trim();
    if (x) {
      const out = await S.api.connectX(x);
      if (out.pending) toast(`To verify @${out.xUsername}, add ${out.code} to your X bio, then press Verify on the Earn page`);
      else if (out.rewarded) toast(`+${out.rewarded} points for linking @${out.xUsername}`);
    }
    await refreshRewards();
    renderTop();
    if (!x) toast(`You’re ${S.me.username}`);
    await loadRoute();
    afterProfile();
  } catch (err) {
    $('#auth-error').textContent = err.message;
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ Live updates

let marketRenderTimer = null;
let homeRenderTimer = null;
let refreshTimer = null;
let refreshAt = 0;

function onLive(type, data) {
  if (type === 'price') {
    const patch = (m) => {
      if (!m || m.id !== data.marketId || !m.live) return false;
      m.live = { ...m.live, lastPrice: data.price, returnPct: data.returnPct, projectedBucket: data.projectedBucket };
      return true;
    };
    if (S.route.name === 'market' && patch(S.market)) {
      if (S.chart?.series) S.chart.series.push([data.ts, data.price]);
      if (!marketRenderTimer) {
        marketRenderTimer = setTimeout(() => {
          marketRenderTimer = null;
          if (S.route.name === 'market' && S.market) {
            setHtml($('#market-main'), marketMain(S.market));
            renderTrade();
          }
        }, 800);
      }
    }
    if (S.route.name === 'home') {
      const hit = [...S.lists.open, ...S.lists.live].some((m) => patch(m));
      if (hit && !homeRenderTimer) {
        homeRenderTimer = setTimeout(() => {
          homeRenderTimer = null;
          heroFlipDone().then(() => S.route.name === 'home' && setHtml($('#view'), homeView()));
        }, 2_000);
      }
    }
  } else if (type === 'market' || (type === 'listing' && S.route.name === 'radar')) {
    // The market being looked at refreshes within a couple of seconds; anything else waits a while,
    // with a random spread, so a busy market doesn't make every open page reload at the same moment.
    const here = S.route.name === 'market' && data?.marketId === S.route.id;
    const delay = here ? 600 + Math.random() * 1500 : 8_000 + Math.random() * 12_000;
    const at = Date.now() + delay;
    if (refreshTimer && refreshAt <= at) return; // one is already coming sooner
    clearTimeout(refreshTimer);
    refreshAt = at;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, delay);
  }
}

// ------------------------------------------------------------------ Admin

const ADMIN_KEY_STORE = 'fp_admin_key';
const A = { api: null, info: null, checks: null, exCheck: null, busy: '', edit: null, preview: null, tab: 'overview' };

function readAdminKey() {
  try {
    return sessionStorage.getItem(ADMIN_KEY_STORE) || '';
  } catch {
    return '';
  }
}

function saveAdminKey(key) {
  try {
    if (key) sessionStorage.setItem(ADMIN_KEY_STORE, key);
    else sessionStorage.removeItem(ADMIN_KEY_STORE);
  } catch {
    /* storage unavailable: key lives only in memory */
  }
}

const ADMIN_TABS = [
  ['overview', 'grid', 'Overview', 'Today at a glance.'],
  ['markets', 'list', 'Markets', 'Post results, publish drafts, edit or cancel markets.'],
  ['analytics', 'chart', 'Analytics', 'Players, activity and markets.'],
  ['users', 'users', 'User activity', 'Every player’s predictions, wins and points, newest first.'],
  ['discover', 'search', 'Find tokens', 'New listings and trending tokens, ready to become markets.'],
  ['create', 'plusCircle', 'Create market', 'Players only see it once you publish.'],
  ['token', 'token', 'TestFPT token', 'The on-chain token players claim their points as.'],
  ['tasks', 'sparkles', 'Tasks', 'Tasks players complete on X for points.'],
  ['settings', 'sliders', 'Settings', 'Automatic markets, reference exchanges and backups.'],
  ['errors', 'alert', 'Errors', 'Problems on the server and in players’ apps, newest first.'],
  ['activity', 'history', 'Admin log', 'Everything done in this panel, newest first.'],
];

/** Team roles, lowest first. A server without roles is treated as the owner's. */
const ADMIN_RANK = { tasks: 1, listings: 2, admin: 3, owner: 4 };
const canAdmin = (level) => (ADMIN_RANK[A.info?.level] ?? ADMIN_RANK.owner) >= ADMIN_RANK[level];
/** The role each admin tab needs. Listing managers see markets, listings and tasks; not results, analytics, token or settings. */
const TAB_LEVEL = { overview: 'listings', markets: 'listings', discover: 'listings', create: 'listings', tasks: 'tasks', activity: 'listings' };
const adminTabs = () => ADMIN_TABS.filter(([id]) => canAdmin(TAB_LEVEL[id] ?? 'admin'));

async function renderAdmin() {
  const view = $('#view');
  if (S.api.demo) {
    view.innerHTML = `
      <h1 class="page-title">Admin</h1>
      <div class="empty"><p>Admin tools need the Firstprint server with internet access. On your computer run <code>npm run dev</code>, then open <code>http://localhost:8787/#/admin</code>.</p></div>`;
    return;
  }
  const key = A.api ? null : readAdminKey();
  if (!A.api && key) A.api = createAdminApi(key);
  // No key: an admin account signed in here (ADMIN_EMAILS / ADMIN_WALLETS on the server) opens it as is.
  const byAccount = !A.api && !A.locked && Boolean(S.me);
  if (byAccount) A.api = createAdminApi('');
  if (A.api && !A.info) {
    try {
      A.info = await A.api.ping();
    } catch (err) {
      A.api = null;
      if (!byAccount) saveAdminKey('');
      if (err.status !== 403) toast(err.message, true);
    }
  }
  if (!A.api) {
    view.innerHTML = `
      <div class="admin-login">
        <span class="page-ico">${ico('lock')}</span>
        <h1 class="page-title">Admin console</h1>
        <p class="muted">${S.me ? `Signed in as <b>${esc(S.me.username)}</b>, which isn’t an admin account.` : 'Log in with your admin email or wallet to open it straight away.'} Team members are added by the owner under Settings → Team; the owner’s own email or wallet is set as <code>ADMIN_EMAILS</code> / <code>ADMIN_WALLETS</code> on the server. Emails count when you sign in with Google or an email code.</p>
        ${S.me ? '' : `<button class="btn btn-solid btn-lg" data-action="connect">${ico('wallet')}Log in</button>`}
        <details class="admin-key-login"${S.me ? ' open' : ''}><summary>Use the admin key instead</summary>
        <form id="admin-login" class="admin-form">
          <label><span class="field-label">Admin key</span><input name="key" type="password" autocomplete="off" required /></label>
          <button class="btn btn-solid btn-lg" type="submit">${ico('key')}Open admin</button>
        </form>
        <p class="fine">The ADMIN_KEY from your server settings. It’s kept only for this browser tab.</p>
        </details>
      </div>`;
    return;
  }

  // Team members who manage tasks only get the Tasks page and nothing else.
  if (A.info.level === 'tasks') return renderTasksOnly(view);

  const manualOnly = Boolean(A.info.manualOnly);
  let loaded;
  try {
    loaded = await Promise.all([
      A.api.markets(),
      manualOnly && !A.info.autoListings ? Promise.resolve([]) : A.api.detected().then((d) => d.detected).catch(() => []),
      A.api.log().catch(() => ({ log: [] })),
      A.api.token().catch(() => ({ enabled: false })),
      A.api.tasks().catch(() => ({ tasks: [] })),
      A.info.level === 'owner' ? A.api.team().catch(() => null) : Promise.resolve(null),
      canAdmin('admin') ? A.api.errors(A.errView ?? 'open').catch(() => null) : Promise.resolve(null),
    ]);
  } catch (err) {
    // The server may be waking up or busy: say so instead of leaving the old tab on screen.
    view.innerHTML = `<div class="empty"><div class="empty-art">${ico('alert')}</div><p><strong>Couldn’t load the admin panel.</strong><br />${esc(err.message)}</p><button class="btn btn-solid" data-action="admin-token-refresh">${ico('refresh')}Try again</button></div>`;
    return;
  }
  const [{ markets }, detected, { log }, token, tasksData, teamData, errorsData] = loaded;
  const { tasks } = tasksData;
  A.xCheck = { on: Boolean(tasksData.xChecks), credit: tasksData.xCredit ?? null, usage: tasksData.xUsage ?? null };
  A.xConnect = tasksData.xConnect ?? null;
  A.markets = markets;
  void backfillLogoPngs(markets);
  A.detected = detected;
  // Tokens with a market that isn't finished show "Market made" in Find tokens: open, a draft, or closed
  // and counting down to its result. Only a settled or cancelled market frees the token for a new one.
  A.made = Object.fromEntries(markets.filter((m) => m.status === 'open' || m.status === 'locked').map((m) => [m.symbol.toUpperCase(), m.id]));
  const venues = A.info.venues;
  const editing = markets.find((m) => m.id === A.edit && m.mode === 'manual' && m.status === 'open') ?? null;
  if (A.edit && !editing) A.edit = null;
  // Closed markets need the admin once their result is due (or their start price couldn't be read);
  // until then they count down by themselves.
  const closed = markets.filter((m) => m.mode === 'manual' && m.phase === 'awaiting_result');
  const needsYou = (m) => m.settleAt <= now() || (m.basePrice == null && /not found/i.test(m.autoOpenNote ?? ''));
  const waiting = closed.filter(needsYou);
  const counting = closed.filter((m) => !needsYou(m)).sort((a, b) => a.settleAt - b.settleAt);
  const drafts = markets.filter((m) => m.phase === 'draft');
  const tab = adminTabs().some(([id]) => id === A.tab) ? A.tab : 'overview';
  // The admin tabs visited, so Back returns to the previous one (Review → Create market → Back → Overview).
  A.history ??= [];
  if (A.lastTab && A.lastTab !== tab && !A.goingBack) A.history = [...A.history, A.lastTab].slice(-20);
  A.goingBack = false;
  A.lastTab = tab;
  const backTo = A.history.length ? A.history[A.history.length - 1] : tab !== 'overview' ? 'overview' : null;
  const backLabel = backTo ? ADMIN_TABS.find(([id]) => id === backTo)?.[2] ?? 'Back' : null;
  // New exchange listings waiting for review (manual-only servers); the old scanner shows its own list in Settings.
  const pending = manualOnly ? detected : [];
  if (A.review && !pending.some((d) => d.id === A.review.id)) A.review = null;
  const review = !editing && A.review ? A.review : null;
  const tooLong = markets.filter(openTooLong).sort((a, b) => b.closeAt - a.closeAt);
  const badges = { markets: waiting.length + pending.length + tooLong.length, token: token?.enabled && !token.ready ? '!' : 0, errors: errorsData?.counts?.open ?? 0 };
  const [, , title, lede] = ADMIN_TABS.find(([id]) => id === tab);

  let body;
  if (tab === 'overview') body = adminOverview({ markets, waiting, drafts, token, tasks, log, pending, tooLong });
  if (tab === 'overview') setTimeout(loadTopUp, 0);
  else if (tab === 'markets') {
    const old = canAdmin('admin') ? await A.api.oldResults().catch(() => null) : null;
    body = adminMarketsTab(markets, waiting, pending, counting, tooLong, old?.results ?? []);
  } else if (tab === 'users') {
    A.act ??= { page: 1, all: false, q: '' };
    try {
      body = userActivityView(await A.api.userActivity(A.act.page, A.act.all ? 50 : 10, A.act.q));
    } catch (err) {
      body = `<div class="empty"><p>${esc(err.message)}</p></div>`;
    }
  }
  else if (tab === 'analytics') {
    try {
      const data = await A.api.analytics(S.vizDays ?? 30);
      body = analyticsSharePanel(data.shareKey) + analyticsView(data);
    } catch (err) {
      body = `<div class="empty"><p>${esc(err.message)}</p></div>`;
    }
  }
  else if (tab === 'create') body = `<section class="panel" id="admin-market-section">
      ${editing || review ? `<div class="section-head"><h2>${editing ? `Edit ${esc(editing.symbol)} market` : `Review ${esc(review.symbol)} from ${esc(review.exchangeName)}`}</h2></div>` : ''}
      ${marketForm(editing, review ? reviewPrefill(review) : editing ? null : A.prefill)}
    </section>`;
  else if (tab === 'discover') body = discoverView();
  else if (tab === 'token') body = tokenAdminSection(token) || `<div class="empty"><p>TestFPT isn’t available on this server.</p></div>`;
  else if (tab === 'tasks') body = tasksAdminSection(tasks);
  else if (tab === 'settings')
    body = `
      ${canAdmin('admin') ? maintenancePanel() : ''}
      ${canAdmin('admin') ? revertRulesPanel(await A.api.revertRules().catch(() => null)) : ''}
      ${autoListingsPanel(A.info.autoListings)}
      ${telegramPanel(A.info.telegram)}
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('landmark')}</span><div><h2>Reference exchanges</h2><p class="muted">Offered for new markets and checked for listings.</p></div></div>
        <div class="toggle-grid">${A.info.exchanges
          .map((e) => `<label class="toggle"><input type="checkbox" data-action="admin-exchange" data-id="${esc(e.id)}"${e.enabled ? ' checked' : ''} /><span class="toggle-ui" aria-hidden="true"></span>${esc(e.name)}</label>`)
          .join('')}</div>
      </section>
      ${teamData ? teamPanel(teamData.team) : ''}
      ${exchangeCheckPanel()}
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('database')}</span><div><h2>Database backup</h2><p class="muted">Copies of the database in Supabase, restored automatically when the server restarts.</p></div></div>
        ${backupLine(A.info.backup) || '<p class="muted">Backups are off. Set SUPABASE_URL and SUPABASE_SERVICE_KEY on the server to turn them on.</p>'}
      </section>
      ${manualOnly ? '' : legacyAdminSections(venues, detected)}`;
  else if (tab === 'errors') body = errorsView(errorsData);
  else body = adminLogView(log);

  view.innerHTML = `
    <div class="admin-shell">
      <aside class="admin-side" aria-label="Admin sections">
        <div class="admin-brand">${ico('shield')}<span>Admin console</span></div>
        <nav class="admin-nav">
          ${adminTabs().map(
            ([id, icon, label]) =>
              `<button type="button" data-action="admin-tab" data-tab="${id}"${id === tab ? ' aria-current="page"' : ''}>${ico(icon)}<span>${label}</span>${badges[id] ? `<span class="nav-badge">${badges[id]}</span>` : ''}</button>`,
          ).join('')}
        </nav>
        <button class="btn admin-lock" data-action="admin-logout">${ico('lock')}Lock admin</button>
      </aside>
      <div class="admin-main">
        <header class="admin-top">
          <div class="admin-head">
            ${backTo ? `<button type="button" class="admin-back" data-action="admin-back" aria-label="Back to ${esc(backLabel)}" title="Back to ${esc(backLabel)}">${ico('arrowLeft')}</button>` : ''}
            <div><h1 class="page-title">${title}</h1><p class="muted">${lede}</p></div>
          </div>
          <div class="admin-status">${statusChips(token, A.info.backup)}</div>
        </header>
        ${body}
      </div>
    </div>`;
  afterAdminRender();
}

/** "Check live price" in the market form: live prices plus warnings about the start price and timing. */
async function runPriceCheck() {
  const form = $('#admin-market');
  const out = $('#price-check-out');
  if (!form || !out) return;
  const d = new FormData(form);
  const symbol = String(form.querySelector('[name=symbol]').value || '').trim();
  const exchanges = d.getAll('exchanges').map(String);
  if (!symbol) return toast('Enter the token symbol first.', true);
  if (!exchanges.length) return toast('Choose at least one exchange.', true);
  out.innerHTML = `<p class="checks-note">${ico('clock')}Checking ${esc(symbol.toUpperCase())} on ${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'}…</p>`;
  let prices;
  try {
    ({ prices } = await A.api.priceCheck({ symbol, exchanges, pairs: d.get('pairs') ? JSON.parse(String(d.get('pairs'))) : undefined }));
  } catch (err) {
    out.innerHTML = `<p class="checks-note">${ico('info')}${esc(err.message)}</p>`;
    return;
  }
  const live = prices.filter((p) => p.price !== null).map((p) => p.price).sort((a, b) => a - b);
  const median = live.length ? live[Math.floor((live.length - 1) / 2)] : null;
  const upcoming = form.querySelector('[data-upcoming]')?.checked;
  const atClose = !upcoming && Boolean(form.querySelector('[data-start-close]')?.checked);
  const base = Number(form.querySelector('[name=basePrice]')?.value || 0);
  const closeAt = new Date(form.querySelector('[name=closeAt]').value).getTime();
  const notes = [];
  const usePrice = median !== null ? `<button class="btn btn-sm" type="button" data-action="admin-use-price" data-price="${median}">Use ${fmtPrice(median)} as start price</button>` : '';
  if (median === null && prices.some((p) => p.error)) notes.push(['medium', 'Couldn’t reach the price source just now, so this isn’t a sign the token stopped trading. Try again in a minute.']);
  else if (median === null) notes.push(['ok', upcoming ? 'Not trading on these exchanges yet. That’s right for an upcoming token.' : 'Not trading on these exchanges yet. If it lists later, tick “Upcoming token” instead of guessing a start price.']);
  else {
    if (upcoming) notes.push(['high', `${esc(symbol.toUpperCase())} is already trading, so it isn’t upcoming. Players could see the price before they pick. ${usePrice}`]);
    if (atClose) notes.push(['ok', `Trading at ${fmtPrice(median)} now. The start price is taken by itself when predictions close.`]);
    if (!upcoming && !atClose && base > 0) {
      const diff = (median - base) / base;
      if (Math.abs(diff) > 0.2) notes.push([Math.abs(diff) > 0.5 ? 'high' : 'medium', `Your start price ${fmtPrice(base)} is ${Math.round(Math.abs(diff) * 100)}% ${diff > 0 ? 'below' : 'above'} the live price. ${usePrice}`]);
      else notes.push(['ok', `Start price is within ${Math.round(Math.abs(diff) * 100)}% of the live price.`]);
    }
    if (!upcoming && !atClose && !(base > 0)) notes.push(['medium', `Enter a start price. ${usePrice}`]);
    if (!atClose && Number.isFinite(closeAt) && closeAt - Date.now() > 48 * 3_600_000) notes.push(['medium', `Predictions stay open ${Math.round((closeAt - Date.now()) / 86_400_000)} days against a fixed start price, so late players can follow the trend. Tick “Start price is the price when predictions close”.`]);
  }
  out.innerHTML = `
    <div class="pc-prices">${prices.map((p) => `<span class="pc-chip${p.price === null ? ' off' : ''}"${p.error ? ` title="${esc(p.error)}"` : ''}><b>${esc(p.name)}</b> ${p.price !== null ? fmtPrice(p.price) : p.error ? `no answer: ${esc(p.error)}` : 'not trading'}</span>`).join('')}</div>
    <ul class="check-list compact">${notes.map(([lvl, html]) => `<li class="lvl-${lvl}"><span class="check-dot" aria-hidden="true"></span><p>${html}</p></li>`).join('')}</ul>`;
}

/** Runs after the admin page is drawn: UTC hints, live price checks, and copying a linked logo. */
function afterAdminRender() {
  updateUtcHints();
  // On phones the tab strip scrolls sideways; keep the open tab in view.
  const nav = $('.admin-nav');
  const cur = nav?.querySelector('[aria-current]');
  if (nav && cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2;
  const box = $('#admin-checks');
  if (box) loadMarketChecks(box);
  const form = $('#admin-market');
  const link = form?.querySelector('[data-logo-link]')?.value.trim();
  if (form && link && /^https:\/\//i.test(link)) copyLogo(form, link);
  // A listing from the review queue: show its live price straight away.
  if (form?.querySelector('[name=detectionId]') || (A.prefill && !form?.dataset.id)) runPriceCheck();
  if (form && form.querySelector('[name=symbol]')?.value.trim()) runBannerPreview();
  if (form?.querySelector('[data-auto-open]')) syncAutoOpen(form);
}

/** Draws the market's Telegram banner from the form as it is now (nothing is saved). */
async function runBannerPreview() {
  const form = $('#admin-market');
  const out = $('#banner-preview-out');
  if (!form || !out) return;
  const d = new FormData(form);
  const symbol = String(d.get('symbol') ?? form.querySelector('[name=symbol]')?.value ?? '').trim();
  if (!symbol) {
    out.innerHTML = `<p class="checks-note">${ico('info')}Enter the token symbol first.</p>`;
    return;
  }
  const seq = (A.bannerSeq = (A.bannerSeq ?? 0) + 1);
  out.innerHTML = `<p class="checks-note">${ico('clock')}Drawing the banner…</p>`;
  try {
    const r = await A.api.bannerPreview({
      symbol,
      name: String(d.get('name') || '').trim(),
      exchanges: d.getAll('exchanges').map(String),
      basePrice: d.has('upcoming') || d.has('startAtClose') ? null : d.get('basePrice') || null,
      startAtClose: d.has('startAtClose') && !d.has('upcoming'),
      closeAt: inputMs(d.get('closeAt')),
      resultAt: inputMs(d.get('resultAt')),
      outcomes: d.get('outcomes') === 'binary' ? 'binary' : 'ladder',
      logoPng: await logoPngCopy(String(d.get('logoUrl') || '')),
    });
    if (seq !== A.bannerSeq || !out.isConnected) return;
    out.innerHTML = `${r.png ? `<img class="banner-img" src="${r.png}" alt="Telegram banner for ${esc(symbol)}" />` : ''}${r.reason ? `<p class="checks-note">${ico('info')}${esc(r.reason)}</p>` : ''}`;
  } catch (err) {
    if (seq === A.bannerSeq && out.isConnected) out.innerHTML = `<p class="checks-note">${ico('info')}Couldn’t draw the banner: ${esc(err.message)}</p>`;
  }
}

/** Open markets compared with live exchange prices (cached for two minutes). */
async function loadMarketChecks(box) {
  if (!A.checks || Date.now() - A.checks.at > 120_000) {
    box.innerHTML = `<p class="checks-note">${ico('clock')}Checking open markets against live exchange prices…</p>`;
    try {
      A.checks = { at: Date.now(), list: (await A.api.marketChecks()).checks };
    } catch (err) {
      if (box.isConnected) box.innerHTML = `<p class="checks-note">${ico('info')}Couldn’t check live prices: ${esc(err.message)}</p>`;
      return;
    }
  }
  if (box.isConnected) box.innerHTML = checksView(A.checks.list);
}

function checksView(list) {
  if (!list.length) return '';
  const items = list.flatMap((c) => c.warnings.map((w) => ({ ...w, c })));
  if (!items.length) return '';
  const high = items.some((i) => i.level === 'high');
  // Markets nobody has predicted on yet can drop their fixed start price for the price at the close.
  const switchable = [...new Set(items.filter((i) => i.c.canUseClose).map((i) => i.c.id))];
  return `
    <details class="adm-collapse adm-warn${high ? ' high' : ''}">
      <summary>${ico('alert')}<b>${items.length} price warning${items.length === 1 ? '' : 's'}</b><span class="muted">in open markets, checked ${fmtAgo(A.checks.at)}</span></summary>
      ${switchable.length > 1 ? `<div class="adm-warn-all"><p class="muted">${switchable.length} of these have no predictions yet. Taking their start price at the close is fairer and needs no checking.</p><button class="btn btn-sm btn-solid" data-action="admin-close-start-all" data-ids="${esc(switchable.join(','))}">${ico('lock')}Use price at close for all ${switchable.length}</button></div>` : ''}
      <ul class="check-list">${items
        .map((i) => `<li class="lvl-${i.level}"><span class="check-dot" aria-hidden="true"></span><p><b>${esc(i.c.symbol)}</b> ${esc(i.text)}</p><span class="check-actions">${i.c.canUseClose ? `<button class="btn btn-sm btn-solid" data-action="admin-close-start" data-id="${esc(i.c.id)}">${ico('lock')}Use price at close</button>` : ''}<button class="btn btn-sm" data-action="admin-edit" data-id="${esc(i.c.id)}">${ico('edit')}Edit</button></span></li>`)
        .join('')}</ul>
      <div class="adm-collapse-foot"><button class="btn btn-sm" data-action="admin-recheck">${ico('refresh')}Check again</button></div>
    </details>`;
}

/** Shows each date-time field in UTC, since exchanges announce listing times in UTC. */
function updateUtcHints() {
  document.querySelectorAll('[data-utc-for]').forEach((hint) => {
    const input = hint.closest('form')?.querySelector(`[name="${hint.dataset.utcFor}"]`);
    const d = input?.value ? new Date(input.value) : null;
    hint.textContent = d && !Number.isNaN(d.getTime())
      ? `= ${d.toLocaleString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} UTC`
      : '';
  });
}

/** Downloads a linked logo through the server and keeps a small copy, so the market never depends on the link. */
async function copyLogo(form, url) {
  const status = form.querySelector('[data-logo-status]');
  const say = (text, cls = '') => status && ((status.textContent = text), (status.className = `logo-status ${cls}`));
  say('Saving a copy of this logo…');
  try {
    const img = await A.api.fetchImage(url);
    const bytes = Uint8Array.from(atob(img.data), (ch) => ch.charCodeAt(0));
    const dataUrl = await shrinkImage(new Blob([bytes], { type: img.contentType }), 128);
    if (!form.isConnected || form.querySelector('[data-logo-link]').value.trim() !== url) return;
    setLogo(form, dataUrl, { keepLink: true });
    say('Saved a copy. The logo no longer depends on that link.', 'ok');
  } catch (err) {
    if (form.isConnected) say(`Couldn’t copy it (${err.message}). The link will be used as it is.`, 'bad');
  }
}

/**
 * Finds the token's logo on CoinGecko by its ticker (and name) and saves a copy, so a market made
 * from a new listing needs no logo pasted by hand. Runs by itself when a listing is reviewed (only
 * if the form has no logo yet), and from the Find button.
 */
async function findLogo(form, { force = false } = {}) {
  if (!form || !A.api) return;
  if (!force && form.querySelector('[name=logoUrl]').value) return;
  const symbol = form.querySelector('[name=symbol]')?.value.trim() ?? '';
  const name = form.querySelector('[name=name]')?.value.trim() ?? '';
  const status = form.querySelector('[data-logo-status]');
  const say = (text, cls = '') => status && ((status.textContent = text), (status.className = `logo-status ${cls}`));
  if (!symbol) return force && say('Fill in the symbol first.', 'bad');
  say(`Looking for ${symbol}’s logo on CoinGecko…`);
  try {
    const { logo } = await A.api.tokenLogo(symbol, name);
    if (!form.isConnected || (!force && form.querySelector('[name=logoUrl]').value)) return;
    if (!logo) return say(`CoinGecko doesn’t list ${symbol} yet. Grab the logo from one of the pages below.`, 'bad');
    form.querySelector('[data-logo-link]').value = logo.logo;
    setLogo(form, logo.logo, { keepLink: true });
    await copyLogo(form, logo.logo);
    if (form.isConnected && form.querySelector('[name=logoUrl]').value) say(`Logo from CoinGecko (${logo.name}). Check it’s the right token.`, 'ok');
  } catch (err) {
    if (form.isConnected) say(`Couldn’t look up the logo (${err.message}). Grab it from one of the pages below.`, 'bad');
  }
}

/**
 * Where the admin can grab a logo by hand when CoinGecko doesn't know the token: its page on each
 * exchange it lists on, the listing announcement, and an image search. Pasting the copied image
 * link saves our own copy (copyLogo), so players never load anything from these sites.
 */
function logoSources(symbol, name, exchanges, pairs = {}, detectionId = null) {
  const sym = String(symbol).trim().toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(sym)) return '';
  const names = Object.fromEntries((A.info?.exchanges ?? []).map((e) => [e.id, e.name]));
  const links = exchanges
    .filter((id) => TRADE_URLS[id] && (id !== 'coingecko' || pairs.coingecko))
    .map((id) => [`${names[id] ?? id} page`, TRADE_URLS[id](encodeURIComponent(sym), { pair: pairs[id] })]);
  const ann = detectionId ? A.detected?.find((d) => d.id === Number(detectionId))?.url : null;
  if (ann) links.push(['Listing announcement', ann]);
  links.push(['Image search', `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(`${sym} ${String(name).trim()} crypto token logo`.replace(/\s+/g, ' '))}`]);
  return `<span class="muted">Logo not found? Open one, right-click the logo, “Copy image address”, paste it above:</span>${links
    .map(([label, href]) => `<a class="btn btn-sm" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ${ico('external')}</a>`)
    .join('')}`;
}

/** Keeps the logo links in step with the symbol, name and exchanges being typed in. */
function refreshLogoSources(form) {
  const box = form?.querySelector('[data-logo-sources]');
  if (!box) return;
  const get = (n) => form.querySelector(`[name=${n}]`)?.value ?? '';
  let pairs = {};
  try {
    pairs = JSON.parse(get('pairs') || '{}');
  } catch {}
  const exchanges = [...form.querySelectorAll('[name=exchanges]:checked')].map((c) => c.value);
  box.innerHTML = logoSources(get('symbol'), get('name'), exchanges, pairs, get('detectionId') || null);
}

/** Admin → Settings: maintenance on/off, with the note players see. */
function maintenancePanel() {
  const m = S.maint ?? { on: false };
  const busy = A.busy === 'maint';
  return `<section class="panel adm-maint${m.on ? ' is-on' : ''}">
    <div class="section-head"><span class="section-ico">${ico('sliders')}</span><div><h2>Maintenance mode ${m.on ? '<span class="pill pill-warn">On</span>' : '<span class="pill pill-off">Off</span>'}</h2>
      <p class="muted">${m.on ? `On since ${m.since ? fmtDate(m.since) : 'just now'}. Players see the update screen and can’t sign up, predict or claim. You can still use the site to test.` : 'Turn it on before deploying a big change. Players see an update screen, nothing new is written, and a fresh backup is taken, so the deploy loses nothing.'}</p></div></div>
    <form class="maint-form" data-maint-form>
      <input name="message" maxlength="200" placeholder="Note for players (optional), e.g. Back in 15 minutes" value="${esc(m.message ?? '')}"${m.on ? ' disabled' : ''} />
      ${m.on
        ? `<button class="btn btn-sm btn-solid" type="button" data-action="admin-maint" data-on="0"${busy ? ' disabled' : ''}>${busy ? '<i class="spin" aria-hidden="true"></i>Turning off' : `${ico('power')}Turn off: go live`}</button>`
        : `<button class="btn btn-sm btn-close-now" type="button" data-action="admin-maint" data-on="1"${busy ? ' disabled' : ''}>${busy ? '<i class="spin" aria-hidden="true"></i>Turning on, backing up' : `${ico('power')}Turn on`}</button>`}
    </form>
    ${how('1. Turn it on and wait for “Backup taken” (up to a minute, while any TestFPT send finishes). 2. Merge and deploy. 3. When the new version is live, test it (you still see the site). 4. Turn it off: players come back by themselves. Markets keep their times; anything that came due in between (closing, start prices, results) catches up when it ends.', 'How to deploy safely')}
  </section>`;
}

/** Turns maintenance on (with a fresh backup) or off. */
async function adminMaintenance(on) {
  if (on && !confirm('Turn on maintenance? Players see an update screen until you turn it off.')) return;
  const message = $('[data-maint-form] [name=message]')?.value ?? '';
  A.busy = 'maint';
  renderAdmin();
  try {
    const out = await A.api.maintenance(on, message);
    applyMaintenance(out);
    if (on) toast(out.backedUp ? 'Maintenance is on. Backup taken: safe to deploy now.' : out.backups ? 'Maintenance is on, but the backup didn’t go through. Wait a minute before deploying.' : 'Maintenance is on. (No backups on this server.)', on && out.backups && !out.backedUp);
    else toast('Maintenance is off. Players are back.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    A.busy = '';
    renderAdmin();
  }
}

/** The long explanation behind a setting, folded away until asked for. */
const how = (html, label = 'How it works') => `<details class="adm-how"><summary>${label}</summary><p>${html}</p></details>`;

/** Small health chips for the admin header: TestFPT and backups. */
function statusChips(token, backup) {
  const chip = (ok, icon, text) => `<span class="status-chip ${ok === true ? 'ok' : ok === false ? 'bad' : 'idle'}">${ico(icon)}${text}</span>`;
  const out = [];
  if (token?.enabled) out.push(chip(token.ready ? true : false, 'token', token.ready ? 'TestFPT live' : 'TestFPT not set up'));
  if (backup?.enabled) out.push(chip(backup.lastError ? false : backup.lastOkAt ? true : null, 'database', backup.lastError ? 'Backup failing' : backup.lastOkAt ? `Backed up ${fmtAgo(backup.lastOkAt)}` : 'Backup pending'));
  else out.push(chip(null, 'database', 'Backups off'));
  return out.join('');
}

/** Overview: the headline numbers first, then one inbox (to do / new listings), then recent activity. */
function adminOverview({ markets, waiting, drafts, token, tasks, log, pending, tooLong = [] }) {
  const open = markets.filter((m) => m.status === 'open' && m.phase !== 'draft');
  const inPools = open.reduce((n, m) => n + m.pool, 0);
  const predictors = open.reduce((n, m) => n + m.predictors, 0);
  const activeTasks = tasks.filter((t) => t.active);
  const stat = (color, label, value, sub, goto) =>
    `<button type="button" class="adm-stat" style="--c:var(--${color})" data-action="admin-tab" data-tab="${goto}"><span class="adm-stat-l">${label}</span><b>${value}</b><small>${sub}</small></button>`;
  const todo = [];
  if (tooLong.length) todo.push(['alert', 'down', `${tooLong.length} market${tooLong.length === 1 ? ' is' : 's are'} open longer than 3 days`, `${tooLong.map((m) => esc(m.symbol)).slice(0, 4).join(', ')}${tooLong.length > 4 ? '…' : ''}: close them so late players can’t follow the trend`, 'markets', 'Close them']);
  for (const m of waiting) todo.push(['alert', 'crash', `${esc(m.symbol)} is waiting for its result`, `${fmtPts(m.pool)} from ${m.predictors} participant${m.predictors === 1 ? '' : 's'}`, 'markets', 'Post result']);
  for (const m of drafts) todo.push(['edit', 'flat', `${esc(m.symbol)} is a draft`, 'Hidden until you publish it', 'markets', 'Review']);
  if (token?.enabled && !token.ready) todo.push(['token', 'warn', 'TestFPT isn’t set up', 'Points stay in balances until it exists', 'token', 'Set up']);
  if (token?.enabled && (token.authorityKey || (token.mint && !token.savedInEnv?.mint))) todo.push(['key', 'warn', 'Save the TestFPT keys in Render', 'So a restart can’t lose them', 'token', 'Show keys']);
  if (A.info.backup?.lastError) todo.push(['database', 'crash', 'Database backup is failing', esc(A.info.backup.lastError), 'settings', 'Check']);
  if (!open.length) todo.push(['plusCircle', 'up', 'No open markets', 'Players have nothing to predict', 'create', 'Create one']);
  if (!activeTasks.length) todo.push(['sparkles', 'up', 'No active tasks', 'Tasks give players more ways to earn', 'tasks', 'Add a task']);
  const todoList = todo.length
    ? `<ul class="todo">${todo
        .map(([icon, color, t, sub, goto, label]) => `<li style="--c:var(--${color})"><span class="todo-ico">${ico(icon)}</span><div><b>${t}</b><span class="muted">${sub}</span></div><button class="btn btn-sm" data-action="admin-tab" data-tab="${goto}">${label}</button></li>`)
        .join('')}</ul>`
    : `<p class="all-good">${ico('checkCircle')}Everything’s in order.</p>`;
  const panes = [['todo', 'To do', todo.length, todoList]];
  if (A.info.manualOnly) panes.push(['listings', 'New listings', pending.length, pending.length ? listingsList(pending) : '<p class="muted">Nothing new. Listings found on the exchanges show up here.</p>']);
  return `
    <div class="adm-stats">
      ${stat('up', 'Open markets', fmtNum(open.length), drafts.length ? `${drafts.length} draft${drafts.length === 1 ? '' : 's'}` : 'Live now', 'markets')}
      ${stat('crash', 'Awaiting result', fmtNum(waiting.length), waiting.length ? 'Post the final price' : 'All caught up', 'markets')}
      ${stat('warn', 'Points in open pools', fmtNum(inPools), 'Across open markets', 'markets')}
      ${stat('brand', 'Predictions', fmtNum(predictors), 'In open markets', 'analytics')}
      ${stat('down', 'Active tasks', fmtNum(activeTasks.length), `${fmtNum(tasks.reduce((n, t) => n + t.completions, 0))} done`, 'tasks')}
    </div>
    ${canAdmin('admin') ? topUpPanel() : ''}
    <div id="admin-checks"></div>
    ${adminInbox(panes)}
    ${adminLogView(log.slice(0, 5), true)}`;
}

/** Extra points for the admin's own account while testing tasks and markets. Only admins see it. */
function topUpPanel() {
  const me = S.me;
  if (!me) {
    return `<section class="panel adm-topup"><div class="topup-head"><span class="section-ico">${ico('coins')}</span><div><h2>Test points</h2><p class="muted">Sign in to the app on this browser first: the points go to that account.</p></div><a class="btn btn-sm" href="#/">${ico('user')}Sign in</a></div></section>`;
  }
  const busy = A.topupBusy;
  const chips = [100, 500, 1000, 5000]
    .map((n) => `<button class="btn btn-sm topup-chip${busy === n ? ' is-busy' : ''}" type="button" data-action="admin-top-up" data-amount="${n}"${busy ? ' disabled' : ''}>${busy === n ? '<i class="spin" aria-hidden="true"></i>Adding' : `+${fmtNum(n)}`}</button>`)
    .join('');
  return `<section class="panel adm-topup">
    <div class="topup-head">
      <span class="section-ico">${ico('coins')}</span>
      <div><h2>Test points</h2><p class="muted">For testing on your own account, <b>${esc(me.username)}</b>. Only admins see this.</p></div>
      <div class="topup-bal"><small>Balance</small><b data-topup-bal>${fmtNum(me.points)}</b></div>
    </div>
    <div class="topup-row">${chips}<form class="topup-custom"><input name="amount" type="number" inputmode="numeric" min="1" max="10000" step="1" placeholder="Amount" aria-label="Points to add"${busy ? ' disabled' : ''} /><button class="btn btn-sm" type="submit"${busy ? ' disabled' : ''}>Add</button></form></div>
    <div class="topup-status" id="topup-status" aria-live="polite">${topUpStatus(A.topup)}</div>
  </section>`;
}

/** Where the last top-ups are: processing on chain, waiting on Earn, or all in the balance. */
function topUpStatus(t) {
  if (!t) return '';
  const day = `<span class="muted">${fmtNum(t.addedToday)} of ${fmtNum(t.dayLimit)} added today</span>`;
  if (t.pending > 0 && t.autoClaim)
    return `<span class="topup-pending"><i class="spin" aria-hidden="true"></i><b>${fmtPts(t.pending)}</b> processing as TestFPT. They show in your balance in about a minute.</span>${day}`;
  if (t.pending > 0)
    return `<span class="topup-pending">${ico('gift')}<b>${fmtPts(t.pending)}</b> waiting for you. <a href="#/earn">Claim them on Earn</a> to see them in your balance.</span>${day}`;
  return `<span class="topup-done">${ico('checkCircle')}All test points are in your balance.</span>${day}`;
}

/** Redraws just the status line and balance, so a waiting top-up never redraws the whole page. */
function paintTopUp() {
  const box = $('#topup-status');
  if (box) box.innerHTML = topUpStatus(A.topup);
  const bal = $('[data-topup-bal]');
  if (bal && S.me) bal.textContent = fmtNum(S.me.points);
}

/** While test points are processing on chain, checks every few seconds and says when they land. */
function watchTopUp() {
  clearTimeout(watchTopUp.timer);
  if (!(A.topup?.pending > 0 && A.topup.autoClaim)) return;
  watchTopUp.timer = setTimeout(async () => {
    if (S.route.name !== 'admin' || !$('#topup-status')) return;
    try {
      const before = A.topup.pending;
      A.topup = (await A.api.topUpStatus()) ?? A.topup;
      if (A.topup.pending < before) {
        await refreshMe();
        rewardToast({ amount: before - A.topup.pending, title: 'Test points arrived' });
      }
      paintTopUp();
    } catch {
      /* try again next round */
    }
    watchTopUp();
  }, 5000);
}

/** Loads the top-up status after the Overview is drawn. */
async function loadTopUp() {
  if (!S.me || !$('#topup-status')) return;
  try {
    A.topup = await A.api.topUpStatus();
    paintTopUp();
    watchTopUp();
  } catch {
    /* the panel still works without it */
  }
}

/** Adds test points to the admin's own account, with clear feedback while it processes. */
async function adminTopUp(amount) {
  const n = Math.floor(Number(amount));
  if (!(n >= 1 && n <= 10_000)) return toast('Choose between 1 and 10,000 points.', true);
  if (A.topupBusy) return toast('Still adding your last top-up. One moment.');
  const stillPending = A.topup?.pending > 0 && A.topup.autoClaim;
  A.topupBusy = n;
  repaintTopUpPanel();
  try {
    const out = await A.api.topUp(n);
    A.topup = out;
    await refreshMe();
    if (!out.onChain) rewardToast({ amount: out.points, title: 'Test points added' });
    else if (out.autoClaim)
      toast(`${stillPending ? 'Your earlier top-up is still processing; this one is added too. ' : ''}+${fmtNum(out.points)} test points on the way. They show in your balance in about a minute.`);
    else toast(`+${fmtNum(out.points)} test points are waiting on the Earn page. Claim them to see them in your balance.`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    A.topupBusy = 0;
    repaintTopUpPanel();
    watchTopUp();
  }
}

/** Swaps in a fresh panel without reloading the rest of the admin page. */
function repaintTopUpPanel() {
  const old = $('.adm-topup');
  if (!old) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = topUpPanel();
  old.replaceWith(tmp.firstElementChild);
}

/** One panel with tabs, so lists that are often empty don’t each take a whole frame. */
function adminInbox(panes) {
  const first = panes.find(([, , n]) => n)?.[0] ?? panes[0][0];
  const cur = panes.some(([id]) => id === A.inbox) ? A.inbox : first;
  return `<section class="panel adm-inbox">
    <div class="adm-tabs" role="tablist">${panes
      .map(([id, label, n]) => `<button type="button" role="tab" data-action="admin-inbox" data-pane="${id}" aria-selected="${id === cur}">${label}${n ? `<span class="count-badge">${n}</span>` : ''}</button>`)
      .join('')}</div>
    ${panes.map(([id, , , html]) => `<div class="adm-pane" data-pane="${id}"${id === cur ? '' : ' hidden'}>${html}</div>`).join('')}
  </section>`;
}

// Old results stay open across re-renders once the admin opens them.
document.addEventListener('toggle', (e) => e.target.matches?.('.adm-old') && (A.oldOpen = e.target.open), true);

/** Settled more than three days ago: keep a copy as a spreadsheet, then clear them out. */
function oldResultsPanel(old) {
  if (!old.length) return '';
  const { rows, nav } = pageOf('adm-old', old);
  return `<details class="adm-collapse adm-old"${A.oldOpen ? ' open' : ''}><summary>${ico('database')}<b>Old results</b><span class="count-badge">${old.length}</span><span class="muted">result 3+ days ago, ready to clear</span></summary>
    <p class="muted adm-fix-note">Download the sheet to keep a copy, then clear them. Clearing removes each market from every list and drops its price data and logo image, which is most of what it stores. Players keep their wins, win rate and leaderboard place. Markets nobody played, and cancelled ones, are deleted completely.</p>
    <div class="row-actions adm-old-actions"><button class="btn btn-sm" data-action="admin-old-csv">${ico('download')}Download sheet</button><button class="btn btn-sm btn-danger" data-action="admin-old-clear-all">${ico('trash')}Clear all ${old.length}</button></div>
    <ul class="todo">${rows
      .map((m) => `<li style="--c:${m.status === 'void' ? 'var(--flat)' : m.winningBucket ? oVar(m.winningBucket, false) : 'var(--flat)'}"><span class="todo-ico">${ico(m.status === 'void' ? 'cross' : 'checkCircle')}</span><div><b>${esc(m.symbol)}</b><span class="muted">${m.status === 'void' ? 'Cancelled' : m.winningBucket ? `${esc(oName(m.winningBucket, false))} won` : 'Settled'} · ${fmtDate(m.settledAt)} · ${fmtNum(m.players)} player${m.players === 1 ? '' : 's'} · ${fmtPts(m.pool)} pool${m.paid ? ` · ${fmtPts(m.paid)} paid` : ''}</span></div>
        <span class="todo-actions"><button class="btn btn-sm" type="button" data-action="admin-old-clear" data-id="${esc(m.id)}">${ico('trash')}Clear</button></span></li>`)
      .join('')}</ul>${nav}</details>`;
}

function adminMarketsTab(markets, waiting, pending, counting = [], tooLong = [], old = []) {
  const allPage = pageOf('adm-markets', markets);
  // Made before the three-day limit: still open for days against a fixed start price. One click closes each.
  const fix = tooLong.length
    ? `<section class="panel adm-results adm-toolong"><div class="section-head"><span class="section-ico">${ico('alert')}</span><h2>Open longer than 3 days <span class="count-badge">${tooLong.length}</span></h2>${tooLong.length > 1 ? `<span class="adm-fix-all"><button class="btn btn-sm btn-close-now" type="button" data-action="admin-close-all">${ico('lock')}Close all now</button><button class="btn btn-sm" type="button" data-action="admin-close-all" data-hours="24">${ico('clock')}Close all in 24h</button></span>` : ''}</div>
        <p class="muted adm-fix-note">Made before the 3-day limit. While predictions stay open, late players can see the token’s trend. Close them now (or give players 24 hours’ notice); predictions stay and the result date doesn’t change.</p>
        <ul class="todo">${tooLong
          .map((m) => `<li style="--c:var(--down)"><span class="todo-ico">${tokenAvatar(m, 'avatar-sm')}</span><div><b>${esc(m.symbol)}</b><span class="muted">Closes in <span data-until="${m.closeAt}">${fmtDur(m.closeAt - now())}</span> · result ${fmtDate(m.settleAt)} · ${fmtPts(m.pool)} from ${m.predictors} participant${m.predictors === 1 ? '' : 's'}</span></div>
            <span class="todo-actions"><button class="btn btn-sm btn-close-now" type="button" data-action="admin-close-now" data-id="${esc(m.id)}">${ico('lock')}Close now</button><button class="btn btn-sm" type="button" data-action="admin-close-24" data-id="${esc(m.id)}">Close in 24h</button></span></li>`)
          .join('')}</ul></section>`
    : '';
  const results = waiting.length
    ? `<section class="panel adm-results"><div class="section-head"><span class="section-ico">${ico('alert')}</span><h2>Waiting for your result <span class="count-badge">${waiting.length}</span></h2></div>
        ${
          canAdmin('admin')
            ? waiting
                .map(
                  (m) => `<details class="adm-row"${A.preview?.id === m.id || waiting.length === 1 ? ' open' : ''}>
                    <summary><span class="mkt-cell">${tokenAvatar(m, 'avatar-sm')}<span><b>${esc(m.symbol)}</b><small class="muted">${fmtPts(m.pool)} · ${m.predictors} participant${m.predictors === 1 ? '' : 's'}</small></span></span><span class="adm-row-cta">Post result</span></summary>
                    ${resultForm(m)}
                  </details>`,
                )
                .join('')
            : `<p class="muted">${waiting.map((m) => esc(m.symbol)).join(', ')}: an admin posts the result.</p>`
        }</section>`
    : '';
  // Closed markets still counting down: nothing to do until the result is due (they move up then).
  const countdown = counting.length
    ? `<details class="adm-collapse"><summary>${ico('clock')}<b>Counting down</b><span class="count-badge">${counting.length}</span><span class="muted">closed, result not due yet</span></summary>
        <ul class="todo">${counting
          .map((m) => `<li style="--c:var(--flat)"><span class="todo-ico">${tokenAvatar(m, 'avatar-sm')}</span><div><b>${esc(m.symbol)}</b><span class="muted">Start ${m.basePrice != null ? fmtPrice(m.basePrice) : 'being read'} · result ${fmtDate(m.settleAt)} · in <span data-until="${m.settleAt}">${fmtDur(m.settleAt - now())}</span> · ${fmtPts(m.pool)}</span></div>
            ${canAdmin('admin') ? `<span class="todo-actions"><button class="btn btn-sm" type="button" data-action="admin-cancel" data-id="${esc(m.id)}">Cancel and refund</button></span>` : ''}</li>`)
          .join('')}</ul></details>`
    : '';
  const listings = pending.length
    ? `<details class="adm-collapse"><summary>${ico('zap')}<b>New listings</b><span class="count-badge">${pending.length}</span><span class="muted">found on the exchanges</span></summary>${listingsList(pending)}</details>`
    : '';
  return `
    ${fix}
    ${results}
    ${countdown}
    <div id="admin-checks"></div>
    ${listings}
    ${oldResultsPanel(old)}
    <section class="panel panel-flush">
      <div class="section-head"><h2>All markets <span class="count-badge">${markets.length}</span></h2><span class="head-action row-gap">${A.info.telegram?.channel ? `<button class="btn btn-sm" data-action="admin-tg-summary" title="One Telegram post with every open market">${ico('telegram')}Post live markets</button>` : ''}<button class="btn btn-solid btn-sm" data-action="admin-tab" data-tab="create">${ico('plus')}New market</button></span></div>
      ${
        markets.length
          ? `<div class="table-scroll"><table class="table"><thead><tr><th>Market</th><th class="hide-sm">Type</th><th>Status</th><th class="right">Pool</th><th class="right"></th></tr></thead><tbody>${allPage.rows
              .map(
                (m) => `<tr>
                  <td><span class="mkt-cell">${tokenAvatar(m, 'avatar-sm')}<span>${m.published ? `<a href="#/market/${encodeURIComponent(m.id)}">${esc(m.symbol)}</a>` : `<b>${esc(m.symbol)}</b>`}<small class="muted hide-sm">${esc(venueNames(m))}</small></span></span></td>
                  <td class="hide-sm">${isYesNo(m) ? 'Yes / No' : m.mode === 'manual' ? 'Five outcomes' : m.kind === 'live_test' ? 'Live test' : 'Automatic'}</td>
                  <td>${adminPhasePill(m)}</td>
                  <td class="right num-cell">${fmtNum(m.pool)}</td>
                  <td class="right"><div class="admin-row-actions">${marketActions(m)}</div></td>
                </tr>`,
              )
              .join('')}</tbody></table></div>${allPage.nav ? `<div class="pad">${allPage.nav}</div>` : ''}`
          : '<p class="muted pad">No markets yet.</p>'
      }
    </section>`;
}

/** TestFPT setup: make the mint authority, give it test SOL, create the token. */
function tokenAdminSection(t) {
  if (!t?.enabled) return '';
  const net = t.cluster === 'devnet' ? 'Devnet' : 'Testnet';
  if (t.ready) {
    return `<section class="panel">
      <div class="section-head"><span class="section-ico">${ico('token')}</span><div><h2>TestFPT token <span class="pill pill-live"><span class="dot" aria-hidden="true"></span>Live</span></h2>
      <p class="muted">Players claim points as TestFPT on Solana ${net}.</p></div></div>
      ${t.lowFunds ? `<p class="form-error">The mint authority is almost out of test SOL (${t.authoritySol} SOL), so on-chain mints are paused. Send it test SOL: <code>${esc(t.authority)}</code> <a href="https://faucet.solana.com" target="_blank" rel="noopener noreferrer">faucet ${ico('external')}</a></p>` : ''}
      ${t.chain ? `<dl class="kpis-mini"><div><dt>Firstprint wallets</dt><dd>${fmtNum(t.chain.wallets)}</dd></div><div><dt>On-chain transactions</dt><dd>${fmtNum(t.chain.mintsConfirmed)}</dd></div><div><dt>Claims on chain</dt><dd>${fmtNum(t.chain.claimsConfirmed)}</dd></div><div><dt>Waiting</dt><dd>${fmtNum(t.chain.mintsWaiting)}</dd></div>${t.chain.mintsFailed ? `<div><dt>Failed</dt><dd>${fmtNum(t.chain.mintsFailed)}</dd></div>` : ''}<div><dt>Authority SOL</dt><dd>${t.authoritySol ?? '–'}</dd></div></dl>` : ''}
      <div class="kv"><span class="muted">Fee wallet: send test SOL here</span><span class="copy-row"><code>${esc(t.authority)}</code><button class="btn btn-sm" data-action="copy-text" data-text="${esc(t.authority)}">${ico('copy')}Copy</button>${t.authorityUrl ? `<a class="btn btn-sm" href="${esc(t.authorityUrl)}" target="_blank" rel="noopener noreferrer">Explorer ${ico('external')}</a>` : ''}<button class="btn btn-sm" data-action="admin-token-refresh">${ico('refresh')}Refresh</button></span></div>
      <p class="muted">This wallet pays every player’s network fee. Top it up on Solana ${net} from the <a href="https://faucet.solana.com" target="_blank" rel="noopener noreferrer">faucet</a> or your own wallet set to ${net}.</p>
      <div class="kv"><span class="muted">Token mint: never send SOL here</span><span class="copy-row"><code>${esc(t.mint)}</code><button class="btn btn-sm" data-action="copy-text" data-text="${esc(t.mint)}">${ico('copy')}Copy</button><a class="btn btn-sm" href="${esc(t.mintUrl)}" target="_blank" rel="noopener noreferrer">Explorer ${ico('external')}</a></span></div>
      ${saveKeysNote(t)}
      ${how(t.walletsOn ? 'Email and Google players get a Firstprint wallet; their rewards and every player’s daily streak are minted to their wallets by this server, which pays the fees. Players with their own wallet claim with one click and the server pays that fee too (they only sign if the server runs out of test SOL).' : 'Players pay the network fee in test SOL. Set WALLET_ENCRYPTION_KEY on the server to give email and Google players a Firstprint wallet.')}</section>`;
  }
  const sol = t.authoritySol;
  const check = (done) => `<span class="step-check" aria-hidden="true">${done ? ico('check') : ''}</span>`;
  return `<section class="panel">
    <div class="section-head"><span class="section-ico">${ico('token')}</span><div><h2>TestFPT token <span class="pill pill-off">Not set up</span></h2>
    <p class="muted">Until TestFPT exists, rewards go straight to players’ balances. Set it up once (Solana ${net}, free):</p></div></div>
    <ol class="steplist">
      <li class="${t.authority ? 'done' : ''}">${check(t.authority)}<div><b>Create the mint authority</b>
        <span class="muted">A key on this server that mints TestFPT when players claim. Keep this server’s database private.</span>
        ${t.authority ? `<span class="copy-row"><code>${esc(t.authority)}</code><button class="btn btn-sm" data-action="copy-text" data-text="${esc(t.authority)}">${ico('copy')}Copy</button></span>${saveKeysNote(t)}` : `<button class="btn btn-solid" data-action="admin-token-authority"${A.busy ? ' disabled' : ''}>${ico('key')}Create authority</button>`}</div></li>
      <li class="${sol ? 'done' : ''}">${check(sol)}<div><b>Give it test SOL</b>
        <span class="muted">Balance on ${net}: <b>${sol === null || sol === undefined ? 'unknown' : `${sol} SOL`}</b>${t.authorityUrl ? ` (<a href="${esc(t.authorityUrl)}" target="_blank" rel="noopener noreferrer">check on Explorer</a>)` : ''}. Paste the address above into the faucet and make sure its network menu says <b>${net}</b>, not Devnet or Mainnet. Then press Refresh balance.</span>
        ${t.balanceError ? `<span class="form-error">${esc(t.balanceError)}</span>` : ''}
        ${t.authority && sol === 0 ? `<span class="form-error">No SOL yet on ${net}. If the faucet said it sent SOL, it may have used another network, or it can take a minute.</span>` : ''}
        <span class="row-actions"><a class="btn" href="https://faucet.solana.com" target="_blank" rel="noopener noreferrer">${ico('droplet')}Open faucet ${ico('external')}</a><button class="btn" data-action="admin-token-airdrop"${t.authority && !A.busy ? '' : ' disabled'}>Request 1 SOL</button><button class="btn" data-action="admin-token-refresh">${ico('refresh')}Refresh balance</button></span></div></li>
      <li>${check(false)}<div><b>Create TestFPT</b>
        <span class="muted">Creates the token on chain, named TestFPT, with 0 decimals (1 point = 1 TestFPT).</span>
        <button class="btn btn-solid" data-action="admin-token-create"${t.authority && !A.busy ? '' : ' disabled'}>${ico('sparkles')}${A.busy === 'token' ? 'Working…' : 'Create TestFPT'}</button>
        ${t.authority && !sol ? '<span class="muted">You can try even if the balance shows unknown: if the SOL isn’t there, it will say so.</span>' : ''}</div></li>
    </ol></section>`;
}

/**
 * On a host without a disk (Render's free plan without backups), the database is wiped on restart and
 * the token setup with it. Saving the key and mint in the host's settings keeps them for good.
 */
function saveKeysNote(t) {
  const rows = [];
  if (t.authorityKey && !t.savedInEnv?.authority) rows.push(['TESTFPT_AUTHORITY_KEY', t.authorityKey]);
  if (t.mint && !t.savedInEnv?.mint) rows.push(['TESTFPT_MINT', t.mint]);
  if (t.authorityKeyHidden && !t.savedInEnv?.authority) return `<p class="muted">${ico('key')} The owner can see and save the TestFPT keys in Render.</p>`;
  // Both already in the host's settings: say so, so nobody goes looking for a key to copy.
  if (t.savedInEnv?.authority && t.savedInEnv?.mint) {
    return `<p class="keys-saved">${ico('check')}<span><b>Keys saved in Render</b> <span class="muted">TESTFPT_AUTHORITY_KEY and TESTFPT_MINT are set, so a restart can’t lose them.</span></span></p>`;
  }
  if (!rows.length) return '';
  return `<div class="save-keys">
    <b>${ico('key')}Save these in Render so a restart can’t lose them</b>
    <span class="muted">Render → firstprint-app → Environment → Add environment variable, one for each, then Save. Keep the key private: it can mint TestFPT.</span>
    ${rows.map(([k, v]) => `<span class="copy-row"><code>${k}</code><code class="secret">${esc(v)}</code><button class="btn btn-sm" data-action="copy-text" data-text="${esc(v)}">${ico('copy')}Copy</button></span>`).join('')}
  </div>`;
}

/** What each kind of problem is, in plain words, and the one-click fix where there is one. */
const ERROR_KINDS = {
  server_error: { label: 'Server error', help: 'A request crashed on the server. Send me the message and where it happened.' },
  email_failed: { label: 'Email', help: 'A sign-in email didn’t send. Check RESEND_API_KEY and your Resend plan’s daily limit.' },
  chain_unavailable: { label: 'Solana', help: 'The Solana testnet didn’t answer. Usually passes by itself.', fix: 'chain' },
  chain: { label: 'TestFPT sends', help: 'A TestFPT send or claim failed. Retry; if it keeps failing, check the token’s test SOL balance.', fix: 'chain' },
  backup: { label: 'Backup', help: 'A database copy to Supabase failed. Take one now; if it fails, check the Supabase keys in Render.', fix: 'backup' },
  telegram: { label: 'Telegram', help: 'A Telegram post or check failed. Check the bot token and that the bot is admin in the channel.' },
  email: { label: 'Email', help: 'An email didn’t send. Check RESEND_API_KEY and the Resend plan limits.' },
  x: { label: 'X checks', help: 'A check on X failed. Check the GetXAPI key and its credit.' },
  price: { label: 'Prices', help: 'A price lookup failed. Usually passes by itself; check the exchange or CoinGecko key if it repeats.' },
  app_crash: { label: 'App crash', help: 'Something broke in a player’s browser. Send me the message and page.' },
};
const SOURCE_LABEL = { server: 'Server', background: 'Background', app: 'Player’s app' };

function errorsView(data) {
  if (!data) return '<div class="empty"><p>Errors aren’t available on this server.</p></div>';
  const view = A.errView ?? 'open';
  const rows = data.errors;
  const tabs = `<div class="seg err-seg" role="tablist">${[['open', `Open${data.counts.open ? ` (${fmtNum(data.counts.open)})` : ''}`], ['fixed', 'Fixed']]
    .map(([id, label]) => `<button type="button" role="tab" data-action="admin-err-view" data-view="${id}" aria-selected="${view === id}">${label}</button>`)
    .join('')}</div>`;
  const head = `<section class="panel err-head">
      <div class="err-stats"><div><b class="mono">${fmtNum(data.counts.open)}</b><span class="muted">open problems</span></div><div><b class="mono">${fmtNum(data.counts.today)}</b><span class="muted">errors in the last 24 h</span></div></div>
      <div class="row-actions">${tabs}${view === 'open' && rows.length ? `<button class="btn btn-sm" data-action="admin-err-resolve-all">${ico('check')}Mark all fixed</button>` : ''}${view === 'fixed' && rows.length ? `<button class="btn btn-sm btn-danger" data-action="admin-err-clear">${ico('trash')}Clear fixed</button>` : ''}</div>
    </section>`;
  if (!rows.length) {
    return `${head}<div class="empty"><div class="empty-art">${ico(view === 'open' ? 'checkCircle' : 'history')}</div><p><strong>${view === 'open' ? 'No open problems.' : 'Nothing fixed yet.'}</strong><br />${view === 'open' ? 'Failed requests, failed background work and crashes in players’ apps show up here.' : ''}</p></div>`;
  }
  return `${head}<section class="panel panel-flush"><ul class="err-list">${rows
    .map((e) => {
      const kind = ERROR_KINDS[e.code] ?? { label: e.code.replace(/_/g, ' '), help: '' };
      const copy = `${kind.label} (${e.code}) · ${e.where ?? ''}\n${e.message}\nSeen ${e.count}×, last ${new Date(e.lastAt).toISOString()}${e.userId ? `\nPlayer ${e.userId}` : ''}${e.detail ? `\n\n${e.detail}` : ''}`;
      return `<li class="err-item">
        <div class="err-top"><span class="pill err-kind">${esc(kind.label)}</span><span class="muted err-src">${SOURCE_LABEL[e.source] ?? e.source}</span>${e.count > 1 ? `<span class="pill err-count mono">${fmtNum(e.count)}×</span>` : ''}<span class="muted err-when">${fmtAgo(e.lastAt)}</span></div>
        <p class="err-msg">${esc(e.message)}</p>
        ${e.where ? `<p class="fine err-where mono">${esc(e.where)}</p>` : ''}
        ${kind.help ? `<p class="fine err-help">${ico('info')}${esc(kind.help)}</p>` : ''}
        ${e.detail ? `<details class="err-detail"><summary>Details</summary><pre>${esc(e.detail)}</pre></details>` : ''}
        <div class="row-actions">
          ${kind.fix && view === 'open' ? `<button class="btn btn-sm btn-solid" data-action="admin-err-fix" data-kind="${kind.fix}" data-id="${e.id}">${ico('refresh')}${kind.fix === 'backup' ? 'Back up now' : 'Retry sends'}</button>` : ''}
          <button class="btn btn-sm" data-action="copy-text" data-text="${esc(copy)}">${ico('copy')}Copy for support</button>
          ${view === 'open' ? `<button class="btn btn-sm" data-action="admin-err-resolve" data-id="${e.id}">${ico('check')}Mark fixed</button>` : ''}
        </div>
      </li>`;
    })
    .join('')}</ul></section>`;
}

const TASK_TARGET_HINT = { follow: 'X handle, e.g. @firstprint', repost: 'Link to the post on X', like: 'Link to the post on X', share: 'Text of the post (the player’s invite link is added)', link: 'https:// link', telegram: 'Public channel, e.g. @firstprint' };

/** Tasks players complete for points: create, set a limit, switch off. */
/** Whether tasks are checked on X (GetXAPI): the credit left, the checks it pays for, and the checks used. */
function xCheckNote() {
  const x = A.xCheck;
  if (!x?.on) return `<section class="panel"><p class="muted x-check-note">${ico('info')} Tasks are honour-based. Set <code>GETXAPI_KEY</code> in Render to check follows, reposts and posts on X.</p></section>`;
  const low = x.credit !== null && x.credit < 1;
  const tile = (icon, color, label, value, sub) =>
    `<div class="stat-tile" style="--c:var(--${color})"><span class="tile-ico">${ico(icon)}</span><dt>${label}</dt><dd>${value}</dd><p>${sub}</p></div>`;
  return `<section class="panel x-usage">
    <div class="section-head"><span class="section-ico">${ico('x')}</span><div><h2>X checks <span class="pill ${low ? 'pill-hot' : 'pill-live'}">${low ? 'Low credit' : 'On'}</span></h2><p class="muted">Follow, repost and post tasks are checked on X before they pay. Likes stay honour-based.</p></div>${low ? '<a class="btn btn-sm head-action" href="https://getxapi.com" target="_blank" rel="noopener">Top up</a>' : ''}</div>
    <dl class="stat-tiles">
      ${tile('wallet', low ? 'down' : 'up', 'GetXAPI credit', x.credit !== null ? `$${x.credit.toFixed(2)}` : '–', x.credit !== null ? 'Balance on the account' : 'Couldn’t read the balance')}
      ${tile('checkCircle', low ? 'down' : 'brand', 'Checks left', x.credit !== null ? fmtNum(Math.floor(x.credit * 1000)) : '–', 'About $0.001 each')}
      ${tile('activity', 'brand', 'Used today', fmtNum(x.usage?.today ?? 0), 'Checks since 00:00 UTC')}
      ${tile('history', 'flat', 'Used in total', fmtNum(x.usage?.total ?? 0), `About $${((x.usage?.total ?? 0) / 1000).toFixed(2)} spent`)}
    </dl>
  </section>`;
}

/** Connect X reward: its points, and a reset that lets everyone link X and earn it again. */
function xConnectAdmin() {
  const x = A.xConnect;
  if (!x) return '';
  return `<section class="panel x-reset-bar">
    <span class="task-ico task-ico-sm">${ico('x')}</span>
    <div class="x-reset-text"><b>Connect X</b><span class="muted">${fmtNum(x.players)} earned +${fmtNum(x.points)}${x.round ? ' since the last reset' : ''}</span></div>
    <form id="admin-x-reset" class="x-reset-form" novalidate title="Reset clears every player’s linked X account, so each can link X again and earn these points. Points already given are kept; nothing is announced.">
      <label class="pts-field"><input name="points" type="number" min="1" max="10000" value="${x.points}" required aria-label="Points for linking X" /><span>pts</span></label>
      <button class="btn btn-sm" type="submit">${ico('refresh')}Reset for everyone</button>
    </form>
  </section>`;
}

function tasksAdminSection(tasks) {
  return `${xCheckNote()}
  <section class="panel">
    <div class="section-head"><span class="section-ico">${ico('plusCircle')}</span><div><h2>Add a task</h2></div></div>
    <form id="admin-task" class="admin-form task-form" novalidate>
      <label><span class="field-label">Type</span><select name="kind">
        <option value="follow">Follow on X</option><option value="repost">Repost on X</option><option value="like">Like on X</option><option value="share">Post on X (with invite link)</option><option value="link">Visit a link</option><option value="telegram">Join Telegram channel</option>
      </select></label>
      <label class="span-2"><span class="field-label">Target</span><input name="target" placeholder="${esc(TASK_TARGET_HINT.follow)}" required /></label>
      <label><span class="field-label">Title <span class="muted">(optional)</span></span><input name="title" maxlength="80" /></label>
      <label><span class="field-label">Points</span><input name="points" type="number" min="1" max="10000" value="50" required /></label>
      <label><span class="field-label">Limit <span class="muted">(players)</span></span><input name="maxCompletions" type="number" min="1" placeholder="No limit" /></label>
      <button class="btn btn-solid" type="submit">${ico('plus')}Add task</button>
    </form>
    ${how(A.xCheck?.on ? 'Players open the task, do it on X, then press Verify. Follow, repost and post tasks are checked on X through GetXAPI (about $0.001 a check); likes can’t be checked, so they stay honour-based. Players first prove their X username with a code in their bio, each X account can be verified by one Firstprint account only, and each task pays once per player.' : 'Players open the task, do it on X, then press Verify. Without GETXAPI_KEY it’s honour-based: each X username can only be linked to one account, and each task pays once per player.')}
  </section>
  ${xConnectAdmin()}
  <section class="panel panel-flush">
    <div class="section-head"><span class="section-ico">${ico('sparkles')}</span><h2>Tasks <span class="count-badge">${tasks.length}</span></h2></div>
    ${
      tasks.length
        ? `<div class="table-scroll"><table class="table"><thead><tr><th>Task</th><th class="right">Points</th><th>Completed</th><th class="right"></th></tr></thead><tbody>${tasks
            .map((t) => {
              const pct = t.maxCompletions ? Math.min(100, Math.round((t.completions / t.maxCompletions) * 100)) : null;
              return `<tr${t.active ? '' : ' class="row-off"'}>
                <td><span class="mkt-cell"><span class="task-ico task-ico-sm">${ico(TASK_ICONS[t.kind] ?? 'star')}</span><span><a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.title)}</a>${t.active ? '' : ' <span class="pill pill-off">Off</span>'}</span></span></td>
                <td class="right num-cell">+${fmtNum(t.points)}</td>
                <td><span class="progress-cell">${fmtNum(t.completions)}${t.maxCompletions ? ` / ${fmtNum(t.maxCompletions)}` : ''}${pct === null ? '' : `<span class="meter"><i style="width:${pct}%"></i></span>`}</span></td>
                <td class="right"><span class="row-actions"><button class="btn btn-sm" data-action="admin-task-edit" data-id="${esc(t.id)}">${ico('edit')}Edit</button><button class="btn btn-sm" data-action="admin-task-toggle" data-id="${esc(t.id)}" data-active="${t.active ? '1' : '0'}">${ico('power')}${t.active ? 'Switch off' : 'Switch on'}</button>${t.active ? `<button class="btn btn-sm" data-action="admin-task-reset" data-id="${esc(t.id)}" data-title="${esc(t.title)}" data-points="${t.points}">${ico('refresh')}Reset</button>` : `<button class="btn btn-sm btn-danger" data-action="admin-task-delete" data-id="${esc(t.id)}" data-title="${esc(t.title)}">${ico('trash')}Delete</button>`}</span></td>
              </tr>${
                A.editTask === t.id
                  ? `<tr class="row-edit"><td colspan="4"><form class="admin-form task-form" data-task-edit="${esc(t.id)}" novalidate>
                      <label class="span-2"><span class="field-label">Title</span><input name="title" maxlength="80" value="${esc(t.title)}" /></label>
                      <label><span class="field-label">Points</span><input name="points" type="number" min="1" max="10000" value="${t.points}" required /></label>
                      <label><span class="field-label">Limit <span class="muted">(players)</span></span><input name="maxCompletions" type="number" min="1" placeholder="No limit" value="${t.maxCompletions ?? ''}" /></label>
                      <span class="row-actions"><button class="btn btn-solid" type="submit">${ico('check')}Save</button><button class="btn" type="button" data-action="admin-task-edit" data-id="">Cancel</button></span>
                      <p class="muted fine span-all">Leave the limit empty so every player can do it. ${fmtNum(t.completions)} player${t.completions === 1 ? ' has' : 's have'} done it so far.</p>
                    </form></td></tr>`
                  : ''
              }`;
            })
            .join('')}</tbody></table></div>`
        : '<p class="muted pad">No tasks yet. Add one above.</p>'
    }
  </section>`;
}

const ADMIN_ACTIONS = {
  testfpt_created: 'Created the TestFPT token',
  task_created: 'Added a task',
  task_updated: 'Changed a task',
  market_drafted: 'Saved a draft',
  market_published: 'Published a market',
  market_unpublished: 'Moved a market back to drafts',
  market_edited: 'Edited a market',
  draft_deleted: 'Deleted a draft',
  market_deleted: 'Deleted a market',
  result_posted: 'Posted a result',
  market_voided: 'Settled as cancelled and refunded',
  market_cancelled: 'Cancelled and refunded a market',
  exchange_on: 'Switched an exchange on',
  exchange_off: 'Switched an exchange off',
  auto_listings_on: 'Switched automatic markets on',
  auto_listings_off: 'Switched automatic markets off',
  telegram_connected: 'Connected Telegram alerts',
  telegram_disconnected: 'Disconnected Telegram alerts',
  telegram_channel_on: 'Set the player Telegram channel',
  telegram_channel_off: 'Stopped posting to the Telegram channel',
  telegram_posted: 'Posted a market to the Telegram channel',
  telegram_posted_open: 'Posted open markets to the Telegram channel',
  telegram_posted_summary: 'Posted a “markets live” summary to the Telegram channel',
  team_member_added: 'Gave someone console access',
  team_member_removed: 'Removed someone’s console access',
  telegram_token_banners_on: 'Turned token banners on for the Telegram channel',
  telegram_token_banners_off: 'Turned token banners off for the Telegram channel',
};

/** The admin console for a team member who manages tasks only. */
async function renderTasksOnly(view) {
  let tasks = [];
  try {
    const data = await A.api.tasks();
    tasks = data.tasks;
    A.xCheck = { on: Boolean(data.xChecks), credit: data.xCredit ?? null, usage: data.xUsage ?? null };
    A.xConnect = data.xConnect ?? null;
  } catch (err) {
    view.innerHTML = `<div class="empty"><p><strong>Couldn’t load tasks.</strong><br />${esc(err.message)}</p></div>`;
    return;
  }
  view.innerHTML = `
    <div class="admin-shell">
      <aside class="admin-side" aria-label="Admin sections">
        <div class="admin-brand">${ico('shield')}<span>Team console</span></div>
        <nav class="admin-nav"><button type="button" aria-current="page">${ico('sparkles')}<span>Tasks</span></button></nav>
        <button class="btn admin-lock" data-action="admin-logout">${ico('lock')}Lock</button>
      </aside>
      <div class="admin-main">
        <header class="admin-top"><div><span class="eyebrow">Team · Tasks only</span><h1 class="page-title">Tasks</h1><p class="muted">Tasks players complete on X for points. Your role lets you add and edit tasks only.</p></div></header>
        ${tasksAdminSection(tasks)}
      </div>
    </div>`;
}

/** Settings → Team (owner only): give people admin-console access by email or wallet. */
function teamPanel(team) {
  const roleName = { admin: 'Admin', listings: 'Listings + tasks', tasks: 'Tasks only' };
  return `
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('user')}</span><div><h2>Team</h2><p class="muted">Who else can open this console.</p></div></div>
        ${
          team.length
            ? `<ul class="team-list">${team
                .map(
                  (m) => `<li><span class="team-who">${ico(m.kind === 'email' ? 'mail' : 'wallet')}<span>${esc(m.kind === 'wallet' ? shortAddress(m.value) : m.value)}</span></span><span class="pill ${m.role === 'admin' ? 'pill-hot' : m.role === 'listings' ? 'pill-live' : 'pill-off'}">${roleName[m.role]}</span><button class="btn btn-sm btn-danger" data-action="admin-team-remove" data-id="${m.id}" data-who="${esc(m.value)}">Remove</button></li>`,
                )
                .join('')}</ul>`
            : '<p class="muted">Nobody yet. Only you can open the console.</p>'
        }
        <div class="team-form">
          <input id="team-value" placeholder="Email or Solana wallet address" autocomplete="off" />
          <select id="team-role"><option value="listings">Listings + tasks</option><option value="tasks">Tasks only</option><option value="admin">Admin</option></select>
          <button class="btn btn-solid btn-sm" data-action="admin-team-add">${ico('plus')}Add</button>
        </div>
        ${how('They log in on the site with this email (Google or an email code) or with this wallet linked, then open Admin from the menu. <b>Admin</b>: everything except this list. <b>Listings + tasks</b>: review new listings, create, edit, publish and unpublish markets, post them to Telegram, and manage tasks (not results, refunds or settings). <b>Tasks only</b>: add and edit tasks.', 'What each role can do')}
      </section>`;
}

/** "MEXC, OKX and Gate" */
function listNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Settings: new listings from the watched exchanges (review queue, or automatic markets). */
/** Admin → Settings: the fee for taking a prediction back, and where it goes. */
function revertRulesPanel(d) {
  if (!d) return '';
  const r = d.rules;
  const t = d.totals;
  const pct = (bps) => Math.round(bps) / 100;
  const field = (name, label, value, step, max, unit) =>
    `<label><span class="field-label">${label}</span><span class="input-unit"><input name="${name}" type="number" min="0" max="${max}" step="${step}" value="${value}" required /><span>${unit}</span></span></label>`;
  return `<section class="panel">
    <div class="section-head"><span class="section-ico">${ico('undo')}</span><div><h2>Taking predictions back</h2>
      <p class="muted">${fmtNum(t.reverts)} taken back so far · ${fmtPts(t.burned)} burned · ${fmtPts(t.earlyPaid)} paid to early players.</p></div></div>
    <form class="admin-form admin-grid revert-form" data-revert-form>
      ${field('baseBps', 'Fee in the first half', pct(r.baseBps), 0.1, 100, '%')}
      ${field('maxBps', 'Fee at the close', pct(r.maxBps), 0.1, 90, '%')}
      ${field('burnBps', 'Share of the fee burned', pct(r.burnBps), 1, 100, '%')}
      ${field('undoMs', 'Free undo after placing', Math.round(r.undoMs / 60_000), 1, 60, 'min')}
      ${field('lockMs', 'No take-backs in the last', Math.round(r.lockMs / 60_000), 1, 240, 'min')}
      <button class="btn btn-solid" type="submit">${ico('check')}Save</button>
    </form>
    ${how('A player can take a prediction back until the lock before the close. In the first half of the prediction window the fee is the starting fee; in the second half it rises, slowly at first and steeply near the close, up to the fee at the close. The burned share is gone for good. The rest is shared at the result among predictions placed in the first half that stayed in, by stake, win or lose; if the market is cancelled it is burned too. Changes apply to take-backs from now on.')}
  </section>`;
}

function autoListingsPanel(a) {
  if (!a) return '';
  const where = !a.exchanges ? 'the watched exchanges' : a.exchanges.length ? listNames(a.exchanges) : 'no exchange (all are switched off under Reference exchanges)';
  return `
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('zap')}</span><div><h2>${a.mode === 'review' ? 'New listings' : 'Automatic markets'}</h2><p class="muted">Checks ${esc(where)} every 2 minutes.</p></div>
          <label class="toggle head-action"><input type="checkbox" data-action="admin-auto-listings"${a.enabled ? ' checked' : ''} /><span class="toggle-ui" aria-hidden="true"></span><span class="sr-only">Check for new listings</span></label></div>
        ${how(
          a.mode === 'review'
            ? 'Firstprint looks for new USDT listings and listing announcements. Each one shows under New listings in Overview and Markets (and on Telegram, if connected). A token that already has a market or is already waiting is not repeated. Review it to open a market with the start price, logo and description you choose. Switch an exchange off under Reference exchanges to stop checking it.'
            : `Firstprint opens a market for each new USDT listing by itself, up to ${a.perDay} a day. Predictions stay open until 1 hour after trading starts. The start price is the average of that first hour and the result comes ${a.hours} hours after listing, both from the exchange it listed on, with no admin needed. You can cancel any of them in Markets.`,
        )}
      </section>`;
}

/** The last things done in this panel, so a payout or cancellation can always be traced. */
/** Admin → User activity: every points movement, with the market, the pick, the stake and the win. */
function userActivityView(d) {
  const rows = d.entries ?? [];
  const what = (e) => {
    if (e.pick && e.market) {
      const pick = `<b style="color:${oVar(e.pick.bucket, false)}">${esc(oName(e.pick.bucket, false))}</b>`;
      const mk = `<a href="#/market/${encodeURIComponent(e.market.id)}">${esc(e.market.symbol)}</a>`;
      if (e.reason === 'stake') return `Predicted ${pick} on ${mk} <span class="muted">· ${fmtPts(e.pick.stake)} staked</span>`;
      if (e.reason === 'payout') return `Won on ${mk} with ${pick} <span class="muted">· ${fmtPts(e.pick.accepted ?? e.pick.stake)} in, ${fmtPts(e.delta)} out${(e.pick.accepted ?? 0) > 0 ? ` (${(e.delta / e.pick.accepted).toFixed(1)}×)` : ''}</span>`;
      if (e.reason === 'refund') return `Refund on ${mk} <span class="muted">· ${pick}</span>`;
      if (e.reason === 'revert') return `Took back ${pick} on ${mk} <span class="muted">· ${fmtPts(e.pick.stake)} staked, ${fmtPts(e.pick.stake - e.delta)} fee</span>`;
      if (e.reason === 'early_reward') return `Early player reward on ${mk} <span class="muted">· ${pick}</span>`;
    }
    return esc((HISTORY_LABELS[e.reason] ?? (() => e.reason))({ symbol: e.market?.symbol }));
  };
  return `<section class="panel panel-flush">
    <div class="section-head"><span class="section-ico">${ico('users')}</span><div><h2>User activity <span class="count-badge">${fmtNum(d.total ?? 0)}</span></h2><p class="muted">Predictions, wins, refunds, rewards and claims by every player, newest first.</p></div></div>
    <form class="act-search pad" data-form="admin-act-search"><input name="q" type="search" placeholder="Filter by player name" value="${esc(A.act?.q ?? '')}" autocomplete="off" /><button class="btn btn-sm" type="submit">${ico('search')}Filter</button>${A.act?.q ? '<button class="btn btn-sm" type="button" data-action="admin-act-clear">Clear</button>' : ''}</form>
    ${
      rows.length
        ? `<div class="table-scroll"><table class="table act-table"><thead><tr><th>When</th><th>Player</th><th>What</th><th class="right">Points</th></tr></thead><tbody>${rows
            .map(
              (e) => `<tr class="${e.reason === 'payout' ? 'act-win' : ''}"><td class="muted nowrap">${fmtAgo(e.at)}</td>
                <td><span class="act-who">${userLink(e.user.username)}<button class="act-only" type="button" data-action="admin-act-user" data-name="${esc(e.user.username)}" title="Show only this player" aria-label="Show only ${esc(e.user.username)}">${ico('search')}</button></span><small class="muted act-bal">${fmtNum(e.user.balance)} pts now</small></td>
                <td>${what(e)}</td>
                <td class="right num-cell ${e.delta >= 0 ? 'profit-pos' : 'dl-neg'}">${e.delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(e.delta))}</td></tr>`,
            )
            .join('')}</tbody></table></div>
          <div class="pad act-foot">${A.act?.all ? pager('adm-act', d.page, d.pages) : d.total > rows.length ? `<button class="btn" data-action="admin-act-all">See all ${fmtNum(d.total)}</button>` : ''}</div>`
        : `<p class="muted pad">${A.act?.q ? 'No activity for that player.' : 'No player activity yet.'}</p>`
    }
  </section>`;
}

function adminLogView(log, compact = false) {
  return `
    <section class="panel">
      <div class="section-head"><span class="section-ico">${ico('history')}</span><h2>${compact ? 'Recent activity' : 'Admin activity'}</h2>${compact && log.length ? '<button class="btn btn-sm head-action" data-action="admin-tab" data-tab="activity">See all</button>' : ''}</div>
      ${
        log.length
          ? `<ul class="timeline-list">${log
              .map(
                (e) =>
                  `<li><span class="tl-dot" aria-hidden="true"></span><div><b>${esc(ADMIN_ACTIONS[e.action] ?? e.action)}</b>${e.target ? ` <span class="muted">${esc(e.target)}</span>` : ''}${e.detail && !compact ? `<br><span class="muted">${esc(e.detail)}</span>` : ''}</div><span class="muted">${fmtAgo(e.at)}</span></li>`,
              )
              .join('')}</ul>`
          : '<p class="muted">Nothing yet. Every market change and result posted from this panel is recorded here.</p>'
      }
    </section>`;
}

function backupLine(b) {
  if (!b?.enabled) return '';
  const ok = b.lastOkAt && !b.lastError;
  return `<p class="backup-line ${ok ? 'ok' : b.lastError ? 'bad' : ''}" role="status">${ico(ok ? 'checkCircle' : b.lastError ? 'alert' : 'clock')}Database backup: ${
    b.lastError ? `failing (${esc(b.lastError)})` : b.lastOkAt ? `last saved ${fmtAgo(b.lastOkAt)}` : 'waiting for the first copy'
  }.</p>`;
}

function legacyAdminSections(venues, detected) {
  return `
    <section class="section">
      <h2>Create a live test market</h2>
      <p class="muted">Uses real prices for a token that already trades. Every selected exchange is checked first, and the market uses all that have a live USDT price.</p>
      <form id="admin-live" class="admin-form admin-grid">
        <label><span class="field-label">Token symbol</span><input name="symbol" list="suggested-tokens" placeholder="SOL" required autocomplete="off" /></label>
        <label><span class="field-label">Starts in</span>
          <select name="startsInMinutes">${[1, 2, 5, 10, 30].map((n) => `<option value="${n}"${n === 2 ? ' selected' : ''}>${n} minute${n === 1 ? '' : 's'}</option>`).join('')}</select>
        </label>
        <label><span class="field-label">Length</span>
          <select name="preset">${A.info.presets.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select>
        </label>
        <fieldset class="venues"><legend class="field-label">Exchanges</legend>
          ${venues.map((v) => `<label class="check"><input type="checkbox" name="exchanges" value="${esc(v.id)}"${v.id === 'sim' ? '' : ' checked'} /> ${esc(v.name)}</label>`).join('')}
        </fieldset>
        <div class="admin-actions"><button class="btn btn-solid" type="submit">Create market</button><span class="muted" id="admin-live-status" role="status"></span></div>
        <datalist id="suggested-tokens">${A.info.suggestedTokens.map((t) => `<option value="${esc(t.symbol)}">${esc(t.name)}</option>`).join('')}</datalist>
      </form>
      <div class="suggested">
        <span class="muted">Suggested:</span>
        ${A.info.suggestedTokens.map((t) => `<button class="btn" data-action="admin-quick" data-symbol="${esc(t.symbol)}" title="${esc(`${t.name}. ${t.note}`)}">${esc(t.symbol)}</button>`).join('')}
        <button class="btn btn-solid" data-action="admin-quick-all">Create all (15 min)</button>
      </div>
    </section>

    <section class="section">
      <div class="admin-head"><h2>Exchange connections</h2><button class="btn" data-action="admin-check">${A.busy === 'check' ? 'Checking…' : 'Run check'}</button></div>
      ${A.exCheck ? checksTable(A.exCheck.results) : '<p class="muted">Calls each exchange once for a BTC price, recent candles, the pair list, and announcements.</p>'}
    </section>

    <section class="section">
      <div class="admin-head"><h2>Detected listings</h2><button class="btn" data-action="admin-track">${A.busy === 'track' ? 'Scanning…' : 'Scan exchanges now'}</button></div>
      ${
        detected.length
          ? `<div class="admin-list">${detected
              .map(
                (d) => `
            <form class="admin-detect" data-detect="${d.id}">
              <div><b>${esc(d.symbol || '?')}</b> <span class="muted">${esc(d.exchangeName)}, ${d.source === 'announcement' ? 'announcement' : 'new pair'}</span><br>
                ${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.title || 'Announcement')}</a>` : `<span class="muted">${esc(d.title || '')}</span>`}</div>
              <label><span class="field-label">Symbol</span><input name="symbol" value="${esc(d.symbol || '')}" required /></label>
              <label><span class="field-label">Trading starts (your time)</span><input name="listingAt" type="datetime-local" value="${d.listingAt ? toLocalInput(d.listingAt) : ''}" required /></label>
              <div class="admin-actions"><button class="btn btn-solid" type="submit">Open market</button><button class="btn" type="button" data-action="admin-ignore" data-id="${d.id}">Ignore</button></div>
            </form>`,
              )
              .join('')}</div>`
          : '<p class="muted">Nothing waiting. New listings appear here after each scan.</p>'
      }
    </section>`;
}

/** Create / edit form for an admin-run market. Fields are locked once users have predicted. */
function marketForm(m, pre = null) {
  // pre: starting values for a new market (a listing from the review queue).
  const v = m ?? pre;
  const locked = Boolean(m && m.published && m.predictors > 0);
  const lock = locked ? ' disabled' : '';
  const t = v?.thresholds ?? { crash: -0.5, down: -0.1, up: 0.1, moon: 0.5 };
  const chosen = new Set(v?.venues ? v.venues.map((x) => x.id) : A.info.exchanges.filter((e) => e.enabled && !e.priceOnly).map((e) => e.id));
  const soon = closeAfter(OPEN_HOURS_DEFAULT);
  const pct = (n) => String(Math.round(n * 1000) / 10);
  // The start price: taken when predictions close (the default), a fixed price, or an upcoming token's opening price.
  const atClose = v ? Boolean(v.startAtClose) : true;
  const upcoming = Boolean(v) && v.basePrice == null && !atClose;
  const fixedPrice = !upcoming && !atClose;
  const openOn = pre?.openHours ?? (m ? null : OPEN_HOURS_DEFAULT);
  const resultOn = pre?.resultDays ?? (m ? null : RESULT_DAYS_DEFAULT);
  // A market priced from CoinGecko keeps its coin id (e.g. pudgy-penguins) as the "pair".
  const cgPair = pre?.pairs?.coingecko ?? m?.venues?.find((x) => x.id === 'coingecko')?.pair ?? null;
  const verifyUrl = pre?.verifyUrl ?? (cgPair ? TRADE_URLS.coingecko('', { pair: cgPair }) : null);
  return `
    <form id="admin-market" class="admin-form mf" data-id="${m ? esc(m.id) : ''}" data-published="${m?.published ? '1' : '0'}" data-outcomes="${m?.outcomes === 'binary' ? 'binary' : 'ladder'}">
      ${pre?.detectionId ? `<input type="hidden" name="detectionId" value="${pre.detectionId}" />` : ''}
      ${cgPair ? `<input type="hidden" name="pairs" value="${esc(JSON.stringify({ coingecko: cgPair }))}" />` : ''}
      <fieldset class="mf-type"${lock}><legend class="sr-only">Market type</legend>
        <label><input type="radio" name="outcomes" value="ladder"${m?.outcomes === 'binary' ? '' : ' checked'} /><span>${ico('trendUp')}Five outcomes</span></label>
        <label><input type="radio" name="outcomes" value="binary"${m?.outcomes === 'binary' ? ' checked' : ''} /><span>${ico('checkCircle')}Yes / No</span></label>
      </fieldset>
      <p class="mf-hint"><span class="ladder-only">Crash, Down, Flat, Up or Moon: how far the price moves from the start price.</span><span class="binary-only">Will the price be at or above a target price? Simplest for new players.</span></p>
      ${locked ? '<p class="mf-note">Players have already predicted, so the token, price, ranges and pool rules are locked. You can still change the description, exchanges and close time.</p>' : ''}

      <section class="mf-group">
        <h3 class="mf-h">Token</h3>
        <div class="mf-cols">
          <label><span class="field-label">Symbol</span><input name="symbol" placeholder="XYZ" value="${esc(v?.symbol ?? '')}" required autocomplete="off"${lock} /></label>
          <label><span class="field-label">Name <span class="muted">(optional)</span></span><input name="name" placeholder="XYZ Protocol" value="${esc(v?.name ?? '')}" autocomplete="off" /></label>
        </div>
        <div class="logo-field">
          <span class="field-label">Logo</span>
          <div class="logo-row">
            <span class="logo-preview" data-logo-preview>${v?.logoUrl ? `<img src="${esc(v.logoUrl)}" alt="" referrerpolicy="no-referrer" />` : ico('image')}</span>
            <input type="hidden" name="logoUrl" value="${esc(v?.logoUrl ?? '')}" />
            <input class="logo-link" data-logo-link type="url" inputmode="url" placeholder="Paste an image link (https://…)" value="${v?.logoUrl && !v.logoUrl.startsWith('data:') ? esc(v.logoUrl) : ''}" autocomplete="off" />
            <label class="btn btn-sm logo-upload">${ico('upload')}<span>Upload</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-logo-file hidden /></label>
            <button class="btn btn-sm" type="button" data-action="logo-find" title="Look the token up on CoinGecko by its ticker and name">${ico('search')}<span>Find</span></button>
            <button class="btn btn-sm" type="button" data-action="logo-clear"${v?.logoUrl ? '' : ' hidden'}>Remove</button>
          </div>
          <small class="logo-status" data-logo-status></small>
          <div class="logo-sources" data-logo-sources>${logoSources(v?.symbol ?? '', v?.name ?? '', [...chosen], v?.pairs ?? {}, pre?.detectionId)}</div>
          <small class="muted" title="On CoinGecko, right-click the token’s logo and choose “Copy image address”.">Square works best. A copy is saved, so the logo keeps working if the link changes.</small>
        </div>
      </section>

      <section class="mf-group">
        <h3 class="mf-h">Price and timing</h3>
        <div class="mf-cols mf-cols-3">
          <label><span class="field-label"><span class="ladder-only">Start price (USD)</span><span class="binary-only">Target price (USD)</span></span><input name="basePrice" type="number" step="any" min="0" placeholder="${upcoming ? 'Set when trading opens' : atClose ? 'Taken at the close' : '0.25'}" value="${fixedPrice ? (v?.basePrice ?? '') : ''}"${fixedPrice ? ' required' : ' disabled'}${lock} /></label>
          <label><span class="field-label">Predictions close</span><input name="closeAt" type="datetime-local" value="${toLocalInput(v?.closeAt ?? soon)}" required /><small class="utc-hint" data-utc-for="closeAt"></small></label>
          <label><span class="field-label">Result</span><input name="resultAt" type="datetime-local" value="${toLocalInput(v?.settleAt ?? soon + RESULT_DAYS_DEFAULT * 86_400_000)}" required /><small class="utc-hint" data-utc-for="resultAt"></small></label>
        </div>
        <div class="mf-presets" role="group" aria-label="How long predictions stay open">
          <span class="muted">Predictions open</span>${OPEN_PRESETS.map((h) => `<button type="button" class="chip-btn${openOn === h ? ' on' : ''}" data-action="admin-open-for" data-hours="${h}" aria-label="${h} hours">${h}h</button>`).join('')}
        </div>
        <div class="mf-presets" role="group" aria-label="When the result comes">
          <span class="muted">Result after</span>${RESULT_PRESETS.map((d) => `<button type="button" class="chip-btn${resultOn === d ? ' on' : ''}" data-action="admin-result-after" data-days="${d}" aria-label="${d} days">${d} days</button>`).join('')}
        </div>
        <label class="check start-close-check"${upcoming ? ' hidden' : ''}><input type="checkbox" name="startAtClose" data-start-close${atClose ? ' checked' : ''}${lock} /> <b>Start price is the price when predictions close</b> <span class="muted">(recommended)</span></label>
        <details class="adm-how start-close-how"${upcoming ? ' hidden' : ''}><summary>Why at the close</summary><p>The result is measured from the moment predictions close, so a token that climbs while predictions are open gives nobody an edge. The price is read by itself from the market’s sources in the minutes before the close; if they don’t answer, you’re asked for it. Untick it only for a fixed target price.</p></details>
        ${verifyUrl ? `<p class="mf-verify">${ico('checkCircle')}The start price will be the CoinGecko price when predictions close. <a href="${esc(verifyUrl)}" target="_blank" rel="noopener noreferrer">See it on CoinGecko ${ico('external')}</a></p>` : ''}
        <div class="upcoming-opt"${cgPair ? ' hidden' : ''}>
          <label class="check upcoming-check"><input type="checkbox" name="upcoming" data-upcoming${upcoming ? ' checked' : ''}${lock} /> Upcoming token: not trading yet</label>
          <details class="adm-how"><summary>How upcoming works</summary><p>No price needed now: set predictions to close when trading starts. Once the token trades, its opening price (from its first minutes of trading) is read from the exchange and becomes the start price by itself. You’re asked for the result only when it is due.</p></details>
          <div class="auto-open"${upcoming && !(m && m.published) ? '' : ' hidden'}>
            <label class="check"><input type="checkbox" name="autoOpen" data-auto-open${v?.autoOpenAt ? ' checked' : ''} /> <b>Open by itself when trading starts</b></label>
            <label class="auto-open-at"${v?.autoOpenAt ? '' : ' hidden'}><span class="field-label">Trading starts</span><input name="autoOpenAt" type="datetime-local" value="${toLocalInput(v?.autoOpenAt ?? v?.listingStart ?? soon)}" /><small class="utc-hint" data-utc-for="autoOpenAt"></small></label>
            <details class="adm-how"><summary>How this works</summary><p>The market waits as a draft. Once the token has traded for 3 minutes (checked against those minutes, so an opening spike is skipped), predictions open, with the channel post. The start price is the price when predictions close. You get a Telegram message either way. Needs the logo, and predictions must stay open at least 30 minutes after trading starts.</p></details>
          </div>
        </div>
        <p class="mf-fine">Times are in your time zone. Predictions stay open at most ${OPEN_HOURS_MAX} hours (an upcoming token closes when it lists), then the market counts down to its result.</p>
      </section>

      <section class="mf-group">
        <h3 class="mf-h">Exchanges</h3>
        <fieldset class="venues"><legend class="sr-only">Reference exchanges</legend>
          ${A.info.exchanges
            .filter((e) => (e.enabled && !e.priceOnly) || chosen.has(e.id))
            .map((e) => `<label class="check"><input type="checkbox" name="exchanges" value="${esc(e.id)}"${chosen.has(e.id) ? ' checked' : ''} /> ${esc(e.name)}</label>`)
            .join('')}
        </fieldset>
        <div class="mf-tools">
          <button class="btn btn-sm" type="button" data-action="admin-price-check" title="Compares the start price and timing with what these exchanges show right now">${ico('activity')}Check live price</button>
          ${A.info.telegram?.channel ? `<button class="btn btn-sm" type="button" data-action="admin-banner-preview" title="What the channel post will look like. Check the logo is this token’s.">${ico('telegram')}Preview banner</button>` : ''}
        </div>
        <div id="price-check-out" aria-live="polite"></div>
        ${A.info.telegram?.channel ? '<div id="banner-preview-out" class="banner-check" aria-live="polite"></div>' : ''}
      </section>

      <section class="mf-group">
        <h3 class="mf-h">Shown to players</h3>
        <label><span class="sr-only">Description and result rules</span>
          <textarea name="note" rows="3" maxlength="2000" placeholder="Description and result rules, e.g. Result is the XYZ/USDT closing price on Binance at 12:00 UTC.">${esc(v?.note ?? '')}</textarea></label>
      </section>

      <details class="mf-more">
        <summary>Outcome ranges and pool rules</summary>
        <div class="mf-cols mf-cols-3">
          <p class="muted binary-only" style="grid-column:1/-1;margin:0">Yes/No markets ignore the ranges: Yes wins at or above the target price.</p>
          <label><span class="field-label">Crash at or below (%)</span><input name="crash" type="number" step="any" value="${pct(t.crash)}"${lock} /></label>
          <label><span class="field-label">Down at or below (%)</span><input name="down" type="number" step="any" value="${pct(t.down)}"${lock} /></label>
          <label><span class="field-label">Up at or above (%)</span><input name="up" type="number" step="any" value="${pct(t.up)}"${lock} /></label>
          <label><span class="field-label">Moon at or above (%)</span><input name="moon" type="number" step="any" value="${pct(t.moon)}"${lock} /></label>
          <label><span class="field-label">Fee (%)</span><input name="fee" type="number" step="any" min="0" max="20" value="${(m?.feeBps ?? 400) / 100}"${lock} /></label>
          <label><span class="field-label">Pool limit (points)</span><input name="softCap" type="number" min="100" step="1" value="${m?.softCap ?? 50000}"${lock} /></label>
        </div>
      </details>

      <div class="admin-actions mf-actions">
        ${
          m
            ? `<button class="btn btn-solid" type="submit" name="intent" value="save">Save changes</button>
               ${m.published ? '' : '<button class="btn btn-solid" type="submit" name="intent" value="publish">Save and publish</button>'}
               <button class="btn" type="button" data-action="admin-edit-cancel">Stop editing</button>`
            : `<button class="btn btn-solid" type="submit" name="intent" value="publish">${ico('send')}Publish market</button>
               <button class="btn" type="submit" name="intent" value="draft">${ico('edit')}Save as draft</button>
               ${pre ? '<button class="btn" type="button" data-action="admin-edit-cancel">Back to the list</button>' : ''}`
        }
      </div>
    </form>`;
}

/** One awaiting-result market: enter the final price, preview winners, then confirm. */
function resultForm(m) {
  const p = A.preview?.id === m.id ? A.preview : null;
  const v = p?.inputs ?? {};
  const s = p?.summary;
  const yn = isYesNo(m);
  const dist = bucketsOf(m).map((b) => `${oName(b, yn)} ${fmtNum(m.totals[b])}`).join(' · ');
  return `
    <form class="admin-detect admin-result" data-resolve="${esc(m.id)}">
      <div><b>${esc(m.symbol)}</b> <span class="muted">${esc(venueNames(m))}</span><br>
        <span class="muted">Start price ${hasStart(m) ? fmtPrice(m.basePrice) : '<b>not set yet</b>'} · Pool ${fmtPts(m.pool)} from ${m.predictors} participant${m.predictors === 1 ? '' : 's'} · ${dist}</span><br>
        <span class="muted">${bucketsOf(m).map((b) => `${oName(b, yn)} ${rangeOf(m, b)}`).join(' · ')}</span></div>
      ${
        hasStart(m)
          ? ''
          : `<label><span class="field-label">${m.startAtClose ? 'Start price at the close (USD)' : 'Opening price (USD)'}</span><input name="basePrice" type="number" step="any" min="0" value="${esc(v.basePrice ?? '')}" placeholder="${m.startAtClose ? `Price at ${esc(fmtDate(m.closeAt))}` : 'First trade price'}" />${m.startAtClose ? '' : liveFillButton(m, 'basePrice')}</label>`
      }
      <label><span class="field-label">Final price (USD)</span><input name="finalPrice" type="number" step="any" min="0" value="${esc(v.finalPrice ?? '')}"${hasStart(m) ? ' required' : ''} />${liveFillButton(m, 'finalPrice')}</label>
      <label><span class="field-label">Winning outcome</span>
        <select name="winningBucket"><option value="">Pick from the price (recommended)</option>${bucketsOf(m).map((b) => `<option value="${b}"${v.winningBucket === b ? ' selected' : ''}>${oName(b, yn)}</option>`).join('')}</select></label>
      <label style="grid-column:1/-1"><span class="field-label">Note shown to users (optional)</span><input name="note" maxlength="2000" value="${esc(v.note ?? '')}" placeholder="e.g. Binance XYZ/USDT close at 12:00 UTC" /></label>
      ${
        s
          ? `<div class="admin-preview" style="grid-column:1/-1">
              <p><b>Preview:</b> ${fmtPrice(s.basePrice)} → ${fmtPrice(s.finalPrice)} is <b>${fmtPct(s.returnPct)}</b>, ${s.voidReason ? `so the market would be <b>cancelled and refunded</b> (${esc(VOID_REASONS[s.voidReason] ?? s.voidReason)})` : `so <b>${oName(s.winningBucket, yn)}</b> wins${s.overridden ? ` (you overrode ${oName(s.computedBucket, yn)} from the price)` : ''}`}.</p>
              <p class="muted">${s.voidReason ? '' : `${s.winnerCount} winner${s.winnerCount === 1 ? '' : 's'} share ${fmtPts(s.netPool)} (pool ${fmtPts(s.pool)} minus ${fmtPts(s.fee)} fee).`}</p>
              ${s.winners.length ? `<ul class="activity">${s.winners.slice(0, 10).map((w) => `<li><span>${esc(w.username)} picked ${outcome(w.bucket, yn)}</span><span class="muted">${fmtPts(w.stake)} → <b>${fmtPts(w.payout)}</b></span></li>`).join('')}</ul>` : ''}
            </div>`
          : ''
      }
      <div class="admin-actions" style="grid-column:1/-1">
        ${hasStart(m) ? '' : `<button class="btn" type="submit" name="intent" value="start">${m.startAtClose ? 'Save start price' : 'Save opening price'}</button>`}
        <button class="btn${s ? '' : ' btn-solid'}" type="submit" name="intent" value="preview">Preview result</button>
        ${s ? '<button class="btn btn-solid" type="submit" name="intent" value="resolve">Confirm and pay winners</button>' : ''}
        <button class="btn" type="button" data-action="admin-cancel" data-id="${esc(m.id)}">Cancel and refund</button>
      </div>
    </form>`;
}

/** "Use live price" under a price field: fills it with the median live price from the market's exchanges. */
function liveFillButton(m, field) {
  // Each source's own pair (a CoinGecko market's is its coin id, not the ticker).
  const pairs = Object.fromEntries(m.venues.filter((x) => x.pair).map((x) => [x.id, x.pair]));
  return `<button class="btn btn-sm live-fill" type="button" data-action="admin-live-fill" data-symbol="${esc(m.symbol)}" data-exchanges="${esc(m.venues.map((x) => x.id).join(','))}" data-pairs="${esc(JSON.stringify(pairs))}" data-field="${field}">${ico('activity')}Use live price</button>`;
}

async function fillLivePrice(el) {
  const input = el.closest('form')?.querySelector(`[name=${el.dataset.field}]`);
  if (!input) return;
  const label = el.innerHTML;
  el.disabled = true;
  el.textContent = 'Getting price…';
  try {
    const { prices } = await A.api.priceCheck({ symbol: el.dataset.symbol, exchanges: el.dataset.exchanges.split(',').filter(Boolean), pairs: JSON.parse(el.dataset.pairs || '{}') });
    const live = prices.filter((p) => p.price !== null).map((p) => p.price).sort((a, b) => a - b);
    if (!live.length) throw new Error(`No live price for ${el.dataset.symbol} right now (${prices.map((p) => `${p.name}: ${p.error || 'not trading'}`).join(', ')}).`);
    const median = live[Math.floor((live.length - 1) / 2)];
    input.value = String(median);
    toast(`Filled ${fmtPrice(median)} from ${prices.filter((p) => p.price !== null).map((p) => p.name).join(', ')}.`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    el.disabled = false;
    el.innerHTML = label;
  }
}

// --- Find tokens: new exchange listings and what is trending, ready to become markets ---------

/** Where each exchange (and the two big trackers) list their new tokens, for checking by hand. */
const LISTING_PAGES = {
  binance: 'https://www.binance.com/en/support/announcement/list/48',
  bybit: 'https://announcements.bybit.com/en/?category=new_crypto',
  okx: 'https://www.okx.com/help/section/announcements-new-listings',
  mexc: 'https://www.mexc.com/newlisting',
  gate: 'https://www.gate.io/announcements/newlisted',
  bitget: 'https://www.bitget.com/support/sections/5955813039257',
  kucoin: 'https://www.kucoin.com/announcement/new-listings',
};
const TRACKER_PAGES = [
  ['CoinGecko · Trending', 'https://www.coingecko.com/en/highlights/trending-crypto'],
  ['CoinGecko · New coins', 'https://www.coingecko.com/en/new-cryptocurrencies'],
  ['CoinMarketCap · Trending', 'https://coinmarketcap.com/trending-cryptocurrencies/'],
  ['CoinMarketCap · New coins', 'https://coinmarketcap.com/new/'],
];
const roundUpHour = (t) => Math.ceil(t / 3_600_000) * 3_600_000;

/**
 * Market timing: predictions stay open up to three days, then the market counts down to its result,
 * 7, 15 or 30 days after the close, measured from the price at the close.
 */
const OPEN_PRESETS = [24, 48, 72];
const OPEN_HOURS_DEFAULT = 72;
/** The most predictions can stay open on a token that is already trading (the server checks it too). */
const OPEN_HOURS_MAX = 72;
const RESULT_PRESETS = [7, 15, 30];
const RESULT_DAYS_DEFAULT = 15;
/**
 * When predictions close if they open for `hours` from now: rounded down to the quarter hour (on the
 * server's clock), so it never goes past the three-day limit.
 */
const closeAfter = (hours, from = now()) => Math.floor((from + hours * 3_600_000) / 900_000) * 900_000;
/** An open market whose predictions close more than three days away: made before the limit. */
const openTooLong = (m) =>
  m.mode === 'manual' && m.status === 'open' && m.published && m.phase === 'baseline' && !(m.basePrice == null && !m.startAtClose) && m.closeAt - now() > (OPEN_HOURS_MAX * 60 + 5) * 60_000;

async function loadDiscover(key, fetcher) {
  A.discover = { ...(A.discover ?? {}), [key]: { loading: true } };
  if (A.tab === 'discover') $('#discover-root').outerHTML = discoverView();
  try {
    const data = await fetcher();
    A.discover[key] = { data, at: Date.now() };
  } catch (err) {
    A.discover[key] = { error: err.message };
  }
  if (A.tab === 'discover' && $('#discover-root')) $('#discover-root').outerHTML = discoverView();
}

const pctChip = (r) => (r == null ? '' : `<span class="disc-chg ${r >= 0 ? 'up' : 'down'}">${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)}%</span>`);
const usd = (n) => (n == null ? '–' : fmtPrice(n));

function discoverView() {
  const d = A.discover ?? {};
  const exchanges = (A.info.exchanges ?? []).filter((e) => !e.priceOnly);
  const venue = A.discoverVenue;
  const ex = venue ? d[`ex:${venue}`] : null;
  const exName = exchanges.find((e) => e.id === venue)?.name ?? venue;
  const tr = d.trending;
  const exRows = (ex?.data?.listings ?? [])
    .map((l, i) => {
      const chg = l.openPrice && l.price ? l.price / l.openPrice - 1 : null;
      return `<tr>
        <td><b>${esc(l.symbol)}</b>${l.name ? `<small class="muted">${esc(l.name)}</small>` : ''}</td>
        <td class="hide-sm">${l.listingAt ? `${fmtDate(l.listingAt)}${l.listingAt > Date.now() ? ` · in ${until(l.listingAt)}` : ''}` : '<span class="muted">Not published</span>'}</td>
        <td class="right num-cell">${usd(l.openPrice)}</td>
        <td class="right num-cell">${usd(l.price)} ${pctChip(chg)}</td>
        <td class="right">${l.marketId ? `<button class="btn btn-sm" data-action="admin-edit" data-id="${esc(l.marketId)}">Has a market</button>` : A.made?.[l.symbol.toUpperCase()] ? `<span class="disc-made">${ico('checkCircle')}Market made</span>` : `<button class="btn btn-sm btn-gold" data-action="admin-discover-make" data-src="ex" data-i="${i}">Make market</button>`}</td>
      </tr>`;
    })
    .join('');
  const trRows = (tr?.data?.coins ?? [])
    .map(
      (c, i) => `<tr>
        <td><span class="disc-tok">${c.logo ? `<img src="${esc(c.logo)}" alt="" referrerpolicy="no-referrer" loading="lazy" />` : ''}<span><b>${esc(c.symbol)}</b><small class="muted">${esc(c.name)}${c.rank ? ` · #${c.rank}` : ''}</small></span></span></td>
        <td class="right num-cell">${usd(c.priceUsd)}</td>
        <td class="right hide-sm">${pctChip(c.change24h)}</td>
        <td class="right"><a class="btn btn-sm" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${ico('external')}</a> ${A.made?.[c.symbol.toUpperCase()] ? `<span class="disc-made">${ico('checkCircle')}Market made</span>` : `<button class="btn btn-sm btn-gold" data-action="admin-discover-make" data-src="cg" data-i="${i}">Make market</button>`}</td>
      </tr>`,
    )
    .join('');
  const state = (s, empty) => (!s ? '' : s.loading ? '<p class="muted">Loading…</p>' : s.error ? `<p class="form-error">${esc(s.error)}</p>` : empty);
  return `<div id="discover-root" class="discover">
    <section class="panel">
      <div class="section-head"><span class="section-ico">${ico('zap')}</span><div><h2>New on exchanges</h2><p class="muted">Pick an exchange to see what it listed this week.</p></div></div>
      <div class="disc-ex">${exchanges
        .map(
          (e) => `<span class="disc-ex-item${venue === e.id ? ' on' : ''}"><button class="btn btn-sm" data-action="admin-discover-exchange" data-venue="${esc(e.id)}"${venue === e.id ? ' aria-pressed="true"' : ''}>${esc(e.name)}</button>${LISTING_PAGES[e.id] ? `<a class="icon-btn" href="${LISTING_PAGES[e.id]}" target="_blank" rel="noopener noreferrer" aria-label="${esc(e.name)} listings page">${ico('external')}</a>` : ''}</span>`,
        )
        .join('')}</div>
      ${
        ex
          ? state(ex, exRows
            ? `<div class="table-scroll"><table class="table disc-table"><thead><tr><th>${esc(exName)}</th><th class="hide-sm">Trading starts</th><th class="right">Open</th><th class="right">Now</th><th></th></tr></thead><tbody>${exRows}</tbody></table></div>`
            : `<p class="muted">Nothing found on ${esc(exName)} this week. New listings are checked every few minutes on the exchanges switched on in Settings; use the arrow to check its page by hand.</p>`)
          : ''
      }
    </section>
    <section class="panel">
      <div class="section-head"><span class="section-ico">${ico('flame')}</span><div><h2>Trending now</h2><p class="muted">From CoinGecko. “Make market” fills in everything; you only check the price.</p></div><button class="btn btn-sm" data-action="admin-discover-trending">${ico('refresh')}${tr?.data ? 'Refresh' : 'Fetch trending'}</button></div>
      ${state(tr, trRows ? `<div class="table-scroll"><table class="table disc-table"><thead><tr><th>Token</th><th class="right">Price</th><th class="right hide-sm">24h</th><th></th></tr></thead><tbody>${trRows}</tbody></table></div><p class="fine">From CoinGecko${tr?.data ? `, ${fmtAgo(tr.data.fetchedAt)}` : ''}.</p>` : '<p class="muted">CoinGecko returned no tokens.</p>')}
    </section>
    <section class="panel">
      <div class="section-head"><span class="section-ico">${ico('external')}</span><div><h2>Look by hand</h2><p class="muted">Opens in a new tab.</p></div></div>
      <div class="disc-links">${TRACKER_PAGES.map(([label, href]) => `<a class="btn btn-sm" href="${href}" target="_blank" rel="noopener noreferrer">${esc(label)} ${ico('external')}</a>`).join('')}</div>
    </section>
  </div>`;
}

/** Fills the Create market form from a found token, after checking which exchanges trade it now. */
async function makeFromDiscovery(el) {
  const i = Number(el.dataset.i);
  const now = Date.now();
  const hour = 3_600_000;
  let pre;
  if (el.dataset.src === 'ex') {
    const l = A.discover?.[`ex:${A.discoverVenue}`]?.data?.listings?.[i];
    if (!l) return;
    const upcoming = Boolean(l.listingAt && l.listingAt > now);
    const closeAt = upcoming ? l.listingAt : closeAfter(OPEN_HOURS_DEFAULT);
    pre = {
      symbol: l.symbol,
      name: l.name ?? '',
      venues: [{ id: l.exchange }],
      basePrice: null,
      startAtClose: !upcoming,
      openHours: upcoming ? null : OPEN_HOURS_DEFAULT,
      resultDays: RESULT_DAYS_DEFAULT,
      closeAt,
      settleAt: closeAt + RESULT_DAYS_DEFAULT * 24 * hour,
      listingStart: upcoming ? l.listingAt : null,
      note: upcoming
        ? `New on ${l.exchangeName}. The start price is the ${l.exchangeName} ${l.symbol}/USDT opening price, and the result is its price at the result time.`
        : `New on ${l.exchangeName}. The start price is the ${l.exchangeName} ${l.symbol}/USDT price when predictions close, and the result is its price at the result time.`,
    };
  } else {
    // Trending on CoinGecko: everything comes from CoinGecko (name, logo, live price), so the token
    // needn't trade on any of our exchanges. The admin only checks the price and publishes.
    const c = A.discover?.trending?.data?.coins?.[i];
    if (!c) return;
    const closeAt = closeAfter(OPEN_HOURS_DEFAULT);
    pre = {
      symbol: c.symbol,
      name: c.name,
      logoUrl: c.logo ?? '',
      venues: [{ id: 'coingecko' }],
      pairs: { coingecko: c.id },
      verifyUrl: c.url,
      trending: true,
      basePrice: null,
      startAtClose: true,
      openHours: OPEN_HOURS_DEFAULT,
      resultDays: RESULT_DAYS_DEFAULT,
      closeAt,
      settleAt: closeAt + RESULT_DAYS_DEFAULT * 24 * hour,
      note: `Trending on CoinGecko. The start price is the CoinGecko price when predictions close; the result is the CoinGecko price at the result time.`,
    };
  }
  A.prefill = { ...pre, from: 'discover' };
  A.review = null;
  A.edit = null;
  A.tab = 'create';
  await renderAdmin();
  window.scrollTo({ top: 0 });
  findLogo($('#admin-market'));
}

/** Starting values for a market made from a detected listing. */
function reviewPrefill(d) {
  const now = Date.now();
  const hour = 3_600_000;
  const upcoming = Boolean(d.listingAt && d.listingAt > now);
  // Upcoming: predictions close when trading starts. Already trading: predictions stay open two days.
  const closeAt = upcoming ? d.listingAt : closeAfter(OPEN_HOURS_DEFAULT);
  const pair = `${d.symbol}/USDT`;
  return {
    detectionId: d.id,
    symbol: d.symbol,
    name: d.name ?? '',
    venues: [{ id: d.exchange }],
    basePrice: null,
    startAtClose: !upcoming,
    openHours: upcoming ? null : OPEN_HOURS_DEFAULT,
    resultDays: RESULT_DAYS_DEFAULT,
    closeAt,
    settleAt: closeAt + RESULT_DAYS_DEFAULT * 24 * hour,
    listingStart: upcoming ? d.listingAt : null,
    note: `New on ${d.exchangeName}. The start price is the ${d.exchangeName} ${pair} ${upcoming ? 'opening price' : 'price when predictions close'}, and the result is the ${d.exchangeName} ${pair} price at the result time.`,
  };
}

/** New exchange listings waiting for the admin: review (opens the market form filled in) or skip. */
function listingsList(pending) {
  const now = Date.now();
  const when = (d) => (!d.listingAt ? 'Start time not published' : d.listingAt > now ? `Trading starts ${fmtDate(d.listingAt)} · in ${until(d.listingAt)}` : `Trading started ${fmtDate(d.listingAt)}`);
  const skipAll = pending.length > 1 ? `<div class="todo-bar"><span class="muted">${fmtNum(pending.length)} waiting</span><button class="btn btn-sm" data-action="admin-review-ignore-all">${ico('forward')}Skip all</button></div>` : '';
  return `${skipAll}<ul class="todo">${pending
    .map(
      (d) => `<li style="--c:var(--${d.listingAt && d.listingAt > now ? 'up' : 'warn'})"><span class="todo-ico">${ico('coins')}</span><div><b>${esc(d.symbol || '?')}${d.name ? ` <span class="muted">${esc(d.name)}</span>` : ''}</b><span class="muted">${esc(d.exchangeName)} · ${when(d)}</span></div>
        <span class="todo-actions"><button class="btn btn-sm btn-solid" data-action="admin-review" data-id="${d.id}">Review</button><button class="btn btn-sm" data-action="admin-review-ignore" data-id="${d.id}">Skip</button></span></li>`,
    )
    .join('')}</ul>`;
}

/** Settings: Telegram alerts for new listings and markets that need a result. */
function telegramPanel(t) {
  if (!t) return '';
  let body;
  if (!t.configured)
    body = `<ol class="tg-steps">
        <li>In Telegram, open <b>@BotFather</b>, send <code>/newbot</code> and follow the steps. It gives you a bot token.</li>
        <li>In Render, open the firstprint service → <b>Environment</b>, add <code>TELEGRAM_BOT_TOKEN</code> with that token, and save. Keep the token private: don’t paste it anywhere else.</li>
        <li>When the server has restarted, come back here to link your chat.</li>
      </ol>`;
  else if (!t.connected) {
    A.tgCode ??= `FP-${String(Math.floor(100000 + Math.random() * 900000))}`;
    body = `<ol class="tg-steps">
        <li>In Telegram, open your bot and press <b>Start</b>.</li>
        <li>Send it this code: <code class="tg-code">${A.tgCode}</code></li>
        <li>Then click Connect.</li>
      </ol>
      <div class="admin-actions"><button class="btn btn-solid btn-sm" data-action="admin-tg-connect">${ico('send')}Connect</button></div>`;
  } else
    body = `<p class="all-good">${ico('checkCircle')}Connected. New listings and markets that need a result are sent to your chat.</p>
      <div class="admin-actions"><button class="btn btn-sm" data-action="admin-tg-test">${ico('send')}Send a test alert</button><button class="btn btn-sm" data-action="admin-tg-disconnect">Disconnect</button></div>`;
  const channel = t.configured
    ? `
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('telegram')}</span><div><h2>Player channel</h2><p class="muted">The public channel where markets and results are posted.</p></div></div>
        ${
          t.channel
            ? `<p class="all-good">${ico('checkCircle')}Posting to <a href="https://t.me/${esc(t.channel)}" target="_blank" rel="noopener noreferrer">@${esc(t.channel)}</a></p>
               ${t.unposted ? `<p class="muted"><b>${t.unposted} open market${t.unposted === 1 ? ' hasn’t' : 's haven’t'} been posted yet</b> (made before the channel was set up).</p>` : ''}
               <div class="admin-actions"><button class="btn btn-solid btn-sm" data-action="admin-tg-summary" title="One post with every open market, soonest to close first">${ico('telegram')}Post live markets</button>${t.unposted ? `<button class="btn btn-sm" data-action="admin-tg-post-open">${ico('telegram')}Post ${t.unposted === 1 ? 'it' : `all ${t.unposted}`} now</button>` : ''}${t.open && t.open > t.unposted ? `<button class="btn btn-sm" data-action="admin-tg-post-open" data-again="1">${ico('telegram')}Post all ${t.open} open markets again</button>` : ''}<button class="btn btn-sm" data-action="admin-tg-channel-remove">Stop posting</button></div>
               <div class="toggle-grid"><label class="toggle"><input type="checkbox" data-action="admin-token-banners"${t.tokenBanners ? ' checked' : ''} /><span class="toggle-ui" aria-hidden="true"></span>Token banners</label></div>
               ${how(`Every market you publish is posted with a banner and a “Predict now” button, a reminder goes out in its last hour, and results with a winner are posted (cancelled markets are not). ${t.tokenBanners ? 'Token banners on: each post gets the token’s own banner with its logo and ticker. A ticker the banner font can’t draw (such as Chinese) falls back to the fixed banner. Check it with “Preview banner” on the market form.' : 'Token banners off: new markets use the fixed banner, and reminders and results are text only.'} Players see a Telegram button on market pages, their dashboard and the menu.`)}`
            : `<ol class="tg-steps">
                <li>In Telegram, create a <b>New Channel</b>, make it <b>Public</b> and give it a link, like <code>firstprint_markets</code>.</li>
                <li>Open the channel → <b>Administrators</b> → <b>Add Admin</b>, pick your bot, and leave <b>Post Messages</b> on.</li>
                <li>Enter the channel name here and save. A welcome message is posted to check it works.</li>
              </ol>
              <div class="tg-channel-form"><input id="tg-channel" placeholder="@firstprint_markets" autocomplete="off" /><button class="btn btn-solid btn-sm" data-action="admin-tg-channel-save">Save channel</button></div>`
        }
      </section>`
    : '';
  return `
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('bell')}</span><div><h2>Telegram alerts</h2><p class="muted">Messages to you for new listings and results to post.</p></div></div>
        ${body}
      </section>${channel}`;
}

/** Row actions: the everyday one stays visible, the rest (cancel, delete, Telegram…) sit in a "⋯" menu. */
function marketActions(m) {
  const btn = (action, icon, label, cls = '') => `<button class="btn btn-sm${cls}" data-action="${action}" data-id="${esc(m.id)}">${ico(icon)}${label}</button>`;
  const item = (action, icon, label, cls = '') => `<button type="button" class="row-menu-item${cls}" data-action="${action}" data-id="${esc(m.id)}">${ico(icon)}${label}</button>`;
  const manualOpen = m.mode === 'manual' && m.status === 'open';
  const main = [];
  const more = [];
  if (manualOpen && !m.published) main.push(btn('admin-publish', 'send', 'Publish', ' btn-solid'));
  if (manualOpen) main.push(btn('admin-edit', 'edit', 'Edit'));
  if (manualOpen && m.published && m.phase === 'baseline') more.push(item('admin-close-now', 'lock', 'Close predictions now'));
  if (manualOpen && m.published && m.predictors === 0) more.push(item('admin-unpublish', 'eye', 'Unpublish'));
  if (A.info.telegram?.channel && m.status === 'open' && m.published && m.kind !== 'live_test') more.push(item('admin-tg-post', 'telegram', 'Post to Telegram'));
  if (manualOpen && !m.published) more.push(item('admin-delete', 'trash', 'Delete draft', ' danger'));
  if (canAdmin('admin') && (m.status === 'open' || m.status === 'locked') && (m.published || m.mode !== 'manual')) more.push(item('admin-cancel', 'undo', 'Cancel and refund', ' danger'));
  // A published market nobody predicted on, or one cancelled and refunded, can be removed for good.
  if (canAdmin('admin') && (m.published || m.mode !== 'manual') && (m.status === 'void' || m.predictors === 0)) more.push(item('admin-delete-market', 'trash', 'Delete market', ' danger'));
  if (more.length) main.push(`<details class="row-menu"><summary class="btn btn-sm" aria-label="More actions for ${esc(m.symbol)}">${ico('more')}</summary><div class="row-menu-list">${more.join('')}</div></details>`);
  return main.join('');
}

function adminPhasePill(m) {
  const text = esc(adminPhase(m));
  if (m.phase === 'draft' && m.autoOpenAt) {
    const due = m.autoOpenAt > now();
    return `<span class="pill pill-hot">${ico('clock')}${due ? `Opens by itself in <span data-until="${m.autoOpenAt}">${fmtDur(m.autoOpenAt - now())}</span>` : 'Opening: checking prices'}</span>${m.autoOpenNote ? `<small class="muted auto-note">${esc(m.autoOpenNote)}</small>` : ''}`;
  }
  if (m.phase === 'draft') return `<span class="pill pill-off">${text}</span>${m.autoOpenNote ? `<small class="muted auto-note">${esc(m.autoOpenNote)}</small>` : ''}`;
  if (m.phase === 'awaiting_result') return `<span class="pill pill-hot">${text}</span>${m.autoOpenNote ? `<small class="muted auto-note">${esc(m.autoOpenNote)}</small>` : ''}`;
  if (m.status === 'resolved') return `<span class="pill pill-done">${isYesNo(m) ? `Settled: ${oName(m.result?.winningBucket, true)}` : text}</span>`;
  if (m.status === 'void') return `<span class="pill pill-off">${text}</span>`;
  return `<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>${text}</span>`;
}

function adminPhase(m) {
  if (m.mode === 'manual') {
    if (m.phase === 'draft') return 'Draft, not published';
    if (m.phase === 'baseline') return `Open, closes ${fmtDate(m.closeAt)} (in ${fmtDur(m.closeAt - now())})`;
    if (m.phase === 'awaiting_result' && m.basePrice == null && !/not found/i.test(m.autoOpenNote ?? '')) return m.startAtClose ? 'Reading the price at the close' : 'Reading the opening price';
    if (m.phase === 'awaiting_result' && m.basePrice != null && m.settleAt > now()) return `Closed, result due ${fmtDate(m.settleAt)}`;
    if (m.phase === 'awaiting_result') return 'Awaiting your result';
  }
  return { pre_listing: `Starts in ${fmtDur(m.listingAt - now())}`, baseline: 'Open, trading', running: `Running, ${fmtDur(m.settleAt - now())} left`, resolved: `Settled: ${NAMES[m.result?.winningBucket] ?? ''}`, void: 'Cancelled' }[m.phase] ?? m.phase;
}

const VERDICTS = {
  works: ['pass', 'Works'],
  blocked: ['fail', 'Blocked here'],
  partial: ['fail', 'Partly works'],
  down: ['fail', 'Not reachable'],
};

function checksTable(results) {
  const cell = (c) => `<td class="${c.ok === null ? 'muted' : c.ok ? 'pass' : 'fail'}" title="${esc(c.detail)}">${c.ok === null ? '–' : c.ok ? 'Pass' : 'Fail'}<small>${esc(String(c.detail).slice(0, 60))}</small></td>`;
  const verdict = (r) => {
    const [cls, label] = VERDICTS[r.verdict] ?? ['muted', '–'];
    return `<td class="${cls}"><b>${label}</b></td>`;
  };
  return `<div class="table-scroll"><table class="table checks"><thead><tr><th>Exchange</th><th>Result</th><th>Live price</th><th>Candles</th><th>Pairs</th><th>Announcements</th></tr></thead><tbody>${results
    .map((r) => `<tr><td><b>${esc(r.name)}</b></td>${verdict(r)}${cell(r.ticker)}${cell(r.candles)}${cell(r.pairs)}${cell(r.announcements)}</tr>`)
    .join('')}</tbody></table></div>`;
}

/** One exchange: the verdict, and what failed if anything did. */
function exCheckRow(r) {
  const [cls, label] = VERDICTS[r.verdict] ?? ['muted', '–'];
  const parts = [['Live price', r.ticker], ['Candles', r.candles], ['New pairs', r.pairs], ['Announcements', r.announcements]];
  const failed = parts.filter(([, c]) => c.ok === false);
  const why = r.verdict === 'works'
    ? parts.filter(([, c]) => c.ok).map(([n]) => n).join(' · ')
    : failed.map(([n, c]) => `${n}: ${String(c.detail).slice(0, 70)}`).join(' · ');
  return `<li><b>${esc(r.name)}</b><span class="ex-verdict ${cls}">${label}</span><small class="muted">${esc(why)}</small></li>`;
}

/** Settings → Exchange check: which exchanges answer this server, before turning more of them on. */
function exchangeCheckPanel() {
  const c = A.exCheck;
  const blocked = c ? c.results.filter((r) => r.verdict === 'blocked').map((r) => r.name) : [];
  const works = c ? c.results.filter((r) => r.verdict === 'works').map((r) => r.name) : [];
  const summary = !c
    ? how('Calls every exchange once from this server (a BTC price, recent candles, the pair list and announcements) to see which ones new listings could come from. Takes up to 15 seconds.')
    : `<p class="checks-note ok">${ico('checkCircle')}Works from this server: ${works.length ? esc(works.join(', ')) : 'none'}.</p>
       ${blocked.length ? `<p class="checks-note">${ico('alert')}Blocked from this server's location: ${esc(blocked.join(', '))}. These exchanges refuse servers in some countries (such as the US). A server in another region, such as Singapore or Frankfurt, can reach them.</p>` : ''}
       <ul class="ex-check">${c.results.map(exCheckRow).join('')}</ul>
       <p class="muted">Checked ${fmtAgo(c.at)}.</p>`;
  return `<section class="panel">
        <div class="section-head"><span class="section-ico">${ico('activity')}</span><div><h2>Exchange check</h2><p class="muted">Which exchanges this server can reach.</p></div><button class="btn btn-sm head-action" data-action="admin-check"${A.busy === 'check' ? ' disabled' : ''}>${ico('refresh')}${A.busy === 'check' ? 'Checking…' : 'Run check'}</button></div>
        ${summary}
      </section>`;
}

function toLocalInput(ts) {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

async function adminCreate(body, statusEl) {
  if (statusEl) statusEl.textContent = `Checking ${body.symbol} on exchanges…`;
  try {
    const out = await A.api.createLive(body);
    const msg = `${body.symbol.toUpperCase()} created with ${out.exchanges.map((e) => e.name).join(', ')}`;
    if (statusEl) statusEl.textContent = msg;
    toast(msg);
    return out;
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message;
    toast(err.message, true);
    return null;
  }
}

async function onAdminAction(action, el) {
  if (!A.api) return;
  const tokenStep = { 'admin-token-authority': 'authority', 'admin-token-airdrop': 'airdrop', 'admin-token-create': 'create' }[action];
  if (tokenStep) {
    A.busy = 'token';
    await renderAdmin();
    try {
      await A.api.tokenStep(tokenStep);
      if (tokenStep === 'create') toast('TestFPT created. Claims are on.');
      if (tokenStep === 'airdrop') toast('Requested 1 test SOL. It can take a few seconds to show.');
    } catch (err) {
      toast(err.message, true);
    }
    A.busy = '';
    return renderAdmin();
  }
  switch (action) {
    case 'admin-back': {
      // Back to the previous admin tab (or Overview), leaving any half-filled form behind.
      const prev = A.history?.length ? A.history.pop() : 'overview';
      A.goingBack = true;
      A.tab = prev;
      A.edit = null;
      A.review = null;
      A.prefill = null;
      await renderAdmin();
      return window.scrollTo({ top: 0 });
    }
    case 'admin-tab':
      // The sidebar and "New market" always start clean (Make market and Edit set these themselves).
      A.tab = el.dataset.tab;
      A.edit = null;
      A.review = null;
      A.prefill = null;
      await renderAdmin();
      return window.scrollTo({ top: 0 });
    case 'admin-token-refresh':
      return renderAdmin();
    case 'admin-task-edit':
      A.editTask = el.dataset.id || null;
      return renderAdmin();
    case 'admin-err-view':
      A.errView = el.dataset.view;
      return renderAdmin();
    case 'admin-err-resolve':
      try {
        await A.api.resolveError(el.dataset.id);
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-old-csv':
      try {
        const { csv } = await A.api.oldResultsCsv();
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `firstprint-old-results-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    case 'admin-old-clear':
    case 'admin-old-clear-all': {
      const all = el.dataset.action === 'admin-old-clear-all';
      if (!confirm(all ? 'Clear every old result? Download the sheet first if you want a copy. Players keep their wins and stats.' : 'Clear this market? Players keep their wins and stats.')) return;
      el.disabled = true;
      try {
        const out = await A.api.clearOldResults(all ? undefined : [el.dataset.id]);
        toast(`Cleared ${out.archived + out.deleted} market${out.archived + out.deleted === 1 ? '' : 's'}`);
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    }
    case 'admin-act-all':
      A.act = { ...(A.act ?? {}), all: true, page: 1 };
      return renderAdmin();
    case 'admin-act-user':
      A.act = { page: 1, all: true, q: el.dataset.name };
      return renderAdmin();
    case 'admin-act-clear':
      A.act = { page: 1, all: false, q: '' };
      return renderAdmin();
    case 'admin-err-resolve-all':
      if (!confirm('Mark every open problem as fixed? New ones still show up.')) return;
      try {
        await A.api.resolveAllErrors();
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-err-clear':
      try {
        await A.api.clearFixedErrors();
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-err-fix': {
      el.disabled = true;
      el.textContent = 'Working…';
      try {
        const out = await A.api.fixError(el.dataset.kind);
        await A.api.resolveError(el.dataset.id);
        toast(out.message ?? 'Done');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    }
    case 'admin-task-delete':
      if (!confirm(`Delete "${el.dataset.title}"? It disappears from the list. Points it already paid stay with the players.`)) return;
      try {
        await A.api.deleteTask(el.dataset.id);
        toast('Task deleted');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-task-reset':
      if (!confirm(`Reset "${el.dataset.title}" for everyone? Every player can do it again and earn ${fmtNum(Number(el.dataset.points))} points, with no player limit. Points already given are kept.`)) return;
      try {
        await A.api.resetTask(el.dataset.id);
        toast('Task reset: open to everyone again');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-task-toggle':
      try {
        await A.api.updateTask(el.dataset.id, { active: el.dataset.active !== '1' });
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-logout':
      // Stays locked for this page, even for an admin account, until the page is reloaded.
      A.locked = true;
      A.api = null;
      A.info = null;
      A.checks = null;
      A.exCheck = null;
      A.edit = null;
      A.preview = null;
      saveAdminKey('');
      return renderAdmin();
    case 'admin-check':
      A.busy = 'check';
      await renderAdmin();
      try {
        A.exCheck = { at: Date.now(), results: (await A.api.checkExchanges()).results };
      } catch (err) {
        toast(err.message, true);
      }
      A.busy = '';
      return renderAdmin();
    case 'admin-track':
      A.busy = 'track';
      await renderAdmin();
      try {
        await A.api.track();
      } catch (err) {
        toast(err.message, true);
      }
      A.busy = '';
      return renderAdmin();
    case 'admin-quick':
      await adminCreate({ symbol: el.dataset.symbol, preset: 'quick', startsInMinutes: 2 }, $('#admin-live-status'));
      return renderAdmin();
    case 'admin-quick-all': {
      el.disabled = true;
      let ok = 0;
      for (const t of A.info.suggestedTokens) if (await adminCreate({ symbol: t.symbol, name: t.name, preset: 'quick', startsInMinutes: 2 }, $('#admin-live-status'))) ok++;
      toast(`${ok} of ${A.info.suggestedTokens.length} markets created`);
      return renderAdmin();
    }
    case 'admin-ignore':
      await A.api.ignore(Number(el.dataset.id));
      return renderAdmin();
    case 'admin-auto-listings':
      try {
        await A.api.setAutoListings(el.checked);
        A.info = await A.api.ping();
        toast(el.checked ? 'Automatic markets are on.' : 'Automatic markets are off. Markets already made keep running.');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-exchange':
      try {
        await A.api.setExchange(el.dataset.id, el.checked);
        A.info = await A.api.ping();
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-open-for':
    case 'admin-result-after': {
      // Predictions open N hours from now; the result N days after the close (kept when the close moves).
      const form = el.closest('form');
      const closeIn = form.querySelector('[name=closeAt]');
      const resultIn = form.querySelector('[name=resultAt]');
      const days = Number(el.dataset.days ?? form.querySelector('[data-action="admin-result-after"].on')?.dataset.days ?? RESULT_DAYS_DEFAULT);
      const close = el.dataset.hours ? closeAfter(Number(el.dataset.hours)) : inputMs(closeIn.value);
      if (!Number.isFinite(close)) return toast('Choose when predictions close first.', true);
      closeIn.value = toLocalInput(close);
      resultIn.value = toLocalInput(close + days * 86_400_000);
      form.querySelectorAll(`[data-action="${el.dataset.action}"]`).forEach((b) => b.classList.toggle('on', b === el));
      updateUtcHints();
      return;
    }
    case 'admin-inbox':
      A.inbox = el.dataset.pane;
      el.closest('.adm-inbox')?.querySelectorAll('[data-pane]').forEach((x) => {
        if (x.matches('[role=tab]')) x.setAttribute('aria-selected', String(x === el));
        else x.hidden = x.dataset.pane !== A.inbox;
      });
      return;
    case 'admin-recheck':
      A.checks = null;
      return renderAdmin();
    case 'admin-price-check':
      return runPriceCheck();
    case 'admin-banner-preview':
      return runBannerPreview();
    case 'admin-team-add': {
      const value = $('#team-value')?.value.trim();
      const role = $('#team-role')?.value;
      if (!value) return toast('Enter an email or a wallet address.', true);
      if (role === 'admin' && !confirm(`Give ${value} admin access? They can create, publish, settle and cancel markets and change settings.`)) return;
      try {
        await A.api.teamAdd(value, role);
        toast(`${value} added`);
      } catch (err) {
        return toast(err.message, true);
      }
      return renderAdmin();
    }
    case 'admin-team-remove':
      if (!confirm(`Remove ${el.dataset.who}'s access?`)) return;
      try {
        await A.api.teamRemove(el.dataset.id);
        toast('Access removed');
      } catch (err) {
        return toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-token-banners':
      try {
        await A.api.setTokenBanners(el.checked);
        A.info = await A.api.ping();
        toast(el.checked ? 'Each market now gets its own banner on Telegram.' : 'Token banners are off. New markets use the fixed banner.');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-use-price': {
      const form = $('#admin-market');
      const up = form?.querySelector('[data-upcoming]');
      if (up?.checked) {
        up.checked = false;
        up.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const close = form?.querySelector('[data-start-close]');
      if (close?.checked && !close.disabled) {
        close.checked = false;
        close.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const input = form?.querySelector('[name=basePrice]');
      if (input && !input.disabled) input.value = el.dataset.price;
      return runPriceCheck();
    }
    case 'admin-edit':
      A.edit = el.dataset.id;
      A.tab = 'create';
      await renderAdmin();
      return window.scrollTo({ top: 0 });
    case 'admin-review':
      A.review = A.detected?.find((d) => d.id === Number(el.dataset.id)) ?? null;
      A.edit = null;
      A.tab = 'create';
      await renderAdmin();
      window.scrollTo({ top: 0 });
      return findLogo($('#admin-market'));
    case 'admin-maint':
      return adminMaintenance(el.dataset.on === '1');
    case 'admin-top-up':
      return adminTopUp(el.dataset.amount);
    case 'admin-review-ignore-all': {
      const n = A.detected?.length ?? 0;
      if (!confirm(`Skip all ${n} listings? They leave the list and no markets are made.`)) return;
      try {
        const out = await A.api.ignoreAll();
        toast(`Skipped ${out.skipped} listing${out.skipped === 1 ? '' : 's'}`);
      } catch (err) {
        toast(err.message, true);
      }
      A.review = null;
      return renderAdmin();
    }
    case 'admin-review-ignore':
      if (!confirm('Skip this listing? It leaves the list and no market is made.')) return;
      try {
        await A.api.ignore(Number(el.dataset.id));
      } catch (err) {
        toast(err.message, true);
      }
      if (A.review?.id === Number(el.dataset.id)) A.review = null;
      return renderAdmin();
    case 'admin-live-fill':
      return fillLivePrice(el);
    case 'admin-tg-connect':
      try {
        await A.api.telegramConnect(A.tgCode);
        A.info = await A.api.ping();
        toast('Telegram connected. Check your chat for a message.');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-tg-test':
      try {
        await A.api.telegramTest();
        toast('Test alert sent. Check Telegram.');
      } catch (err) {
        toast(err.message, true);
      }
      return;
    case 'admin-tg-channel-save':
    case 'admin-tg-channel-remove': {
      const value = action === 'admin-tg-channel-save' ? $('#tg-channel')?.value.trim() : '';
      if (action === 'admin-tg-channel-save' && !value) return toast('Enter the channel name, like @firstprint_markets.', true);
      if (action === 'admin-tg-channel-remove' && !confirm('Stop posting new markets to the channel?')) return;
      el.disabled = true;
      try {
        await A.api.telegramChannel(value);
        A.info = await A.api.ping();
        toast(value ? 'Channel saved. Check it for the welcome message.' : 'Stopped posting to the channel.');
      } catch (err) {
        toast(err.message, true);
        el.disabled = false;
        return;
      }
      return renderAdmin();
    }
    case 'admin-tg-post':
      if (!confirm('Post this market to the Telegram channel now?')) return;
      el.disabled = true;
      try {
        await A.api.telegramPost(el.dataset.id);
        toast('Posted to the channel.');
        A.info = await A.api.ping();
      } catch (err) {
        toast(err.message, true);
      }
      el.disabled = false;
      return;
    case 'admin-tg-summary': {
      if (!confirm('Post a “markets live” summary to the Telegram channel now?')) return;
      el.disabled = true;
      try {
        const { count } = await A.api.telegramPostSummary();
        toast(`Posted: ${count} market${count === 1 ? '' : 's'} live`);
      } catch (err) {
        toast(err.message, true);
      }
      el.disabled = false;
      return;
    }
    case 'admin-tg-post-open': {
      el.disabled = true;
      try {
        const again = el.dataset.again === '1';
        if (again && !confirm('Post every open market to the channel again, even ones already posted?')) {
          el.disabled = false;
          return;
        }
        const { count } = await A.api.telegramPostOpen(again);
        toast(count ? `Queued ${count} post${count === 1 ? '' : 's'}, a few seconds apart. If any fail, the count here stays up.` : 'Everything is posted already.');
        setTimeout(async () => {
          A.info = await A.api.ping().catch(() => A.info);
          if (A.tab === 'settings') renderAdmin();
        }, count * 3_600 + 2_000);
      } catch (err) {
        toast(err.message, true);
        el.disabled = false;
      }
      return;
    }
    case 'admin-viz-days':
      S.vizDays = Number(el.dataset.days);
      return renderAdmin();
    case 'admin-analytics-share':
    case 'admin-analytics-off': {
      const on = action === 'admin-analytics-share';
      if (!confirm(on ? 'Create a new share link? Any old link stops working.' : 'Turn off the share link? Partners will no longer see the stats.')) return;
      try {
        await A.api.analyticsShare(on);
        toast(on ? 'Share link ready. Copy it below.' : 'Share link turned off.');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    }
    case 'admin-copy-share': {
      const input = $('#viz-share-url');
      try {
        await navigator.clipboard.writeText(input.value);
        toast('Link copied');
      } catch {
        input.select();
        toast('Press Ctrl+C (or ⌘C) to copy');
      }
      return;
    }
    case 'admin-tg-disconnect':
      if (!confirm('Stop sending alerts to this Telegram chat?')) return;
      await A.api.telegramDisconnect().catch((err) => toast(err.message, true));
      A.info = await A.api.ping();
      return renderAdmin();
    case 'admin-discover-trending':
      return loadDiscover('trending', () => A.api.trending());
    case 'admin-discover-exchange':
      A.discoverVenue = el.dataset.venue;
      return loadDiscover(`ex:${el.dataset.venue}`, () => A.api.exchangeNew(el.dataset.venue));
    case 'admin-discover-make':
      return makeFromDiscovery(el);
    case 'admin-edit-cancel':
      A.tab = A.prefill?.from === 'discover' ? 'discover' : 'markets';
      A.review = null;
      A.prefill = null;
      A.edit = null;
      return renderAdmin();
    case 'admin-publish':
    case 'admin-unpublish':
    case 'admin-delete':
      if (action === 'admin-delete' && !confirm('Delete this draft?')) return;
      if (action === 'admin-publish' && !confirm('Publish this market? Users will be able to predict straight away.')) return;
      try {
        if (action === 'admin-publish') await A.api.publish(el.dataset.id);
        else if (action === 'admin-unpublish') await A.api.unpublish(el.dataset.id);
        else await A.api.deleteDraft(el.dataset.id);
        toast(action === 'admin-publish' ? 'Market published' : action === 'admin-unpublish' ? 'Market moved back to drafts' : 'Draft deleted');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-delete-market':
      if (!confirm('Delete this market for good? It disappears from the app and can’t be brought back.')) return;
      try {
        await A.api.deleteMarket(el.dataset.id);
        toast('Market deleted');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-close-start':
    case 'admin-close-start-all': {
      // A fixed start price becomes the price when predictions close (markets nobody has predicted on).
      const ids = el.dataset.ids ? el.dataset.ids.split(',') : [el.dataset.id];
      const sym = ids.length === 1 ? ((A.markets ?? []).find((m) => m.id === ids[0])?.symbol ?? 'this market') : `${ids.length} markets`;
      if (!confirm(`Use the price at the close as the start price for ${sym}?\n\nThe fixed start price is removed. When predictions close, the live price is read by itself and locked.`)) return;
      let done = 0;
      for (const id of ids) {
        try {
          await A.api.useCloseStart(id);
          done++;
        } catch (err) {
          toast(err.message, true);
        }
      }
      if (done) toast(`${done === 1 ? sym : `${done} markets`} now take${done === 1 ? 's' : ''} the start price at the close`);
      A.checks = null;
      return renderAdmin();
    }
    case 'admin-close-now':
    case 'admin-close-24':
    case 'admin-close-all': {
      // Older markets open for days: close predictions now or in 24 hours. The result date stays.
      const hours = el.dataset.action === 'admin-close-24' ? 24 : Number(el.dataset.hours ?? 0);
      const ids = el.dataset.action === 'admin-close-all' ? (A.markets ?? []).filter(openTooLong).map((m) => m.id) : [el.dataset.id];
      const what = ids.length === 1 ? `${(A.markets ?? []).find((m) => m.id === ids[0])?.symbol ?? 'this market'}` : `${ids.length} markets`;
      if (!ids.length || !confirm(`${hours ? `Close predictions on ${what} in 24 hours?` : `Close predictions on ${what} now?`}\n\nPlayers keep their predictions and the result date stays the same.`)) return;
      let done = 0;
      for (const id of ids) {
        try {
          await A.api.closePredictions(id, hours);
          done++;
        } catch (err) {
          toast(err.message, true);
        }
      }
      if (done) toast(hours ? `${done === 1 ? what : `${done} markets`} close in 24 hours` : `Predictions closed on ${done === 1 ? what : `${done} markets`}`);
      return renderAdmin();
    }
    case 'admin-cancel':
      if (!confirm('Cancel this market and refund every prediction?')) return;
      try {
        await A.api.cancel(el.dataset.id);
        if (A.preview?.id === el.dataset.id) A.preview = null;
        toast('Market cancelled and refunded');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
  }
}

async function onAdminSubmit(form, submitter) {
  if (form.matches('.topup-custom')) return adminTopUp(new FormData(form).get('amount'));
  if (form.matches('[data-maint-form]')) return adminMaintenance(!S.maint?.on);
  if (form.matches('[data-revert-form]')) {
    const d = Object.fromEntries(new FormData(form));
    try {
      await A.api.setRevertRules({
        baseBps: Math.round(Number(d.baseBps) * 100),
        maxBps: Math.round(Number(d.maxBps) * 100),
        burnBps: Math.round(Number(d.burnBps) * 100),
        undoMs: Math.round(Number(d.undoMs) * 60_000),
        lockMs: Math.round(Number(d.lockMs) * 60_000),
      });
      toast('Take-back rules saved');
    } catch (err) {
      toast(err.message, true);
    }
    return renderAdmin();
  }
  if (form.id === 'admin-login') {
    const key = String(new FormData(form).get('key') || '');
    A.api = createAdminApi(key);
    try {
      A.info = await A.api.ping();
      saveAdminKey(key);
    } catch (err) {
      A.api = null;
      toast(err.status === 403 ? 'That admin key is wrong.' : err.message, true);
    }
    return renderAdmin();
  }
  if (form.id === 'admin-market') return submitAdminMarket(form, submitter?.value || 'save');
  if (form.id === 'admin-task') {
    const data = Object.fromEntries(new FormData(form));
    try {
      await A.api.createTask({ ...data, points: Number(data.points), maxCompletions: data.maxCompletions ? Number(data.maxCompletions) : null });
      toast('Task added');
      return renderAdmin();
    } catch (err) {
      return toast(err.message, true);
    }
  }
  if (form.id === 'admin-x-reset') {
    const points = Number(new FormData(form).get('points'));
    if (!confirm(`Reset Connect X for everyone? Every player's X link is cleared, and each can earn ${fmtNum(points)} points again by linking X.`)) return;
    try {
      const out = await A.api.resetXConnect(points);
      toast(`Connect X reset: ${fmtNum(out.cleared)} account${out.cleared === 1 ? '' : 's'} unlinked`);
      return renderAdmin();
    } catch (err) {
      return toast(err.message, true);
    }
  }
  if (form.dataset.taskEdit) {
    const data = Object.fromEntries(new FormData(form));
    try {
      await A.api.updateTask(form.dataset.taskEdit, { title: data.title, points: Number(data.points), maxCompletions: data.maxCompletions ? Number(data.maxCompletions) : null });
      A.editTask = null;
      toast('Task saved');
      return renderAdmin();
    } catch (err) {
      return toast(err.message, true);
    }
  }
  if (form.dataset.resolve) return submitAdminResult(form, submitter?.value || 'preview');
  if (form.id === 'admin-live') {
    const data = new FormData(form);
    const body = {
      symbol: String(data.get('symbol') || '').trim(),
      startsInMinutes: Number(data.get('startsInMinutes')),
      preset: String(data.get('preset')),
      exchanges: data.getAll('exchanges').map(String),
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const out = await adminCreate(body, $('#admin-live-status'));
    btn.disabled = false;
    if (out) return renderAdmin();
    return;
  }
  if (form.dataset.detect) {
    const data = new FormData(form);
    try {
      const m = await A.api.approve(Number(form.dataset.detect), {
        symbol: String(data.get('symbol')),
        listingAt: new Date(String(data.get('listingAt'))).getTime(),
      });
      toast(`Market opened for ${m.symbol}`);
    } catch (err) {
      toast(err.message, true);
    }
    return renderAdmin();
  }
}


const inputMs = (v) => new Date(String(v)).getTime();

async function submitAdminMarket(form, intent) {
  const d = new FormData(form);
  const pct = (name) => Number(d.get(name)) / 100;
  const body = {
    name: String(d.get('name') || '').trim(),
    exchanges: d.getAll('exchanges').map(String),
    closeAt: inputMs(d.get('closeAt')),
    resultAt: inputMs(d.get('resultAt')),
    note: String(d.get('note') || '').trim(),
    logoUrl: String(d.get('logoUrl') || '').trim(),
  };
  // The server draws Telegram banners with this PNG copy of the logo.
  const logoPng = await logoPngCopy(body.logoUrl);
  if (logoPng) body.logoPng = logoPng;
  // Disabled (locked) fields are absent from FormData and stay unchanged on the server.
  if (d.has('symbol')) body.symbol = String(d.get('symbol') || '').trim();
  if (d.get('detectionId')) body.detectionId = Number(d.get('detectionId'));
  if (d.get('pairs')) body.pairs = JSON.parse(String(d.get('pairs')));
  // "Upcoming token": no start price yet; the opening price is added once trading starts.
  // "At the close": no start price yet either; it is read when predictions close.
  const atClose = form.querySelector('[data-start-close]');
  if (atClose && !atClose.disabled && !d.has('upcoming')) body.startAtClose = atClose.checked;
  if (d.has('upcoming') || body.startAtClose) body.basePrice = null;
  else if (d.has('basePrice')) body.basePrice = Number(d.get('basePrice'));
  // Opens by itself when trading starts: saved as a scheduled draft, never published from here.
  const autoOpen = d.has('upcoming') && d.has('autoOpen');
  if (autoOpen) {
    body.autoOpenAt = inputMs(d.get('autoOpenAt'));
    if (!Number.isFinite(body.autoOpenAt)) return toast('Choose when trading starts.', true);
    if (!body.logoUrl) return toast('Add the token’s logo first: markets that open by themselves need one.', true);
  } else if (form.dataset.id) body.autoOpenAt = null;
  if (d.has('crash')) {
    body.config = {
      thresholds: { crash: pct('crash'), down: pct('down'), up: pct('up'), moon: pct('moon') },
      feeBps: Math.round(Number(d.get('fee')) * 100),
      softCap: Number(d.get('softCap')),
      outcomes: d.get('outcomes') === 'binary' ? 'binary' : 'ladder',
    };
  }
  if (!Number.isFinite(body.closeAt) || !Number.isFinite(body.resultAt)) return toast('Choose the close time and the expected result time.', true);
  // A second market on a token that still has one running is almost always a mistake.
  const sym = String(body.symbol ?? '').toUpperCase();
  if (!form.dataset.id && sym && A.made?.[sym] && !confirm(`${sym} already has a market that hasn’t had its result yet. Make another one anyway?`)) return;
  if (autoOpen && intent === 'publish') {
    if (!confirm(`Schedule this market? It stays a draft, then opens by itself about 3 minutes after trading starts (${new Date(body.autoOpenAt).toLocaleString()}). Its start price is the price when predictions close.`)) return;
    intent = 'save';
  } else if (intent === 'publish' && !confirm(`Publish this market? Users will be able to predict straight away.\n\nPredictions close: ${fmtDate(body.closeAt)} (in ${fmtDur(body.closeAt - now())})\nStart price: ${body.startAtClose ? 'the price at that moment' : body.basePrice == null ? 'the opening price' : fmtPrice(body.basePrice)}\nResult: ${fmtDate(body.resultAt)}`)) return;
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const id = form.dataset.id;
    let m;
    if (id) m = await A.api.updateManual(id, body);
    else m = await A.api.createManual({ ...body, publish: intent === 'publish' });
    if (id && intent === 'publish') m = await A.api.publish(id);
    // Made from Find tokens: go back there, so the next token is one click away.
    const fromDiscover = !id && A.prefill?.from === 'discover';
    if (fromDiscover) (A.made ??= {})[String(m.symbol).toUpperCase()] = m.id;
    A.edit = null;
    A.review = null;
    A.prefill = null;
    A.tab = fromDiscover ? 'discover' : 'markets';
    toast(m.published ? `${m.symbol} market is live` : m.autoOpenAt ? `${m.symbol} scheduled: it opens by itself when trading starts` : `${m.symbol} saved as a draft`);
  } catch (err) {
    toast(err.message, true);
    buttons.forEach((b) => (b.disabled = false));
    return;
  }
  return renderAdmin();
}

async function submitAdminResult(form, intent) {
  const id = form.dataset.resolve;
  const d = new FormData(form);
  const inputs = {
    basePrice: String(d.get('basePrice') || ''),
    finalPrice: String(d.get('finalPrice') || ''),
    winningBucket: String(d.get('winningBucket') || ''),
    note: String(d.get('note') || '').trim(),
  };
  const key = JSON.stringify(inputs);
  const body = {
    finalPrice: Number(inputs.finalPrice),
    basePrice: inputs.basePrice ? Number(inputs.basePrice) : undefined,
    winningBucket: inputs.winningBucket || undefined,
    note: inputs.note || undefined,
  };
  if (intent === 'start' && !inputs.basePrice) return toast('Enter the opening price first.', true);
  if (intent !== 'start' && !inputs.finalPrice) return toast('Enter the final price.', true);
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    // A token listed after its market opened: record the opening price so players can see it.
    if (intent === 'start') {
      await A.api.setStartPrice(id, Number(inputs.basePrice));
      toast('Opening price saved. Players can see it now.');
      return renderAdmin();
    }
    // Money moves only after the admin has seen a preview of exactly these inputs.
    if (intent === 'resolve' && A.preview?.id === id && A.preview.key === key) {
      const s = A.preview.summary;
      const what = s.voidReason ? 'Cancel this market and refund everyone' : `Declare ${oName(s.winningBucket, s.outcomes === 'binary')} the winner and pay ${s.winnerCount} winner${s.winnerCount === 1 ? '' : 's'} ${fmtPts(s.totalPaid)}`;
      if (!confirm(`${what}? This can’t be undone.`)) {
        buttons.forEach((b) => (b.disabled = false));
        return;
      }
      const out = await A.api.resolve(id, body);
      A.preview = null;
      toast(out.voidReason ? 'Market cancelled and refunded' : `Result posted. ${out.winnerCount} winner${out.winnerCount === 1 ? '' : 's'} paid.`);
    } else {
      A.preview = { id, key, inputs, summary: await A.api.previewResult(id, body) };
      if (intent === 'resolve') toast('Check the preview, then confirm.');
    }
  } catch (err) {
    toast(err.message, true);
  }
  return renderAdmin();
}

// ------------------------------------------------------------------ Events

// Remember whether "Your claims" is open, so a redraw of the Earn page keeps it as the player left it.
document.addEventListener(
  'toggle',
  (e) => {
    if (e.target instanceof HTMLDetailsElement && e.target.matches('.claims-box')) S.claimsOpen = e.target.open;
  },
  true,
);

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.matches?.('[data-backdrop]')) return S.modalBusy ? undefined : closeModal();

  const action = t.closest('[data-action]')?.dataset.action;
  const filter = t.closest('[data-filter]')?.dataset.filter;
  const lbPeriod = t.closest('[data-lb-period]')?.dataset.lbPeriod;
  if (S.menuOpen && !t.closest('#top-menu') && !t.closest('[data-action="menu"]')) closeMenu();
  if (S.streakOpen && !t.closest('#streak-pop') && !t.closest('[data-action="streak"]')) {
    S.streakOpen = false;
    renderTop();
  }
  const dashTab = t.closest('[data-dash-tab]')?.dataset.dashTab;
  if (dashTab) return showDashTab(dashTab);
  const pnlRange = t.closest('[data-pnl-range]')?.dataset.pnlRange;
  if (pnlRange && S.dashData) {
    S.pnlRange = pnlRange;
    $('#view').innerHTML = portfolioView(...S.dashData);
    return;
  }
  if (lbPeriod) {
    S.lbPeriod = lbPeriod;
    return loadRoute();
  }
  const rung = t.closest('.rung');
  const pick = t.closest('[data-pick]')?.dataset.pick;
  const stakeBtn = t.closest('[data-stake]')?.dataset.stake;
  const walletBtn = t.closest('[data-wallet]');
  if (walletBtn) return walletFlow(walletBtn.dataset.purpose, listWallets()[Number(walletBtn.dataset.wallet)]);

  const heroDot = t.closest('[data-hero-dot]')?.dataset.heroDot;
  if (heroDot != null) {
    S.heroPausedUntil = Date.now() + 8000;
    return showHeroSlide(Number(heroDot));
  }
  if (filter) {
    S.filter = filter;
    S.showN = PAGE;
    S.query = '';
    if ($('#market-search')) $('#market-search').value = '';
    $('#view').innerHTML = homeView();
    return;
  }
  if (rung && !rung.disabled) {
    pickBucket(rung.dataset.bucket);
    if (isMobile()) openSheet();
    else $('#stake')?.focus();
    return;
  }
  if (pick) return pickBucket(pick);
  if (stakeBtn) {
    const max = S.me ? Math.min(S.me.points, S.market.userCap - S.market.mine.reduce((s, p) => s + p.stake, 0)) : 1000;
    S.trade.stake = stakeBtn === 'max' ? Math.max(0, max) : Number(stakeBtn);
    $('#stake').value = S.trade.stake;
    return requestQuote();
  }

  if (action?.startsWith('admin-')) return onAdminAction(action, t.closest('[data-action]'));

  switch (action) {
    case 'connect':
      return openAuth('connect');
    case 'share': {
      const m = S.market;
      const url = location.href;
      const title = `${m.symbol} on Firstprint`;
      try {
        if (navigator.share) await navigator.share({ title, text: `Predict ${m.symbol} on Firstprint`, url });
        else {
          await navigator.clipboard.writeText(url);
          toast('Link copied');
        }
      } catch (err) {
        if (err?.name !== 'AbortError') {
          // Clipboard or sharing is blocked in some browsers; show the link so it can still be copied.
          prompt('Copy this link', url);
        }
      }
      return;
    }
    case 'auth-resend':
      return resendCode();
    case 'auth-change-email':
      S.auth = { ...S.auth, step: 'start', devCode: null };
      return renderAuth();
    case 'link-wallet':
      return openAuth('link');
    case 'demo-wallet':
      return walletFlow(t.closest('[data-purpose]').dataset.purpose, null);
    case 'close-modal':
      return closeModal();
    case 'show-more': {
      S.showN = Math.max(PAGE, S.showN ?? PAGE) + PAGE;
      const out = $('#market-results');
      if (out) out.innerHTML = marketResults();
      return;
    }
    case 'logout':
      await S.api.logout();
      A.api = null;
      A.info = null;
      await disconnectWallets();
      S.me = null;
      renderTop();
      toast('Logged out');
      return loadRoute();
    case 'viz-retry':
      return loadRoute();
    case 'viz-export':
      return downloadAnalytics();
    case 'page': {
      const b = t.closest('[data-action]');
      return goPage(b.dataset.list, Number(b.dataset.page), b);
    }
    case 'viz-days':
      S.vizDays = Number(t.closest('[data-action]').dataset.days);
      return loadRoute();
    case 'claim':
      if (S.claimingDaily) return;
      S.claimingDaily = true;
      try {
        const from = t.closest('[data-action]').getBoundingClientRect();
        const me = await S.api.claimDaily();
        const day = me.daily?.streak ?? 1;
        const got = dailyReward(day);
        await collectPoints(from, got, '.chip.points', { count: true });
        S.me = me;
        S.daily = null;
        rewardToast({
          amount: got,
          title: `Day ${day} streak`,
          sub: `Tomorrow +${me.daily?.next ?? got}${S.rewards?.onChain && me.wallets?.length ? ' · sent as TestFPT' : ''}`,
        });
        renderTop();
        return loadRoute();
      } catch (err) {
        return toast(err.message, true);
      } finally {
        S.claimingDaily = false;
      }
    case 'testnet-hide':
      writePref('fp:testnet-hide', '1');
      return t.closest('.testnet-card')?.remove();
    case 'start-guide':
      return openAuth('start');
    case 'inbox':
      return openInbox();
    case 'tour':
      return openTour();
    case 'tour-next':
      S.tourStep = Math.min(TOUR.length - 1, S.tourStep + 1);
      return renderAuth();
    case 'tour-back':
      S.tourStep = Math.max(0, S.tourStep - 1);
      return renderAuth();
    case 'tour-done':
      return finishTour();
    case 'win-close':
      return closeWin();
    case 'revert-open':
      return openRevert(t.closest('[data-action]').dataset.id);
    case 'revert-confirm':
      return confirmRevert();
    case 'pnl-open': {
      const btn = t.closest('[data-action]');
      S.pnl = { marketId: btn.dataset.id, symbol: btn.dataset.symbol };
      S.modal = 'pnl';
      return renderAuth();
    }
    case 'pnl-native':
      return pnlNativeShare();
    case 'pnl-copy':
      try {
        await navigator.clipboard.writeText(pnlLinks(S.pnl).page);
        toast('Link copied');
      } catch {
        toast('Couldn’t copy the link.', true);
      }
      return;
    case 'profile-skip':
      return afterProfile();
    case 'claim-tokens':
      return claimTokens();
    case 'task-go': {
      // Let the link open the task on X, and remember it was opened.
      const id = t.closest('[data-task]').dataset.task;
      S.api
        .startTask(id)
        .then(refreshRewards)
        .then(() => S.route.name === 'earn' && ($('#view').innerHTML = earnView()))
        .catch((err) => toast(err.message, true));
      return;
    }
    case 'task-verify':
      return onTaskVerify(t.closest('[data-task]').dataset.task, t.closest('[data-action]'));
    case 'copy-text':
      return copyText(t.closest('[data-text]').dataset.text);
    case 'x-verify':
      return onXVerify();
    case 'task-connect':
      S.xOpenTask = t.closest('[data-task]').dataset.task;
      if (S.route.name === 'earn') $('#view').innerHTML = earnView();
      return $('#x-form input')?.focus();
    case 'x-restart':
      S.rewards = { ...S.rewards, xPending: null };
      if (S.route.name === 'earn') $('#view').innerHTML = earnView();
      return $('#x-form input')?.focus();
    case 'predict':
      return submitPrediction();
    case 'open-sheet':
      return openSheet();
    case 'close-sheet':
      return closeSheet();
    case 'theme':
      return setTheme(currentTheme() === 'light' ? 'dark' : 'light');
    case 'streak':
      S.streakOpen = !S.streakOpen;
      S.menuOpen = false;
      renderTop();
      if (S.streakOpen) $('#streak-pop .sp-claim')?.focus();
      return;
    case 'menu':
      S.streakOpen = false;
      S.menuOpen = !S.menuOpen;
      renderTop();
      if (S.menuOpen) $('#top-menu a, #top-menu button')?.focus();
      return;
    case 'quick-pick':
      S.pendingPick = { id: t.closest('[data-id]').dataset.id, bucket: t.closest('[data-bucket]').dataset.bucket };
      location.hash = `#/market/${encodeURIComponent(S.pendingPick.id)}`;
      return;
    case 'how':
      e.preventDefault();
      closeMenu();
      if (S.route.name !== 'home') {
        location.hash = '#/';
        setTimeout(() => $('#how')?.scrollIntoView({ behavior: 'smooth' }), 500);
      } else $('#how')?.scrollIntoView({ behavior: 'smooth' });
      return;
    case 'logo-clear':
      return setLogo(t.closest('form'), '');
    case 'logo-find':
      return findLogo(t.closest('form'), { force: true });
    case 'retry':
      return loadRoute();
    case 'skip':
      S.api.skip(2 * 60_000);
      toast('Skipped ahead 2 minutes');
      return refresh();
    case 'reset':
      S.api.reset();
      S.trade = { bucket: null, stake: 100, quote: null, seq: 0, busy: false };
      S.tradeKey = '';
      await refreshMe();
      toast('Demo reset');
      return loadRoute();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'market-search') {
    const was = Boolean((S.query ?? '').trim());
    S.query = e.target.value;
    if (S.route.name !== 'home') {
      location.hash = '#/';
      return;
    }
    // Starting or clearing a search redraws the page: the hero and featured deck step aside, so
    // the results show straight under the search bar instead of below the fold.
    if (was !== Boolean(S.query.trim())) {
      $('#view').innerHTML = homeView();
      window.scrollTo({ top: 0 });
      return;
    }
    const out = $('#market-results');
    if (out) out.innerHTML = marketResults();
    document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-selected', String(!S.query && b.dataset.filter === S.filter)));
    return;
  }
  if (e.target.id === 'stake') {
    const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 7);
    if (digits !== e.target.value) e.target.value = digits;
    S.trade.stake = Number(digits || 0);
    requestQuote();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.matches?.('#admin-market [type=datetime-local]')) return updateUtcHints();
  if (e.target.matches?.('#admin-market [name=symbol], #admin-market [name=name]')) {
    clearTimeout(refreshLogoSources.timer);
    refreshLogoSources.timer = setTimeout(() => refreshLogoSources(e.target.form), 300);
  }
  if (!e.target.matches?.('[data-logo-link]')) return;
  const v = e.target.value.trim();
  if (!v || /^https:\/\/\S+$/i.test(v)) setLogo(e.target.form, v, { keepLink: true });
  // Keep our own copy of a pasted logo once the admin stops typing.
  clearTimeout(copyLogo.timer);
  if (A.api && /^https:\/\/\S+$/i.test(v)) copyLogo.timer = setTimeout(() => copyLogo(e.target.form, v), 600);
});

document.addEventListener('change', async (e) => {
  if (!e.target.matches?.('[data-logo-file]')) return;
  const file = e.target.files?.[0];
  const form = e.target.form;
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Choose an image file (PNG, JPG, WebP, GIF or SVG).', true);
  if (file.size > 5_000_000) return toast('That image is over 5 MB. Choose a smaller one.', true);
  try {
    setLogo(form, await shrinkImage(file, 128));
  } catch {
    toast('Couldn’t read that image. Try a PNG or JPG.', true);
  }
});

// A broken logo link falls back to the letter circle. Image errors don't bubble, so listen while capturing.
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('tok-logo')) return;
    img.closest('.avatar')?.replaceWith(Object.assign(document.createElement('template'), { innerHTML: avatar(img.dataset.sym, [...img.parentElement.classList].filter((c) => /^avatar-(sm|md|lg|xl)$/.test(c)).join(' ')) }).content);
  },
  true,
);

/** The start price field follows its choice: typed in for a fixed price, empty when it comes later. */
function syncStartPrice(form) {
  if (!form) return;
  const upcoming = Boolean(form.querySelector('[data-upcoming]')?.checked);
  const close = form.querySelector('[data-start-close]');
  form.querySelectorAll('.start-close-check, .start-close-how').forEach((x) => (x.hidden = upcoming));
  const atClose = !upcoming && Boolean(close?.checked);
  const price = form.querySelector('[name=basePrice]');
  if (!price || (close?.disabled && price.disabled)) return;
  price.disabled = upcoming || atClose;
  price.required = !price.disabled;
  price.placeholder = upcoming ? 'Set when trading opens' : atClose ? 'Taken at the close' : '0.25';
  if (price.disabled) price.value = '';
}

/**
 * "Open by itself when trading starts": shows the trading start time, keeps predictions open at
 * least two days after it, and names the main button for what it will do.
 */
function syncAutoOpen(form, timeChanged = false) {
  if (!form) return;
  const on = Boolean(form.querySelector('[data-auto-open]')?.checked);
  const at = form.querySelector('.auto-open-at');
  if (at) at.hidden = !on;
  if (on) {
    const open = inputMs(form.querySelector('[name=autoOpenAt]').value);
    const close = form.querySelector('[name=closeAt]');
    const result = form.querySelector('[name=resultAt]');
    if (Number.isFinite(open) && (timeChanged || !(inputMs(close.value) >= open + 30 * 60_000))) {
      close.value = toLocalInput(open + OPEN_HOURS_DEFAULT * 3_600_000);
      if (!(inputMs(result.value) > open + OPEN_HOURS_DEFAULT * 3_600_000)) result.value = toLocalInput(open + OPEN_HOURS_DEFAULT * 3_600_000 + RESULT_DAYS_DEFAULT * 86_400_000);
    }
  }
  const main = form.querySelector('button[name=intent][value=publish]');
  if (main) main.innerHTML = on ? `${ico('clock')}Schedule: opens by itself` : form.dataset.id ? 'Save and publish' : `${ico('send')}Publish market`;
  updateUtcHints();
}

/** Puts a logo (link or data URL, '' for none) into the market form and its preview. */
function setLogo(form, value, { keepLink = false } = {}) {
  if (!form) return;
  if (form.id === 'admin-market' && $('#banner-preview-out')) setTimeout(runBannerPreview, 0);
  form.querySelector('[name=logoUrl]').value = value;
  if (!keepLink) form.querySelector('[data-logo-link]').value = value.startsWith('data:') ? '' : value;
  const preview = form.querySelector('[data-logo-preview]');
  preview.innerHTML = value ? `<img src="${esc(value)}" alt="" referrerpolicy="no-referrer" />` : ico('image');
  form.querySelector('[data-action=logo-clear]').hidden = !value;
}

/**
 * A 128 × 128 PNG copy of a stored logo, for the Telegram banners the server draws (its image
 * library reads PNG but not WebP). Only for logos already saved as data: images; null otherwise.
 */
async function logoPngCopy(dataUrl) {
  if (!/^data:image\//.test(dataUrl || '')) return null;
  if (dataUrl.startsWith('data:image/png')) return dataUrl.length < 290_000 ? dataUrl : null;
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    canvas.getContext('2d').drawImage(img, 0, 0, 128, 128);
    const png = canvas.toDataURL('image/png');
    return png.length < 290_000 ? png : null;
  } catch {
    return null;
  }
}

/** Markets saved before banners existed get their PNG logo copy the next time an admin opens the panel. */
async function backfillLogoPngs(markets) {
  A.pngDone ??= new Set();
  for (const m of markets) {
    if (!m.logoUrl?.startsWith('data:') || m.hasLogoPng || A.pngDone.has(m.id)) continue;
    A.pngDone.add(m.id);
    const png = await logoPngCopy(m.logoUrl);
    if (png) await A.api.setLogoPng(m.id, png).catch(() => {});
  }
}

/** Draws an image into a size × size square (cropped to the centre) and returns a small data URL. */
async function shrinkImage(file, size) {
  // Read as a data URL: the page's security policy allows data: images but not blob: ones.
  const src = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
  const w = img.naturalWidth || size;
  const h = img.naturalHeight || size;
  const side = Math.min(w, h);
  // Safari can't encode WebP and falls back to PNG, which for a detailed logo can pass the server's
  // size limit, so step down in size until the copy fits. A 64 × 64 PNG always does.
  let out = '';
  for (const s of [size, Math.round(size * 0.75), Math.round(size / 2)]) {
    const canvas = Object.assign(document.createElement('canvas'), { width: s, height: s });
    canvas.getContext('2d').drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, s, s);
    const webp = canvas.toDataURL('image/webp', 0.9);
    out = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
    if (out.length <= LOGO_MAX_CHARS) return out;
  }
  return out;
}

/** Longest logo data URL the server accepts (MAX_LOGO in src/services/firstprint.ts), with some room. */
const LOGO_MAX_CHARS = 38_000;

document.addEventListener('input', (e) => {
  if (e.target.id !== 'auth-code') return;
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) submitCode(e.target.form);
});

document.addEventListener('click', (e) => {
  document.querySelectorAll('details.row-menu[open]').forEach((d) => {
    if (!d.contains(e.target) || e.target.closest('.row-menu-item')) d.open = false;
  });
});
// The ⋯ menu floats over the page (fixed), so a table that scrolls sideways never clips it.
document.addEventListener(
  'toggle',
  (e) => {
    const d = e.target;
    if (!d.matches?.('details.row-menu') || !d.open) return;
    const r = d.querySelector('summary').getBoundingClientRect();
    const list = d.querySelector('.row-menu-list');
    const w = Math.max(list.offsetWidth, 190);
    list.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    const below = r.bottom + 6 + list.offsetHeight < innerHeight;
    list.style.top = `${below ? r.bottom + 6 : r.top - 6 - list.offsetHeight}px`;
  },
  true,
);
addEventListener('scroll', () => document.querySelectorAll('details.row-menu[open]').forEach((d) => (d.open = false)), { passive: true, capture: true });

document.addEventListener('change', (e) => {
  if (e.target.matches?.('#admin-market [name=exchanges]')) refreshLogoSources(e.target.form);
  if (e.target.matches?.('[data-start-close]') || e.target.matches?.('[data-upcoming]')) syncStartPrice(e.target.closest('form'));
  if (e.target.matches?.('[data-upcoming]')) {
    const form = e.target.closest('form');
    const auto = form.querySelector('.auto-open');
    if (auto && !(form.dataset.id && form.dataset.published === '1')) auto.hidden = !e.target.checked;
    if (!e.target.checked && form.querySelector('[data-auto-open]')) {
      form.querySelector('[data-auto-open]').checked = false;
      syncAutoOpen(form);
    }
  }
  if (e.target.matches?.('[data-auto-open]')) syncAutoOpen(e.target.closest('form'));
  if (e.target.name === 'autoOpenAt' && e.target.closest('#admin-market')) syncAutoOpen(e.target.closest('form'), true);
  if (e.target.name === 'outcomes' && e.target.closest('#admin-market')) {
    e.target.closest('form').dataset.outcomes = e.target.value;
  }
  if (e.target.name === 'kind' && e.target.closest('#admin-task')) {
    e.target.closest('form').querySelector('[name=target]').placeholder = TASK_TARGET_HINT[e.target.value] ?? '';
  }
  if (e.target.id === 'market-sort') {
    S.sort = e.target.value;
    const out = $('#market-results');
    if (out) out.innerHTML = marketResults();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.dataset?.form === 'admin-act-search') {
    e.preventDefault();
    A.act = { page: 1, all: true, q: new FormData(e.target).get('q')?.toString().trim() ?? '' };
    renderAdmin();
  } else if (e.target.id === 'auth-email-form') {
    e.preventDefault();
    submitEmail(e.target);
  } else if (e.target.id === 'auth-code-form') {
    e.preventDefault();
    submitCode(e.target);
  } else if (e.target.id === 'username-form') {
    e.preventDefault();
    submitUsername(e.target);
  } else if (e.target.id === 'x-form') {
    e.preventDefault();
    submitX(e.target);
  } else if (S.route.name === 'admin') {
    e.preventDefault();
    onAdminSubmit(e.target, e.submitter);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (S.modal && !S.modalBusy) closeModal();
  else if (S.sheetOpen) closeSheet();
});

// Countdowns tick every second; when one reaches zero, refresh so the phase updates.
setInterval(() => {
  let expired = false;
  document.querySelectorAll('[data-until]').forEach((el) => {
    const left = Number(el.dataset.until) - now();
    const text = fmtDur(left);
    if (el.textContent !== text) el.textContent = text;
    if (left <= 0 && left > -1500) expired = true;
  });
  tickCountdowns();
  // Everyone's countdown ends together: spread the refreshes over a few seconds.
  if (expired) setTimeout(refresh, 1200 + Math.random() * 6000);
}, 1000);

// Background refresh. While the live stream is connected it already brings every market change
// (new predictions, closes, results) and prices, so the full reload only catches the rest (balance,
// leaderboard) every 45 seconds; without the stream, every 8 seconds as before.
const REFRESH_LIVE_MS = 45_000;
const REFRESH_OFFLINE_MS = 20_000;
setInterval(() => {
  if (document.hidden) return;
  if (Date.now() - (S.refreshedAt ?? 0) >= (S.live ? REFRESH_LIVE_MS : REFRESH_OFFLINE_MS) - 500) refresh();
}, 4_000);
// Back on the tab after a while: catch up straight away.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - (S.refreshedAt ?? 0) > REFRESH_OFFLINE_MS) refresh();
});

// The trending stack steps every six seconds (each step is a full 3D move, so not more often) unless
// the visitor is pointing at it (with reduced motion the CSS swaps the 3D drop for a gentle fade).
setInterval(() => {
  const deck = $('[data-hero-deck]');
  if (!deck || document.hidden || deck.matches(':hover, :focus-within') || Date.now() < (S.heroPausedUntil ?? 0)) return;
  // Nobody sees it scrolled off screen, so don't spend the phone's time animating it.
  const r = deck.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return;
  showHeroSlide((S.heroIdx ?? 0) + 1);
}, 6000);

// ------------------------------------------------------------------ Boot

(async function boot() {
  captureReferral();
  const forceDemo = window.FP_FORCE_DEMO || new URLSearchParams(location.search).has('demo');
  // A server outage must never silently replace real balances with simulated ones.
  S.api = forceDemo ? new DemoBackend() : createApi();
  renderDemoBar();
  if (document.documentElement.dataset.theme) syncThemeColor();
  // Following the device setting: redraw the switch icon when the device flips light/dark.
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (!document.documentElement.dataset.theme) renderTop();
  });
  wake.onWaking = () => {
    if (!$('.wake-bar')) {
      $('#demo-bar').innerHTML = '<div class="wake-bar" role="status"><p>Waking up the server. The first visit after a quiet period can take up to a minute. This page will load by itself.</p></div>';
    }
  };
  wake.onAwake = () => {
    if ($('.wake-bar')) $('#demo-bar').innerHTML = '';
    renderDemoBar();
  };
  S.cfg = await S.api.config().catch(() => ({}));
  S.signIn = S.cfg.signIn ?? S.signIn;
  wake.onMaintenance = (message) => applyMaintenance({ on: true, message: message ?? '' });
  try {
    await refreshMe();
  } catch (err) {
    toast(err.message, true);
  }
  window.addEventListener('hashchange', onRoute);
  await onRoute();
  S.refreshedAt = Date.now(); // the page was just loaded: no background refresh straight away
  applyMaintenance(S.cfg.maintenance);
  watchMaintenance();
  maybeTourVisitor();
  S.api.subscribe(onLive, (ok) => {
    if (S.live !== ok) {
      S.live = ok;
      if (S.route.name === 'market' && S.market) $('#market-main').innerHTML = marketMain(S.market);
    }
  });
  onWalletsChanged(() => {
    if ((S.modal === 'link' || (S.modal === 'connect' && S.auth?.step === 'start')) && !S.modalBusy) renderAuth();
  });
})();


// ---------------------------------------------------------------- Motion details

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
const TICKS = new Map();

/** Counts a ticker from its last shown value to the new one and flashes it green or red. */
function runTicker(el) {
  const key = el.dataset.tick;
  const to = Number(el.dataset.val);
  const from = TICKS.get(key);
  TICKS.set(key, to);
  if (from === undefined || from === to || REDUCED_MOTION.matches) return;
  el.classList.remove('tick-up', 'tick-down');
  void el.offsetWidth; // restart the flash
  el.classList.add(to > from ? 'tick-up' : 'tick-down');
  const start = performance.now();
  const dur = 550;
  const step = (t) => {
    const k = Math.min(1, (t - start) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmtNum(Math.round(from + (to - from) * e));
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Moves the sliding highlight of each tab group to its selected tab. Once per frame at most, and all
 * positions are read before any is written, so the page is laid out once instead of once per group.
 */
const SEG_GROUPS = '.tabs, .dash-tabs';
let segFrame = 0;
function syncAllSegs() {
  if (segFrame) return;
  segFrame = requestAnimationFrame(() => {
    segFrame = 0;
    const read = [...document.querySelectorAll(SEG_GROUPS)].map((group) => {
      const on = group.querySelector('[aria-selected="true"]');
      return { group, on, x: on?.offsetLeft ?? 0, w: on?.offsetWidth ?? 0 };
    });
    for (const { group, on, x, w } of read) {
      if (!on) {
        group.classList.remove('seg-on');
        continue;
      }
      group.style.setProperty('--seg-x', `${x}px`);
      group.style.setProperty('--seg-w', `${w}px`);
      if (!group.classList.contains('seg-on')) requestAnimationFrame(() => group.classList.add('seg-on', 'seg-ready'));
    }
  });
}

new MutationObserver((records) => {
  let segs = false;
  for (const r of records) {
    if (r.type === 'attributes') {
      if (r.target.closest?.(SEG_GROUPS)) segs = true;
      continue;
    }
    for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches('[data-tick]')) runTicker(n);
      n.querySelectorAll('[data-tick]').forEach(runTicker);
      if (n.matches(SEG_GROUPS) || n.querySelector(SEG_GROUPS)) segs = true;
    }
  }
  if (segs) syncAllSegs();
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
window.addEventListener('resize', syncAllSegs);
document.fonts?.ready.then(syncAllSegs);

// A soft light follows the pointer across market cards (mouse and trackpad only).
if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
}

function closeMenu() {
  if (!S.menuOpen) return;
  S.menuOpen = false;
  renderTop();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.menuOpen) {
    closeMenu();
    $('[data-action="menu"]')?.focus();
  }
  if (e.key === 'Escape' && S.streakOpen) {
    S.streakOpen = false;
    renderTop();
    $('[data-action="streak"]')?.focus();
  }
  // "/" jumps to search, as on most trading sites.
  if (e.key === '/' && !e.target.closest?.('input, textarea, select, [contenteditable]')) {
    e.preventDefault();
    $('#market-search')?.focus();
  }
});
