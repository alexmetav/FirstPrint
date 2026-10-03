// Firstprint website. Vanilla ES modules, no build step.

import { bucketRangeLabel } from './engine.js';
import { ApiError, backendAvailable, captureReferral, createAdminApi, createApi, wake } from './api.js';
import { DemoBackend } from './demo.js';
import { OUTCOME_ICONS, ico } from './icons.js';
import { INSTALL_LINKS, connectAndSign, disconnectWallets, isMobileDevice, listWallets, mobileWalletLinks, onWalletsChanged, shortAddress, signTransactionWith } from './wallet.js';

const LADDER = ['moon', 'up', 'flat', 'down', 'crash'];
const NAMES = { crash: 'Crash', down: 'Down', flat: 'Flat', up: 'Up', moon: 'Moon' };
const icon = (b) => ico(OUTCOME_ICONS[b], 'oc-ico');
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
  filter: 'open',
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

function fmtPct(r, digits = 1) {
  if (r === null || r === undefined) return '–';
  const v = Math.abs(r * 100).toFixed(digits);
  if (Number(v) === 0) return `0.${'0'.repeat(digits)}%`;
  return `${r > 0 ? '+' : '−'}${v}%`;
}

function fmtPrice(p) {
  if (!p) return '–';
  return `$${p >= 1 ? p.toFixed(3) : p.toPrecision(4)}`;
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
const outcome = (b) => `<b class="oc" style="--c:var(--${b})">${icon(b)}${NAMES[b]}</b>`;
const rangeLabel = (b, t) => bucketRangeLabel(b, t).replace(/-/g, '−');
const share = (m, b) => (m.pool ? m.totals[b] / m.pool : 0);

function estMultiple(m, b, stake = 100) {
  const net = (m.pool + stake) * (1 - m.feeBps / 10_000);
  return net / (m.totals[b] + stake);
}

function leader(m) {
  if (!m.pool) return null;
  return LADDER.reduce((best, b) => (m.totals[b] > m.totals[best] ? b : best), LADDER[0]);
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
}

/** Rewards, tasks and the referral link for the signed-in player (nothing for visitors). */
async function refreshRewards() {
  S.rewards = S.me && S.api.rewards ? await S.api.rewards().catch(() => null) : null;
}

async function loadHome() {
  const [open, live, settled] = await Promise.all(['open', 'live', 'settled'].map((f) => S.api.markets(f)));
  syncClock(open.serverTime);
  S.lists = { open: open.markets, live: live.markets, settled: settled.markets };
}

async function loadMarket(id) {
  const m = await S.api.market(id);
  syncClock(m.serverTime);
  const [chart, activity] = await Promise.all([
    m.phase === 'pre_listing' || isManual(m) ? Promise.resolve(null) : S.api.chart(id),
    S.api.activity(id),
  ]);
  if (S.market?.id !== id) {
    S.trade = { bucket: null, stake: 100, quote: null, seq: 0, busy: false };
    S.tradeKey = '';
  }
  S.market = m;
  S.chart = chart;
  S.activity = activity.activity;
}

async function refresh() {
  if (S.refreshing || S.modal || S.route.name === 'admin') return;
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
  if (h === '/portfolio' || h === '/dashboard') return { name: 'portfolio' };
  if (h === '/radar') return { name: 'radar' };
  if (h === '/earn') return { name: 'earn' };
  if (h === '/admin') return { name: 'admin' };
  return { name: 'home' };
}

async function onRoute() {
  const next = parseRoute();
  const changed = next.name !== S.route.name || next.id !== S.route.id;
  S.route = next;
  if (changed) {
    closeSheet();
    $('#view').innerHTML = '<p class="loading">Loading</p>';
    window.scrollTo(0, 0);
  }
  renderTop();
  await loadRoute(changed);
  if (changed) $('#view').focus({ preventScroll: true });
}

async function loadRoute() {
  const view = $('#view');
  try {
    if (S.route.name === 'home') {
      await loadHome();
      view.innerHTML = homeView();
    } else if (S.route.name === 'market') {
      await loadMarket(S.route.id);
      renderMarket();
    } else if (S.route.name === 'leaderboard') {
      const lb = await S.api.leaderboard();
      view.innerHTML = leaderboardView(lb);
    } else if (S.route.name === 'admin') {
      await renderAdmin();
    } else if (S.route.name === 'radar' && S.cfg?.manualOnly) {
      location.replace('#/');
      return;
    } else if (S.route.name === 'radar') {
      const { listings } = await S.api.detectedListings();
      view.innerHTML = radarView(listings);
    } else if (S.route.name === 'earn') {
      await refreshRewards();
      view.innerHTML = earnView();
    } else if (S.route.name === 'portfolio') {
      const preds = S.me ? (await S.api.myPredictions()).predictions : [];
      const history = S.me && S.api.ledger ? (await S.api.ledger().catch(() => ({ entries: [] }))).entries : [];
      const stats = S.me && S.api.stats ? await S.api.stats().catch(() => null) : null;
      view.innerHTML = portfolioView(preds, history, stats);
    }
    document.title = titleFor();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      view.innerHTML = `<div class="empty"><p>This market doesn’t exist or was removed.</p><a class="btn" href="#/">Browse markets</a></div>`;
    } else {
      view.innerHTML = `<div class="empty"><p>${esc(err.message || 'Something went wrong.')}</p><button class="btn" data-action="retry">Try again</button></div>`;
    }
  }
}

