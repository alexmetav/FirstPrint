// Firstprint website. Vanilla ES modules, no build step.

import { bucketRangeLabel } from './engine.js';
import { ApiError, backendAvailable, createAdminApi, createApi } from './api.js';
import { DEMO_LOGIN, DemoBackend } from './demo.js';
import { INSTALL_LINKS, connectAndSign, disconnectWallets, isMobileDevice, listWallets, mobileWalletLinks, onWalletsChanged, shortAddress } from './wallet.js';

const LADDER = ['moon', 'up', 'flat', 'down', 'crash'];
const NAMES = { crash: 'Crash', down: 'Down', flat: 'Flat', up: 'Up', moon: 'Moon' };
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
const outcome = (b) => `<b class="oc" style="--c:var(--${b})">${NAMES[b]}</b>`;
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
  renderTop();
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
    m.phase === 'pre_listing' ? Promise.resolve(null) : S.api.chart(id),
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
  if (h === '/portfolio') return { name: 'portfolio' };
  if (h === '/radar') return { name: 'radar' };
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
    } else if (S.route.name === 'radar') {
      const { listings } = await S.api.detectedListings();
      view.innerHTML = radarView(listings);
    } else if (S.route.name === 'portfolio') {
      const preds = S.me ? (await S.api.myPredictions()).predictions : [];
      view.innerHTML = portfolioView(preds);
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
  if (S.route.name === 'portfolio') return 'Portfolio: Firstprint';
  return 'Firstprint: predict new exchange listings';
}

// ------------------------------------------------------------------ Top bar

function renderTop() {
  const cur = (name) => (S.route.name === name || (name === 'home' && S.route.name === 'market') ? ' aria-current="page"' : '');
  const wallet = S.me?.wallets?.[0]?.address;
  $('#topbar').innerHTML = `
    <div class="topbar-inner">
      <a class="wordmark" href="#/" aria-label="Firstprint home"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>Firstprint</a>
      <nav class="nav" aria-label="Main">
        <a href="#/"${cur('home')}>Markets</a>
        <a href="#/radar"${cur('radar')}>Listing radar</a>
        <a href="#/leaderboard"${cur('leaderboard')}>Leaderboard</a>
        <a href="#/portfolio"${cur('portfolio')}>Portfolio</a>
      </nav>
      <div class="account">
        ${
          S.me
            ? `<a class="points" href="#/portfolio" title="Signed in as ${esc(S.me.username)}">${fmtPts(S.me.points)}</a>
               <a class="wallet-chip" href="#/portfolio">${wallet ? esc(shortAddress(wallet)) : esc(S.me.username)}</a>`
            : `<button class="btn btn-solid" data-action="connect">Connect wallet</button>`
        }
      </div>
    </div>`;
}

