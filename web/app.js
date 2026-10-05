// Firstprint website. Vanilla ES modules, no build step.

import { bucketRangeLabel } from './engine.js';
import { ApiError, backendAvailable, captureReferral, createAdminApi, createApi, wake } from './api.js';
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
  retracted: 'the exchange cancelled the listing',
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
  lbPeriod: 'week',
  query: '',
  exchange: 'all',
  lists: { open: [], live: [], settled: [] },
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

// ------------------------------------------------------------------ Utilities

const $ = (sel, root = document) => root.querySelector(sel);
const now = () => Date.now() + S.skew;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const fmtNum = (n) => Math.round(n ?? 0).toLocaleString('en-US');
const fmtPts = (n) => `${fmtNum(n)} pts`;

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
  return `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: p >= 100 ? 2 : 4 })}`;
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
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const until = (ts) => `<span data-until="${ts}">${fmtDur(ts - now())}</span>`;
const outcome = (b, yn = false) => `<b class="oc" style="--c:${oVar(b, yn)}">${icon(b, yn)}${oName(b, yn)}</b>`;
const rangeLabel = (b, t) => bucketRangeLabel(b, t).replace(/-/g, '−');
/** The price range an outcome covers, for either kind of market. */
/** A market created before its token traded has no start price yet: it's the opening price. */
const hasStart = (m) => m.basePrice != null;
/** A token that isn't trading yet: predictions close when it lists, and its opening price is the start. */
const isUpcoming = (m) => m.mode === 'manual' && !hasStart(m) && m.status === 'open' && m.phase !== 'awaiting_result' && m.closeAt > now();
const startText = (m, short = false) => (hasStart(m) ? fmtPrice(m.basePrice) : short ? 'opening price' : 'its opening price');
const rangeOf = (m, b) => (isYesNo(m) ? (b === 'up' ? `At or above ${hasStart(m) ? fmtPrice(m.basePrice) : 'open'}` : `Below ${hasStart(m) ? fmtPrice(m.basePrice) : 'open'}`) : rangeLabel(b, m.thresholds));
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
  toastTimer = setTimeout(() => (el.className = ''), 3200);
}

function syncClock(serverTime) {
  if (typeof serverTime === 'number') S.skew = serverTime - Date.now();
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
}