function titleFor() {
  if (S.route.name === 'market' && S.market) return `${S.market.symbol} on ${S.market.exchange}: Firstprint`;
  if (S.route.name === 'leaderboard') return 'Leaderboard: Firstprint';
  if (S.route.name === 'radar') return 'Listing radar: Firstprint';
  if (S.route.name === 'admin') return 'Admin: Firstprint';
  if (S.route.name === 'portfolio') return 'Your dashboard: Firstprint';
  if (S.route.name === 'earn') return 'Earn points: Firstprint';
  return 'Firstprint: predict new exchange listings';
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

function renderTop() {
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
      <a class="wordmark" href="#/" aria-label="Firstprint home"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>Firstprint</a>
      <nav class="nav" aria-label="Main">
        ${pages.map(([name, href, label]) => `<a href="${href}"${cur(name)}>${ico(NAV_ICONS[name])}${label}</a>`).join('')}
      </nav>
      <div class="account">
        ${S.cfg?.rewards ? `<button class="chip chip-faucet" data-action="faucet" title="Get free test SOL for network fees">${ico('droplet')}<span class="hide-sm">Test SOL</span></button>` : ''}
        ${
          S.me
            ? `${S.me.canClaimDaily ? `<button class="chip gift" data-action="claim" title="Claim your free daily points">${ico('gift')}+100</button>` : ''}
               <a class="chip points" href="#/portfolio" title="Your points balance">${ico('coins')}${fmtNum(S.me.points)}<span class="unit">pts</span></a>
               <a class="chip wallet-chip" href="#/portfolio" title="Signed in as ${esc(S.me.username)}">${avatar(S.me.username, 'avatar-sm')}<span>${wallet ? esc(shortAddress(wallet)) : esc(S.me.username)}</span></a>`
            : `<button class="btn btn-solid" data-action="connect">${ico('wallet')}Log in</button>`
        }
      </div>
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

function homeView() {
  const all = [...S.lists.open, ...S.lists.live, ...S.lists.settled];
  const exchanges = [...new Set(all.map((m) => m.exchange))].sort();
  const list = S.lists[S.filter].filter((m) => S.exchange === 'all' || m.exchange === S.exchange);
  const byListing = [...S.lists.open].sort((a, b) => a.listingAt - b.listingAt);
  const featured = byListing.find((m) => m.phase === 'pre_listing') ?? byListing[0];
  const tab = (f, label) =>
    `<button role="tab" aria-selected="${S.filter === f}" data-filter="${f}">${label}<span class="count">${S.lists[f].length}</span></button>`;

  return `
    ${startChecklist()}
    ${featured ? featuredView(featured) : ''}
    <div class="section-head section-head-tight"><span class="section-ico">${ico('grid')}</span><div><h2>All markets</h2><p class="muted">Pick a market, choose an outcome, stake points.</p></div></div>
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Market status">
        ${S.cfg?.manualOnly ? `${tab('open', 'Open')}${tab('live', 'Awaiting result')}${tab('settled', 'Settled')}` : `${tab('open', 'Upcoming')}${tab('live', 'Live')}${tab('settled', 'Settled')}`}
      </div>
      <label class="select">${ico('landmark')}<span class="hide-sm">Exchange</span>
        <select id="exchange-filter">
          <option value="all">All exchanges</option>
          ${exchanges.map((e) => `<option value="${esc(e)}"${S.exchange === e ? ' selected' : ''}>${esc(e)}</option>`).join('')}
        </select>
      </label>
    </div>
    ${
      list.length
        ? `<div class="grid">${list.map(cardView).join('')}</div>`
        : `<div class="empty">${emptyText()}</div>`
    }
    ${howItWorks()}`;
}

function emptyText() {
  if (S.filter === 'live') return `<div class="empty-art">${ico('clock')}</div><p>No markets are waiting for a result. Markets move here once predictions close.</p><button class="btn" data-filter="open">See open markets</button>`;
  if (S.filter === 'settled') return `<div class="empty-art">${ico('checkCircle')}</div><p>No settled markets yet. Results appear here after Firstprint posts them.</p>`;
  return `<div class="empty-art">${ico('satellite')}</div>
    <p><strong>No open markets right now.</strong><br />New markets land here as soon as Firstprint opens them.</p>
    ${S.me?.canClaimDaily ? `<button class="btn btn-solid" data-action="claim">${ico('gift')}Claim 100 free points meanwhile</button>` : `<a class="btn" href="#/leaderboard">${ico('trophy')}See the leaderboard</a>`}`;
}

/** The pool split as five bars, Moon on top, used by the featured market. */
function miniLadder(m) {
  return `
    <div class="mini-ladder" aria-label="Pool split by outcome">
      <div class="mini-head"><span>Where the crowd is</span><span>${fmtPts(m.pool)}</span></div>
      ${LADDER.map((b) => {
        const pct = share(m, b) * 100;
        return `<div class="mini-rung" style="--c:var(--${b});--share:${pct}%"><b>${icon(b)}${NAMES[b]}</b><span class="muted">${rangeLabel(b, m.thresholds)}</span><span class="pct">${Math.round(pct)}%</span></div>`;
      }).join('')}
    </div>`;
}

/** Pool, predictors and timing as three small facts with icons. */
function heroFacts(m, whenLabel, whenValue) {
  return `
    <dl class="hero-facts">
      <div>${ico('coins')}<dt>Pool</dt><dd>${fmtPts(m.pool)}</dd></div>
      <div>${ico('users')}<dt>Predictors</dt><dd>${fmtNum(m.predictors)}</dd></div>
      <div>${ico('clock')}<dt>${whenLabel}</dt><dd>${whenValue}</dd></div>
    </dl>`;
}

function featuredView(m) {
  if (isManual(m)) {
    return `
    <section class="featured" aria-labelledby="featured-title">
      <div class="featured-main">
        <span class="eyebrow"><span class="dot" aria-hidden="true"></span>Featured market · open for predictions</span>
        <div class="hero-token">${avatar(m.symbol, 'avatar-xl')}<div><h1 id="featured-title">${esc(m.symbol)} <span class="h1-soft">is open</span></h1><p class="hero-name">${esc(m.name || m.symbol)} · start price ${fmtPrice(m.basePrice)}</p></div></div>
        <p class="lede">Predict where ${esc(m.name || m.symbol)} is priced at the result, compared with the start price. ${m.pool ? '' : 'Nobody has predicted yet, so early picks get the biggest bonus.'}</p>
        ${heroFacts(m, 'Closes in', until(m.closeAt))}
        <div class="actions">
          <a class="btn btn-solid btn-lg" href="#/market/${encodeURIComponent(m.id)}">${ico('target')}Make a prediction</a>
          <a class="btn btn-lg" href="#how">How it works</a>
        </div>
      </div>
      ${miniLadder(m)}
    </section>`;
  }
  const pre = m.phase === 'pre_listing';
  const test = m.kind === 'live_test';
  const verb = test ? (pre ? 'market starts' : 'market is live') : `${pre ? 'lists' : 'is trading'} on ${esc(m.exchange)}`;
  return `
    <section class="featured" aria-labelledby="featured-title">
      <div class="featured-main">
        <span class="eyebrow"><span class="dot" aria-hidden="true"></span>Featured market</span>
        <div class="hero-token">${avatar(m.symbol, 'avatar-xl')}<div><h1 id="featured-title">${esc(m.symbol)} <span class="h1-soft">${verb}</span></h1><p class="hero-name">${esc(m.name || m.symbol)}</p></div></div>
        <p class="lede">Predict where ${esc(m.name || m.symbol)} trades ${fmtSpan(m.settleAt - m.listingAt)} after ${test ? `the market starts, using live prices from ${esc(venueNames(m))}` : 'listing'}.</p>
        ${heroFacts(m, pre ? (test ? 'Starts in' : 'Lists in') : 'Closes in', pre ? until(m.listingAt) : until(m.closeAt))}
        <div class="actions">
          <a class="btn btn-solid btn-lg" href="#/market/${encodeURIComponent(m.id)}">${ico('target')}Make a prediction</a>
          <a class="btn btn-lg" href="#how">How it works</a>
        </div>
      </div>
      ${miniLadder(m)}
    </section>`;
}

/** Status pill for a market card: what is happening and how it looks. */
function cardStatus(m) {
  if (m.status === 'resolved') return '<span class="pill pill-done">Settled</span>';
  if (m.status === 'void') return '<span class="pill pill-off">Cancelled</span>';
  if (m.phase === 'awaiting_result') return '<span class="pill pill-wait">Awaiting result</span>';
  if (m.phase === 'pre_listing') return '<span class="pill pill-soon">Upcoming</span>';
  if (m.phase === 'running') return '<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>Live</span>';
  return '<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>Open</span>';
}

function cardView(m) {
  const lead = leader(m);
  let leadText;
  if (m.status === 'resolved') leadText = `Settled in ${outcome(m.result.winningBucket)} at ${fmtPct(m.result.returnPct)}`;
  else if (m.phase === 'awaiting_result') leadText = 'Predictions closed. Result coming soon';
  else if (m.status === 'void') leadText = 'Cancelled. Points were returned.';
  else if (m.live?.projectedBucket) leadText = `Now ${fmtPct(m.live.returnPct)}, tracking ${outcome(m.live.projectedBucket)}`;
  else if (lead) leadText = `${outcome(lead)} leads with ${Math.round(share(m, lead) * 100)}%`;
  else leadText = '<span class="muted">No predictions yet. Be the first.</span>';

  let when;
  if (m.phase === 'pre_listing') when = `${m.kind === 'live_test' ? 'Starts' : 'Lists'} in ${until(m.listingAt)}`;
  else if (m.phase === 'baseline') when = `Closes in ${until(m.closeAt)}`;
  else if (m.phase === 'running') when = `Result in ${until(m.settleAt)}`;
  else if (m.phase === 'awaiting_result') when = 'Awaiting result';
  else when = fmtDate(m.settleAt);

  const soon = m.status === 'open' && m.closeAt - now() < 15 * 60_000 && m.closeAt > now();
  return `
    <a class="card${soon ? ' soon' : ''}" href="#/market/${encodeURIComponent(m.id)}">
      <div class="card-top">
        ${avatar(m.symbol, 'avatar-md')}
        <div class="card-title"><span class="sym">${esc(m.symbol)}</span><span class="card-name">${esc(m.name || '')}${m.kind === 'live_test' ? ' <span class="tag tag-test">Live test</span>' : ''}</span></div>
        ${soon ? `<span class="pill pill-hot">${ico('flame')}Closing soon</span>` : cardStatus(m)}
      </div>
      <div class="card-lead">${leadText}</div>
      <div class="strip${m.pool ? '' : ' empty'}" aria-hidden="true">
        ${['crash', 'down', 'flat', 'up', 'moon'].map((b) => `<span style="--c:var(--${b});flex:${m.pool ? m.totals[b] : 1}"></span>`).join('')}
      </div>
      <div class="card-venues">${ico('landmark')}${esc(venueNames(m))}</div>
      <div class="card-foot">
        <span class="when">${ico('clock')}${when}</span>
        <span>${ico('users')}${fmtNum(m.predictors)}</span>
        <span class="pool">${ico('coins')}${fmtNum(m.pool)}</span>
      </div>
    </a>`;
}

/** Three friendly steps up front; the full rules stay one tap away. */
function howItWorks() {
  const steps = `
      <div class="section-head"><span class="section-ico">${ico('info')}</span><div><h2>How it works</h2><p class="muted">Free to play. Points only, no real money.</p></div></div>
      <ol class="steps">
        <li><span class="step-ico" style="--c:var(--up)">${ico('target')}</span><b>Pick an outcome</b><p>Where will the price land? Five choices, from ${outcome('crash')} to ${outcome('moon')}.</p></li>
        <li><span class="step-ico" style="--c:var(--moon)">${ico('coins')}</span><b>Stake free points</b><p>Everyone starts with 1,000 points, plus 100 more every day. No real money.</p></li>
        <li><span class="step-ico" style="--c:var(--brand)">${ico('trophy')}</span><b>Win the pool</b><p>If you’re right, you split the pool with the other winners. Earlier picks earn more.</p></li>
      </ol>
      <details class="full-rules"><summary>Full rules</summary>`;
  if (S.cfg?.manualOnly) {
    return `
    <section class="section" id="how" style="margin-top:36px">${steps}
      <ol class="rules">
        <li>Firstprint publishes a market for a token listed on major exchanges, with a start price. Log in with Google, email, or a Solana wallet to get 1,000 free points.</li>
        <li>Pick one of five outcomes for where the price ends up compared with the start price, from Crash to Moon. Predictions close at the time shown, and earlier predictions earn a bigger share.</li>
        <li>After they close, Firstprint posts the final price and the winners on the market page.</li>
        <li>Everyone who picked the winning outcome splits the pool, minus a 4% fee. If nobody picked it, everyone gets their points back.</li>
      </ol></details>
    </section>`;
  }
  return `
    <section class="section" id="how" style="margin-top:36px">${steps}
      <ol class="rules">
        <li>Firstprint watches seven exchanges for new listings and opens a market when one is confirmed. Sign in with Google, email, or a Solana wallet to get 1,000 free points.</li>
        <li>Pick one of five outcomes for the price 72 hours after listing, from Crash to Moon. Predictions stay open until 1 hour after trading starts, and earlier predictions earn a bigger share.</li>
        <li>The starting price is the average over the first hour of trading. The final price is the average over the last hour, so a single spike can’t decide a market.</li>
        <li>Everyone who picked the winning outcome splits the pool, minus a 4% fee. If nobody picked it, everyone gets their points back.</li>
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

  const rungs = LADDER.map((b) => {
    const pct = share(m, b) * 100;
    const won = m.status === 'resolved' && m.result.winningBucket === b;
    let pays = '–';
    if (canPick) pays = `${estMultiple(m, b).toFixed(1)}×`;
    else if (won && m.totals[b]) pays = `${(net / m.totals[b]).toFixed(2)}×`;
    else if (!settled && m.totals[b]) pays = `${(m.pool * (1 - m.feeBps / 10_000) / m.totals[b]).toFixed(1)}×`;
    return `
      <button class="rung${won ? ' won' : ''}" style="--c:var(--${b});--share:${pct}%" data-bucket="${b}"
        aria-pressed="${S.trade.bucket === b}" ${canPick ? '' : 'disabled'}
        aria-label="${NAMES[b]}, ${rangeLabel(b, m.thresholds)}, ${Math.round(pct)}% of pool">
        <span class="rung-name">
          <b>${icon(b)}${NAMES[b]}${mineBy[b] ? `<span class="tag tag-you">You ${fmtNum(mineBy[b])}</span>` : ''}${
            nowBucket === b ? `<span class="tag tag-now">Now ${fmtPct(m.live.returnPct)}</span>` : ''
          }${won ? '<span class="tag tag-now">Winner</span>' : ''}</b>
          <small>${rangeLabel(b, m.thresholds)}</small>
        </span>
        <span class="num">${Math.round(pct)}%</span>
        <span class="num">${pays}</span>
        <span class="num pool-col">${fmtNum(m.totals[b])}<small>pts</small></span>
      </button>`;
  }).join('');

  return `
    <a class="back" href="#/">${ico('arrowLeft')}All markets</a>
    <header class="m-head">
      <div class="m-title">${avatar(m.symbol, 'avatar-lg')}<div class="m-title-text"><div class="m-title-row"><h1 class="sym">${esc(m.symbol)}</h1>${cardStatus(m)}${
        (m.phase === 'baseline' || m.phase === 'running') && S.live && !isManual(m) ? '<span class="live-badge"><span class="live-dot" aria-hidden="true"></span>Live price</span>' : ''
      }</div>${m.name ? `<span class="m-name">${esc(m.name)}</span>` : ''}</div><button class="btn share-btn" data-action="share" aria-label="Share this market">${ico('share')}<span class="hide-sm">Share</span></button></div>
      <p class="m-question">${
        isManual(m)
          ? `Where will ${esc(m.name || m.symbol)} be priced at the result, compared with the start price of ${fmtPrice(m.basePrice)}?`
          : m.kind === 'live_test'
          ? `Where will ${esc(m.name || m.symbol)} trade ${span} after this market starts?`
          : `Where will ${esc(m.name || m.symbol)} trade ${span} after listing on ${esc(m.exchange)}?`
      }</p>
      <p class="m-status">${statusLine(m)}</p>
      <p class="m-venues">${m.kind === 'live_test' ? '<span class="tag tag-test">Live test</span> ' : ''}${ico('landmark')}${isManual(m) ? `Reference exchanges: ${esc(venueNames(m))}` : `Prices from ${esc(venueNames(m))}`}</p>
    </header>

    <dl class="stats">
      <div>${ico('coins')}<dt>Pool</dt><dd>${fmtPts(m.pool)}</dd></div>
      <div>${ico('users')}<dt>Predictors</dt><dd>${fmtNum(m.predictors)}</dd></div>
      ${
        isManual(m)
          ? `<div>${ico('dollar')}<dt>Start price</dt><dd>${fmtPrice(m.basePrice)}</dd></div><div>${ico('calendar')}<dt>Closes</dt><dd>${fmtDate(m.closeAt)}</dd></div>`
          : `<div>${ico('calendar')}<dt>${m.kind === 'live_test' ? 'Starts' : 'Listing'}</dt><dd>${fmtDate(m.listingAt)}</dd></div><div>${ico('clock')}<dt>Result</dt><dd>${fmtDate(m.settleAt)}</dd></div>`
      }
    </dl>

    ${isManual(m) ? manualPanel(m) : chartView(m)}

    <div class="ladder${settled ? ' settled' : ''}" role="group" aria-label="Outcomes">
      <div class="ladder-head"><span>${isManual(m) ? 'Final price vs start' : `Price after ${span}`}</span><span>Crowd</span><span>Pays</span><span class="pool-col">Pool</span></div>
      ${rungs}
      ${canPick ? '<p class="fine" style="margin:2px 0 0">Pays shows the current payout per point before early bonuses. Your estimate in the prediction panel includes your bonus.</p>' : ''}
    </div>

    <section class="section panel">
      <div class="section-head"><span class="section-ico">${ico('shield')}</span><h2>How this market settles</h2></div>
      ${isManual(m) ? manualRules(m) : ''}
      <ol class="rules"${isManual(m) ? ' hidden' : ''}>
        <li>Starting price: the average price over the first ${fmtSpan(m.closeAt - m.listingAt)} ${m.kind === 'live_test' ? 'after the market starts' : 'of trading'}, from ${esc(venueNames(m))}.</li>
        <li>Final price: the average over the last ${fmtSpan(m.closeAt - m.listingAt)} before ${fmtDate(m.settleAt)}. If the token trades on several exchanges, the volume-weighted median is used.</li>
        <li>Predictions close ${fmtSpan(m.closeAt - m.listingAt)} after trading starts. Earlier predictions get up to ${(1 + m.earlyBirdK).toFixed(1)}× weight when the pool is split.</li>
        <li>Winners split the pool minus a ${m.feeBps / 100}% fee. Limit ${fmtPts(m.userCap)} per person.</li>
        <li>The market is cancelled and refunded if the listing is delayed more than 24 hours, trading halts for too long, there isn’t enough trading data, or nobody picks the winning outcome.</li>
      </ol>
    </section>

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

    <section class="section panel">
      <div class="section-head"><span class="section-ico">${ico('activity')}</span><h2>Recent predictions</h2></div>
      ${
        S.activity.length
          ? `<ul class="activity feed">${S.activity
              .slice(0, 12)
              .map((a) => `<li>${avatar(a.username, 'avatar-sm')}<span class="feed-main"><b class="who">${esc(a.username)}</b> picked ${outcome(a.bucket)}</span><span class="muted">${fmtPts(a.stake)} · ${fmtAgo(a.placedAt)}</span></li>`)
              .join('')}</ul>`
          : '<p class="muted">No predictions yet.</p>'
      }
    </section>`;
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
    const step = (state, title, when) => `<li class="${state}"><span class="step-dot" aria-hidden="true">${state === 'done' ? ico('check') : ''}</span><b>${title}</b><span class="muted">${when}</span></li>`;
    return `
      <ol class="timeline" aria-label="Market timeline">
        ${step('done', 'Market opened', fmtDate(m.openedAt))}
        ${step(closed ? 'done' : 'now', closed ? 'Predictions closed' : 'Predictions close', closed ? fmtDate(m.closeAt) : `${fmtDate(m.closeAt)} · in ${until(m.closeAt)}`)}
        ${step(closed ? 'now' : '', 'Result posted', `Expected around ${fmtDate(m.settleAt)}`)}
      </ol>`;
  }
  const b = r.winningBucket ?? 'flat';
  return `
    <div class="chart">
      <div class="chart-head">
        <div><div>Result</div><div class="muted">Start ${fmtPrice(r.basePrice)} → final ${fmtPrice(r.finalPrice)}</div></div>
        <div class="now" style="color:var(--${b})">${fmtPct(r.returnPct)}</div>
      </div>
    </div>
    ${
      r.winners?.length
        ? `<section class="section panel"><div class="section-head"><span class="section-ico">${ico('trophy')}</span><h2>Winners</h2></div><ul class="activity feed">${r.winners
            .map((w) => `<li>${avatar(w.username, 'avatar-sm')}<span class="feed-main"><b class="who">${esc(w.username)}</b> picked ${outcome(w.bucket)}</span><span class="muted">${fmtPts(w.stake)} → <b class="profit-pos">${fmtPts(w.payout)}</b></span></li>`)
            .join('')}</ul></section>`
        : ''
    }`;
}

function manualRules(m) {
  return `
    ${m.note ? `<p class="m-note">${esc(m.note)}</p>` : ''}
    <ol class="rules">
      <li>Start price: ${fmtPrice(m.basePrice)}. The result is the final price compared with it, using the ranges shown above.</li>
      <li>Predictions close ${fmtDate(m.closeAt)}. Earlier predictions get up to ${(1 + m.earlyBirdK).toFixed(1)}× weight when the pool is split.</li>
      <li>After that the market waits for Firstprint to post the final price. The result and winners appear on this page.</li>
      <li>Winners split the pool minus a ${m.feeBps / 100}% fee. Limit ${fmtPts(m.userCap)} per person.</li>
      <li>The market is cancelled and refunded if nobody picks the winning outcome, everyone picks the same outcome, or Firstprint cancels it.</li>
    </ol>`;
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
      <p>${m.phase === 'pre_listing' ? `${m.kind === 'live_test' ? 'Starts' : 'Lists'} in ${until(m.listingAt)}` : `Closes in ${until(m.closeAt)}`}</p>
      <button class="cta" style="--c:var(--text)" data-action="open-sheet">Make a prediction</button>
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
    $('#picker').innerHTML = LADDER.map(
      (b) =>
        `<button type="button" role="radio" aria-checked="${S.trade.bucket === b}" data-pick="${b}" style="--c:var(--${b})"><span class="pick-ico">${icon(b)}</span><b>${NAMES[b]}</b><small>${Math.round(share(m, b) * 100)}%</small></button>`,
    ).join('');
    updateSummary();
  } else if (mode === 'closed') {
    $('#trade-closed').innerHTML = `<h2>Predictions closed</h2><p class="muted">${isManual(m) ? 'Result expected in' : 'Result in'} ${until(m.settleAt)}.${
      m.live?.projectedBucket ? ` Right now the price is ${fmtPct(m.live.returnPct)}, which would settle in ${outcome(m.live.projectedBucket)}.` : ''
    }</p>`;
  } else {
    $('#trade-closed').innerHTML =
      m.status === 'resolved'
        ? `<h2>Settled in ${outcome(m.result.winningBucket)}</h2><p class="muted">Final price ${fmtPrice(m.result.finalPrice)}, ${fmtPct(m.result.returnPct)} from the starting price of ${fmtPrice(m.result.basePrice)}.</p>`
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
      return `<div class="position" style="--c:var(--${p.bucket})"><span><b>${NAMES[p.bucket]}</b> ${fmtPts(p.stake)}</span><span>${state}</span></div>`;
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
  card.style.setProperty('--c', b ? `var(--${b})` : 'var(--text)');

  const q = S.trade.quote;
  const summary = $('#trade-summary');
  if (!b) {
    summary.innerHTML = '<div><dt>Pick an outcome to see your estimated payout.</dt></div>';
  } else {
    summary.innerHTML = `
      <div class="big"><dt>If ${icon(b)}${NAMES[b]} wins</dt><dd>${q ? `about ${fmtPts(q.payout)}` : '…'}</dd></div>
      <div><dt>Return on stake</dt><dd>${q && stake ? `${q.multiple.toFixed(2)}×` : '–'}</dd></div>
      <div><dt>Early bonus</dt><dd>${q ? `${q.weight.toFixed(2)}×` : '–'}</dd></div>
      <div><dt>Price range</dt><dd>${rangeLabel(b, m.thresholds)}</dd></div>`;
  }

  const cta = $('#trade-cta');
  if (!S.me) {
    cta.textContent = 'Log in to predict';
    cta.disabled = false;
  } else if (!b) {
    cta.textContent = 'Pick an outcome';
    cta.disabled = true;
  } else {
    cta.textContent = S.trade.busy ? 'Placing prediction' : `Predict ${NAMES[b]} for ${fmtPts(stake || 0)}`;
    cta.disabled = S.trade.busy || !stake || stake < m.minStake;
  }

  $('#trade-fine').textContent = S.me
    ? `You have ${fmtPts(S.me.points)}. Limit ${fmtPts(m.userCap)} per market. Minimum ${m.minStake} pts.`
    : 'Log in to start with 1,000 free points.';
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
    celebrate(bucket);
    toast(`You’re in! ${NAMES[bucket]} for ${fmtPts(stake)}${payout ? `. Win about ${fmtPts(payout)} if it lands.` : '.'}`);
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

function leaderboardView(lb) {
  const medal = (rank) => (rank <= 3 ? ` medal-${rank}` : '');
  const rows = lb.entries
    .map(
      (e) => `
      <tr class="${e.isMe ? 'me' : ''}">
        <td><span class="rank${medal(e.rank)}">${e.rank}</span></td>
        <td><span class="who-cell">${avatar(e.name, 'avatar-sm')}<span>${esc(e.name)}${e.isMe ? ' <span class="tag tag-you">You</span>' : ''}</span></span></td>
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
            <b>${esc(e.name)}</b>
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
      <p class="page-lede">Points won or lost on markets settled this week. The board resets every Monday at 00:00 UTC.</p></div>
    </header>
    ${
      lb.entries.length
        ? `${podium}<div class="panel panel-flush"><table class="table"><thead><tr><th>Rank</th><th>Predictor</th><th class="right">Profit</th><th class="right hide-sm">Correct</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><div class="empty-art">${ico('trophy')}</div><p>No markets have settled this week yet.</p></div>`
    }
    ${S.me && !lb.me ? '<p class="fine">You’ll appear here after one of your predictions settles.</p>' : ''}`;
}

function portfolioView(preds, history = [], stats = null) {
  if (!S.me) {
    return `
      <header class="page-head"><span class="page-ico">${ico('dashboard')}</span><div><h1 class="page-title">Your dashboard</h1></div></header>
      <div class="empty"><div class="empty-art">${ico('dashboard')}</div>
        <p><strong>Log in to see your dashboard.</strong><br />Your points, win rate and results live here. New accounts start with 1,000 free points.</p>
        <button class="btn btn-solid" data-action="connect">${ico('wallet')}Log in</button></div>`;
  }
  const active = preds.filter((p) => p.marketStatus === 'open' || p.marketStatus === 'locked');
  const activeTable = active.length
    ? `<table class="table"><thead><tr><th>Market</th><th>Your pick</th><th class="right">Stake</th><th class="right">Status</th></tr></thead><tbody>${active
        .map((p) => {
          const status = p.marketStatus === 'open' ? '<span class="pill pill-live"><span class="dot" aria-hidden="true"></span>Open</span>' : `<span class="pill pill-wait">${p.mode === 'manual' ? 'Awaiting result' : 'In play'}</span>`;
          return `<tr><td><a class="mkt-cell" href="#/market/${encodeURIComponent(p.marketId)}">${avatar(p.symbol, 'avatar-sm')}<span>${esc(p.symbol)}</span></a></td><td>${outcome(p.bucket)}</td><td class="right num-cell">${fmtNum(p.stake)}</td><td class="right">${status}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : `<p class="muted pad">Nothing in play right now. <a href="#/">Pick a market</a> to get started.</p>`;
  const method = S.me.wallets.length ? `Wallet ${esc(shortAddress(S.me.wallets[0].address))}` : S.me.hasEmail ? 'Signed in with email' : 'Signed in';

  return `
    <section class="profile-card">
      ${avatar(S.me.username, 'avatar-xl')}
      <div class="profile-main">
        <span class="eyebrow">Your dashboard</span>
        <h1 class="page-title">${esc(S.me.username)}</h1>
        <p class="muted">${method}${S.me.xUsername ? ` · ${ico('x')} @${esc(S.me.xUsername)}` : ''}</p>
      </div>
      <div class="profile-actions">
        <a class="btn" href="#/earn">${ico('gift')}Earn points</a>
        <button class="btn" data-action="logout">${ico('logout')}Log out</button>
      </div>
    </section>
    ${startChecklist()}
    ${statTiles(stats)}
    ${stats ? `<div class="dash-grid">${profitChart(stats.history)}${outcomeRecord(stats.byOutcome)}</div>` : ''}
    <section class="section panel panel-flush">
      <div class="section-head"><span class="section-ico">${ico('target')}</span><h2>In play${active.length ? ` <span class="count-badge">${active.length}</span>` : ''}</h2></div>
      ${activeTable}
    </section>
    ${stats ? pastMarkets(stats) : ''}
    <div class="dash-grid">
      <section class="section panel">
        <div class="section-head"><span class="section-ico">${ico('wallet')}</span><h2>Wallets</h2></div>
        ${
          S.me.wallets.length
            ? `<ul class="wallet-list">${S.me.wallets
                .map((w) => `<li><span class="addr" title="${esc(w.address)}">${esc(shortAddress(w.address))}</span><span class="muted">${esc(w.walletName || 'Solana wallet')}</span><a class="muted" href="https://solscan.io/account/${encodeURIComponent(w.address)}" target="_blank" rel="noopener noreferrer">Solscan ${ico('external')}</a></li>`)
                .join('')}</ul>`
            : '<p class="muted">No wallet linked. Link one to sign in with it too and to claim TestFPT.</p>'
        }
        <button class="btn" data-action="link-wallet">${ico('plus')}Link ${S.me.wallets.length ? 'another' : 'a Solana'} wallet</button>
      </section>
      ${historyView(history)}
    </div>`;
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
    S.me.canClaimDaily ? `<button class="btn btn-solid tile-btn" data-action="claim">${ico('gift')}Claim 100</button>` : '',
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
      <p class="fine">Net points after each settled market (${pts.length} markets). The table below lists every one.</p>
    </section>`;
}

/** How each outcome has done when you picked it. */
function outcomeRecord(byOutcome) {
  const rows = LADDER.filter((b) => byOutcome[b].picks);
  if (!rows.length) return '';
  return `
    <section class="section panel">
      <div class="section-head"><span class="section-ico">${ico('target')}</span><h2>Your picks by outcome</h2></div>
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
function pastMarkets(st) {
  const rows = st.history;
  return `
    <section class="section panel panel-flush">
      <div class="section-head"><span class="section-ico">${ico('history')}</span><h2>Past markets${rows.length ? ` <span class="count-badge">${rows.length}</span>` : ''}</h2></div>
      ${
        rows.length
          ? `<table class="table"><thead><tr><th>Market</th><th>Your pick</th><th class="hide-sm">Result</th><th class="right">Staked</th><th class="right">Points</th></tr></thead><tbody>${rows
              .map(
                (m) => `<tr>
                  <td><a class="mkt-cell" href="#/market/${encodeURIComponent(m.marketId)}">${avatar(m.symbol, 'avatar-sm')}<span>${esc(m.symbol)}</span></a> <span class="muted hide-sm">${fmtAgo(m.settledAt)}</span></td>
                  <td>${m.buckets.map(outcome).join(' ')}</td>
                  <td class="hide-sm">${m.winningBucket ? outcome(m.winningBucket) : '–'}</td>
                  <td class="right">${fmtNum(m.staked)}</td>
                  <td class="right"><b class="${m.won ? 'profit-pos' : 'profit-neg'}">${signed(m.profit)}</b></td>
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
  daily: () => 'Daily claim',
  stake: (e) => `Prediction${e.symbol ? ` on ${e.symbol}` : ''}`,
  refund: (e) => `Refund${e.symbol ? ` from ${e.symbol}` : ''}`,
  payout: (e) => `Won${e.symbol ? ` on ${e.symbol}` : ''}`,
};

/** Every change to the balance, so points never seem to appear or vanish. */
function historyView(entries) {
  if (!entries.length) return '';
  return `
    <section class="section panel">
      <div class="section-head"><span class="section-ico">${ico('coins')}</span><h2>Points history</h2></div>
      <ul class="activity ledger">${entries
        .map((e) => {
          const label = (HISTORY_LABELS[e.reason] ?? (() => e.reason))(e);
          const name = e.marketId ? `<a href="#/market/${encodeURIComponent(e.marketId)}">${esc(label)}</a>` : esc(label);
          return `<li><span>${name}</span><span><b class="${e.delta >= 0 ? 'profit-pos' : ''}">${e.delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(e.delta))}</b> <span class="muted">${fmtAgo(e.at)}</span></span></li>`;
        })
        .join('')}</ul>
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
function startChecklist() {
  if (!S.me || !S.rewards?.onChain || S.rewards.welcomeClaimed) return '';
  return `
    <section class="start-card">
      <span class="start-ico">${ico('token')}</span>
      <div class="start-text"><h2>Claim your 1,000 TestFPT to start</h2><p class="muted">Link a wallet, get free test SOL for the fee, then claim. Takes about two minutes.</p></div>
      <div class="start-actions"><button class="btn btn-solid" data-action="start-guide">${ico('list')}Show me the steps</button><a class="btn" href="#/earn">Claim</a></div>
    </section>`;
}

function earnView() {
  if (!S.me) {
    return `
      <header class="page-head"><span class="page-ico">${ico('gift')}</span><div><h1 class="page-title">Earn points</h1></div></header>
      <div class="empty"><div class="empty-art">${ico('gift')}</div>
        <p><strong>Log in to earn points.</strong><br />Complete tasks on X, invite friends and claim your points.</p>
        <button class="btn btn-solid" data-action="connect">${ico('wallet')}Log in</button></div>`;
  }
  const r = S.rewards;
  if (!r) return '<h1 class="page-title">Earn points</h1><div class="empty"><p>Rewards aren’t available right now.</p></div>';
  const open = r.tasks.filter((t) => !t.done && t.remaining !== 0);
  const available = open.reduce((n, t) => n + t.points, 0);
  return `
    <header class="page-head">
      <span class="page-ico">${ico('gift')}</span>
      <div><h1 class="page-title">Earn points</h1>
      <p class="page-lede">${r.onChain ? `Your rewards arrive as <b>TestFPT</b>, a token on the Solana ${clusterName()} network, when you claim them to your wallet. Claimed points also go into your Firstprint balance.` : 'Complete tasks and invite friends. Points go straight to your balance.'}</p></div>
    </header>
    <dl class="earn-stats">
      <div>${ico('list')}<dt>Open tasks</dt><dd>${open.length}</dd></div>
      <div>${ico('sparkles')}<dt>Points available</dt><dd>+${fmtNum(available)}</dd></div>
      <div>${ico('users')}<dt>Friends invited</dt><dd>${fmtNum(r.referral.invited)}</dd></div>
      <div>${ico('x')}<dt>X account</dt><dd>${r.xUsername ? `@${esc(r.xUsername)}` : 'Not linked'}</dd></div>
    </dl>
    ${r.onChain ? claimCard(r) : ''}
    <div class="earn-grid">
      ${xCard(r)}
      ${referralCard(r)}
    </div>
    ${tasksCard(r)}
    ${r.onChain ? claimsList(r) : ''}`;
}

function claimCard(r) {
  const wallets = S.me.wallets;
  return `
    <section class="claim-card">
      <div class="claim-amount"><span class="claim-ico">${ico('token')}</span><div><span class="muted">Ready to claim</span><b>${fmtNum(r.claimable)} <small>TestFPT</small></b></div></div>
      <div class="claim-side">
        ${
          !wallets.length
            ? '<p class="muted" style="margin:0">Link a Solana wallet to claim to it.</p><button class="btn btn-solid" data-action="link-wallet">Link wallet</button>'
            : `${wallets.length > 1 ? `<label class="select">To <select id="claim-wallet">${wallets.map((w) => `<option value="${esc(w.address)}">${esc(shortAddress(w.address))}${w.walletName ? ` · ${esc(w.walletName)}` : ''}</option>`).join('')}</select></label>` : `<span class="muted">To ${esc(shortAddress(wallets[0].address))}</span>`}
               <button class="cta" style="--c:var(--moon)" data-action="claim-tokens"${r.claimable && !S.claimBusy ? '' : ' disabled'}>${S.claimBusy ? 'Claiming…' : r.claimable ? `Claim ${fmtNum(r.claimable)} TestFPT` : 'Nothing to claim yet'}</button>`
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
      <div class="section-head"><span class="section-ico">${ico('list')}</span><div><h2>Tasks</h2><p class="muted">Open a task, do it on X, then come back and press Verify.</p></div></div>
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
          : '<p class="muted">No tasks right now. Check back soon.</p>'
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

async function onTaskVerify(taskId) {
  try {
    const out = await S.api.verifyTask(taskId);
    celebrate('up');
    toast(out.onChain ? `+${fmtNum(out.points)} points ready to claim as TestFPT` : `+${fmtNum(out.points)} points added`);
  } catch (err) {
    toast(err.message, true);
    if (err.code === 'x_required') $('#x-form input')?.focus();
  }
  await refreshMe();
  if (S.route.name === 'earn') $('#view').innerHTML = earnView();
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
        ${w.icon ? `<img src="${esc(w.icon)}" alt="" width="28" height="28" />` : `<span class="wallet-fallback" aria-hidden="true">${esc(w.name[0])}</span>`}
        <span>${esc(w.name)}</span><span class="muted">Detected</span>
      </button>`,
    )
    .join('');
  if (wallets.length) return `<div class="wallet-options">${list}</div>`;
  const links = isMobileDevice() ? mobileWalletLinks() : INSTALL_LINKS;
  return `
    <div class="no-wallet">
      <p>${isMobileDevice() ? 'Open Firstprint inside your wallet app to connect.' : 'No Solana wallet found in this browser. Install one, then reload this page.'}</p>
      <div class="wallet-links">${links.map((l) => `<a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${isMobileDevice() ? `Open in ${esc(l.name)}` : esc(l.name)}</a>`).join('')}</div>
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
      'New accounts start with 1,000 free points. Use any option below. They all lead to the same account.',
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

function closeModal() {
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
  // New players: complete the profile (or skip), then see how to get started.
  if (created || user?.needsUsername) openAuth('username');
  else if (claimFirst) openAuth('start');
}

/** After the profile step, new players see the getting-started steps if they still have to claim. */
function afterProfile() {
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
const A = { api: null, info: null, checks: null, busy: '', edit: null, preview: null, tab: 'overview' };

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
  ['create', 'plusCircle', 'Create market', 'Save a draft, check it, then publish. Users only see published markets.'],
  ['token', 'token', 'TestFPT token', 'The on-chain token players claim their points as.'],
  ['tasks', 'sparkles', 'Tasks', 'Tasks players complete on X for points.'],
  ['settings', 'sliders', 'Settings', 'Reference exchanges and database backups.'],
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
  if (A.api && !A.info) {
    try {
      A.info = await A.api.ping();
    } catch (err) {
      A.api = null;
      saveAdminKey('');
      if (err.status !== 403) toast(err.message, true);
    }
  }
  if (!A.api) {
    view.innerHTML = `
      <div class="admin-login">
        <span class="page-ico">${ico('lock')}</span>
        <h1 class="page-title">Admin console</h1>
        <p class="muted">Enter the ADMIN_KEY from your server settings. It’s kept only for this browser tab.</p>
        <form id="admin-login" class="admin-form">
          <label><span class="field-label">Admin key</span><input name="key" type="password" autocomplete="off" required /></label>
          <button class="btn btn-solid btn-lg" type="submit">${ico('key')}Open admin</button>
        </form>
      </div>`;
    return;
  }

  const manualOnly = Boolean(A.info.manualOnly);
  const [{ markets }, detected, { log }, token, { tasks }] = await Promise.all([
    A.api.markets(),
    manualOnly ? Promise.resolve([]) : A.api.detected().then((d) => d.detected),
    A.api.log().catch(() => ({ log: [] })),
    A.api.token().catch(() => ({ enabled: false })),
    A.api.tasks().catch(() => ({ tasks: [] })),
  ]);
  const venues = A.info.venues;
  const editing = markets.find((m) => m.id === A.edit && m.mode === 'manual' && m.status === 'open') ?? null;
  if (A.edit && !editing) A.edit = null;
  const waiting = markets.filter((m) => m.mode === 'manual' && m.phase === 'awaiting_result');
  const drafts = markets.filter((m) => m.phase === 'draft');
  const tab = ADMIN_TABS.some(([id]) => id === A.tab) ? A.tab : 'overview';
  const badges = { markets: waiting.length, token: token?.enabled && !token.ready ? '!' : 0 };
  const [, , title, lede] = ADMIN_TABS.find(([id]) => id === tab);

  let body;
  if (tab === 'overview') body = adminOverview({ markets, waiting, drafts, token, tasks, log });
  else if (tab === 'markets') body = adminMarketsTab(markets, waiting);
  else if (tab === 'create') body = `<section class="panel" id="admin-market-section">
      <div class="section-head"><span class="section-ico">${ico(editing ? 'edit' : 'plusCircle')}</span><div><h2>${editing ? `Edit ${esc(editing.symbol)} market` : 'New market'}</h2><p class="muted">When the close time passes, the market waits in Markets for your result.</p></div></div>
      ${marketForm(editing)}
    </section>`;
  else if (tab === 'token') body = tokenAdminSection(token) || `<div class="empty"><p>TestFPT isn’t available on this server.</p></div>`;
  else if (tab === 'tasks') body = tasksAdminSection(tasks);
  else if (tab === 'settings')
    body = `
      <section class="panel">
        <div class="section-head"><span class="section-ico">${ico('landmark')}</span><div><h2>Reference exchanges</h2><p class="muted">Switch off an exchange to stop it being offered for new markets. Nothing is fetched from these exchanges; they are shown to users as the reference for the price you enter.</p></div></div>
        <div class="toggle-grid">${A.info.exchanges
          .map((e) => `<label class="toggle"><input type="checkbox" data-action="admin-exchange" data-id="${esc(e.id)}"${e.enabled ? ' checked' : ''} /><span class="toggle-ui" aria-hidden="true"></span>${esc(e.name)}</label>`)
          .join('')}</div>
      </section>
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
                  <td><span class="mkt-cell">${avatar(m.symbol, 'avatar-sm')}<span>${m.published ? `<a href="#/market/${encodeURIComponent(m.id)}">${esc(m.symbol)}</a>` : `<b>${esc(m.symbol)}</b>`}<small class="muted hide-sm">${esc(venueNames(m))}</small></span></span></td>
                  <td class="hide-sm">${m.mode === 'manual' ? 'Manual' : m.kind === 'live_test' ? 'Live test' : 'Listing'}</td>
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
};

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
      ${A.checks ? checksTable(A.checks) : '<p class="muted">Calls each exchange once for a BTC price, recent candles, the pair list, and announcements.</p>'}
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
function marketForm(m) {
  const locked = Boolean(m && m.published && m.predictors > 0);
  const lock = locked ? ' disabled' : '';
  const t = m?.thresholds ?? { crash: -0.5, down: -0.1, up: 0.1, moon: 0.5 };
  const chosen = new Set(m ? m.venues.map((v) => v.id) : A.info.exchanges.filter((e) => e.enabled).map((e) => e.id));
  const soon = Math.ceil((Date.now() + 24 * 3_600_000) / 3_600_000) * 3_600_000;
  const pct = (n) => String(Math.round(n * 1000) / 10);
  return `
    <form id="admin-market" class="admin-form admin-grid" data-id="${m ? esc(m.id) : ''}">
      ${locked ? '<p class="muted" style="grid-column:1/-1">Users have already predicted, so the token, start price, ranges, and pool rules are locked. You can still edit the description, exchanges, and move the close time later. To change anything else, cancel and refund the market.</p>' : ''}
      <label><span class="field-label">Token symbol</span><input name="symbol" placeholder="XYZ" value="${esc(m?.symbol ?? '')}" required autocomplete="off"${lock} /></label>
      <label><span class="field-label">Token name (optional)</span><input name="name" placeholder="XYZ Protocol" value="${esc(m?.name ?? '')}" autocomplete="off" /></label>
      <label><span class="field-label">Start price (USD)</span><input name="basePrice" type="number" step="any" min="0" placeholder="0.25" value="${m?.basePrice ?? ''}" required${lock} /></label>
      <label><span class="field-label">Predictions close (your time)</span><input name="closeAt" type="datetime-local" value="${toLocalInput(m?.closeAt ?? soon)}" required /></label>
      <label><span class="field-label">Result expected by (your time)</span><input name="resultAt" type="datetime-local" value="${toLocalInput(m?.settleAt ?? soon + 24 * 3_600_000)}" required /></label>
      <fieldset class="venues"><legend class="field-label">Reference exchanges</legend>
        ${A.info.exchanges
          .filter((e) => e.enabled || chosen.has(e.id))
          .map((e) => `<label class="check"><input type="checkbox" name="exchanges" value="${esc(e.id)}"${chosen.has(e.id) ? ' checked' : ''} /> ${esc(e.name)}</label>`)
          .join('')}
      </fieldset>
      <label style="grid-column:1/-1"><span class="field-label">Description and result rules (shown to users)</span>
        <textarea name="note" rows="3" maxlength="2000" placeholder="e.g. Result is the XYZ/USDT closing price on Binance at 12:00 UTC.">${esc(m?.note ?? '')}</textarea></label>
      <details style="grid-column:1/-1"><summary class="field-label">Outcome ranges and pool rules</summary>
        <div class="admin-grid" style="margin-top:10px">
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
               <button class="btn" type="submit" name="intent" value="draft">${ico('edit')}Save as draft</button>`
        }
      </div>
    </form>`;
}

/** One awaiting-result market: enter the final price, preview winners, then confirm. */
function resultForm(m) {
  const p = A.preview?.id === m.id ? A.preview : null;
  const v = p?.inputs ?? {};
  const s = p?.summary;
  const dist = LADDER.map((b) => `${NAMES[b]} ${fmtNum(m.totals[b])}`).join(' · ');
  return `
    <form class="admin-detect admin-result" data-resolve="${esc(m.id)}">
      <div><b>${esc(m.symbol)}</b> <span class="muted">${esc(venueNames(m))}</span><br>
        <span class="muted">Start price ${fmtPrice(m.basePrice)} · Pool ${fmtPts(m.pool)} from ${m.predictors} predictor${m.predictors === 1 ? '' : 's'} · ${dist}</span><br>
        <span class="muted">${LADDER.map((b) => `${NAMES[b]} ${rangeLabel(b, m.thresholds)}`).join(' · ')}</span></div>
      <label><span class="field-label">Final price (USD)</span><input name="finalPrice" type="number" step="any" min="0" value="${esc(v.finalPrice ?? '')}" required /></label>
      <label><span class="field-label">Winning outcome</span>
        <select name="winningBucket"><option value="">Pick from the price (recommended)</option>${LADDER.map((b) => `<option value="${b}"${v.winningBucket === b ? ' selected' : ''}>${NAMES[b]}</option>`).join('')}</select></label>
      <label style="grid-column:1/-1"><span class="field-label">Note shown to users (optional)</span><input name="note" maxlength="2000" value="${esc(v.note ?? '')}" placeholder="e.g. Binance XYZ/USDT close at 12:00 UTC" /></label>
      ${
        s
          ? `<div class="admin-preview" style="grid-column:1/-1">
              <p><b>Preview:</b> ${fmtPrice(s.basePrice)} → ${fmtPrice(s.finalPrice)} is <b>${fmtPct(s.returnPct)}</b>, ${s.voidReason ? `so the market would be <b>cancelled and refunded</b> (${esc(VOID_REASONS[s.voidReason] ?? s.voidReason)})` : `so <b>${NAMES[s.winningBucket]}</b> wins${s.overridden ? ` (you overrode ${NAMES[s.computedBucket]} from the price)` : ''}`}.</p>
              <p class="muted">${s.voidReason ? '' : `${s.winnerCount} winner${s.winnerCount === 1 ? '' : 's'} share ${fmtPts(s.netPool)} (pool ${fmtPts(s.pool)} minus ${fmtPts(s.fee)} fee).`}</p>
              ${s.winners.length ? `<ul class="activity">${s.winners.slice(0, 10).map((w) => `<li><span>${esc(w.username)} picked ${outcome(w.bucket)}</span><span class="muted">${fmtPts(w.stake)} → <b>${fmtPts(w.payout)}</b></span></li>`).join('')}</ul>` : ''}
            </div>`
          : ''
      }
      <div class="admin-actions" style="grid-column:1/-1">
        <button class="btn${s ? '' : ' btn-solid'}" type="submit" name="intent" value="preview">Preview result</button>
        ${s ? '<button class="btn btn-solid" type="submit" name="intent" value="resolve">Confirm and pay winners</button>' : ''}
        <button class="btn" type="button" data-action="admin-cancel" data-id="${esc(m.id)}">Cancel and refund</button>
      </div>
    </form>`;
}

function marketActions(m) {
  const btn = (action, icon, label, cls = '') => `<button class="btn btn-sm${cls}" data-action="${action}" data-id="${esc(m.id)}">${ico(icon)}${label}</button>`;
  const manualOpen = m.mode === 'manual' && m.status === 'open';
  const out = [];
  if (manualOpen) out.push(btn('admin-edit', 'edit', 'Edit'));
  if (manualOpen && !m.published) out.push(btn('admin-publish', 'send', 'Publish', ' btn-solid'), btn('admin-delete', 'trash', 'Delete', ' btn-danger'));
  if (manualOpen && m.published && m.predictors === 0) out.push(btn('admin-unpublish', 'eye', 'Unpublish'));
  if ((m.status === 'open' || m.status === 'locked') && (m.published || m.mode !== 'manual')) out.push(btn('admin-cancel', 'undo', 'Cancel and refund', ' btn-danger'));
  return out.join(' ');
}

function adminPhasePill(m) {
  const text = esc(adminPhase(m));
  if (m.phase === 'draft') return `<span class="pill pill-off">${text}</span>`;
  if (m.phase === 'awaiting_result') return `<span class="pill pill-hot">${text}</span>`;
  if (m.status === 'resolved') return `<span class="pill pill-done">${text}</span>`;
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

function checksTable(results) {
  const cell = (c) => `<td class="${c.ok === null ? 'muted' : c.ok ? 'pass' : 'fail'}" title="${esc(c.detail)}">${c.ok === null ? '–' : c.ok ? 'Pass' : 'Fail'}<small>${esc(String(c.detail).slice(0, 60))}</small></td>`;
  return `<div class="table-scroll"><table class="table checks"><thead><tr><th>Exchange</th><th>Live price</th><th>Candles</th><th>Pairs</th><th>Announcements</th></tr></thead><tbody>${results
    .map((r) => `<tr><td><b>${esc(r.name)}</b></td>${cell(r.ticker)}${cell(r.candles)}${cell(r.pairs)}${cell(r.announcements)}</tr>`)
    .join('')}</tbody></table></div>`;
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
      if (A.tab !== 'create') A.edit = null;
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
      A.api = null;
      A.info = null;
      A.checks = null;
      A.edit = null;
      A.preview = null;
      saveAdminKey('');
      return renderAdmin();
    case 'admin-check':
      A.busy = 'check';
      await renderAdmin();
      try {
        A.checks = (await A.api.checkExchanges()).results;
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
    case 'admin-exchange':
      try {
        await A.api.setExchange(el.dataset.id, el.checked);
        A.info = await A.api.ping();
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
    case 'admin-edit':
      A.edit = el.dataset.id;
      A.tab = 'create';
      await renderAdmin();
      return window.scrollTo({ top: 0 });
    case 'admin-edit-cancel':
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
  };
  // Disabled (locked) fields are absent from FormData and stay unchanged on the server.
  if (d.has('symbol')) body.symbol = String(d.get('symbol') || '').trim();
  if (d.has('basePrice')) body.basePrice = Number(d.get('basePrice'));
  if (d.has('crash')) {
    body.config = {
      thresholds: { crash: pct('crash'), down: pct('down'), up: pct('up'), moon: pct('moon') },
      feeBps: Math.round(Number(d.get('fee')) * 100),
      softCap: Number(d.get('softCap')),
    };
  }
  if (!Number.isFinite(body.closeAt) || !Number.isFinite(body.resultAt)) return toast('Choose the close time and the expected result time.', true);
  if (intent === 'publish' && !confirm('Publish this market? Users will be able to predict straight away.')) return;
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const id = form.dataset.id;
    let m;
    if (id) m = await A.api.updateManual(id, body);
    else m = await A.api.createManual({ ...body, publish: intent === 'publish' });
    if (id && intent === 'publish') m = await A.api.publish(id);
    A.edit = null;
    A.tab = 'markets';
    toast(m.published ? `${m.symbol} market is live` : `${m.symbol} saved as a draft`);
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
  const inputs = { finalPrice: String(d.get('finalPrice') || ''), winningBucket: String(d.get('winningBucket') || ''), note: String(d.get('note') || '').trim() };
  const key = JSON.stringify(inputs);
  const body = { finalPrice: Number(inputs.finalPrice), winningBucket: inputs.winningBucket || undefined, note: inputs.note || undefined };
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    // Money moves only after the admin has seen a preview of exactly these inputs.
    if (intent === 'resolve' && A.preview?.id === id && A.preview.key === key) {
      const s = A.preview.summary;
      const what = s.voidReason ? 'Cancel this market and refund everyone' : `Declare ${NAMES[s.winningBucket]} the winner and pay ${s.winnerCount} winner${s.winnerCount === 1 ? '' : 's'} ${fmtPts(s.totalPaid)}`;
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
  const rung = t.closest('.rung');
  const pick = t.closest('[data-pick]')?.dataset.pick;
  const stakeBtn = t.closest('[data-stake]')?.dataset.stake;
  const walletBtn = t.closest('[data-wallet]');
  if (walletBtn) return walletFlow(walletBtn.dataset.purpose, listWallets()[Number(walletBtn.dataset.wallet)]);

  if (filter) {
    S.filter = filter;
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
      await disconnectWallets();
      S.me = null;
      renderTop();
      toast('Logged out');
      return loadRoute();
    case 'claim':
      try {
        S.me = await S.api.claimDaily();
        celebrate('moon');
        toast('+100 points added. See you tomorrow!');
        renderTop();
        return loadRoute();
      } catch (err) {
        return toast(err.message, true);
      }
    case 'faucet':
      return openAuth('faucet');
    case 'start-guide':
      return openAuth('start');
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
      return onTaskVerify(t.closest('[data-task]').dataset.task);
    case 'copy-text':
      return copyText(t.closest('[data-text]').dataset.text);
    case 'predict':
      return submitPrediction();
    case 'open-sheet':
      return openSheet();
    case 'close-sheet':
      return closeSheet();
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
  if (e.target.id === 'stake') {
    const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 7);
    if (digits !== e.target.value) e.target.value = digits;
    S.trade.stake = Number(digits || 0);
    requestQuote();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'auth-code') return;
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) submitCode(e.target.form);
});

document.addEventListener('change', (e) => {
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