function renderDemoBar() {
  if (!S.api.demo) return;
  $('#demo-bar').innerHTML = `
    <div class="demo-bar"><div class="demo-bar-inner">
      <p><strong>Practice only:</strong> simulated prices, browser-only accounts, and no real funds or persisted predictions.</p>
      <button class="btn" data-action="skip">Skip ahead 2 minutes</button>
      <button class="btn" data-action="reset">Reset demo</button>
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
    ${featured ? featuredView(featured) : ''}
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Market status">
        ${tab('open', 'Upcoming')}${tab('live', 'Live')}${tab('settled', 'Settled')}
      </div>
      <label class="select">Exchange
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
  if (S.filter === 'live') return '<p>No markets are running right now. Upcoming markets move here once predictions close.</p><button class="btn" data-filter="open">See upcoming</button>';
  if (S.filter === 'settled') return '<p>No settled markets yet. Results appear here 72 hours after each listing.</p>';
  return '<p>No upcoming listings match this filter. New markets open as soon as exchanges announce listings.</p>';
}

function featuredView(m) {
  const pre = m.phase === 'pre_listing';
  const test = m.kind === 'live_test';
  const verb = test ? (pre ? 'market starts' : 'market is live') : `${pre ? 'lists' : 'is trading'} on ${esc(m.exchange)}`;
  return `
    <section class="featured" aria-labelledby="featured-title">
      <div>
        <h1 id="featured-title">${esc(m.symbol)} ${verb}
          <span class="countdown">${pre ? `in ${until(m.listingAt)}` : `predictions close in ${until(m.closeAt)}`}</span>
        </h1>
        <p class="lede">Predict where ${esc(m.name || m.symbol)} trades ${fmtSpan(m.settleAt - m.listingAt)} after ${test ? `the market starts, using live prices from ${esc(venueNames(m))}` : 'listing'}.
          ${m.pool ? `${fmtPts(m.pool)} in the pool from ${m.predictors} predictor${m.predictors === 1 ? '' : 's'}.` : 'Nobody has predicted yet.'}</p>
        <div class="actions">
          <a class="btn btn-solid" href="#/market/${encodeURIComponent(m.id)}">Make a prediction</a>
          <a class="btn" href="#how">How it works</a>
        </div>
      </div>
      <div class="mini-ladder" aria-label="Pool split by outcome">
        ${LADDER.map((b) => {
          const pct = share(m, b) * 100;
          return `<div class="mini-rung" style="--c:var(--${b});--share:${pct}%"><b>${NAMES[b]}</b><span class="muted">${rangeLabel(b, m.thresholds)}</span><span class="pct">${Math.round(pct)}%</span></div>`;
        }).join('')}
      </div>
    </section>`;
}

function cardView(m) {
  const lead = leader(m);
  let leadText;
  if (m.status === 'resolved') leadText = `Settled in ${outcome(m.result.winningBucket)} at ${fmtPct(m.result.returnPct)}`;
  else if (m.status === 'void') leadText = 'Cancelled. Points were returned.';
  else if (m.live?.projectedBucket) leadText = `Now ${fmtPct(m.live.returnPct)}, tracking ${outcome(m.live.projectedBucket)}`;
  else if (lead) leadText = `${outcome(lead)} leads with ${Math.round(share(m, lead) * 100)}% of the pool`;
  else leadText = '<span class="muted">No predictions yet</span>';

  let when;
  if (m.phase === 'pre_listing') when = `${m.kind === 'live_test' ? 'Starts' : 'Lists'} in ${until(m.listingAt)}`;
  else if (m.phase === 'baseline') when = `Closes in ${until(m.closeAt)}`;
  else if (m.phase === 'running') when = `Result in ${until(m.settleAt)}`;
  else when = fmtDate(m.settleAt);

  return `
    <a class="card" href="#/market/${encodeURIComponent(m.id)}">
      <div class="card-top"><span class="sym">${esc(m.symbol)}</span><span class="exch">${esc(m.exchange)}</span></div>
      <div class="card-name">${esc(m.name || '')}${m.kind === 'live_test' ? ' <span class="tag tag-test">Live test</span>' : ''}</div>
      <div class="strip${m.pool ? '' : ' empty'}" aria-hidden="true">
        ${['crash', 'down', 'flat', 'up', 'moon'].map((b) => `<span style="--c:var(--${b});flex:${m.pool ? m.totals[b] : 1}"></span>`).join('')}
      </div>
      <div class="card-lead">${leadText}</div>
      <div class="card-foot"><span class="when">${when}</span><span>${fmtPts(m.pool)}</span></div>
    </a>`;
}

function howItWorks() {
  return `
    <section class="section" id="how" style="margin-top:36px">
      <h2>How it works</h2>
      <ol class="rules">
        <li>Firstprint watches seven exchanges for new listings and opens a market when one is confirmed. Connect a Solana wallet to get 1,000 free points.</li>
        <li>Pick one of five outcomes for the price 72 hours after listing, from Crash to Moon. Predictions stay open until 1 hour after trading starts, and earlier predictions earn a bigger share.</li>
        <li>The starting price is the average over the first hour of trading. The final price is the average over the last hour, so a single spike can’t decide a market.</li>
        <li>Everyone who picked the winning outcome splits the pool, minus a 4% fee. If nobody picked it, everyone gets their points back.</li>
      </ol>
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
      return `${m.kind === 'live_test' ? 'The market has started.' : 'Trading started.'} Predictions close in <strong>${until(m.closeAt)}</strong>.`;
    case 'running':
      return `Predictions are closed. Result in <strong>${until(m.settleAt)}</strong>.`;
    case 'resolved':
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
          <b>${NAMES[b]}${mineBy[b] ? `<span class="tag tag-you">You ${fmtNum(mineBy[b])}</span>` : ''}${
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
    <a class="back" href="#/">All markets</a>
    <header class="m-head">
      <div class="m-title"><h1 class="sym">${esc(m.symbol)}</h1><span class="exch">${esc(m.exchange)}</span>${
        (m.phase === 'baseline' || m.phase === 'running') && S.live ? '<span class="live-badge"><span class="live-dot" aria-hidden="true"></span>Live price</span>' : ''
      }</div>
      <p class="m-question">${
        m.kind === 'live_test'
          ? `Where will ${esc(m.name || m.symbol)} trade ${span} after this market starts?`
          : `Where will ${esc(m.name || m.symbol)} trade ${span} after listing on ${esc(m.exchange)}?`
      }</p>
      <p class="m-status">${statusLine(m)}</p>
      <p class="m-venues">${m.kind === 'live_test' ? '<span class="tag tag-test">Live test</span> ' : ''}Prices from ${esc(venueNames(m))}</p>
    </header>

    <dl class="stats">
      <div><dt>Pool</dt><dd>${fmtPts(m.pool)}</dd></div>
      <div><dt>Predictors</dt><dd>${fmtNum(m.predictors)}</dd></div>
      <div><dt>${m.kind === 'live_test' ? 'Starts' : 'Listing'}</dt><dd>${fmtDate(m.listingAt)}</dd></div>
      <div><dt>Result</dt><dd>${fmtDate(m.settleAt)}</dd></div>
    </dl>

    ${chartView(m)}

    <div class="ladder${settled ? ' settled' : ''}" role="group" aria-label="Outcomes">
      <div class="ladder-head"><span>Price after ${span}</span><span>Crowd</span><span>Pays</span><span class="pool-col">Pool</span></div>
      ${rungs}
      ${canPick ? '<p class="fine" style="margin:2px 0 0">Pays shows the current payout per point before early bonuses. Your estimate in the prediction panel includes your bonus.</p>' : ''}
    </div>

    <section class="section">
      <h2>How this market settles</h2>
      <ol class="rules">
        <li>Starting price: the average price over the first ${fmtSpan(m.closeAt - m.listingAt)} ${m.kind === 'live_test' ? 'after the market starts' : 'of trading'}, from ${esc(venueNames(m))}.</li>
        <li>Final price: the average over the last ${fmtSpan(m.closeAt - m.listingAt)} before ${fmtDate(m.settleAt)}. If the token trades on several exchanges, the volume-weighted median is used.</li>
        <li>Predictions close ${fmtSpan(m.closeAt - m.listingAt)} after trading starts. Earlier predictions get up to ${(1 + m.earlyBirdK).toFixed(1)}× weight when the pool is split.</li>
        <li>Winners split the pool minus a ${m.feeBps / 100}% fee. Limit ${fmtPts(m.userCap)} per person.</li>
        <li>The market is cancelled and refunded if the listing is delayed more than 24 hours, trading halts for too long, there isn’t enough trading data, or nobody picks the winning outcome.</li>
      </ol>
    </section>

    ${
      m.scorecard
        ? `<section class="section">
            <h2>About ${esc(m.symbol)}</h2>
            <dl class="facts">
              ${m.scorecard.fdvUsd ? `<div><dt>Valuation at listing</dt><dd>$${fmtCompact(m.scorecard.fdvUsd)}</dd></div>` : ''}
              ${m.scorecard.circulatingPct !== undefined ? `<div><dt>Circulating supply</dt><dd>${m.scorecard.circulatingPct}%</dd></div>` : ''}
              ${m.scorecard.airdropPct !== undefined ? `<div><dt>Airdrop share</dt><dd>${m.scorecard.airdropPct}%</dd></div>` : ''}
              ${m.scorecard.unlocks ? `<div style="grid-column:1/-1"><dt>Unlocks</dt><dd>${esc(m.scorecard.unlocks)}</dd></div>` : ''}
            </dl>
          </section>`
        : ''
    }

    <section class="section">
      <h2>Recent predictions</h2>
      ${
        S.activity.length
          ? `<ul class="activity">${S.activity
              .slice(0, 12)
              .map((a) => `<li><span>${esc(a.username)} picked ${outcome(a.bucket)}</span><span class="muted">${fmtPts(a.stake)}, ${fmtAgo(a.placedAt)}</span></li>`)
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
          <h2>Predict ${esc(m.symbol)}</h2>
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
        `<button type="button" role="radio" aria-checked="${S.trade.bucket === b}" data-pick="${b}" style="--c:var(--${b})"><b>${NAMES[b]}</b><small>${Math.round(share(m, b) * 100)}%</small></button>`,
    ).join('');
    updateSummary();
  } else if (mode === 'closed') {
    $('#trade-closed').innerHTML = `<h2>Predictions closed</h2><p class="muted">Result in ${until(m.settleAt)}.${
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
  if (!S.me) return mode === 'open' ? '' : '<p class="fine">Connect a wallet to track your predictions.</p>';
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
      <div class="big"><dt>If ${NAMES[b]} wins</dt><dd>${q ? `about ${fmtPts(q.payout)}` : '…'}</dd></div>
      <div><dt>Return on stake</dt><dd>${q && stake ? `${q.multiple.toFixed(2)}×` : '–'}</dd></div>
      <div><dt>Early bonus</dt><dd>${q ? `${q.weight.toFixed(2)}×` : '–'}</dd></div>
      <div><dt>Price range</dt><dd>${rangeLabel(b, m.thresholds)}</dd></div>`;
  }

  const cta = $('#trade-cta');
  if (!S.me) {
    cta.textContent = 'Connect wallet to predict';
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
    : 'Connect a Solana wallet to start with 1,000 free points.';
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
    await S.api.predict(m.id, bucket, stake);
    toast(`Predicted ${NAMES[bucket]} for ${fmtPts(stake)}`);
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
  const rows = lb.entries
    .map(
      (e) => `
      <tr class="${e.isMe ? 'me' : ''}">
        <td class="rank">${e.rank}</td>
        <td>${esc(e.name)}${e.isMe ? ' <span class="tag tag-you">You</span>' : ''}</td>
        <td class="right ${e.profit >= 0 ? 'profit-pos' : 'profit-neg'}">${e.profit >= 0 ? '+' : '−'}${fmtNum(Math.abs(e.profit))}</td>
        <td class="right hide-sm">${e.wins} of ${e.total}</td>
      </tr>`,
    )
    .join('');
  return `
    <h1 class="page-title">Leaderboard</h1>
    <p class="page-lede">Points won or lost on markets settled this week. The board resets every Monday at 00:00 UTC.</p>
    ${
      lb.entries.length
        ? `<table class="table"><thead><tr><th>Rank</th><th>Predictor</th><th class="right">Profit</th><th class="right hide-sm">Correct</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty"><p>No markets have settled this week yet.</p></div>'
    }
    ${S.me && !lb.me ? '<p class="fine">You’ll appear here after one of your predictions settles.</p>' : ''}`;
}

function portfolioView(preds) {
  if (!S.me) {
    return `
      <h1 class="page-title">Portfolio</h1>
      <div class="empty"><p>Connect a Solana wallet to see your points and predictions. New accounts start with 1,000 free points.</p>
        <button class="btn btn-solid" data-action="connect">Connect wallet</button></div>`;
  }
  const active = preds.filter((p) => p.marketStatus === 'open' || p.marketStatus === 'locked');
  const settled = preds.filter((p) => p.marketStatus === 'resolved' || p.marketStatus === 'void');
  const table = (list, empty) =>
    list.length
      ? `<table class="table"><thead><tr><th>Market</th><th>Outcome</th><th class="right">Stake</th><th class="right">Status</th></tr></thead><tbody>${list
          .map((p) => {
            let status = p.marketStatus === 'open' ? 'Open' : 'In play';
            if (p.marketStatus === 'resolved') status = p.payout > 0 ? `<span class="profit-pos">Won ${fmtNum(p.payout)}</span>` : 'Didn’t win';
            if (p.marketStatus === 'void') status = 'Refunded';
            return `<tr><td><a href="#/market/${encodeURIComponent(p.marketId)}">${esc(p.symbol)}</a> <span class="muted hide-sm">${esc(p.exchange)}</span></td><td>${outcome(p.bucket)}</td><td class="right">${fmtNum(p.stake)}</td><td class="right">${status}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : `<p class="muted">${empty}</p>`;

  return `
    <h1 class="page-title">Portfolio</h1>
    <div class="balance">
      <div><div class="amount">${fmtNum(S.me.points)}</div><div class="muted">points available, signed in as ${esc(S.me.username)}</div></div>
      ${
        S.me.canClaimDaily
          ? '<button class="btn btn-solid" data-action="claim">Claim 100 daily points</button>'
          : '<p class="muted" style="margin:0">Daily points claimed. Claim again after 00:00 UTC.</p>'
      }
      <button class="btn" data-action="logout">Log out</button>
    </div>
    <section class="section">
      <h2>Wallets</h2>
      ${
        S.me.wallets.length
          ? `<ul class="wallet-list">${S.me.wallets
              .map((w) => `<li><span class="addr" title="${esc(w.address)}">${esc(shortAddress(w.address))}</span><span class="muted">${esc(w.walletName || 'Solana wallet')}</span><a class="muted" href="https://solscan.io/account/${encodeURIComponent(w.address)}" target="_blank" rel="noopener noreferrer">View on Solscan</a></li>`)
              .join('')}</ul>`
          : '<p class="muted">No wallet linked yet. Link one to sign in with it and to be ready for on-chain pools.</p>'
      }
      <button class="btn" data-action="link-wallet">Link ${S.me.wallets.length ? 'another' : 'a Solana'} wallet</button>
    </section>
    <section class="section"><h2>Active predictions</h2>${table(active, 'No active predictions. Pick an upcoming listing to get started.')}</section>
    <section class="section"><h2>Settled</h2>${table(settled, 'Your results appear here after markets settle.')}</section>`;
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

function openAuth(kind) {
  S.modal = kind;
  S.modalBusy = false;
  closeSheet();
  let html;
  if (kind === 'connect' || kind === 'link') {
    const linking = kind === 'link';
    html = modalShell(
      linking ? 'Link a Solana wallet' : 'Connect a Solana wallet',
      linking ? 'Sign a message to prove you own the wallet. It’s free and sends no transaction.' : 'Sign in by signing a message. It’s free, sends no transaction, and new accounts get 1,000 points.',
      `${walletButtons(kind)}
       ${S.api.demo ? `<button class="btn" style="width:100%;margin-top:10px" data-action="demo-wallet" data-purpose="${kind}">Use a demo wallet</button>` : ''}
       <p class="form-error" id="auth-error" role="alert"></p>
       <p class="fine" id="auth-status"></p>
       ${linking ? '' : '<p class="fine">Prefer email? <button class="switch" data-action="login">Log in with email</button> or <button class="switch" data-action="signup">create an email account</button>.</p>'}`,
    );
  } else if (kind === 'username') {
    html = modalShell(
      'Choose a username',
      'This is how you appear on leaderboards and in market activity.',
      `<form id="username-form" novalidate>
         <label><span class="field-label">Username</span><input name="username" value="${esc(S.me?.username ?? '')}" minlength="3" maxlength="20" autocomplete="username" required /></label>
         <button class="cta" style="--c:var(--text)" type="submit">Save username</button>
         <p class="form-error" id="auth-error" role="alert"></p>
       </form>
       <p class="fine"><button class="switch" data-action="close-modal">Skip for now</button></p>`,
    );
  } else {
    const signup = kind === 'signup';
    html = modalShell(
      signup ? 'Create an email account' : 'Log in with email',
      signup ? 'Start with 1,000 free points. You can link a wallet later.' : '',
      `<form id="auth-form" novalidate>
         <label><span class="field-label">Email</span><input name="email" type="email" autocomplete="email" required /></label>
         ${signup ? '<label><span class="field-label">Username</span><input name="username" autocomplete="username" minlength="3" maxlength="20" required /></label>' : ''}
         <label><span class="field-label">Password</span><input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" required /></label>
         <button class="cta" style="--c:var(--text)" type="submit">${signup ? 'Create account' : 'Log in'}</button>
         <p class="form-error" id="auth-error" role="alert"></p>
       </form>
       <p class="fine"><button class="switch" data-action="connect">Connect a wallet instead</button></p>
       ${S.api.demo && !signup ? `<p class="fine">Demo account: ${DEMO_LOGIN.email} with password ${DEMO_LOGIN.password}</p>` : ''}`,
    );
  }
  $('#modal-root').innerHTML = html;
  ($('#modal-root input') || $('#modal-root button.wallet-option') || $('#modal-root button'))?.focus();
}

function closeModal() {
  S.modal = null;
  S.modalBusy = false;
  $('#modal-root').innerHTML = '';
}

async function afterSignIn(user, created) {
  closeModal();
  await refreshMe();
  toast(created ? 'Account created. 1,000 points added.' : `Signed in as ${S.me.username}`);
  S.tradeKey = '';
  await loadRoute();
  if (user?.needsUsername) openAuth('username');
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

async function submitAuth(form) {
  const data = Object.fromEntries(new FormData(form));
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const out = S.modal === 'signup' ? await S.api.signup(data) : await S.api.login(data);
    await afterSignIn(out.user, S.modal === 'signup');
  } catch (err) {
    $('#auth-error').textContent = err.message;
    btn.disabled = false;
  }
}

async function submitUsername(form) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    S.me = await S.api.setUsername(new FormData(form).get('username'));
    closeModal();
    renderTop();
    toast(`You’re ${S.me.username}`);
    await loadRoute();
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
const A = { api: null, info: null, checks: null, busy: '' };

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
      <h1 class="page-title">Admin</h1>
      <p class="page-lede">Enter the ADMIN_KEY from your .env file. It’s kept only for this browser tab.</p>
      <form id="admin-login" class="admin-form" style="max-width:420px">
        <label><span class="field-label">Admin key</span><input name="key" type="password" autocomplete="off" required /></label>
        <button class="btn btn-solid" type="submit">Open admin</button>
      </form>`;
    return;
  }

  const [{ markets }, { detected }] = await Promise.all([A.api.markets(), A.api.detected()]);
  const venues = A.info.venues;
  view.innerHTML = `
    <div class="admin-head">
      <h1 class="page-title">Admin</h1>
      <button class="btn" data-action="admin-logout">Lock admin</button>
    </div>

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
    </section>

    <section class="section">
      <h2>All markets</h2>
      ${
        markets.length
          ? `<table class="table"><thead><tr><th>Market</th><th class="hide-sm">Type</th><th>Status</th><th class="right">Pool</th><th class="right"></th></tr></thead><tbody>${markets
              .map(
                (m) => `<tr>
                  <td><a href="#/market/${encodeURIComponent(m.id)}">${esc(m.symbol)}</a> <span class="muted hide-sm">${esc(venueNames(m))}</span></td>
                  <td class="hide-sm">${m.kind === 'live_test' ? 'Live test' : 'Listing'}</td>
                  <td>${esc(adminPhase(m))}</td>
                  <td class="right">${fmtNum(m.pool)}</td>
                  <td class="right">${m.status === 'open' || m.status === 'locked' ? `<button class="btn" data-action="admin-cancel" data-id="${esc(m.id)}">Cancel and refund</button>` : ''}</td>
                </tr>`,
              )
              .join('')}</tbody></table>`
          : '<p class="muted">No markets yet.</p>'
      }
    </section>`;
}

function adminPhase(m) {
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
  switch (action) {
    case 'admin-logout':
      A.api = null;
      A.info = null;
      A.checks = null;
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
    case 'admin-cancel':
      if (!confirm('Cancel this market and refund every prediction?')) return;
      try {
        await A.api.cancel(el.dataset.id);
        toast('Market cancelled and refunded');
      } catch (err) {
        toast(err.message, true);
      }
      return renderAdmin();
  }
}

async function onAdminSubmit(form) {
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
      return openAuth(action);
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
        toast('Added 100 points');
        renderTop();
        return loadRoute();
      } catch (err) {
        return toast(err.message, true);
      }
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

document.addEventListener('change', (e) => {
  if (e.target.id === 'exchange-filter') {
    S.exchange = e.target.value;
    $('#view').innerHTML = homeView();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'auth-form') {
    e.preventDefault();
    submitAuth(e.target);
  } else if (e.target.id === 'username-form') {
    e.preventDefault();
    submitUsername(e.target);
  } else if (S.route.name === 'admin') {
    e.preventDefault();
    onAdminSubmit(e.target);
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
  const forceDemo = window.FP_FORCE_DEMO || new URLSearchParams(location.search).has('demo');
  // A server outage must never silently replace real balances with simulated ones.
  S.api = forceDemo ? new DemoBackend() : createApi();
  renderDemoBar();
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
    if ((S.modal === 'connect' || S.modal === 'link') && !S.modalBusy) openAuth(S.modal);
  });
})();