async function loadHome() {
  const [open, live, settled] = await Promise.all(['open', 'live', 'settled'].map((f) => S.api.markets(f)));
  syncClock(open.serverTime);
  S.lists = { open: open.markets, live: live.markets, settled: settled.markets };
  const featured = [...S.lists.open].sort(byTrending)[0];
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
function skeletonView(name) {
  const card = '<div class="sk-card"><div class="sk-row"><i class="sk sk-circle"></i><span class="sk-col"><i class="sk sk-line w40"></i><i class="sk sk-line w25"></i></span></div><i class="sk sk-line w70"></i><i class="sk sk-bar"></i><i class="sk sk-line w50"></i></div>';
  const grid = `<div class="sk-grid">${card.repeat(6)}</div>`;
  if (name === 'home') return `<div class="skeleton" aria-busy="true" aria-label="Loading markets"><div class="sk-hero"><i class="sk sk-line w30"></i><i class="sk sk-title"></i><i class="sk sk-line w50"></i></div>${grid}</div>`;
  if (name === 'portfolio') return `<div class="skeleton" aria-busy="true" aria-label="Loading your dashboard"><div class="sk-row"><i class="sk sk-circle lg"></i><span class="sk-col"><i class="sk sk-line w20"></i><i class="sk sk-title w30"></i></span></div><div class="sk-grid two"><div class="sk-card tall"></div><div class="sk-card tall"></div></div><div class="sk-card block"></div></div>`;
  return `<div class="skeleton" aria-busy="true" aria-label="Loading"><i class="sk sk-title w40"></i><i class="sk sk-line w60"></i><div class="sk-card block"></div></div>`;
}

/** A short fade-and-rise when a new page appears (not on live updates of the same page). */
function enterView() {
  const view = $('#view');
  if (!view) return;
  view.classList.remove('view-enter');
  void view.offsetWidth;
  view.classList.add('view-enter');
  clearTimeout(enterView.timer);
  enterView.timer = setTimeout(() => view.classList.remove('view-enter'), 500);
}

async function onRoute() {
  const next = parseRoute();
  const changed = next.name !== S.route.name || next.id !== S.route.id;
  S.route = next;
  S.menuOpen = false;
  if (changed) {
    closeSheet();
    $('#view').innerHTML = skeletonView(next.name);
    window.scrollTo(0, 0);
  }
  renderTop();
  await loadRoute(changed);
  if (changed) enterView();
  if (changed && document.activeElement?.id !== 'market-search') $('#view').focus({ preventScroll: true });
}

async function loadRoute() {
  const view = $('#view');
  try {
    if (S.route.name === 'home') {
      await loadHome();
      view.innerHTML = homeView();
    } else if (S.route.name === 'market') {
      await loadMarket(S.route.id);
      const pending = S.pendingPick;
      if (pending?.id === S.route.id) {
        S.pendingPick = null;
        if (S.market.status === 'open' && bucketsOf(S.market).includes(pending.bucket)) S.trade.bucket = pending.bucket;
      }
      renderMarket();
      if (pending?.id === S.route.id && S.trade.bucket) {
        requestQuote();
        if (isMobile()) openSheet();
        else setTimeout(() => $('#stake')?.focus({ preventScroll: true }), 50);
      }
    } else if (S.route.name === 'leaderboard') {
      const lb = await S.api.leaderboard(S.lbPeriod);
      view.innerHTML = leaderboardView(lb);
    } else if (S.route.name === 'profile') {
      S.profile = await S.api.profile(S.route.id);
      view.innerHTML = profileView(S.profile);
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
            view.innerHTML = analyticsView(await S.api.publicAnalytics(S.route.key, S.vizDays ?? 30), { shared: true });
          } catch (err) {
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
      view.innerHTML = radarView(listings);
    } else if (S.route.name === 'earn') {
      await Promise.all([refreshRewards(), loadDaily()]);
      view.innerHTML = earnView();
    } else if (S.route.name === 'portfolio') {
      const preds = S.me ? (await S.api.myPredictions()).predictions : [];
      const history = S.me && S.api.ledger ? (await S.api.ledger().catch(() => ({ entries: [] }))).entries : [];
      const stats = S.me && S.api.stats ? await S.api.stats().catch(() => null) : null;
      await loadDaily();
      view.innerHTML = portfolioView(preds, history, stats);
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
  return 'Firstprint: predict new exchange listings';
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

function drawTop() {
  const cur = (name) => (S.route.name === name || (name === 'home' && S.route.name === 'market') ? ' aria-current="page"' : '');
  const wallet = S.me?.wallets?.[0]?.address;
  const pages = [
    ['home', '#/', 'Markets', 'Markets'],
    ...(S.cfg?.manualOnly ? [] : [['radar', '#/radar', 'Listing radar', 'Radar']]),
    ['earn', '#/earn', 'Earn', 'Earn'],
    ['leaderboard', '#/leaderboard', 'Leaderboard', 'Ranks'],
    ['portfolio', '#/portfolio', 'Dashboard', 'Me'],
  ];
  $('#tabbar').innerHTML = pages
    .map(([name, href, , short]) => `<a href="${href}"${cur(name)}>${ico(NAV_ICONS[name])}<span>${short}</span></a>`)
    .join('');
  $('#topbar').innerHTML = `
    <div class="topbar-inner">
      <a class="wordmark" href="#/" aria-label="Firstprint home"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="word">Firstprint</span></a>
      <label class="top-search">${ico('search')}<input id="market-search" type="search" placeholder="Search markets" value="${esc(S.query ?? '')}" autocomplete="off" aria-label="Search markets" /><kbd aria-hidden="true">/</kbd></label>
      <div class="account">
        ${
          S.me
            ? `<button class="chip bell${S.me.unreadNotifications ? ' has-new' : ''}" data-action="inbox" aria-label="Your results${S.me.unreadNotifications ? `, ${S.me.unreadNotifications} new` : ''}">${ico('bell')}${S.me.unreadNotifications ? `<span class="bell-n">${S.me.unreadNotifications > 9 ? '9+' : S.me.unreadNotifications}</span>` : ''}</button>
               ${S.me.canClaimDaily ? `<button class="chip gift" data-action="claim" title="Claim your free daily points" aria-label="Claim ${dailyNext()} free daily points">${ico('gift')}<span class="gift-n">+${dailyNext()}</span></button>` : ''}
               <a class="chip points" href="#/portfolio" title="Your points balance">${ico('coins')}${tick('me:points:top', S.me.points)}<span class="unit">pts</span></a>
               <a class="chip wallet-chip" href="#/portfolio" title="Signed in as ${esc(S.me.username)}">${avatar(S.me.username, 'avatar-sm')}<span>${wallet ? esc(shortAddress(wallet)) : esc(S.me.username)}</span></a>`
            : `<a class="top-link hide-sm" href="#/" data-action="how">${ico('info')}How it works</a><button class="btn btn-gold" data-action="connect">Log in</button>`
        }
        <button class="chip menu-btn" data-action="menu" aria-label="Menu" aria-haspopup="true" aria-expanded="${S.menuOpen ? 'true' : 'false'}" aria-controls="top-menu">${ico('menu')}</button>
      </div>
      ${S.menuOpen ? menuView(pages) : ''}
    </div>
    <nav class="subnav" aria-label="Main">
      ${pages.map(([name, href, label]) => `<a href="${href}"${cur(name)}>${ico(NAV_ICONS[name])}${label}</a>`).join('')}
    </nav>`;
}

/** Everything secondary: pages, test SOL, the theme switch, help and the account. */
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
      <ol class="st-days">${tiles}</ol>
      <p class="st-rule muted">Claim once a day (UTC): 50 points on day 1, 25 more each day, 200 a day from day 7. Miss a day and it starts again at 50.</p>
      ${
        compact
          ? ''
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

function analyticsView(d, { shared = false } = {}) {
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
          ? `<header class="viz-head"><div><span class="eyebrow">Firstprint · live stats</span><h1 class="page-title">How Firstprint is growing</h1><p class="page-lede">A free prediction game on new crypto exchange listings, on Solana testnet. Updated ${fmtAgo(d.generatedAt)}.</p></div></header>`
          : ''
      }
      <div class="viz-filters">${seg(shared ? 'viz-days' : 'admin-viz-days')}<span class="muted">${range}</span></div>
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
      </div>
      <div class="viz-extra">
        <div><b>${fmtNum(T.predictions)}</b><span>predictions all time</span></div>
        <div><b>${fmtCompact(T.staked)}</b><span>points staked all time</span></div>
        <div><b>${fmtNum(T.referred)}</b><span>players invited by friends</span></div>
        <div><b>${fmtNum(T.tasksDone)}</b><span>tasks completed on X</span></div>
        <div><b>${fmtNum(T.testfptClaimers)}</b><span>players claimed TestFPT (${fmtCompact(T.testfptClaimed)} total)</span></div>
      </div>
      <details class="viz-table"><summary>Daily numbers as a table</summary>
        <div class="table-wrap"><table class="table"><thead><tr><th>Day (UTC)</th><th class="right">Active</th><th class="right">New</th><th class="right">Predictions</th><th class="right">Points staked</th></tr></thead>
        <tbody>${[...d.series].reverse().map((x) => `<tr><td>${fmtShortDay(x.day)}</td><td class="right">${fmtNum(x.active)}</td><td class="right">${fmtNum(x.newPlayers)}</td><td class="right">${fmtNum(x.predictions)}</td><td class="right">${fmtNum(x.staked)}</td></tr>`).join('')}</tbody></table></div>
      </details>
      <p class="fine">Totals only: no names, emails or wallets are shown. Test accounts are left out. Points have no cash value.</p>
    </div>`;
}

/** Admin: create, copy or turn off the read-only link partners use. */
function analyticsSharePanel(key) {
  const url = key ? `${location.origin}${location.pathname}#/stats/${key}` : '';
  return `
    <section class="panel viz-share">
      <div class="section-head"><span class="section-ico">${ico('share')}</span><div><h2>Share with partners</h2><p class="muted">A read-only link to this page with totals only. No names, emails or wallets. Anyone with the link can see it, so share it only with partners.</p></div></div>
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
      ${S.cfg?.rewards ? `<button role="menuitem" data-action="faucet">${ico('droplet')}Get test SOL</button>` : ''}
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

/** Home tabs: three ways to sort open markets, then markets waiting for a result and settled ones. */
const HOME_TABS = [
  ['trending', 'flame', 'Trending'],
  ['ending', 'clock', 'Ending soon'],
  ['new', 'sparkles', 'New'],
  ['live', 'history', 'Awaiting result'],
  ['settled', 'checkCircle', 'Settled'],
];

/** Most points staked in the last day first, then the most predictors and the biggest pool. */
const byTrending = (a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0) || b.predictors - a.predictors || b.pool - a.pool;

const venuesOf = (m) => (m.venues?.length ? m.venues.map((v) => v.name) : [m.exchange]);

function tabList(tab) {
  if (tab === 'live') return [...S.lists.live];
  if (tab === 'settled') return [...S.lists.settled];
  const open = [...S.lists.open];
  if (tab === 'ending') return open.sort((a, b) => a.closeAt - b.closeAt);
  if (tab === 'new') return open.sort((a, b) => b.openedAt - a.openedAt);
  return open.sort(byTrending);
}

/** The cards under the tabs: the chosen tab, or every market matching the search. */
function marketResults() {
  const q = (S.query ?? '').trim().toLowerCase();
  const byExchange = (m) => S.exchange === 'all' || venuesOf(m).includes(S.exchange);
  if (q) {
    const all = [...[...S.lists.open].sort(byTrending), ...S.lists.live, ...S.lists.settled];
    const hits = all.filter((m) => byExchange(m) && (m.symbol.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)));
    return hits.length
      ? `<p class="results-note">${hits.length} market${hits.length === 1 ? '' : 's'} matching “${esc(S.query.trim())}”</p><div class="grid">${hits.map(cardView).join('')}</div>`
      : `<div class="empty"><div class="empty-art">${ico('search')}</div><p><strong>No markets match “${esc(S.query.trim())}”.</strong><br />Try a token symbol like BTC or a project name.</p></div>`;
  }
  const list = tabList(S.filter).filter(byExchange);
  return list.length ? `<div class="grid">${list.map(cardView).join('')}</div>` : `<div class="empty">${emptyText()}</div>`;
}

function homeView() {
  const tnCard = startChecklist();
  if (!HOME_TABS.some(([id]) => id === S.filter)) S.filter = 'trending';
  const featured = [...S.lists.open].sort(byTrending)[0];
  const count = (id) => (id === 'live' ? S.lists.live.length : id === 'settled' ? S.lists.settled.length : S.lists.open.length);
  const base = tabList(S.filter);
  const shown = base.filter((m) => S.exchange === 'all' || !S.exchange || venuesOf(m).includes(S.exchange));
  const onlyFeatured = !S.query && featured && ['trending', 'ending', 'new'].includes(S.filter) && shown.length === 1 && shown[0].id === featured.id;
  const exchanges = [...new Set([...S.lists.open, ...S.lists.live, ...S.lists.settled].flatMap(venuesOf))].sort();
  // Only exchanges that have markets in this tab (plus the one currently chosen).
  const exList = exchanges.map((e) => [e, base.filter((m) => venuesOf(m).includes(e)).length]).filter(([e, n]) => n > 0 || S.exchange === e);
  const filterBtn = ([id, icon, label]) =>
    `<button data-filter="${id}" aria-current="${S.filter === id && !S.query}">${ico(icon)}<span>${label}</span><span class="side-n">${count(id)}</span></button>`;
  const exBtn = (id, label, n) => `<button data-exchange="${esc(id)}" aria-current="${(S.exchange ?? 'all') === id}">${id === 'all' ? ico('landmark') : `<span class="ex-dot" aria-hidden="true">${esc(label.slice(0, 1))}</span>`}<span>${esc(label)}</span><span class="side-n">${n}</span></button>`;
  return `
    ${tnCard}
    ${S.query ? '' : homeHero(!tnCard)}
    <div class="home">
      <aside class="home-side" aria-label="Filter markets">
        <div class="side-group">${HOME_TABS.map(filterBtn).join('')}</div>
        ${exList.length > 1 ? `<div class="side-label">Exchanges</div><div class="side-group">${exBtn('all', 'All exchanges', base.length)}${exList.map(([e, n]) => exBtn(e, e, n)).join('')}</div>` : ''}
      </aside>
      <div class="home-main">
        ${featured && !S.query ? featuredView(featured) : ''}
        <div class="home-head">
          ${onlyFeatured ? '' : `<h2>${S.query ? 'Search results' : (HOME_TABS.find(([id]) => id === S.filter)?.[2] ?? 'Markets')}</h2>`}
          ${S.exchange && S.exchange !== 'all' ? `<button class="chip chip-sm" data-exchange="all">${esc(S.exchange)} ${ico('cross')}</button>` : ''}
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
  const venues = [...new Set(open.flatMap(venuesOf))].sort().slice(0, 4);
  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);
  const word = (b) => `<b style="color:${oVar(b, false)}">${oName(b, false)}</b>`;
  const stats = [
    open.length ? ['Open markets', fmtNum(open.length)] : null,
    inPlay ? ['In play', `${fmtNum(inPlay)} pts`] : null,
    best >= 1 ? ['Top payout now', `${best.toFixed(1)}×`] : null,
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
            : `<p class="hero-badge">${ico('sparkles')}Listing prediction markets<span class="hero-badge-more"> · Free to play</span></p>`
        }
        <h1 id="hero-title">Predict where new listings land.<span class="soft"> Before the price settles.</span></h1>
        <p class="hero-sub">Pick one of five outcomes (${LADDER.map(word).join(', ')}) on freshly listed tokens${venues.length ? ` across ${esc(list(venues))}` : ''}. Points only, no real money.</p>
        ${stats.length ? `<dl class="hero-stats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
      </div>
      ${
        next
          ? `<a class="hero-next" href="#/market/${encodeURIComponent(next.id)}">
        <span class="hero-next-head"><span>Closing next</span><span class="st st-live"><i aria-hidden="true"></i>Open</span></span>
        <span class="hero-next-id">${tokenAvatar(next, 'avatar-md')}<span><b>${esc(next.symbol)}</b>${next.name ? `<small>${esc(next.name)}</small>` : ''}</span></span>
        <span class="hero-next-facts"><span><small>Closes in</small><b>${until(next.closeAt)}</b></span><span><small>Pool</small><b>${fmtNum(next.pool || 0)} pts</b></span></span>
        <span class="btn btn-gold btn-sm">Predict ${ico('arrowRight')}</span>
      </a>`
          : ''
      }
    </section>`;
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
  if (S.filter === 'live') return `<div class="empty-art">${ico('clock')}</div><p>No markets are waiting for a result. Markets move here once predictions close.</p><button class="btn" data-filter="trending">See open markets</button>`;
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
             <div>${ico('users')}<dt>Predictors</dt><dd>${fmtNum(m.predictors)}</dd></div>`
          : isManual(m)
          ? `<div>${ico('dollar')}<dt>${isYesNo(m) ? 'Target' : 'Start price'}</dt><dd>${hasStart(m) ? fmtPrice(m.basePrice) : 'At listing'}</dd></div>`
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

function featuredView(m) {
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
    manual ? fact(yn ? 'Target price' : 'Start price', hasStart(m) ? fmtPrice(m.basePrice) : 'At listing <span class="feat-sub">opening price</span>') : '',
    pre ? fact(m.kind === 'live_test' ? 'Starts in' : 'Lists in', until(isUpcoming(m) ? m.closeAt : m.listingAt)) : fact('Closes in', until(m.closeAt)),
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
    <section class="feat" aria-labelledby="featured-title">
      <div class="feat-main">
        <div class="feat-kicker"><span class="st ${pre ? 'st-soon' : 'st-live'}"><i aria-hidden="true"></i>${pre ? 'Upcoming' : 'Open'}</span><span aria-hidden="true">·</span><span>Featured market</span></div>
        <div class="feat-id">
          ${tokenAvatar(m, 'avatar-lg')}
          <div><h2 id="featured-title">${esc(m.symbol)}</h2>${m.name ? `<p>${esc(m.name)}</p>` : ''}</div>
        </div>
        <p class="feat-q">${question}</p>
        <dl class="feat-facts">${facts}</dl>
        <div class="feat-actions">
          <a class="btn btn-gold" href="${href}">Open market ${ico('arrowRight')}</a>
          ${m.pool ? '' : '<span class="feat-hint">No predictions yet. Early picks earn the biggest bonus.</span>'}
        </div>
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
    body = `${upcoming ? upcomingLine(m) : '<p class="card-quiet">No predictions yet. Early picks get the biggest bonus.</p>'}${quickPicks(m, 'qp-mini')}`;
  } else {
    // The two outcomes the crowd backs most (Up and Down before anyone predicts).
    const top = m.pool ? [...bucketsOf(m)].sort((a, b) => m.totals[b] - m.totals[a]).slice(0, 2) : ['up', 'down'];
    body = `<div class="o-rows">${top
      .map((b) => {
        const x = poolMultiple(m, b);
        return `<div class="o-row" style="--c:var(--${b})">
          <span class="o-name">${icon(b)}${oName(b)}<small>${rangeOf(m, b)}</small></span>
          <b class="o-pct">${m.pool ? `${Math.round(share(m, b) * 100)}%` : '–'}</b>
          <button class="qp qp-sm" style="--c:var(--${b})" data-action="quick-pick" data-id="${esc(m.id)}" data-bucket="${b}"${open ? '' : ' disabled'} aria-label="Pick ${oName(b)} on ${esc(m.symbol)}">${x ? `${x.toFixed(1)}×` : 'Pick'}</button>
        </div>`;
      })
      .join('')}</div>`;
  }

  let when;
  if (m.phase === 'pre_listing') when = `${m.kind === 'live_test' ? 'Starts' : 'Lists'} in ${until(m.listingAt)}`;
  else if (upcoming) when = `Lists in ${until(m.closeAt)}`;
  else if (m.status === 'open' && m.phase !== 'awaiting_result' && m.phase !== 'running') when = `Closes in ${until(m.closeAt)}`;
  else if (m.phase === 'running') when = `Result in ${until(m.settleAt)}`;
  else if (m.phase === 'awaiting_result') when = 'Awaiting result';
  else when = fmtDate(m.settleAt);

  const state =
    m.status === 'resolved' ? '<span class="st st-done">Settled</span>'
    : m.status === 'void' ? '<span class="st st-off">Cancelled</span>'
    : m.phase === 'awaiting_result' ? '<span class="st st-wait">Awaiting</span>'
    : soon ? `<span class="st st-hot">${ico('flame')}${upcoming ? 'Listing soon' : 'Closing soon'}</span>`
    : upcoming ? '<span class="st st-soon"><i aria-hidden="true"></i>Upcoming</span>'
    : '<span class="st st-live"><i aria-hidden="true"></i>Open</span>';

  return `
    <article class="card mcard${soon ? ' soon' : ''}">
      <div class="card-top">
        ${tokenAvatar(m, 'avatar-md')}
        <a class="card-link" href="${href}"><span class="sym">${esc(m.symbol)}${yn ? ' <span class="tag tag-yn">Yes / No</span>' : ''}</span><span class="card-name">${esc(m.name || '')}${m.kind === 'live_test' ? ' <span class="tag tag-test">Live test</span>' : ''}</span></a>
        ${g}
      </div>
      ${body}
      ${myPickLine(m)}
      <div class="card-foot">
        ${state}${m.pool ? `<span class="dot-sep" aria-hidden="true">·</span><span>${tick(`pool:card:${m.id}`, m.pool)} pts</span>` : ''}<span class="dot-sep" aria-hidden="true">·</span><span class="card-ex">${esc(venueNames(m))}</span>
        <span class="when">${when}</span>
      </div>
    </article>`;
}

/** On a settled market: the player's own points won or lost, with the button to share it. */
function myResultRow(m) {
  const mine = (m.mine ?? []).filter((p) => p.stake - (p.refund ?? 0) > 0);
  if (m.status !== 'resolved' || !mine.length) return '';
  const profit = mine.reduce((s, p) => s + (p.payout ?? 0) - (p.stake - (p.refund ?? 0)), 0);
  return `<div class="my-result"><span>Your result <b class="${profit >= 0 ? 'profit-pos' : 'profit-neg'}">${signed(profit)} pts</b></span>${pnlButton(m.id, m.symbol, 'btn btn-sm')}</div>`;
}

/** "You: Up · 250" on a card, so players can see their picks without opening the market. */
function myPickLine(m) {
  if (!m.mine?.length) return '';
  const yn = isYesNo(m);
  const by = {};
  for (const p of m.mine) by[p.bucket] = (by[p.bucket] ?? 0) + p.stake;
  let state = '';
  if (m.status === 'resolved') state = m.mine.some((p) => p.payout > 0) ? ` · <b class="profit-pos">won ${fmtNum(m.mine.reduce((s, p) => s + (p.payout ?? 0), 0))}</b>` : ' · didn’t win';
  else if (m.status === 'void') state = ' · refunded';
  return `<div class="card-mine">${ico('user')}<span>You: ${Object.entries(by)
    .map(([b, pts]) => `${outcome(b, yn)} ${fmtNum(pts)}`)
    .join(', ')}${state}</span></div>`;
}

/** Three friendly steps up front; the full rules stay one tap away. */
function howItWorks() {
  const steps = `
      <div class="section-head"><span class="section-ico">${ico('info')}</span><div><h2>How it works</h2><p class="muted">Free to play. Points only, no real money.</p></div><button class="btn btn-sm head-action" data-action="tour">${ico('sparkles')}Take the tour</button></div>
      <ol class="steps">
        <li><span class="step-ico" style="--c:var(--up)">${ico('target')}</span><b>Pick an outcome</b><p>Where will the price land? Five choices, from ${outcome('crash')} to ${outcome('moon')}, or a simple Yes or No.</p></li>
        <li><span class="step-ico" style="--c:var(--moon)">${ico('coins')}</span><b>Stake free points</b><p>Everyone gets ${startPoints()}, plus up to 200 more every day with a daily streak. No real money.</p></li>
        <li><span class="step-ico" style="--c:var(--brand)">${ico('trophy')}</span><b>Win the pool</b><p>If you’re right, you split the pool with the other winners. Earlier picks earn more.</p></li>
      </ol>
      <details class="full-rules"><summary>Full rules</summary>`;
  if (S.cfg?.manualOnly) {
    return `
    <section class="section" id="how" style="margin-top:36px">${steps}
      <ol class="rules">
        <li>Firstprint opens markets on newly listed tokens on major exchanges, including new listings it spots automatically on MEXC, OKX, Gate, Bitget and KuCoin. Log in with Google, email, or a Solana wallet to get ${startPoints()}.</li>
        <li>Pick one of five outcomes for where the price ends up compared with the start price, from Crash to Moon. Predictions close at the time shown, and earlier predictions earn a bigger share.</li>
        <li>When the result is due, the final price and the winners appear on the market page.</li>
        <li>Everyone who picked the winning outcome splits the pool, minus the fee shown on the market (usually 4%). Everyone gets their points back if nobody picked the winner, everyone picked the same outcome, or the market is cancelled.</li>
      </ol></details>
    </section>`;
  }
  return `
    <section class="section" id="how" style="margin-top:36px">${steps}
      <ol class="rules">
        <li>Firstprint watches seven exchanges for new listings and opens a market when one is confirmed. Sign in with Google, email, or a Solana wallet to get ${startPoints()}.</li>
        <li>Pick one of five outcomes for the price 72 hours after listing, from Crash to Moon. Predictions stay open until 1 hour after trading starts, and earlier predictions earn a bigger share.</li>
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
  $('#market-main').innerHTML = marketMain(m);
  $('#mobile-bar-root').innerHTML = mobileBar(m);
  renderTrade();
}

function statusLine(m) {
  switch (m.phase) {
    case 'pre_listing':
      return m.kind === 'live_test'
        ? `Starts in <strong>${until(m.listingAt)}</strong>. Predictions close ${fmtSpan(m.closeAt - m.listingAt)} after it starts.`
        : `Lists in <strong>${until(m.listingAt)}</strong>. Predictions close ${fmtSpan(m.closeAt - m.listingAt)} after trading starts.`;
    case 'baseline':
      if (isManual(m)) return `Predictions close in <strong>${until(m.closeAt)}</strong>. The result is expected around ${fmtDate(m.settleAt)}.`;
      return `${m.kind === 'live_test' ? 'The market has started.' : 'Trading started.'} Predictions close in <strong>${until(m.closeAt)}</strong>.`;
    case 'running':
      return `Predictions are closed. Result in <strong>${until(m.settleAt)}</strong>.`;
    case 'awaiting_result':
      return `Predictions are closed. Waiting for Firstprint to post the final price. Expected around <strong>${fmtDate(m.settleAt)}</strong>.`;
    case 'resolved':
      if (isYesNo(m)) return `Result posted: final price <strong>${fmtPrice(m.result.finalPrice)}</strong> against a target of ${fmtPrice(m.result.basePrice)}, so ${outcome(m.result.winningBucket, true)} wins.`;
      if (isManual(m)) return `Result posted: ${fmtPrice(m.result.basePrice)} → <strong>${fmtPrice(m.result.finalPrice)}</strong> (${fmtPct(m.result.returnPct)}), so ${outcome(m.result.winningBucket)} wins.`;
      return `Settled in ${outcome(m.result.winningBucket)} at <strong>${fmtPct(m.result.returnPct)}</strong> on ${fmtDate(m.settleAt)}.`;
    case 'void':
      return `Cancelled because ${VOID_REASONS[m.result?.voidReason] ?? 'of a data problem'}. All points were returned.`;
  }
  return '';
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

  const rungs = bucketsOf(m).map((b) => {
    const pct = share(m, b) * 100;
    const won = m.status === 'resolved' && m.result.winningBucket === b;
    let pays = '–';
    if (canPick && m.totals[b]) pays = `${estMultiple(m, b).toFixed(1)}×`;
    else if (canPick) pays = 'Be first';
    else if (won && m.totals[b]) pays = `${(net / m.totals[b]).toFixed(2)}×`;
    else if (!settled && m.totals[b]) pays = `${(m.pool * (1 - m.feeBps / 10_000) / m.totals[b]).toFixed(1)}×`;
    return `
      <button class="rung${won ? ' won' : ''}${yn ? ' rung-yn' : ''}" style="--c:${oVar(b, yn)};--share:${pct}%" data-bucket="${b}"
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
    ? `Where will ${esc(m.name || m.symbol)} be priced at the result, compared with ${hasStart(m) ? `the start price of ${fmtPrice(m.basePrice)}` : 'its opening price when trading starts'}?`
    : m.kind === 'live_test'
    ? `Where will ${esc(m.name || m.symbol)} trade ${span} after this market starts?`
    : `Where will ${esc(m.name || m.symbol)} trade ${span} after listing on ${esc(m.exchange)}?`;

  // One line of facts: price, timing, where the price comes from, and the pool once it exists.
  const fact = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const facts = [
    isManual(m) ? fact(yn ? 'Target price' : 'Start price', hasStart(m) ? fmtPrice(m.basePrice) : 'Opening price') : fact(m.kind === 'live_test' ? 'Starts' : 'Listing', fmtDate(m.listingAt)),
    m.status === 'open' && m.phase !== 'awaiting_result' && m.phase !== 'running'
      ? fact(isUpcoming(m) ? 'Lists & closes' : 'Closes', `${fmtDate(m.closeAt)} <span class="muted">· in ${until(m.closeAt)}</span>`)
      : fact('Result', fmtDate(m.settleAt)),
    settled || m.phase === 'awaiting_result' ? '' : fact('Result expected', fmtDate(m.settleAt)),
    m.pool ? fact('Pool', `${tick(`pool:page:${m.id}`, m.pool)} pts <span class="muted">· ${fmtNum(m.predictors)} predictor${m.predictors === 1 ? '' : 's'}</span>`) : '',
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
          ? `<div class="m-upcoming">${ico('clock')}<div><b>Listed. Opening price coming soon</b><p>Predictions are closed. Firstprint posts ${esc(m.symbol)}’s opening price here, then the result after ${fmtDate(m.settleAt)}.</p></div></div>`
          : ''
      }
      ${m.status === 'resolved' || m.status === 'void' || m.phase === 'awaiting_result' ? `<p class="m-status">${statusLine(m)}</p>` : ''}
      <dl class="m-facts">${facts}</dl>
      <div class="m-refs">${ico('landmark')}<span>${isManual(m) ? 'Reference' : 'Prices from'} ${esc(venueNames(m))}</span>${priceLinks(m)}</div>
    </header>

    ${isManual(m) ? manualPanel(m) : chartView(m)}

    <section class="ladder${settled ? ' settled' : ''}${yn ? ' ladder-yn' : ''}${quiet ? ' ladder-quiet' : ''}" role="group" aria-label="Outcomes">
      <div class="ladder-head"><span>${yn ? 'Your answer' : isManual(m) ? 'Final price vs start' : `Price after ${span}`}</span>${quiet ? '' : '<span>Crowd</span><span>Pays</span><span class="pool-col">Pool</span>'}</div>
      ${rungs}
    </section>
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
};

function priceLinks(m) {
  const links = (m.venues ?? []).filter((v) => TRADE_URLS[v.id]);
  if (!links.length || m.status === 'resolved' || m.status === 'void') return '';
  const base = encodeURIComponent(m.symbol.toUpperCase());
  return `<div class="price-links"><span class="muted">${ico('chart')}Check the live price:</span>${links
    .map((v) => `<a class="btn btn-sm" href="${TRADE_URLS[v.id](base)}" target="_blank" rel="noopener noreferrer">${esc(v.name)} ${ico('external')}</a>`)
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
      <li>Yes wins if the final price is at or above ${hasStart(m) ? fmtPrice(m.basePrice) : `the opening price when ${esc(m.symbol)} starts trading (posted here once known)`}. No wins if it is below.</li>
      <li>Predictions close ${fmtDate(m.closeAt)}. Earlier predictions get up to ${(1 + m.earlyBirdK).toFixed(1)}× weight when the pool is split.</li>
      <li>After that the market waits for Firstprint to post the final price. The result and winners appear on this page.</li>
      <li>Winners split the pool minus a ${m.feeBps / 100}% fee. Limit ${fmtPts(m.userCap)} per person.</li>
      <li>The market is cancelled and refunded if nobody picks the winning answer, everyone picks the same answer, or Firstprint cancels it.</li>
    </ol>`;
  }
  return `
    ${m.note ? `<p class="m-note">${esc(m.note)}</p>` : ''}
    <ol class="rules">
      <li>${hasStart(m) ? `Start price: ${fmtPrice(m.basePrice)}.` : `Start price: the opening price when ${esc(m.symbol)} starts trading on ${esc(venueNames(m))}. Firstprint posts it here once trading opens.`} The result is the final price compared with it, using the ranges shown above.</li>
      <li>Predictions close ${fmtDate(m.closeAt)}. Earlier predictions get up to ${(1 + m.earlyBirdK).toFixed(1)}× weight when the pool is split.</li>
      <li>After that the market waits for Firstprint to post the final price. The result and winners appear on this page.</li>
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
  const t1 = Math.max(o.series[o.series.length - 1].t, Math.min(now(), m.closeAt));
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
      <div class="section-head"><span class="section-ico">${ico('users')}</span><h2>Top predictors <span class="count-badge">${fmtNum(h.total)}</span></h2></div>
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
      return `<div class="position" style="--c:${oVar(p.bucket, isYesNo(m))}"><span><b>${oName(p.bucket, isYesNo(m))}</b> ${fmtPts(p.stake)}</span><span>${state}</span></div>`;
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
    toast(`You’re in! ${oName(bucket, isYesNo(m))} for ${fmtPts(stake)}${payout ? `. Win about ${fmtPts(payout)} if it lands.` : '.'}`);
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
  const colors = [`var(--${bucket})`, `var(--${bucket})`, 'var(--moon)', 'var(--up)', 'var(--text)'];
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
 * bar, which then pulses and shows "+N". Resolves when the first coin lands, so the balance can
 * update right as it arrives. People who prefer less motion just see the pulse.
 */
function collectPoints(from, amount = 0, to = '.chip.points') {
  const target = typeof to === 'string' ? $(to) || $('.chip.points') : to;
  const start = from instanceof Element ? from.getBoundingClientRect() : from;
  const land = () => {
    const el = typeof to === 'string' ? $(to) || $('.chip.points') : to;
    if (!el) return;
    el.classList.remove('pts-hit');
    void el.offsetWidth;
    el.classList.add('pts-hit');
    if (amount) {
      const r = el.getBoundingClientRect();
      const gain = document.createElement('span');
      gain.className = 'pts-gain';
      gain.setAttribute('aria-hidden', 'true');
      gain.textContent = `+${fmtNum(amount)}`;
      gain.style.left = `${r.left + r.width / 2}px`;
      gain.style.top = `${r.bottom + 4}px`;
      document.body.appendChild(gain);
      setTimeout(() => gain.remove(), 1300);
    }
  };
  if (!target || !start || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    land();
    return Promise.resolve();
  }
  const end = target.getBoundingClientRect();
  const sx = start.left + start.width / 2;
  const sy = start.top + start.height / 2;
  const ex = end.left + Math.min(22, end.width / 2);
  const ey = end.top + end.height / 2;
  const count = Math.max(8, Math.min(16, Math.round(Math.log10(Math.max(10, amount)) * 5)));
  return new Promise((resolve) => {
    let landed = 0;
    for (let i = 0; i < count; i++) {
      const c = document.createElement('i');
      c.className = 'coin-fly';
      c.setAttribute('aria-hidden', 'true');
      document.body.appendChild(c);
      // Burst out a little, then curve into the balance.
      const mx = sx + (Math.random() - 0.5) * 150;
      const my = sy - 30 - Math.random() * 80;
      const anim = c.animate(
        [
          { transform: `translate(${sx}px, ${sy}px) scale(0.3) rotate(0deg)`, opacity: 0 },
          { transform: `translate(${mx}px, ${my}px) scale(1) rotate(160deg)`, opacity: 1, offset: 0.35 },
          { transform: `translate(${ex}px, ${ey}px) scale(0.5) rotate(320deg)`, opacity: 0.85 },
        ],
        { duration: 820, delay: i * 38, easing: 'cubic-bezier(0.55, 0, 0.2, 1)', fill: 'both' },
      );
      anim.onfinish = () => {
        c.remove();
        if (++landed === 1) {
          land();
          resolve();
        }
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
        ? `${podium}<div class="panel panel-flush"><table class="table"><thead><tr><th>Rank</th><th>Predictor</th><th class="right">Profit</th><th class="right hide-sm">Correct</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><div class="empty-art">${ico('trophy')}</div><p>No markets have settled ${{ day: 'today', week: 'this week', month: 'this month', all: '' }[lb.period ?? 'week'] || 'yet'}${lb.period === 'all' ? '' : ' yet'}.</p></div>`
    }
    ${S.me && !lb.me ? '<p class="fine">You’ll appear here after one of your predictions settles.</p>' : ''}`;
}

function portfolioView(preds, history = [], stats = null) {
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
      ${dashSummary(stats)}
      ${stats && stats.history.length >= 2 ? `<div class="dash-insights">${profitChart(stats.history)}${outcomeRecord(stats.byOutcome)}</div>` : ''}
      <div class="dash-layout">
        <section class="dash-card dash-main" aria-label="Your predictions">
          <div class="dash-tabs" role="tablist">
            <button role="tab" id="dt-active" aria-controls="dp-active" aria-selected="${tab === 'active'}" tabindex="${tab === 'active' ? 0 : -1}" data-dash-tab="active">Active predictions${active.length ? `<span class="count">${active.length}</span>` : ''}</button>
            <button role="tab" id="dt-past" aria-controls="dp-past" aria-selected="${tab === 'past'}" tabindex="${tab === 'past' ? 0 : -1}" data-dash-tab="past">Past markets${past.length ? `<span class="count">${past.length}</span>` : ''}</button>
          </div>
          <div role="tabpanel" id="dp-active" aria-labelledby="dt-active"${tab === 'active' ? '' : ' hidden'}>${activeTable(active)}</div>
          <div role="tabpanel" id="dp-past" aria-labelledby="dt-past"${tab === 'past' ? '' : ' hidden'}>${pastTable(stats)}</div>
        </section>
        <aside class="dash-side">
          ${streakCard(true)}
          ${telegramCard()}
          ${walletsCard()}
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

/** Points and win rate side by side; a record card joins them once a market has settled. */
function dashSummary(st) {
  const points = `
    <div class="sum-card sum-points">
      <div class="sum-top"><span class="sum-label">${ico('coins')}Points</span>
        ${S.me.canClaimDaily ? `<button class="btn btn-gold btn-sm" data-action="claim">${ico('gift')}Claim ${dailyNext()}</button>` : `<span class="sum-note">${ico('flame')}Day ${S.me.daily?.streak ?? 1} streak · +${dailyNext()} tomorrow</span>`}</div>
      <div class="sum-value">${tick('me:points:dash', S.me.points)}</div>
      <p class="sum-sub">${st?.open.staked ? `${fmtNum(st.open.staked)} more in play` : 'Available to predict with'}</p>
    </div>`;
  const settled = Boolean(st?.settled);
  const pct = settled ? Math.round(st.winRate * 100) : null;
  const winRate = `
    <div class="sum-card">
      <div class="sum-top"><span class="sum-label">${ico('percent')}Win rate</span></div>
      ${
        settled
          ? `<div class="sum-value">${pct}%</div>
             <div class="meter" role="img" aria-label="${pct}% of markets won"><i style="width:${pct}%"></i></div>
             <p class="sum-sub">${st.wins} of ${st.settled} market${st.settled === 1 ? '' : 's'} won</p>`
          : `<div class="sum-value sum-na" aria-label="Not available yet">—</div>
             <p class="sum-sub">${st?.marketsPlayed ? 'Shows once your first market settles' : 'Not available until your first market settles'}</p>`
      }
    </div>`;
  if (!settled) return `<section class="dash-summary" aria-label="Summary">${points}${winRate}</section>`;
  const fact = (label, value, sub) => `<div><dt>${label}</dt><dd>${value}</dd>${sub ? `<p>${sub}</p>` : ''}</div>`;
  const record = `
    <div class="sum-card sum-record">
      <div class="sum-top"><span class="sum-label">${ico('award')}Your record</span></div>
      <dl class="record-grid">
        ${fact('Points won', `<span class="${st.netProfit >= 0 ? 'profit-pos' : 'profit-neg'}">${signed(st.netProfit)}</span>`, `from ${fmtNum(st.totalStaked)} staked`)}
        ${fact('Best win', st.bestWin ? `<span class="profit-pos">${signed(st.bestWin.profit)}</span>` : '<span class="sum-na">—</span>', st.bestWin ? `on <a href="#/market/${encodeURIComponent(st.bestWin.marketId)}">${esc(st.bestWin.symbol)}</a>` : 'No wins yet')}
        ${fact('Streak', `${st.currentStreak}`, `best ${st.bestStreak}`)}
        ${fact('Rank', st.rank ? `#${fmtNum(st.rank)}` : '<span class="sum-na">—</span>', st.rank ? `of ${fmtNum(st.players)}` : 'Not ranked yet')}
      </dl>
    </div>`;
  return `<section class="dash-summary has-record" aria-label="Summary">${points}${winRate}${record}</section>`;
}

function activeTable(active) {
  if (!active.length) return dashEmpty('target', 'No active predictions. Pick an outcome on any open market to start your record.', `<a class="btn btn-sm" href="#/">${ico('grid')}Explore markets</a>`);
  return `<table class="table dash-table"><thead><tr><th>Market</th><th>Your pick</th><th class="right">Stake</th><th class="right">Status</th></tr></thead><tbody>${active
    .map((p) => {
      const status = p.marketStatus === 'open' ? '<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>Open</span>' : `<span class="pill pill-wait">${p.mode === 'manual' ? 'Awaiting result' : 'In play'}</span>`;
      return `<tr><td><a class="mkt-cell" href="#/market/${encodeURIComponent(p.marketId)}">${tokenAvatar(p, 'avatar-sm')}<span>${esc(p.symbol)}</span></a></td><td>${outcome(p.bucket, p.outcomes === 'binary')}</td><td class="right num-cell">${fmtNum(p.stake)}</td><td class="right">${status}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function pastTable(st) {
  const rows = st?.history ?? [];
  const refunds = st?.refundedMarkets ? `<p class="fine">${st.refundedMarkets} cancelled market${st.refundedMarkets === 1 ? ' was' : 's were'} refunded and ${st.refundedMarkets === 1 ? 'doesn’t' : 'don’t'} count toward your record.</p>` : '';
  if (!rows.length) return dashEmpty('history', 'No settled markets yet. Your results appear here when markets you predicted on are settled.') + refunds;
  return `<table class="table dash-table"><thead><tr><th>Market</th><th>Your pick</th><th class="hide-sm">Result</th><th class="right">Staked</th><th class="right">Points</th></tr></thead><tbody>${rows
    .map(
      (m) => `<tr>
        <td><a class="mkt-cell" href="#/market/${encodeURIComponent(m.marketId)}">${tokenAvatar(m, 'avatar-sm')}<span>${esc(m.symbol)}<small class="muted">${fmtAgo(m.settledAt)}</small></span></a></td>
        <td>${m.buckets.map((b) => outcome(b, m.binary)).join(' ')}</td>
        <td class="hide-sm">${m.winningBucket ? outcome(m.winningBucket, m.binary) : '–'}</td>
        <td class="right num-cell">${fmtNum(m.staked)}</td>
        <td class="right"><b class="${m.won ? 'profit-pos' : 'profit-neg'}">${signed(m.profit)}</b>${pnlButton(m.marketId, m.symbol, 'icon-btn pnl-mini', true)}</td>
      </tr>`,
    )
    .join('')}</tbody></table>${refunds}`;
}

function walletsCard() {
  const ws = S.me.wallets;
  return `
    <section class="dash-card">
      <div class="dash-card-head"><h2>${ico('wallet')}Wallets</h2>${ws.length ? `<span class="count">${ws.length}</span>` : ''}</div>
      ${
        ws.length
          ? `<ul class="dash-wallets">${ws
              .map(
                (w) => `<li>${WALLET_LOGOS[w.walletName] ? `<img class="wallet-logo" src="${WALLET_LOGOS[w.walletName]}" alt="" width="20" height="20" />` : ''}<span class="dw-main"><span class="addr" title="${esc(w.address)}">${esc(shortAddress(w.address))}</span><span class="muted">${esc(w.walletName || 'Solana wallet')}</span></span>
                  <a class="dw-link" href="https://solscan.io/account/${encodeURIComponent(w.address)}" target="_blank" rel="noopener noreferrer" aria-label="View ${esc(shortAddress(w.address))} on Solscan">Solscan ${ico('external')}</a></li>`,
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
  const positions = p.positions.length
    ? `<table class="table"><thead><tr><th>Market</th><th>Pick</th><th class="right">Points</th><th class="right">Status</th></tr></thead><tbody>${p.positions
        .map(
          (x) => `<tr><td><a class="mkt-cell" href="#/market/${encodeURIComponent(x.marketId)}">${tokenAvatar(x, 'avatar-sm')}<span>${esc(x.symbol)}</span></a></td><td>${outcome(x.bucket, x.outcomes === 'binary')}</td><td class="right num-cell">${fmtNum(x.stake)}</td><td class="right">${
            x.marketStatus === 'open' ? '<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>Open</span>' : '<span class="pill pill-wait">Awaiting result</span>'
          }</td></tr>`,
        )
        .join('')}</tbody></table>`
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
      ${tile('star', 'moon', 'Best win', st.bestWin ? `<span class="profit-pos">${signed(st.bestWin.profit)}</span>` : '–', st.bestWin ? `on <a href="#/market/${encodeURIComponent(st.bestWin.marketId)}">${esc(st.bestWin.symbol)}</a>` : 'No wins yet')}
      ${tile('flame', 'down', 'Streak', `${st.currentStreak}`, `wins in a row · best ${st.bestStreak}`)}
      ${tile('target', 'brand', 'Markets played', fmtNum(st.marketsPlayed), `${fmtNum(st.open.markets)} still open`)}
    </dl>
    ${st.history.length >= 2 ? `<div class="dash-grid">${profitChart(st.history)}${outcomeRecord(st.byOutcome, p.isMe ? undefined : 'Picks by outcome')}</div>` : ''}
    <section class="section panel panel-flush">
      <div class="section-head"><span class="section-ico">${ico('target')}</span><h2>In play${p.positions.length ? ` <span class="count-badge">${p.positions.length}</span>` : ''}</h2></div>
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
    'moon',
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
    ${tile('star', 'moon', 'Best win', st.bestWin ? `<span class="profit-pos">${signed(st.bestWin.profit)}</span>` : '–', st.bestWin ? `on <a href="#/market/${encodeURIComponent(st.bestWin.marketId)}">${esc(st.bestWin.symbol)}</a>` : 'Your first win shows up here')}
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
function outcomeRecord(byOutcome, title = 'Your picks by outcome') {
  const rows = LADDER.filter((b) => byOutcome[b].picks);
  if (!rows.length) return '';
  return `
    <section class="section panel">
      <div class="section-head"><span class="section-ico">${ico('target')}</span><h2>${title}</h2></div>
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
  return `
    <section class="section panel panel-flush">
      <div class="section-head"><span class="section-ico">${ico('history')}</span><h2>Past markets${rows.length ? ` <span class="count-badge">${rows.length}</span>` : ''}</h2></div>
      ${
        rows.length
          ? `<table class="table"><thead><tr><th>Market</th><th>Your pick</th><th class="hide-sm">Result</th><th class="right">Staked</th><th class="right">Points</th></tr></thead><tbody>${rows
              .map(
                (m) => `<tr>
                  <td><a class="mkt-cell" href="#/market/${encodeURIComponent(m.marketId)}">${tokenAvatar(m, 'avatar-sm')}<span>${esc(m.symbol)}</span></a> <span class="muted hide-sm">${fmtAgo(m.settledAt)}</span></td>
                  <td>${m.buckets.map((b) => outcome(b, m.binary)).join(' ')}</td>
                  <td class="hide-sm">${m.winningBucket ? outcome(m.winningBucket, m.binary) : '–'}</td>
                  <td class="right">${fmtNum(m.staked)}</td>
                  <td class="right"><b class="${m.won ? 'profit-pos' : 'profit-neg'}">${signed(m.profit)}</b>${mine ? pnlButton(m.marketId, m.symbol, 'icon-btn pnl-mini', true) : ''}</td>
                </tr>`,
              )
              .join('')}</tbody></table>`
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
  stake: (e) => `Prediction${e.symbol ? ` on ${e.symbol}` : ''}`,
  refund: (e) => `Refund${e.symbol ? ` from ${e.symbol}` : ''}`,
  payout: (e) => `Won${e.symbol ? ` on ${e.symbol}` : ''}`,
};

/** Every change to the balance, so points never seem to appear or vanish. */
function historyView(entries) {
  return `
    <section class="dash-card">
      <div class="dash-card-head"><h2>${ico('coins')}Points history</h2></div>
      ${
        entries.length
          ? `<ul class="dash-ledger">${entries
              .map((e) => {
                const label = (HISTORY_LABELS[e.reason] ?? (() => e.reason))(e);
                const name = e.marketId ? `<a href="#/market/${encodeURIComponent(e.marketId)}">${esc(label)}</a>` : esc(label);
                return `<li><span class="dl-main">${name}<small>${fmtAgo(e.at)}</small></span><b class="${e.delta >= 0 ? 'profit-pos' : 'dl-neg'}">${e.delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(e.delta))}</b></li>`;
              })
              .join('')}</ul>`
          : '<p class="dash-card-text">Every change to your balance will be listed here.</p>'
      }
    </section>`;
}

// ------------------------------------------------------------------ Earn: tasks, referrals, TestFPT

const FAUCET_URL = 'https://faucet.solana.com';
const rewardsCluster = () => S.rewards?.cluster || S.cfg?.rewards?.cluster || 'testnet';
const clusterName = () => (rewardsCluster() === 'devnet' ? 'Devnet' : 'Testnet');
const TASK_ICONS = { follow: 'userPlus', repost: 'repeat', like: 'heart', share: 'megaphone', link: 'link' };

/** How to get free test SOL for the network fee. */
function faucetSteps() {
  const wallet = S.me?.wallets?.[0]?.address;
  const net = clusterName();
  return `
    <ol class="howto">
      <li><b>Switch your wallet to ${net}.</b>
        <span class="muted">Phantom: Settings → Developer Settings → turn on Testnet Mode → Solana ${net}. Solflare: Settings → Network → ${net}. Backpack: Settings → Solana → ${net}.</span></li>
      <li><b>Copy your wallet address.</b>
        ${wallet ? `<span class="copy-row"><code>${esc(shortAddress(wallet))}</code><button class="btn" data-action="copy-text" data-text="${esc(wallet)}">Copy address</button></span>` : '<span class="muted">It’s at the top of your wallet. Link it to Firstprint on the Earn page so you can claim to it.</span>'}</li>
      <li><b>Get test SOL from the faucet.</b>
        <span class="muted">Open the faucet, choose ${net}, paste your address and request 1 SOL. It’s free and has no value. If it says you’ve asked too often, try again later.</span>
        <a class="btn btn-solid" href="${FAUCET_URL}" target="_blank" rel="noopener noreferrer">${ico('droplet')}Open the Solana faucet ${ico('external')}</a></li>
      <li><b>Come back and claim.</b> <span class="muted">On the Earn page, claim your points. Your wallet pays a tiny fee from the test SOL.</span></li>
    </ol>
    <button class="btn" style="width:100%" data-action="close-modal">Done</button>`;
}

/** The getting-started steps, with what's already done ticked. */
function startSteps() {
  const r = S.rewards;
  const hasWallet = Boolean(S.me?.wallets?.length);
  const step = (done, title, body, action = '') =>
    `<li class="${done ? 'done' : ''}"><span class="step-check" aria-hidden="true">${done ? ico('check') : ''}</span><div><b>${title}</b><span class="muted">${body}</span>${done ? '' : action}</div></li>`;
  return `
    <ol class="steplist">
      ${step(hasWallet, 'Link a Solana wallet', 'Phantom, Solflare or Backpack. Your TestFPT goes here.', '<button class="btn" data-action="link-wallet">Link wallet</button>')}
      ${step(false, `Get free test SOL (${clusterName()})`, 'Pays the tiny network fee for your claim.', '<button class="btn" data-action="faucet">Show me how</button>')}
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
    ['Claim TestFPT', 'Free test SOL pays the fee', false],
  ];
  const done = steps.filter((x) => x[2]).length;
  const next = steps.findIndex((x) => !x[2]);
  const cta = !signedIn
    ? `<button class="btn btn-gold" data-action="connect">Sign in to claim ${ico('arrowRight')}</button>`
    : !wallet
    ? `<button class="btn btn-gold" data-action="start-guide">Link a wallet ${ico('arrowRight')}</button>`
    : `<a class="btn btn-gold" href="#/earn">Claim 1,000 TestFPT ${ico('arrowRight')}</a>`;
  return `
    <section class="testnet-card" aria-labelledby="testnet-title" style="--done:${done / steps.length}">
      <div class="tn-coins" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="tn-copy">
        <p class="tn-kicker"><span class="dot-live" aria-hidden="true"></span>Testnet is live</p>
        <h2 id="testnet-title">Claim 1,000 free TestFPT<span class="soft"> on Solana ${clusterName()}.</span></h2>
        <p class="tn-sub">Your Firstprint points, as a token in your own wallet. Takes about two minutes. Test network only, no real money.</p>
      </div>
      <ol class="tn-steps">${steps
        .map(([t, sub, ok], i) => `<li class="${ok ? 'done' : i === next ? 'next' : ''}"><span class="tn-n">${ok ? ico('check') : `0${i + 1}`}</span><span><b>${t}</b><small>${sub}</small></span></li>`)
        .join('')}</ol>
      <div class="tn-actions">${cta}${signedIn ? '<button class="btn tn-more" data-action="start-guide">See all steps</button>' : ''}</div>
      <span class="tn-progress" aria-hidden="true"><i></i></span>
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
        <p class="page-lede">${r.onChain ? `Rewards arrive as <b>TestFPT</b> on Solana ${clusterName()} when you claim them, and go into your Firstprint balance too.` : 'Complete tasks and invite friends. Points go straight to your balance.'}</p>
      </header>
      ${streakCard()}
      ${r.onChain ? claimCard(r) : ''}
      <div class="earn2-grid">
        <div class="earn2-main">
          ${tasksCard(r)}
          ${r.onChain ? claimsList(r) : ''}
        </div>
        <aside class="earn2-side">
          ${xCard(r)}
          ${referralCard(r)}
        </aside>
      </div>
    </div>`;
}

function claimCard(r) {
  const wallets = S.me.wallets;
  return `
    <section class="claim-card${r.claimable ? ' has-claim' : ' is-empty'}">
      <div class="claim-amount"><span class="claim-ico">${ico('token')}</span><div><b>${r.claimable ? `<span class="num">${fmtNum(r.claimable)}</span> TestFPT ready to claim` : 'Nothing to claim yet'}</b><span class="muted">${r.claimable ? 'Send it to your wallet whenever you like.' : 'Finish a task or invite a friend, then claim it here as TestFPT.'}</span></div></div>
      <div class="claim-side">
        ${
          !wallets.length
            ? '<p class="muted" style="margin:0">Link a Solana wallet to claim to it.</p><button class="btn btn-solid" data-action="link-wallet">Link wallet</button>'
            : !(r.claimable || S.claimBusy)
            ? ''
            : `${wallets.length > 1 ? `<label class="select">To <select id="claim-wallet">${wallets.map((w) => `<option value="${esc(w.address)}">${esc(shortAddress(w.address))}${w.walletName ? ` · ${esc(w.walletName)}` : ''}</option>`).join('')}</select></label>` : `<span class="muted">To ${esc(shortAddress(wallets[0].address))}</span>`}
               <button class="btn btn-gold" data-action="claim-tokens"${S.claimBusy ? ' disabled' : ''}>${S.claimBusy ? 'Claiming…' : `Claim ${fmtNum(r.claimable)} TestFPT`}</button>`
        }
        <p class="fine" id="claim-status" role="status">Your wallet pays a tiny fee in test SOL. <button class="switch" data-action="faucet">Need test SOL?</button>${r.mintUrl ? ` · <a href="${esc(r.mintUrl)}" target="_blank" rel="noopener noreferrer">TestFPT on Solana Explorer ${ico('external')}</a>` : ''}</p>
      </div>
    </section>`;
}

function xCard(r) {
  return `
    <section class="earn-card">
      <div class="card-head"><span class="card-ico">${ico('x')}</span><h2>Your X account</h2>${r.xConnectPoints && !r.xUsername ? `<span class="pill pill-pts">+${r.xConnectPoints}</span>` : ''}</div>
      ${
        r.xUsername
          ? `<p class="linked">${ico('checkCircle')}Linked as <b>@${esc(r.xUsername)}</b></p><p class="fine">Tasks on X are checked against this account.</p>`
          : `<p class="muted">Link your X username to unlock X tasks${r.xConnectPoints ? ` and get <b>+${r.xConnectPoints} points</b>` : ''}. No password or login needed.</p>
             <form id="x-form" class="inline-form" novalidate><span class="input-wrap"><span class="input-prefix">@</span><input name="x" placeholder="yourname" maxlength="16" autocomplete="off" aria-label="X username" /></span><button class="btn btn-solid" type="submit">${ico('link')}Link</button></form>
             <p class="form-error" id="x-error" role="alert"></p>`
      }
    </section>`;
}

function referralCard(r) {
  const f = r.referral;
  const shareText = encodeURIComponent('I’m calling new crypto listings on Firstprint. Join me and get free points:');
  return `
    <section class="earn-card">
      <div class="card-head"><span class="card-ico">${ico('userPlus')}</span><h2>Invite friends</h2><span class="pill pill-pts">+${f.perReferral} each</span></div>
      <p class="muted">You get <b>+${f.perReferral} points</b> when a friend signs up with your link and makes their first prediction (up to ${f.limit} friends).</p>
      <div class="copy-row"><input readonly value="${esc(f.link)}" aria-label="Your invite link" /><button class="btn" data-action="copy-text" data-text="${esc(f.link)}">${ico('copy')}Copy</button></div>
      <a class="btn" href="https://x.com/intent/tweet?text=${shareText}&url=${encodeURIComponent(f.link)}" target="_blank" rel="noopener noreferrer">${ico('x')}Share on X</a>
      <div class="ref-stats"><span><b>${fmtNum(f.invited)}</b> signed up</span><span><b>${fmtNum(f.rewarded)}</b> rewarded</span><span><b class="profit-pos">${signed(f.points)}</b> points</span></div>
    </section>`;
}

function tasksCard(r) {
  const rows = r.tasks;
  return `
    <section class="section panel">
      <div class="section-head"><span class="section-ico">${ico('list')}</span><div><h2>Tasks</h2><p class="muted">Open a task, do it on X, then come back and press Verify.</p></div>${(() => { const n = rows.filter((t) => !t.done && t.remaining !== 0).reduce((sum, t) => sum + t.points, 0); return n ? `<span class="pill pill-pts head-action">+${fmtNum(n)} available</span>` : ''; })()}</div>
      ${
        rows.length
          ? `<ul class="tasks">${rows
              .map((t) => {
                const full = t.remaining === 0 && !t.done;
                let action;
                if (t.done) action = `<span class="task-done">${ico('checkCircle')}Done</span>`;
                else if (full) action = '<span class="muted">Limit reached</span>';
                else if (t.startedAt) action = `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${ico('external')}Open again</a><button class="btn btn-solid" data-action="task-verify" data-task="${esc(t.id)}">${ico('check')}Verify</button>`;
                else action = `<a class="btn btn-solid" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer" data-action="task-go" data-task="${esc(t.id)}">Start ${ico('chevronRight')}</a>`;
                return `<li class="task${t.done ? ' is-done' : ''}">
                  <span class="task-ico">${ico(TASK_ICONS[t.kind] ?? 'star')}</span>
                  <div class="task-body"><b>${esc(t.title)}</b><small><span class="pts">+${fmtNum(t.points)} points</span>${t.remaining !== null && !t.done ? ` · ${fmtNum(t.remaining)} spots left` : ''}</small></div>
                  <div class="task-actions">${action}</div>
                </li>`;
              })
              .join('')}</ul>
             <p class="fine">We check your linked X username; tasks done with another account don’t count.</p>`
          : `<div class="earn2-empty">${ico('list')}<p><b>No tasks right now.</b> New tasks on X show up here. Inviting friends earns points meanwhile.</p></div>`
      }
    </section>`;
}

function claimsList(r) {
  if (!r.claims.length) return '';
  const label = { pending: 'Waiting for wallet', submitted: 'Confirming', confirmed: 'Claimed', failed: 'Failed', expired: 'Expired' };
  return `
    <section class="section panel">
      <div class="section-head"><span class="section-ico">${ico('token')}</span><h2>Your claims</h2></div>
      <ul class="activity">${r.claims
        .map(
          (c) => `<li><span>${fmtNum(c.amount)} TestFPT to ${esc(shortAddress(c.wallet))} · <b class="${c.status === 'confirmed' ? 'profit-pos' : c.status === 'failed' || c.status === 'expired' ? 'profit-neg' : ''}">${label[c.status] ?? c.status}</b>${c.error && c.status !== 'confirmed' ? ` <span class="muted">${esc(c.error)}</span>` : ''}</span>
            <span class="muted">${c.explorerUrl ? `<a href="${esc(c.explorerUrl)}" target="_blank" rel="noopener noreferrer">Explorer ${ico('external')}</a> · ` : ''}${fmtAgo(c.at)}</span></li>`,
        )
        .join('')}</ul>
    </section>`;
}

function setClaimStatus(text) {
  const el = $('#claim-status');
  if (el) el.textContent = text;
}

/** Claim every reward to the chosen wallet: the server prepares, the wallet signs and pays the fee. */
async function claimTokens() {
  if (S.claimBusy) return;
  const wallet = $('#claim-wallet')?.value || S.me?.wallets?.[0]?.address;
  if (!wallet) return openAuth('link');
  S.claimBusy = true;
  const btn = $('[data-action="claim-tokens"]');
  const from = btn?.getBoundingClientRect();
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Claiming…';
  }
  setClaimStatus('Preparing your claim…');
  try {
    const c = await S.api.startClaim(wallet);
    setClaimStatus(`Approve the transaction in your wallet: it mints ${fmtNum(c.amount)} TestFPT to ${shortAddress(wallet)}.`);
    const walletName = S.me.wallets.find((w) => w.address === wallet)?.walletName;
    const signedTx = await signTransactionWith(wallet, c.transaction, c.cluster, walletName);
    setClaimStatus('Sending to Solana…');
    let res = await S.api.submitClaim(c.claimId, signedTx);
    for (let i = 0; res.status === 'submitted' && i < 20; i++) {
      setClaimStatus('Confirming on Solana…');
      await new Promise((r) => setTimeout(r, 3_000));
      res = await S.api.claimStatus(c.claimId);
    }
    if (res.status === 'confirmed') {
      await collectPoints(from, res.amount);
      celebrate('moon');
      toast(`${fmtNum(res.amount)} TestFPT claimed. Check your wallet!`);
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

async function onTaskVerify(taskId, btn) {
  const from = btn?.getBoundingClientRect();
  try {
    const out = await S.api.verifyTask(taskId);
    await refreshMe();
    if (S.route.name === 'earn') $('#view').innerHTML = earnView();
    // On-chain rewards wait in the claim bar; otherwise they go straight to the balance.
    await collectPoints(from, out.points, out.onChain ? '.claim-card .claim-ico' : '.chip.points');
    toast(out.onChain ? `+${fmtNum(out.points)} points ready to claim as TestFPT` : `+${fmtNum(out.points)} points added`);
  } catch (err) {
    toast(err.message, true);
    if (err.code === 'x_required') $('#x-form input')?.focus();
    await refreshMe();
    if (S.route.name === 'earn') $('#view').innerHTML = earnView();
  }
}

async function submitX(form) {
  const err = $('#x-error');
  try {
    const out = await S.api.connectX(String(new FormData(form).get('x') ?? ''));
    toast(out.rewarded ? `+${out.rewarded} points for linking @${out.xUsername}` : `Linked @${out.xUsername}`);
    await refreshMe();
    if (S.route.name === 'earn') $('#view').innerHTML = earnView();
  } catch (e) {
    if (err) err.textContent = e.message;
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
        ? `<table class="table radar"><thead><tr><th>Token</th><th>Exchange</th><th class="hide-sm">Found from</th><th>Trading starts</th><th class="right">Market</th></tr></thead><tbody>${rows}</tbody></table>`
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
  } else if (kind === 'pnl') {
    html = modalShell('Share your result', 'Your PnL card for this market. Post it on X, or save the image.', pnlView(S.pnl));
  } else if (kind === 'tour') {
    html = tourView();
  } else if (kind === 'faucet') {
    html = modalShell('Get free test SOL', 'TestFPT lives on the Solana test network. Claiming it costs a tiny network fee, paid in free test SOL.', faucetSteps());
  } else if (kind === 'start') {
    html = modalShell('Start predicting in 4 steps', 'Your 1,000 starting points are TestFPT tokens. Claim them to your wallet, then use them to predict.', startSteps());
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
  if (n.won) return { icon: 'trophy', tone: 'moon', title: `You won ${fmtPts(n.payout)} on ${esc(n.symbol)}`, body: `It settled ${yn ? 'as' : 'in'} ${win}. You staked ${fmtPts(n.staked)}.` };
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
  if (S.me && S.rewards?.onChain && !S.rewards.welcomeClaimed) return openAuth('start');
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
  const claimFirst = S.rewards?.onChain && !S.rewards.welcomeClaimed;
  toast(created ? (claimFirst ? 'Account created. Claim your 1,000 TestFPT to start.' : 'Account created. 1,000 points added.') : `Signed in as ${S.me.username}`);
  S.tradeKey = '';
  await loadRoute();
  // New players: complete the profile (or skip), take the short tour, then see how to get started.
  S.newPlayer = Boolean(created);
  if (created || user?.needsUsername) openAuth('username');
  else if (claimFirst) openAuth('start');
}

/** After the profile step, new players see the getting-started steps if they still have to claim. */
function afterProfile() {
  if (S.newPlayer) {
    S.newPlayer = false;
    return openTour();
  }
  if (S.rewards?.onChain && !S.rewards.welcomeClaimed) openAuth('start');
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
      if (out.rewarded) toast(`+${out.rewarded} points for linking @${out.xUsername}`);
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
            $('#market-main').innerHTML = marketMain(S.market);
            renderTrade();
          }
        }, 800);
      }
    }
    if (S.route.name === 'home') {
      const hit = [...S.lists.open, ...S.lists.live].some((m) => patch(m));
      const busy = document.activeElement?.id === 'exchange-filter';
      if (hit && !homeRenderTimer && !busy) {
        homeRenderTimer = setTimeout(() => {
          homeRenderTimer = null;
          if (S.route.name === 'home') $('#view').innerHTML = homeView();
        }, 2_000);
      }
    }
  } else if (type === 'market' || (type === 'listing' && S.route.name === 'radar')) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 700);
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
  ['overview', 'grid', 'Overview', 'What needs your attention and how Firstprint is doing.'],
  ['markets', 'list', 'Markets', 'Post results, publish drafts, edit or cancel markets.'],
  ['analytics', 'chart', 'Analytics', 'Players, activity and markets. Share a read-only link with partners.'],
  ['create', 'plusCircle', 'Create market', 'Save a draft, check it, then publish. Users only see published markets.'],
  ['token', 'token', 'TestFPT token', 'The on-chain token players claim their points as.'],
  ['tasks', 'sparkles', 'Tasks', 'Tasks players complete on X for points.'],
  ['settings', 'sliders', 'Settings', 'Automatic markets, reference exchanges and backups.'],
  ['activity', 'history', 'Activity', 'Everything done in this panel, newest first.'],
];

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
        <p class="muted">${S.me ? `Signed in as <b>${esc(S.me.username)}</b>, which isn’t an admin account.` : 'Log in with your admin email or wallet to open it straight away.'} An admin account is one whose email is in <code>ADMIN_EMAILS</code> (signed in with Google or an email code) or with a linked wallet in <code>ADMIN_WALLETS</code>, set in the server settings.</p>
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

  const manualOnly = Boolean(A.info.manualOnly);
  let loaded;
  try {
    loaded = await Promise.all([
      A.api.markets(),
      manualOnly && !A.info.autoListings ? Promise.resolve([]) : A.api.detected().then((d) => d.detected).catch(() => []),
      A.api.log().catch(() => ({ log: [] })),
      A.api.token().catch(() => ({ enabled: false })),
      A.api.tasks().catch(() => ({ tasks: [] })),
    ]);
  } catch (err) {
    // The server may be waking up or busy: say so instead of leaving the old tab on screen.
    view.innerHTML = `<div class="empty"><div class="empty-art">${ico('alert')}</div><p><strong>Couldn’t load the admin panel.</strong><br />${esc(err.message)}</p><button class="btn btn-solid" data-action="admin-token-refresh">${ico('refresh')}Try again</button></div>`;
    return;
  }
  const [{ markets }, detected, { log }, token, { tasks }] = loaded;
  void backfillLogoPngs(markets);
  A.detected = detected;
  const venues = A.info.venues;
  const editing = markets.find((m) => m.id === A.edit && m.mode === 'manual' && m.status === 'open') ?? null;
  if (A.edit && !editing) A.edit = null;
  const waiting = markets.filter((m) => m.mode === 'manual' && m.phase === 'awaiting_result');
  const drafts = markets.filter((m) => m.phase === 'draft');
  const tab = ADMIN_TABS.some(([id]) => id === A.tab) ? A.tab : 'overview';
  // New exchange listings waiting for review (manual-only servers); the old scanner shows its own list in Settings.
  const pending = manualOnly ? detected : [];
  if (A.review && !pending.some((d) => d.id === A.review.id)) A.review = null;
  const review = !editing && A.review ? A.review : null;
  const badges = { markets: waiting.length + pending.length, token: token?.enabled && !token.ready ? '!' : 0 };
  const [, , title, lede] = ADMIN_TABS.find(([id]) => id === tab);

  let body;
  if (tab === 'overview') body = listingsPanel(pending) + adminOverview({ markets, waiting, drafts, token, tasks, log });
  else if (tab === 'markets') body = listingsPanel(pending) + adminMarketsTab(markets, waiting);
  else if (tab === 'analytics') {
    try {
      const data = await A.api.analytics(S.vizDays ?? 30);
      body = analyticsSharePanel(data.shareKey) + analyticsView(data);
    } catch (err) {
      body = `<div class="empty"><p>${esc(err.message)}</p></div>`;
    }
  }
  else if (tab === 'create') body = `<section class="panel" id="admin-market-section">
      <div class="section-head"><span class="section-ico">${ico(editing ? 'edit' : 'plusCircle')}</span><div><h2>${editing ? `Edit ${esc(editing.symbol)} market` : review ? `Review ${esc(review.symbol)} from ${esc(review.exchangeName)}` : 'New market'}</h2><p class="muted">${review ? 'Check the start price and times, add the logo and a description, then publish.' : 'When the close time passes, the market waits in Markets for your result.'}</p></div></div>
      ${marketForm(editing, review ? reviewPrefill(review) : null)}
    </section>`;
  else if (tab === 'token') body = tokenAdminSection(token) || `<div class="empty"><p>TestFPT isn’t available on this server.</p></div>`;
  else if (tab === 'tasks') body = tasksAdminSection(tasks);
  else if (tab === 'settings')
    body = `
      ${autoListingsPanel(A.info.autoListings)}
      ${telegramPanel(A.info.telegram)}
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('landmark')}</span><div><h2>Reference exchanges</h2><p class="muted">Switch off an exchange to stop it being offered for new markets you create and to stop checking it for new listings. They are shown to users as the reference for the price you enter.</p></div></div>
        <div class="toggle-grid">${A.info.exchanges
          .map((e) => `<label class="toggle"><input type="checkbox" data-action="admin-exchange" data-id="${esc(e.id)}"${e.enabled ? ' checked' : ''} /><span class="toggle-ui" aria-hidden="true"></span>${esc(e.name)}</label>`)
          .join('')}</div>
      </section>
      ${exchangeCheckPanel()}
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('database')}</span><div><h2>Database backup</h2><p class="muted">Copies of the database in Supabase, restored automatically when the server restarts.</p></div></div>
        ${backupLine(A.info.backup) || '<p class="muted">Backups are off. Set SUPABASE_URL and SUPABASE_SERVICE_KEY on the server to turn them on.</p>'}
      </section>
      ${manualOnly ? '' : legacyAdminSections(venues, detected)}`;
  else body = adminLogView(log);

  view.innerHTML = `
    <div class="admin-shell">
      <aside class="admin-side" aria-label="Admin sections">
        <div class="admin-brand">${ico('shield')}<span>Admin console</span></div>
        <nav class="admin-nav">
          ${ADMIN_TABS.map(
            ([id, icon, label]) =>
              `<button type="button" data-action="admin-tab" data-tab="${id}"${id === tab ? ' aria-current="page"' : ''}>${ico(icon)}<span>${label}</span>${badges[id] ? `<span class="nav-badge">${badges[id]}</span>` : ''}</button>`,
          ).join('')}
        </nav>
        <button class="btn admin-lock" data-action="admin-logout">${ico('lock')}Lock admin</button>
      </aside>
      <div class="admin-main">
        <header class="admin-top">
          <div><span class="eyebrow">Admin</span><h1 class="page-title">${title}</h1><p class="muted">${lede}</p></div>
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
    ({ prices } = await A.api.priceCheck({ symbol, exchanges }));
  } catch (err) {
    out.innerHTML = `<p class="checks-note">${ico('info')}${esc(err.message)}</p>`;
    return;
  }
  const live = prices.filter((p) => p.price !== null).map((p) => p.price).sort((a, b) => a - b);
  const median = live.length ? live[Math.floor((live.length - 1) / 2)] : null;
  const upcoming = form.querySelector('[data-upcoming]')?.checked;
  const base = Number(form.querySelector('[name=basePrice]')?.value || 0);
  const closeAt = new Date(form.querySelector('[name=closeAt]').value).getTime();
  const notes = [];
  const usePrice = median !== null ? `<button class="btn btn-sm" type="button" data-action="admin-use-price" data-price="${median}">Use ${fmtPrice(median)} as start price</button>` : '';
  if (median === null) notes.push(['ok', upcoming ? 'Not trading on these exchanges yet. That’s right for an upcoming token.' : 'Not trading on these exchanges yet. If it lists later, tick “Upcoming token” instead of guessing a start price.']);
  else {
    if (upcoming) notes.push(['high', `${esc(symbol.toUpperCase())} is already trading, so it isn’t upcoming. Players could see the price before they pick. ${usePrice}`]);
    if (!upcoming && base > 0) {
      const diff = (median - base) / base;
      if (Math.abs(diff) > 0.2) notes.push([Math.abs(diff) > 0.5 ? 'high' : 'medium', `Your start price ${fmtPrice(base)} is ${Math.round(Math.abs(diff) * 100)}% ${diff > 0 ? 'below' : 'above'} the live price. ${usePrice}`]);
      else notes.push(['ok', `Start price is within ${Math.round(Math.abs(diff) * 100)}% of the live price.`]);
    }
    if (!upcoming && !(base > 0)) notes.push(['medium', `Enter a start price. ${usePrice}`]);
    if (Number.isFinite(closeAt) && closeAt - Date.now() > 48 * 3_600_000) notes.push(['medium', `Predictions stay open ${Math.round((closeAt - Date.now()) / 86_400_000)} days while the price is visible. 1–2 days is fairer.`]);
  }
  out.innerHTML = `
    <div class="pc-prices">${prices.map((p) => `<span class="pc-chip${p.price === null ? ' off' : ''}"><b>${esc(p.name)}</b> ${p.price === null ? 'not trading' : fmtPrice(p.price)}</span>`).join('')}</div>
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
  if (form?.querySelector('[name=detectionId]')) runPriceCheck();
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
      basePrice: d.has('upcoming') ? null : d.get('basePrice') || null,
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
  if (!items.length) return `<p class="checks-note ok">${ico('checkCircle')}No problems found in ${list.length} open market${list.length === 1 ? '' : 's'} (checked against live exchange prices).</p>`;
  return `
    <section class="panel panel-alert checks">
      <div class="section-head"><span class="section-ico">${ico('alert')}</span><div><h2>Check these markets <span class="count-badge">${items.length}</span></h2><p class="muted">Compared with live exchange prices ${fmtAgo(A.checks.at)}. Fix them before players notice.</p></div><button class="btn btn-sm head-action" data-action="admin-recheck">${ico('refresh')}Check again</button></div>
      <ul class="check-list">${items
        .map((i) => `<li class="lvl-${i.level}"><span class="check-dot" aria-hidden="true"></span><p><b>${esc(i.c.symbol)}</b> ${esc(i.text)}</p><button class="btn btn-sm" data-action="admin-edit" data-id="${esc(i.c.id)}">${ico('edit')}Edit</button></li>`)
        .join('')}</ul>
    </section>`;
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

/** Small health chips for the admin header: TestFPT and backups. */
function statusChips(token, backup) {
  const chip = (ok, icon, text) => `<span class="status-chip ${ok === true ? 'ok' : ok === false ? 'bad' : 'idle'}">${ico(icon)}${text}</span>`;
  const out = [];
  if (token?.enabled) out.push(chip(token.ready ? true : false, 'token', token.ready ? 'TestFPT live' : 'TestFPT not set up'));
  if (backup?.enabled) out.push(chip(backup.lastError ? false : backup.lastOkAt ? true : null, 'database', backup.lastError ? 'Backup failing' : backup.lastOkAt ? `Backed up ${fmtAgo(backup.lastOkAt)}` : 'Backup pending'));
  else out.push(chip(null, 'database', 'Backups off'));
  return out.join('');
}

/** Overview: headline numbers, then anything that needs doing. */
function adminOverview({ markets, waiting, drafts, token, tasks, log }) {
  const open = markets.filter((m) => m.status === 'open' && m.phase !== 'draft');
  const inPools = open.reduce((n, m) => n + m.pool, 0);
  const predictors = open.reduce((n, m) => n + m.predictors, 0);
  const activeTasks = tasks.filter((t) => t.active);
  const done = tasks.reduce((n, t) => n + t.completions, 0);
  const kpi = (icon, color, label, value, sub) =>
    `<div class="stat-tile" style="--c:var(--${color})"><span class="tile-ico">${ico(icon)}</span><dt>${label}</dt><dd>${value}</dd><p>${sub}</p></div>`;
  const todo = [];
  for (const m of waiting) todo.push(['alert', 'crash', `${esc(m.symbol)} is waiting for its result`, `Predictions closed. ${fmtPts(m.pool)} from ${m.predictors} predictor${m.predictors === 1 ? '' : 's'} to pay out.`, 'markets', 'Post result']);
  for (const m of drafts) todo.push(['edit', 'flat', `${esc(m.symbol)} is a draft`, 'Users can’t see it until you publish it.', 'markets', 'Review']);
  if (token?.enabled && !token.ready) todo.push(['token', 'moon', 'TestFPT isn’t set up', 'Players get points in their balance until the token exists.', 'token', 'Set up']);
  if (token?.enabled && (token.authorityKey || (token.mint && !token.savedInEnv?.mint))) todo.push(['key', 'moon', 'Save the TestFPT keys in Render', 'So a restart can’t lose them.', 'token', 'Show keys']);
  if (A.info.backup?.lastError) todo.push(['database', 'crash', 'Database backup is failing', esc(A.info.backup.lastError), 'settings', 'Check']);
  if (!open.length) todo.push(['plusCircle', 'up', 'No open markets', 'Players have nothing to predict on right now.', 'create', 'Create one']);
  if (!activeTasks.length) todo.push(['sparkles', 'up', 'No active tasks', 'Tasks give players more ways to earn points.', 'tasks', 'Add a task']);
  return `
    <div id="admin-checks"></div>
    <dl class="stat-tiles">
      ${kpi('target', 'up', 'Open markets', fmtNum(open.length), `${drafts.length} draft${drafts.length === 1 ? '' : 's'}`)}
      ${kpi('clock', 'crash', 'Awaiting result', fmtNum(waiting.length), waiting.length ? 'Post the final price' : 'All caught up')}
      ${kpi('coins', 'moon', 'Points in open pools', fmtNum(inPools), 'Across open markets')}
      ${kpi('users', 'brand', 'Predictions', fmtNum(predictors), 'In open markets')}
      ${kpi('sparkles', 'down', 'Active tasks', fmtNum(activeTasks.length), `${fmtNum(done)} completion${done === 1 ? '' : 's'} so far`)}
    </dl>
    <div class="dash-grid">
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('checkCircle')}</span><h2>Needs attention${todo.length ? ` <span class="count-badge">${todo.length}</span>` : ''}</h2></div>
        ${
          todo.length
            ? `<ul class="todo">${todo
                .map(([icon, color, t, sub, goto, label]) => `<li style="--c:var(--${color})"><span class="todo-ico">${ico(icon)}</span><div><b>${t}</b><span class="muted">${sub}</span></div><button class="btn btn-sm" data-action="admin-tab" data-tab="${goto}">${label}</button></li>`)
                .join('')}</ul>`
            : `<p class="all-good">${ico('checkCircle')}Everything’s in order.</p>`
        }
      </section>
      ${adminLogView(log.slice(0, 6), true)}
    </div>`;
}

function adminMarketsTab(markets, waiting) {
  return `
    <div id="admin-checks"></div>
    ${
      waiting.length
        ? `<section class="panel panel-alert"><div class="section-head"><span class="section-ico">${ico('alert')}</span><div><h2>Waiting for your result <span class="count-badge">${waiting.length}</span></h2>
          <p class="muted">Predictions have closed. Enter the final price to pick the winners and pay out the pool.</p></div></div>
          ${waiting.map(resultForm).join('')}</section>`
        : ''
    }
    <section class="panel panel-flush">
      <div class="section-head"><span class="section-ico">${ico('list')}</span><h2>All markets <span class="count-badge">${markets.length}</span></h2><button class="btn btn-solid btn-sm head-action" data-action="admin-tab" data-tab="create">${ico('plus')}New market</button></div>
      ${
        markets.length
          ? `<div class="table-scroll"><table class="table"><thead><tr><th>Market</th><th class="hide-sm">Type</th><th>Status</th><th class="right">Pool</th><th class="right"></th></tr></thead><tbody>${markets
              .map(
                (m) => `<tr>
                  <td><span class="mkt-cell">${tokenAvatar(m, 'avatar-sm')}<span>${m.published ? `<a href="#/market/${encodeURIComponent(m.id)}">${esc(m.symbol)}</a>` : `<b>${esc(m.symbol)}</b>`}<small class="muted hide-sm">${esc(venueNames(m))}</small></span></span></td>
                  <td class="hide-sm">${isYesNo(m) ? 'Yes / No' : m.mode === 'manual' ? 'Five outcomes' : m.kind === 'live_test' ? 'Live test' : 'Automatic'}</td>
                  <td>${adminPhasePill(m)}</td>
                  <td class="right num-cell">${fmtNum(m.pool)}</td>
                  <td class="right"><div class="admin-row-actions">${marketActions(m)}</div></td>
                </tr>`,
              )
              .join('')}</tbody></table></div>`
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
      <p class="muted">Players claim their points to their wallets as TestFPT on Solana ${net}. They pay the network fee in test SOL.</p></div></div>
      <div class="kv"><span class="muted">Mint address</span><span class="copy-row"><code>${esc(t.mint)}</code><button class="btn btn-sm" data-action="copy-text" data-text="${esc(t.mint)}">${ico('copy')}Copy</button><a class="btn btn-sm" href="${esc(t.mintUrl)}" target="_blank" rel="noopener noreferrer">Explorer ${ico('external')}</a></span></div>
      ${saveKeysNote(t)}</section>`;
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
  if (!rows.length) return '';
  return `<div class="save-keys">
    <b>${ico('key')}Save these in Render so a restart can’t lose them</b>
    <span class="muted">Render → firstprint-app → Environment → Add environment variable, one for each, then Save. Keep the key private: it can mint TestFPT.</span>
    ${rows.map(([k, v]) => `<span class="copy-row"><code>${k}</code><code class="secret">${esc(v)}</code><button class="btn btn-sm" data-action="copy-text" data-text="${esc(v)}">${ico('copy')}Copy</button></span>`).join('')}
  </div>`;
}

const TASK_TARGET_HINT = { follow: 'X handle, e.g. @firstprint', repost: 'Link to the post on X', like: 'Link to the post on X', share: 'Text of the post (the player’s invite link is added)', link: 'https:// link' };

/** Tasks players complete for points: create, set a limit, switch off. */
function tasksAdminSection(tasks) {
  return `<section class="panel">
    <div class="section-head"><span class="section-ico">${ico('plusCircle')}</span><div><h2>Add a task</h2>
    <p class="muted">Players open the task, do it on X, then press Verify. X has no free API to check, so it's honour-based: each X username can only be linked to one account, and each task pays once per player.</p></div></div>
    <form id="admin-task" class="admin-form task-form" novalidate>
      <label><span class="field-label">Type</span><select name="kind">
        <option value="follow">Follow on X</option><option value="repost">Repost on X</option><option value="like">Like on X</option><option value="share">Post on X (with invite link)</option><option value="link">Visit a link</option>
      </select></label>
      <label class="span-2"><span class="field-label">Target</span><input name="target" placeholder="${esc(TASK_TARGET_HINT.follow)}" required /></label>
      <label><span class="field-label">Title <span class="muted">(optional)</span></span><input name="title" maxlength="80" /></label>
      <label><span class="field-label">Points</span><input name="points" type="number" min="1" max="10000" value="50" required /></label>
      <label><span class="field-label">Limit <span class="muted">(players)</span></span><input name="maxCompletions" type="number" min="1" placeholder="No limit" /></label>
      <button class="btn btn-solid" type="submit">${ico('plus')}Add task</button>
    </form>
  </section>
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
                <td class="right"><button class="btn btn-sm" data-action="admin-task-toggle" data-id="${esc(t.id)}" data-active="${t.active ? '1' : '0'}">${ico('power')}${t.active ? 'Switch off' : 'Switch on'}</button></td>
              </tr>`;
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
  telegram_token_banners_on: 'Turned token banners on for the Telegram channel',
  telegram_token_banners_off: 'Turned token banners off for the Telegram channel',
};

/** "MEXC, OKX and Gate" */
function listNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Settings: new listings from the watched exchanges (review queue, or automatic markets). */
function autoListingsPanel(a) {
  if (!a) return '';
  const where = !a.exchanges ? 'the watched exchanges' : a.exchanges.length ? listNames(a.exchanges) : 'no exchange (all are switched off under Reference exchanges)';
  return `
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('zap')}</span><div><h2>${a.mode === 'review' ? 'New listings' : 'Automatic markets'}</h2><p class="muted">${
          a.mode === 'review'
            ? `Every 2 minutes Firstprint checks ${esc(where)} for new USDT listings and listing announcements. Each one appears under New listings in Overview and Markets (and on Telegram, if connected). A token that already has a market or is already waiting is not repeated. Review it to open a market with the start price, logo and description you choose. Switch an exchange off under Reference exchanges to stop checking it.`
            : `Every 2 minutes Firstprint checks ${esc(where)} for new USDT listings and opens a market by itself, up to ${a.perDay} a day. Predictions stay open until 1 hour after trading starts. The start price is the average of that first hour and the result comes ${a.hours} hours after listing, both from the exchange it listed on, with no admin needed. You can cancel any of them in Markets.`
        }</p></div></div>
        <div class="toggle-grid"><label class="toggle"><input type="checkbox" data-action="admin-auto-listings"${a.enabled ? ' checked' : ''} /><span class="toggle-ui" aria-hidden="true"></span>Check for new listings</label></div>
      </section>`;
}

/** The last things done in this panel, so a payout or cancellation can always be traced. */
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
  const chosen = new Set(v?.venues ? v.venues.map((x) => x.id) : A.info.exchanges.filter((e) => e.enabled).map((e) => e.id));
  const soon = Math.ceil((Date.now() + 24 * 3_600_000) / 3_600_000) * 3_600_000;
  const pct = (n) => String(Math.round(n * 1000) / 10);
  const upcoming = Boolean(v) && v.basePrice == null;
  return `
    <form id="admin-market" class="admin-form admin-grid" data-id="${m ? esc(m.id) : ''}" data-published="${m?.published ? '1' : '0'}" data-outcomes="${m?.outcomes === 'binary' ? 'binary' : 'ladder'}">
      ${pre?.detectionId ? `<input type="hidden" name="detectionId" value="${pre.detectionId}" />` : ''}
      <fieldset class="type-pick" style="grid-column:1/-1"${lock}><legend class="field-label">Market type</legend>
        <label class="type-card"><input type="radio" name="outcomes" value="ladder"${m?.outcomes === 'binary' ? '' : ' checked'} /><span>${ico('trendUp')}<b>Five outcomes</b><small>Crash, Down, Flat, Up or Moon: how far the price moves from the start price.</small></span></label>
        <label class="type-card"><input type="radio" name="outcomes" value="binary"${m?.outcomes === 'binary' ? ' checked' : ''} /><span>${ico('checkCircle')}<b>Yes / No</b><small>Will the price be at or above a target price? Simplest for new players.</small></span></label>
      </fieldset>
      ${locked ? '<p class="muted" style="grid-column:1/-1">Users have already predicted, so the token, start price, ranges, and pool rules are locked. You can still edit the description, exchanges, and move the close time later. To change anything else, cancel and refund the market.</p>' : ''}
      <label><span class="field-label">Token symbol</span><input name="symbol" placeholder="XYZ" value="${esc(v?.symbol ?? '')}" required autocomplete="off"${lock} /></label>
      <label><span class="field-label">Token name (optional)</span><input name="name" placeholder="XYZ Protocol" value="${esc(v?.name ?? '')}" autocomplete="off" /></label>
      <div class="logo-field" style="grid-column:1/-1">
        <span class="field-label">Token logo (optional)</span>
        <div class="logo-row">
          <span class="logo-preview" data-logo-preview>${m?.logoUrl ? `<img src="${esc(m.logoUrl)}" alt="" referrerpolicy="no-referrer" />` : ico('image')}</span>
          <input type="hidden" name="logoUrl" value="${esc(m?.logoUrl ?? '')}" />
          <input class="logo-link" data-logo-link type="url" inputmode="url" placeholder="Paste an image link (https://…)" value="${m?.logoUrl && !m.logoUrl.startsWith('data:') ? esc(m.logoUrl) : ''}" autocomplete="off" />
          <label class="btn btn-sm logo-upload">${ico('upload')}Upload<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-logo-file hidden /></label>
          <button class="btn btn-sm" type="button" data-action="logo-clear"${m?.logoUrl ? '' : ' hidden'}>Remove</button>
        </div>
        <small class="logo-status" data-logo-status></small>
        <small class="muted">Square images look best. Pasted links and uploads are saved as a 128 × 128 copy, so the logo keeps working even if the link changes. Tip: on CoinGecko, right-click the token's logo and choose “Copy image address”.</small>
      </div>
      <div class="price-field">
        <label><span class="field-label"><span class="ladder-only">Start price (USD)</span><span class="binary-only">Target price (USD)</span></span><input name="basePrice" type="number" step="any" min="0" placeholder="${upcoming ? 'Set when trading opens' : '0.25'}" value="${v?.basePrice ?? ''}"${upcoming ? ' disabled' : ' required'}${lock} /></label>
        <div class="upcoming-opt">
          <label class="check upcoming-check"><input type="checkbox" name="upcoming" data-upcoming${upcoming ? ' checked' : ''}${lock} /> Upcoming token: not trading yet</label>
          <small class="muted">No price needed now: the start price becomes its opening price. Set predictions to close when trading starts, then add the opening price under Markets → Awaiting result.</small>
          <div class="auto-open"${upcoming && !(m && m.published) ? '' : ' hidden'}>
            <label class="check"><input type="checkbox" name="autoOpen" data-auto-open${v?.autoOpenAt ? ' checked' : ''} /> <b>Open by itself when trading starts</b></label>
            <label class="auto-open-at"${v?.autoOpenAt ? '' : ' hidden'}><span class="field-label">Trading starts (your time)</span><input name="autoOpenAt" type="datetime-local" value="${toLocalInput(v?.autoOpenAt ?? v?.listingStart ?? soon)}" /><small class="utc-hint" data-utc-for="autoOpenAt"></small></label>
            <small class="muted">Instead of opening now, the market waits as a draft. Once the token has traded for 3 minutes, its live exchange price (checked against those minutes, so an opening spike is skipped) becomes the start price and predictions open, with the channel post. You get a Telegram message either way. Needs the logo, and predictions must stay open at least 30 minutes after trading starts.</small>
          </div>
        </div>
      </div>
      <label><span class="field-label">Predictions close (your time)</span><input name="closeAt" type="datetime-local" value="${toLocalInput(v?.closeAt ?? soon)}" required /><small class="utc-hint" data-utc-for="closeAt"></small></label>
      <label><span class="field-label">Result expected by (your time)</span><input name="resultAt" type="datetime-local" value="${toLocalInput(v?.settleAt ?? soon + 24 * 3_600_000)}" required /><small class="utc-hint" data-utc-for="resultAt"></small></label>
      <div class="price-check" style="grid-column:1/-1">
        <button class="btn btn-sm" type="button" data-action="admin-price-check">${ico('activity')}Check live price</button>
        <span class="muted">Compares the start price and timing with what the chosen exchanges show right now.</span>
        <div id="price-check-out" aria-live="polite"></div>
      </div>
      ${
        A.info.telegram?.channel
          ? `<div class="banner-check" style="grid-column:1/-1">
        <button class="btn btn-sm" type="button" data-action="admin-banner-preview">${ico('telegram')}Preview Telegram banner</button>
        <span class="muted">What the channel post will look like. Check the logo is this token’s, not another token with the same ticker.</span>
        <div id="banner-preview-out" aria-live="polite"></div>
      </div>`
          : ''
      }
      <fieldset class="venues"><legend class="field-label">Reference exchanges</legend>
        ${A.info.exchanges
          .filter((e) => e.enabled || chosen.has(e.id))
          .map((e) => `<label class="check"><input type="checkbox" name="exchanges" value="${esc(e.id)}"${chosen.has(e.id) ? ' checked' : ''} /> ${esc(e.name)}</label>`)
          .join('')}
      </fieldset>
      <label style="grid-column:1/-1"><span class="field-label">Description and result rules (shown to users)</span>
        <textarea name="note" rows="3" maxlength="2000" placeholder="e.g. Result is the XYZ/USDT closing price on Binance at 12:00 UTC.">${esc(v?.note ?? '')}</textarea></label>
      <details style="grid-column:1/-1"><summary class="field-label">Outcome ranges and pool rules</summary>
        <div class="admin-grid" style="margin-top:10px">
          <p class="muted binary-only" style="grid-column:1/-1;margin:0">Yes/No markets ignore the ranges: Yes wins at or above the target price.</p>
          <label><span class="field-label">Crash at or below (%)</span><input name="crash" type="number" step="any" value="${pct(t.crash)}"${lock} /></label>
          <label><span class="field-label">Down at or below (%)</span><input name="down" type="number" step="any" value="${pct(t.down)}"${lock} /></label>
          <label><span class="field-label">Up at or above (%)</span><input name="up" type="number" step="any" value="${pct(t.up)}"${lock} /></label>
          <label><span class="field-label">Moon at or above (%)</span><input name="moon" type="number" step="any" value="${pct(t.moon)}"${lock} /></label>
          <label><span class="field-label">Fee (%)</span><input name="fee" type="number" step="any" min="0" max="20" value="${(m?.feeBps ?? 400) / 100}"${lock} /></label>
          <label><span class="field-label">Pool limit (points)</span><input name="softCap" type="number" min="100" step="1" value="${m?.softCap ?? 50000}"${lock} /></label>
        </div>
      </details>
      <div class="admin-actions" style="grid-column:1/-1">
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
        <span class="muted">Start price ${hasStart(m) ? fmtPrice(m.basePrice) : '<b>not set yet</b>'} · Pool ${fmtPts(m.pool)} from ${m.predictors} predictor${m.predictors === 1 ? '' : 's'} · ${dist}</span><br>
        <span class="muted">${bucketsOf(m).map((b) => `${oName(b, yn)} ${rangeOf(m, b)}`).join(' · ')}</span></div>
      ${
        hasStart(m)
          ? ''
          : `<label><span class="field-label">Opening price (USD)</span><input name="basePrice" type="number" step="any" min="0" value="${esc(v.basePrice ?? '')}" placeholder="First trade price" />${liveFillButton(m, 'basePrice')}</label>`
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
        ${hasStart(m) ? '' : '<button class="btn" type="submit" name="intent" value="start">Save opening price</button>'}
        <button class="btn${s ? '' : ' btn-solid'}" type="submit" name="intent" value="preview">Preview result</button>
        ${s ? '<button class="btn btn-solid" type="submit" name="intent" value="resolve">Confirm and pay winners</button>' : ''}
        <button class="btn" type="button" data-action="admin-cancel" data-id="${esc(m.id)}">Cancel and refund</button>
      </div>
    </form>`;
}

/** "Use live price" under a price field: fills it with the median live price from the market's exchanges. */
function liveFillButton(m, field) {
  return `<button class="btn btn-sm live-fill" type="button" data-action="admin-live-fill" data-symbol="${esc(m.symbol)}" data-exchanges="${esc(m.venues.map((x) => x.id).join(','))}" data-field="${field}">${ico('activity')}Use live price</button>`;
}

async function fillLivePrice(el) {
  const input = el.closest('form')?.querySelector(`[name=${el.dataset.field}]`);
  if (!input) return;
  const label = el.innerHTML;
  el.disabled = true;
  el.textContent = 'Getting price…';
  try {
    const { prices } = await A.api.priceCheck({ symbol: el.dataset.symbol, exchanges: el.dataset.exchanges.split(',').filter(Boolean) });
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

/** Starting values for a market made from a detected listing. */
function reviewPrefill(d) {
  const now = Date.now();
  const hour = 3_600_000;
  const upcoming = Boolean(d.listingAt && d.listingAt > now);
  // Upcoming: predictions close when trading starts. Already trading: give players an hour from now.
  const closeAt = upcoming ? d.listingAt : Math.ceil((now + hour) / (15 * 60_000)) * 15 * 60_000;
  const settleAt = (d.listingAt && d.listingAt > now - hour ? d.listingAt : closeAt) + 72 * hour;
  const pair = `${d.symbol}/USDT`;
  return {
    detectionId: d.id,
    symbol: d.symbol,
    name: d.name ?? '',
    venues: [{ id: d.exchange }],
    basePrice: upcoming ? null : '',
    closeAt,
    settleAt,
    listingStart: upcoming ? d.listingAt : null,
    note: `New on ${d.exchangeName}. The start price is the ${d.exchangeName} ${pair} price when ${upcoming ? 'trading opens' : 'predictions open'}, and the result is the ${d.exchangeName} ${pair} price at the result time.`,
  };
}

/** New exchange listings waiting for the admin: review (opens the market form filled in) or skip. */
function listingsPanel(pending) {
  if (!pending.length) return '';
  const now = Date.now();
  const when = (d) => (!d.listingAt ? 'Start time not published' : d.listingAt > now ? `Trading starts ${fmtDate(d.listingAt)} · in ${until(d.listingAt)}` : `Trading started ${fmtDate(d.listingAt)}`);
  return `
    <section class="panel panel-alert">
      <div class="section-head"><span class="section-ico">${ico('zap')}</span><div><h2>New listings <span class="count-badge">${pending.length}</span></h2><p class="muted">Found on the exchange by Firstprint. Review one to open a market for it, or skip it.</p></div></div>
      <ul class="todo">${pending
        .map(
          (d) => `<li style="--c:var(--${d.listingAt && d.listingAt > now ? 'up' : 'moon'})"><span class="todo-ico">${ico('coins')}</span><div><b>${esc(d.symbol || '?')}${d.name ? ` <span class="muted">${esc(d.name)}</span>` : ''}</b><span class="muted">${esc(d.exchangeName)} · ${when(d)}</span></div>
            <span class="todo-actions"><button class="btn btn-sm btn-solid" data-action="admin-review" data-id="${d.id}">Review</button><button class="btn btn-sm" data-action="admin-review-ignore" data-id="${d.id}">Skip</button></span></li>`,
        )
        .join('')}</ul>
    </section>`;
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
        <div class="section-head"><span class="section-ico">${ico('telegram')}</span><div><h2>Player channel</h2><p class="muted">A public Telegram channel players join. Every market you publish is posted there with a banner and a “Predict now” button, a reminder goes out in its last hour, and results with a winner are posted (cancelled markets are not). Players see a Telegram button on market pages, their dashboard and the menu.</p></div></div>
        ${
          t.channel
            ? `<p class="all-good">${ico('checkCircle')}Posting to <a href="https://t.me/${esc(t.channel)}" target="_blank" rel="noopener noreferrer">@${esc(t.channel)}</a></p>
               <p class="muted">New markets and results are posted by themselves, and a “last hour” reminder goes out an hour before predictions close.${t.unposted ? ` <b>${t.unposted} open market${t.unposted === 1 ? ' hasn’t' : 's haven’t'} been posted yet</b> (made before the channel was set up).` : ''}</p>
               <div class="admin-actions">${t.unposted ? `<button class="btn btn-solid btn-sm" data-action="admin-tg-post-open">${ico('telegram')}Post ${t.unposted === 1 ? 'it' : `all ${t.unposted}`} now</button>` : ''}${t.open && t.open > t.unposted ? `<button class="btn btn-sm" data-action="admin-tg-post-open" data-again="1">${ico('telegram')}Post all ${t.open} open markets again</button>` : ''}<button class="btn btn-sm" data-action="admin-tg-channel-remove">Stop posting</button></div>
               <div class="toggle-grid"><label class="toggle"><input type="checkbox" data-action="admin-token-banners"${t.tokenBanners ? ' checked' : ''} /><span class="toggle-ui" aria-hidden="true"></span>Token banners</label></div>
               <p class="muted">${t.tokenBanners ? 'Each post gets the token’s own banner: its logo, ticker and details. A ticker the banner font can’t draw (such as Chinese) falls back to the fixed banner. Check it with “Preview Telegram banner” on the market form before publishing.' : 'Off: new markets use the fixed banner, and reminders and results are text only.'}</p>`
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
        <div class="section-head"><span class="section-ico">${ico('bell')}</span><div><h2>Telegram alerts</h2><p class="muted">A message to you when a new token lists on an exchange we watch, and when a market closes and needs your result.</p></div></div>
        ${body}
      </section>${channel}`;
}

function marketActions(m) {
  const btn = (action, icon, label, cls = '') => `<button class="btn btn-sm${cls}" data-action="${action}" data-id="${esc(m.id)}">${ico(icon)}${label}</button>`;
  const manualOpen = m.mode === 'manual' && m.status === 'open';
  const out = [];
  if (manualOpen) out.push(btn('admin-edit', 'edit', 'Edit'));
  if (manualOpen && !m.published) out.push(btn('admin-publish', 'send', 'Publish', ' btn-solid'), btn('admin-delete', 'trash', 'Delete', ' btn-danger'));
  if (manualOpen && m.published && m.predictors === 0) out.push(btn('admin-unpublish', 'eye', 'Unpublish'));
  if (A.info.telegram?.channel && m.status === 'open' && m.published && m.kind !== 'live_test') out.push(btn('admin-tg-post', 'telegram', 'Post to Telegram'));
  if ((m.status === 'open' || m.status === 'locked') && (m.published || m.mode !== 'manual')) out.push(btn('admin-cancel', 'undo', 'Cancel and refund', ' btn-danger'));
  return out.join(' ');
}

function adminPhasePill(m) {
  const text = esc(adminPhase(m));
  if (m.phase === 'draft' && m.autoOpenAt) {
    const due = m.autoOpenAt > now();
    return `<span class="pill pill-hot">${ico('clock')}${due ? `Opens by itself in <span data-until="${m.autoOpenAt}">${fmtDur(m.autoOpenAt - now())}</span>` : 'Opening: checking prices'}</span>${m.autoOpenNote ? `<small class="muted auto-note">${esc(m.autoOpenNote)}</small>` : ''}`;
  }
  if (m.phase === 'draft') return `<span class="pill pill-off">${text}</span>${m.autoOpenNote ? `<small class="muted auto-note">${esc(m.autoOpenNote)}</small>` : ''}`;
  if (m.phase === 'awaiting_result') return `<span class="pill pill-hot">${text}</span>`;
  if (m.status === 'resolved') return `<span class="pill pill-done">${isYesNo(m) ? `Settled: ${oName(m.result?.winningBucket, true)}` : text}</span>`;
  if (m.status === 'void') return `<span class="pill pill-off">${text}</span>`;
  return `<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>${text}</span>`;
}

function adminPhase(m) {
  if (m.mode === 'manual') {
    if (m.phase === 'draft') return 'Draft, not published';
    if (m.phase === 'baseline') return `Open, closes in ${fmtDur(m.closeAt - now())}`;
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
    ? '<p class="muted">Calls every exchange once from this server (a BTC price, recent candles, the pair list and announcements) to see which ones new listings could come from. Takes up to 15 seconds.</p>'
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
    case 'admin-tab':
      A.tab = el.dataset.tab;
      if (A.tab !== 'create') {
        A.edit = null;
        A.review = null;
      }
      await renderAdmin();
      return window.scrollTo({ top: 0 });
    case 'admin-token-refresh':
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
    case 'admin-recheck':
      A.checks = null;
      return renderAdmin();
    case 'admin-price-check':
      return runPriceCheck();
    case 'admin-banner-preview':
      return runBannerPreview();
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
      return window.scrollTo({ top: 0 });
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
    case 'admin-edit-cancel':
      A.review = null;
      A.edit = null;
      A.tab = 'markets';
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
  // "Upcoming token": no start price yet; the opening price is added once trading starts.
  if (d.has('upcoming')) body.basePrice = null;
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
  if (autoOpen && intent === 'publish') {
    if (!confirm(`Schedule this market? It stays a draft, then opens by itself about 3 minutes after trading starts (${new Date(body.autoOpenAt).toLocaleString()}), with the live price as its start price.`)) return;
    intent = 'save';
  } else if (intent === 'publish' && !confirm('Publish this market? Users will be able to predict straight away.')) return;
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const id = form.dataset.id;
    let m;
    if (id) m = await A.api.updateManual(id, body);
    else m = await A.api.createManual({ ...body, publish: intent === 'publish' });
    if (id && intent === 'publish') m = await A.api.publish(id);
    A.edit = null;
    A.review = null;
    A.tab = 'markets';
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

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.matches?.('[data-backdrop]')) return S.modalBusy ? undefined : closeModal();

  const action = t.closest('[data-action]')?.dataset.action;
  const filter = t.closest('[data-filter]')?.dataset.filter;
  const lbPeriod = t.closest('[data-lb-period]')?.dataset.lbPeriod;
  if (S.menuOpen && !t.closest('#top-menu') && !t.closest('[data-action="menu"]')) closeMenu();
  const exchangePick = t.closest('[data-exchange]')?.dataset.exchange;
  if (exchangePick) {
    S.exchange = exchangePick;
    $('#view').innerHTML = homeView();
    return;
  }
  const dashTab = t.closest('[data-dash-tab]')?.dataset.dashTab;
  if (dashTab) return showDashTab(dashTab);
  if (lbPeriod) {
    S.lbPeriod = lbPeriod;
    return loadRoute();
  }
  const rung = t.closest('.rung');
  const pick = t.closest('[data-pick]')?.dataset.pick;
  const stakeBtn = t.closest('[data-stake]')?.dataset.stake;
  const walletBtn = t.closest('[data-wallet]');
  if (walletBtn) return walletFlow(walletBtn.dataset.purpose, listWallets()[Number(walletBtn.dataset.wallet)]);

  if (filter) {
    S.filter = filter;
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
    case 'login':
    case 'signup':
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
        await collectPoints(from, got);
        S.me = me;
        S.daily = null;
        toast(`+${got} points · Day ${day} streak${day > 1 ? ' 🔥' : ''}. Tomorrow: +${me.daily?.next ?? got}.`);
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
    case 'faucet':
      return openAuth('faucet');
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
    case 'predict':
      return submitPrediction();
    case 'open-sheet':
      return openSheet();
    case 'close-sheet':
      return closeSheet();
    case 'theme':
      return setTheme(currentTheme() === 'light' ? 'dark' : 'light');
    case 'menu':
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
    S.query = e.target.value;
    if (S.route.name !== 'home') {
      location.hash = '#/';
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

/**
 * "Open by itself when trading starts": shows the trading start time, keeps predictions open at
 * least a day after it, and names the main button for what it will do.
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
      close.value = toLocalInput(open + 24 * 3_600_000);
      if (!(inputMs(result.value) > open + 24 * 3_600_000)) result.value = toLocalInput(open + 72 * 3_600_000);
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
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  canvas.getContext('2d').drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
  const webp = canvas.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

document.addEventListener('input', (e) => {
  if (e.target.id !== 'auth-code') return;
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) submitCode(e.target.form);
});

document.addEventListener('change', (e) => {
  if (e.target.matches?.('[data-upcoming]')) {
    const form = e.target.closest('form');
    const price = form.querySelector('[name=basePrice]');
    price.disabled = e.target.checked;
    price.required = !e.target.checked;
    price.placeholder = e.target.checked ? 'Set when trading opens' : '0.25';
    if (e.target.checked) price.value = '';
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
  if (e.target.id === 'exchange-filter') {
    S.exchange = e.target.value;
    $('#view').innerHTML = homeView();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'auth-email-form') {
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
    el.textContent = fmtDur(left);
    if (left <= 0 && left > -1500) expired = true;
  });
  if (expired) setTimeout(refresh, 1200);
}, 1000);

setInterval(() => {
  if (!document.hidden) refresh();
}, 8000);

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
  try {
    await refreshMe();
  } catch (err) {
    toast(err.message, true);
  }
  window.addEventListener('hashchange', onRoute);
  await onRoute();
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

/** Moves the sliding highlight of a tab group to its selected tab. */
function syncSeg(group) {
  const on = group.querySelector('[aria-selected="true"]');
  if (!on) return group.classList.remove('seg-on');
  group.style.setProperty('--seg-x', `${on.offsetLeft}px`);
  group.style.setProperty('--seg-w', `${on.offsetWidth}px`);
  if (!group.classList.contains('seg-on')) requestAnimationFrame(() => group.classList.add('seg-on', 'seg-ready'));
}
const SEG_GROUPS = '.tabs, .dash-tabs';
const syncAllSegs = () => document.querySelectorAll(SEG_GROUPS).forEach(syncSeg);

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
  // "/" jumps to search, as on most trading sites.
  if (e.key === '/' && !e.target.closest?.('input, textarea, select, [contenteditable]')) {
    e.preventDefault();
    $('#market-search')?.focus();
  }
});
