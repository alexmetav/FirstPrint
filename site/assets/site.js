// Firstprint website: motion system, landing interactions, and the app
// (live exchange explorer + coming-soon tabs).

import { EXCHANGES } from './exchanges.js';

const CONFIG = window.FIRSTPRINT_CONFIG ?? { links: {} };
const REFRESH_MS = 60_000;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  list: null,
  btcUsd: null,
  updatedAt: null,
  live: false,
  search: '',
  sort: 'volume',
  detail: new Map(),
  timer: null,
};

// ------------------------------------------------------------------ Helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function usd(n, compact = true) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  if (!compact) return n >= 1 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${n.toPrecision(4)}`;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(abs >= 1e10 ? 1 : 2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

const monogram = (name) => `<span class="monogram" aria-hidden="true">${esc(name.replace(/[^A-Za-z0-9]/g, '')[0] ?? '?')}</span>`;

function safeImageUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A live provider logo with an accessible fallback. */
function exchangeMark(ex, alt = '') {
  const src = safeImageUrl(ex.logo);
  return `<span class="ex-logo">${src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.hidden=true" />` : ''}${monogram(ex.name)}</span>`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3200);
}

// ------------------------------------------------------------------ Motion

/** Reveals elements as they scroll in, honouring their data-delay. */
const revealer = REDUCED
  ? null
  : new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.style.setProperty('--d', `${e.target.dataset.delay ?? 0}ms`);
          e.target.classList.add('in');
          revealer.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.15 },
    );

function watchReveals(root = document) {
  const items = $$('.reveal', root);
  if (!revealer) return items.forEach((el) => el.classList.add('in'));
  items.forEach((el) => (el.classList.contains('in') ? null : revealer.observe(el)));
}

/**
 * Fast flick-scrolling can outrun IntersectionObserver callbacks, which would
 * leave content invisible. After scrolling settles, reveal anything already
 * on screen.
 */
function sweepReveals() {
  for (const el of $$('.reveal:not(.in)')) {
    if (el.getBoundingClientRect().top < window.innerHeight) {
      el.style.setProperty('--d', '0ms');
      el.classList.add('in');
      revealer?.unobserve(el);
    }
  }
}

if (revealer) {
  let sweepTimer;
  addEventListener(
    'scroll',
    () => {
      clearTimeout(sweepTimer);
      sweepTimer = setTimeout(sweepReveals, 140);
      requestAnimationFrame(sweepReveals);
    },
    { passive: true },
  );
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/** Counts a number up when it first appears. */
function countUp(el, to, suffix = '', duration = 1100) {
  if (REDUCED) return (el.textContent = `${to}${suffix}`);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = `${Math.round(easeOut(t) * to)}${suffix}`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function watchCounters() {
  const els = $$('[data-count]');
  if (REDUCED || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        countUp(e.target, Number(e.target.dataset.count), e.target.dataset.suffix ?? '');
        io.unobserve(e.target);
      }
    },
    { threshold: 0.6 },
  );
  els.forEach((el) => {
    el.textContent = `0${el.dataset.suffix ?? ''}`;
    io.observe(el);
  });
}

/** Buttons drift slightly toward the pointer, then spring back. */
function magnetic(el) {
  if (REDUCED) return;
  const strength = 0.28;
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${(e.clientX - r.left - r.width / 2) * strength}px`);
    el.style.setProperty('--my', `${(e.clientY - r.top - r.height / 2) * strength}px`);
  });
  el.addEventListener('pointerleave', () => {
    el.style.setProperty('--mx', '0px');
    el.style.setProperty('--my', '0px');
  });
}

/** Cards light up under the pointer. */
function spotlight(el) {
  if (REDUCED) return;
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--px', `${((e.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty('--py', `${((e.clientY - r.top) / r.height) * 100}%`);
  });
}

/** The hero card tilts a little with the pointer. */
function parallaxCard(el) {
  if (REDUCED || window.matchMedia('(pointer: coarse)').matches) return;
  const area = el.parentElement;
  area.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
    const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
    el.style.setProperty('--ry', `${Math.max(-1, Math.min(1, dx)) * 5}deg`);
    el.style.setProperty('--rx', `${Math.max(-1, Math.min(1, -dy)) * 4}deg`);
  });
  area.addEventListener('pointerleave', () => {
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--rx', '0deg');
  });
}

/** Header hides on scroll down and returns on scroll up. */
function autoHideNav() {
  const nav = $('#nav');
  if (!nav) return;
  let last = 0;
  addEventListener(
    'scroll',
    () => {
      const y = window.scrollY;
      nav.classList.toggle('stuck', y > 12);
      nav.classList.toggle('hide', y > 420 && y > last + 4);
      last = y;
    },
    { passive: true },
  );
}

// ------------------------------------------------------------------ Hero market

/**
 * The example market plays its own life: predictions build, the listing starts,
 * the clock runs down, and one outcome wins. Then it resets and runs again.
 */
function heroMarket() {
  const ladder = $('#hm-ladder');
  if (!ladder) return;
  const rows = $$('li', ladder);
  const phase = $('#hm-phase');
  const sub = $('#hm-sub');
  const clock = $('#hm-clock');
  const clockLabel = $('#hm-clock-label');
  const foot = $('#hm-foot-text');

  const ROUNDS = [
    { shares: [18, 31, 22, 19, 10], winner: 'up', move: '+28%' },
    { shares: [9, 17, 24, 28, 22], winner: 'crash', move: '−61%' },
    { shares: [34, 29, 14, 15, 8], winner: 'moon', move: '+112%' },
    { shares: [12, 22, 31, 23, 12], winner: 'flat', move: '+3%' },
  ];

  let round = 0;
  let timers = [];
  let countdown = null;
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const stopCountdown = () => {
    if (countdown) clearTimeout(countdown);
    countdown = null;
  };

  const setShares = (shares) =>
    rows.forEach((li, i) => {
      li.style.setProperty('--share', `${shares[i]}%`);
      const em = $('em', li);
      if (REDUCED) return (em.textContent = `${shares[i]}%`);
      countUp(em, shares[i], '%', 900);
    });

  function run() {
    timers.forEach(clearTimeout);
    timers = [];
    stopCountdown();
    const r = ROUNDS[round % ROUNDS.length];
    round++;

    rows.forEach((li) => li.classList.remove('won', 'dim'));
    phase.textContent = 'Predictions open';
    phase.style.color = '';
    sub.textContent = 'Lists on a major exchange';
    clockLabel.textContent = 'Lists in';
    clock.textContent = '02:14:09';
    clock.style.color = '';
    foot.textContent = 'Share of the pool on each outcome';
    setShares([0, 0, 0, 0, 0]);

    at(300, () => setShares(r.shares));

    at(3400, () => {
      phase.textContent = 'Trading live';
      sub.textContent = 'Listed. 72-hour window running';
      clockLabel.textContent = 'Settles in';
      let left = 71 * 3600 + 59 * 60;
      const tick = () => {
        left = Math.max(0, left - 2700);
        const h = String(Math.floor(left / 3600)).padStart(2, '0');
        const m = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
        clock.textContent = `${h}:${m}:00`;
        countdown = left > 0 ? setTimeout(tick, 45) : null;
      };
      tick();
    });

    at(5700, () => {
      stopCountdown();
      const winner = rows.find((li) => li.dataset.b === r.winner);
      rows.forEach((li) => li !== winner && li.classList.add('dim'));
      winner.classList.add('won');
      phase.textContent = 'Settled';
      clockLabel.textContent = 'Final move';
      clock.textContent = r.move;
      clock.style.color = getComputedStyle(winner).getPropertyValue('--c');
      foot.textContent = `${$('b', winner).textContent} wins the pool`;
    });

    at(9200, run);
  }

  if (REDUCED) {
    setShares(ROUNDS[0].shares);
    return;
  }
  // Runs only while on screen, and never more than one loop at a time.
  let running = false;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !running) {
          running = true;
          run();
        } else if (!e.isIntersecting && running) {
          running = false;
          timers.forEach(clearTimeout);
          timers = [];
          stopCountdown();
        }
      }
    },
    { threshold: 0.25 },
  );
  io.observe(ladder.closest('.hero-market'));
}

function buildTicker() {
  const track = $('#ticker-track');
  if (!track) return;
  const items = EXCHANGES.map((e) => `<span class="ticker-item"><i aria-hidden="true"></i>${esc(e.name)}</span>`).join('');
  track.innerHTML = items + items; // duplicated so the loop is seamless
}


// ------------------------------------------------------------------ Practice market

/**
 * A playable sample market. The visitor picks an outcome, a price path draws
 * over about four seconds, and the result settles. Streaks are kept locally so
 * coming back feels like picking up where you left off.
 */
function practiceMarket() {
  const root = $('#try');
  if (!root) return;
  const picks = $('#try-picks');
  const buttons = $$('button', picks);
  const result = $('#try-result');
  const again = $('#try-again');
  const path = $('#try-path');
  const chart = $('#try-chart');
  const move = $('#try-move');
  const streakEl = $('#try-streak');
  const scoreEl = $('.try-score');
  const symbolEl = $('#try-symbol');
  const subEl = $('#try-sub');
  const chip = $('#try-chip');
  const question = $('#try-question');

  const NAMES = { crash: 'Crash', down: 'Down', flat: 'Flat', up: 'Up', moon: 'Moon' };
  const TOKENS = ['VELA', 'NOVA', 'KORA', 'ARCO', 'TIDE', 'MOSS', 'QUILL', 'LUMA'];
  // Roughly how often each outcome shows up, based on how listings usually behave.
  const ODDS = [
    ['crash', 0.18],
    ['down', 0.26],
    ['flat', 0.18],
    ['up', 0.23],
    ['moon', 0.15],
  ];
  const RANGE = { crash: [-0.82, -0.52], down: [-0.48, -0.12], flat: [-0.08, 0.08], up: [0.12, 0.46], moon: [0.55, 1.8] };

  let streak = 0;
  let best = 0;
  let plays = 0;
  try {
    const saved = JSON.parse(localStorage.getItem('fp:practice') ?? '{}');
    streak = saved.streak ?? 0;
    best = saved.best ?? 0;
    plays = saved.plays ?? 0;
  } catch {
    /* storage optional */
  }
  const save = () => {
    try {
      localStorage.setItem('fp:practice', JSON.stringify({ streak, best, plays }));
    } catch {
      /* ignore */
    }
  };
  streakEl.textContent = streak;

  const rand = (a, b) => a + Math.random() * (b - a);
  const ORDER = ['moon', 'up', 'flat', 'down', 'crash'];

  /** Fresh crowd split each round; payouts follow from it, minus a 4% fee. */
  function newPool() {
    // Squaring spreads the crowd unevenly, the way a real pool sits: a couple of
    // favourites and a long shot that pays much more.
    // A moderate spread: favourites near 30-35%, long shots near 8%, which keeps
    // payouts in a believable 2x to 12x band.
    const weights = ORDER.map(() => Math.pow(0.5 + Math.random(), 1.8));
    const total = weights.reduce((a, b) => a + b, 0);
    const share = Object.fromEntries(ORDER.map((k, i) => [k, Math.max(0.08, weights[i] / total)]));
    buttons.forEach((b) => {
      const pays = 0.96 / share[b.dataset.pick];
      $('em', b).textContent = `${pays >= 10 ? pays.toFixed(0) : pays.toFixed(1)}×`;
    });
    return share;
  }
  const pickOutcome = () => {
    let r = Math.random();
    for (const [name, p] of ODDS) {
      if ((r -= p) <= 0) return name;
    }
    return 'flat';
  };

  function burst(el) {
    if (REDUCED) return;
    const r = el.getBoundingClientRect();
    const colors = ['--moon', '--up', '--flat', '--down', '--crash'];
    for (let i = 0; i < 18; i++) {
      const s = document.createElement('span');
      s.className = 'spark';
      const angle = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 130;
      s.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;background:var(${colors[i % colors.length]});--dx:${Math.cos(angle) * dist}px;--dy:${Math.sin(angle) * dist}px;--rot:${Math.random() * 540}deg`;
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 1000);
    }
  }

  /** Draws a plausible price path to the final return over `ms`. */
  function drawPath(finalReturn, ms, onDone) {
    const W = 320;
    const H = 140;
    const mid = 70;
    const steps = 56;
    const seedA = Math.random() * 10;
    const seedB = Math.random() * 10;
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const drift = finalReturn * (1 - Math.pow(1 - t, 1.8));
      const wobble = (Math.sin(t * 9 + seedA) * 0.05 + Math.sin(t * 23 + seedB) * 0.028) * (1 - t * 0.55);
      const spike = t < 0.08 ? Math.sin(t * 38) * 0.09 : 0;
      const r = drift + wobble + spike;
      const y = Math.max(6, Math.min(H - 6, mid - r * 58));
      points.push([(t * W).toFixed(1), y.toFixed(1)]);
    }
    if (REDUCED) {
      path.setAttribute('d', `M${points.map((p) => p.join(',')).join('L')}`);
      return onDone();
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const n = Math.max(2, Math.round(t * points.length));
      path.setAttribute('d', `M${points.slice(0, n).map((p) => p.join(',')).join('L')}`);
      if (t < 1) requestAnimationFrame(step);
      else onDone();
    };
    requestAnimationFrame(step);
  }

  function reset() {
    picks.classList.remove('locked');
    buttons.forEach((b) => {
      b.disabled = false;
      b.setAttribute('aria-checked', 'false');
      b.classList.remove('win');
    });
    again.hidden = true;
    move.classList.remove('show');
    path.setAttribute('d', 'M0,70');
    chart.style.removeProperty('--c');
    result.className = 'try-result';
    result.textContent = plays ? 'Pick an outcome to run another.' : 'Pick an outcome to start.';
    chart.classList.add('idle');
    newPool();
    const sym = TOKENS[Math.floor(Math.random() * TOKENS.length)];
    symbolEl.textContent = sym;
    subEl.textContent = 'Lists on a major exchange in 2 hours';
    question.textContent = `Where will ${sym} trade 72 hours after listing?`;
    chip.textContent = 'Practice market';
  }

  function play(choice, button) {
    picks.classList.add('locked');
    chart.classList.remove('idle');
    buttons.forEach((b) => (b.disabled = true));
    button.setAttribute('aria-checked', 'true');
    chip.textContent = 'Trading live';
    subEl.textContent = 'Listed. 72-hour window running';
    result.textContent = 'Running the 72 hours…';

    const outcome = pickOutcome();
    const r = rand(...RANGE[outcome]);
    chart.style.setProperty('--c', `var(--${outcome})`);

    drawPath(r, REDUCED ? 0 : 3600, () => {
      const won = outcome === choice;
      const pct = `${r > 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)}%`;
      move.textContent = pct;
      move.classList.add('show');
      chip.textContent = 'Settled';
      subEl.textContent = `Final move ${pct}`;
      const winner = buttons.find((b) => b.dataset.pick === outcome);
      winner.classList.add('win');
      winner.setAttribute('aria-checked', 'true');

      plays++;
      if (won) {
        streak++;
        best = Math.max(best, streak);
        streakEl.textContent = streak;
        scoreEl.classList.add('bump');
        setTimeout(() => scoreEl.classList.remove('bump'), 600);
        burst(winner);
        result.className = 'try-result win';
        const pays = $('em', winner).textContent;
        result.innerHTML = `<b>You called it. ${NAMES[outcome]}, ${pct}.</b>Paid ${pays}. ${streak > 1 ? `${streak} in a row${best === streak ? ', your best yet.' : '.'}` : 'One more?'}`;
      } else {
        streak = 0;
        streakEl.textContent = streak;
        result.className = 'try-result lose';
        result.innerHTML = `<b>${NAMES[outcome]} instead, ${pct}.</b>You picked ${NAMES[choice]}.${best ? ` Your best streak is ${best}.` : ''}`;
      }
      save();
      again.hidden = false;
      again.focus({ preventScroll: true });
    });
  }

  picks.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pick]');
    if (b && !b.disabled) play(b.dataset.pick, b);
  });
  again.addEventListener('click', reset);
  reset();
  if (best) result.textContent = `Pick an outcome. Your best streak is ${best}.`;
}

// ------------------------------------------------------------------ Data

const cache = new Map();
const STORE_PREFIX = 'fp:cg:';
const STORE_TTL = 10 * 60_000;

/** Reads a previous response so repeat visits show numbers immediately. */
function readStore(path) {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + path);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    return Date.now() - entry.t < STORE_TTL ? entry : null;
  } catch {
    return null;
  }
}

function writeStore(path, entry) {
  try {
    localStorage.setItem(STORE_PREFIX + path, JSON.stringify(entry));
  } catch {
    /* private mode or quota: caching is optional */
  }
}

async function cg(path, ttl = REFRESH_MS) {
  const hit = cache.get(path) ?? readStore(path);
  if (hit) cache.set(path, hit);
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  const res = await fetch(`/api/market-data?path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(12_000) });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.message ?? `Data service error ${res.status}`);
  const entry = {
    t: Date.now(),
    data: payload.data,
    updatedAt: Number(payload.updatedAt) || Date.now(),
    stale: Boolean(payload.stale),
  };
  cache.set(path, entry);
  writeStore(path, entry);
  return entry.data;
}

/** Cached copy if one exists, however old. Used when the network fails. */
function staleData(path) {
  return (cache.get(path) ?? readStore(path))?.data ?? null;
}

async function loadExchanges() {
  const listPath = '/exchanges?per_page=100&page=1';
  const pricePath = '/simple/price?ids=bitcoin&vs_currencies=usd';
  const [list, price] = await Promise.allSettled([cg(listPath), cg(pricePath)]);
  const rows = list.status === 'fulfilled' && Array.isArray(list.value) ? list.value : staleData(listPath);
  const priceData = price.status === 'fulfilled' ? price.value : staleData(pricePath);
  const live = Array.isArray(rows);
  const btcUsd = priceData?.bitcoin?.usd ?? null;
  const byId = new Map(live ? rows.map((x) => [x.id, x]) : []);
  const freshness = cache.get(listPath) ?? readStore(listPath);

  state.btcUsd = btcUsd;
  state.live = live;
  state.stale = Boolean(live && (list.status !== 'fulfilled' || freshness?.stale));
  state.updatedAt = freshness?.updatedAt ?? freshness?.t ?? state.updatedAt ?? Date.now();
  state.list = EXCHANGES.map((ex) => {
    const row = byId.get(ex.cg);
    const available = ex.liveData && Boolean(row);
    const volBtc = available ? (row?.trade_volume_24h_btc ?? null) : null;
    return {
      ...ex,
      country: available ? (row?.country ?? null) : null,
      founded: available ? (row?.year_established ?? ex.founded) : ex.founded,
      trust: available ? (row?.trust_score ?? null) : null,
      volumeUsd: volBtc !== null && btcUsd ? volBtc * btcUsd : null,
      // Prefer CoinGecko's current image, but retain a permanent branded fallback.
      logo: available ? (safeImageUrl(row?.image) ?? ex.logo) : ex.logo,
    };
  });
}

// ------------------------------------------------------------------ Landing

function initLanding() {
  const grid = $('#landing-exchanges');
  if (grid) {
    grid.innerHTML = EXCHANGES.slice(0, 10)
      .map(
        (ex, i) => `
        <a class="ex-tile reveal" data-delay="${i * 40}" href="#/app/exchange/${ex.id}">
          ${exchangeMark(ex)}
          <span><b>${esc(ex.name)}</b><small>${ex.liveData ? 'Live exchange data' : 'Data feed coming soon'}</small></span>
        </a>`,
      )
      .join('');
  }

  $$('[data-config]').forEach((el) => {
    const key = el.dataset.config;
    const url = safeUrl(key === 'waitlist' ? CONFIG.waitlistUrl : CONFIG.links?.[key]);
    if (url) {
      el.href = url;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
      el.hidden = false;
    }
  });

  buildTicker();
  heroMarket();
  practiceMarket();
  autoHideNav();
  watchReveals();
  watchCounters();
  $$('.magnetic').forEach(magnetic);
  $$('.tilt').forEach(spotlight);
  const card = $('.hero-market');
  if (card) parallaxCard(card);
  requestAnimationFrame(() => document.body.classList.add('is-loaded'));
}

// ------------------------------------------------------------------ Router

function parseRoute() {
  const h = location.hash;
  if (!h.startsWith('#/app')) return { view: 'landing', anchor: h.slice(1) };
  const parts = h.replace(/^#\/app\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'exchange' && parts[1]) return { view: 'app', tab: 'exchanges', exchange: decodeURIComponent(parts[1]) };
  if (parts[0] === 'predictions') return { view: 'app', tab: 'predictions' };
  if (parts[0] === 'radar') return { view: 'app', tab: 'radar' };
  return { view: 'app', tab: 'exchanges' };
}

let lastView = null;
async function onRoute() {
  const r = parseRoute();
  const switched = r.view !== lastView;
  lastView = r.view;
  document.body.dataset.view = r.view;
  $('#app').hidden = r.view !== 'app';

  if (r.view === 'landing') {
    stopRefresh();
    document.title = 'Firstprint: predict the first 72 hours of new token listings';
    if (r.anchor && r.anchor !== 'top') {
      const target = document.getElementById(r.anchor);
      if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: switched ? 'auto' : 'smooth' }));
    } else if (switched) {
      window.scrollTo(0, 0);
    }
    return;
  }

  renderAppShell(r);
  window.scrollTo(0, 0);
  if (r.tab === 'exchanges' && r.exchange) return renderExchangeDetail(r.exchange);
  if (r.tab === 'exchanges') return renderExchanges();
  if (r.tab === 'predictions') return renderPredictionsSoon();
  if (r.tab === 'radar') return renderRadarSoon();
}

// ------------------------------------------------------------------ App shell

function renderAppShell(r) {
  const cur = (tab) => (r.tab === tab ? ' aria-current="page"' : '');
  $('#app').innerHTML = `
    <header class="app-bar">
      <div class="wrap app-bar-inner">
        <a class="wordmark" href="#top" aria-label="Firstprint home"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>Firstprint</a>
        <nav class="app-tabs" aria-label="App">
          <a href="#/app/exchanges"${cur('exchanges')}>Exchanges</a>
          <a href="/beta/">Predictions <span class="soon">Beta</span></a>
          <a href="#/app/radar"${cur('radar')}>Listing radar <span class="soon">Soon</span></a>
        </nav>
        <a class="btn" href="/beta/">Connect wallet <span class="soon">Beta</span></a>
      </div>
    </header>
    <main class="wrap app-main" id="app-main" tabindex="-1"></main>`;
}

// ------------------------------------------------------------------ Exchanges

function sortedRows() {
  const q = state.search.trim().toLowerCase();
  const rows = (state.list ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || (r.country ?? '').toLowerCase().includes(q));
  const by = {
    volume: (a, b) => (b.volumeUsd ?? -1) - (a.volumeUsd ?? -1),
    trust: (a, b) => (b.trust ?? -1) - (a.trust ?? -1) || (b.volumeUsd ?? -1) - (a.volumeUsd ?? -1),
    name: (a, b) => a.name.localeCompare(b.name),
  }[state.sort];
  return rows.sort(by);
}

function dataNote() {
  if (state.stale) {
    return `<p class="data-note offline"><span class="dot-live" aria-hidden="true"></span>Cached CoinGecko data, updated <span data-ago="${state.updatedAt}">${ago(state.updatedAt)}</span>. <button class="btn" data-action="retry" style="padding:3px 12px;font-size:13px">Refresh</button></p>`;
  }
  if (state.live) {
    return `<p class="data-note"><span class="dot-live" aria-hidden="true"></span>Live from CoinGecko, updated <span data-ago="${state.updatedAt}">${ago(state.updatedAt)}</span></p>`;
  }
  return `<p class="data-note offline"><span class="dot-live" aria-hidden="true"></span>Live data couldn’t load. Showing basic details. <button class="btn" data-action="retry" style="padding:3px 12px;font-size:13px">Try again</button></p>`;
}

function exchangesTable(animate = false) {
  const rows = sortedRows();
  if (!rows.length) return `<div class="empty">No exchanges match “${esc(state.search)}”.</div>`;
  return `
    <div class="table-scroll">
      <table class="ex-table">
        <thead><tr>
          <th class="rank hide-sm">#</th>
          <th>Exchange</th>
          <th class="right">24h volume</th>
          <th class="hide-sm">Trust score</th>
          <th class="right hide-sm">Founded</th>
          <th class="right hide-sm">Data feed</th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (r, i) => `
            <tr data-href="#/app/exchange/${r.id}"${animate && !REDUCED ? ` class="row-in" style="animation-delay:${Math.min(i * 35, 500)}ms"` : ''}>
              <td class="rank hide-sm">${i + 1}</td>
              <td><a class="ex-name" href="#/app/exchange/${r.id}">${exchangeMark(r)}<span><b>${esc(r.name)}</b><small>${esc(r.country ?? '')}</small></span></a></td>
              <td class="right num">${state.live ? usd(r.volumeUsd) : '–'}</td>
              <td class="hide-sm">${r.trust !== null ? `<span class="trust"><span class="trust-bar" style="--t:${Number(r.trust)}"><i></i></span>${Number(r.trust)}/10</span>` : '<span class="muted">–</span>'}</td>
              <td class="right hide-sm">${esc(r.founded ?? '–')}</td>
              <td class="right hide-sm">${r.liveData ? '<span class="radar-pill on">Live</span>' : '<span class="radar-pill off">Soon</span>'}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function renderExchangesBody(animate = false) {
  if (!$('#ex-body')) return;
  const total = state.live ? state.list.reduce((s, r) => s + (r.volumeUsd ?? 0), 0) : null;
  $('#ex-note').innerHTML = dataNote();
  $('#ex-stats').innerHTML = `
    <div><dt>Exchanges</dt><dd>${EXCHANGES.length}</dd></div>
    <div><dt>Combined 24h volume</dt><dd>${total ? usd(total) : '–'}</dd></div>
    <div><dt>Bitcoin price</dt><dd>${state.btcUsd ? usd(state.btcUsd, false).replace(/\.\d+$/, '') : '–'}</dd></div>
    <div><dt>Live data feeds</dt><dd>${EXCHANGES.filter((e) => e.liveData).length}</dd></div>`;
  $('#ex-body').innerHTML = exchangesTable(animate);
}

/** Coins people are searching for right now, from CoinGecko's trending list. */
async function renderTrending() {
  const box = $('#trending');
  if (!box) return;
  try {
    const d = await cg('/search/trending', 5 * 60_000);
    const coins = (d?.coins ?? []).slice(0, 10).map((c) => c.item).filter(Boolean);
    if (!coins.length) return box.remove();
    box.innerHTML = `
      <div class="trending-head">
        <h2>Trending searches</h2>
        <span class="muted" style="font-size:13.5px">Most searched on CoinGecko in the last 24 hours</span>
      </div>
      <div class="trend-row">
        ${coins
          .map(
            (c, i) => `
          <article class="trend-card"${REDUCED ? '' : ` style="animation-delay:${i * 45}ms"`}>
            <span class="trend-rank">#${i + 1}</span>
            <b class="trend-sym">${esc((c.symbol ?? '').toUpperCase())}</b>
            <span class="trend-name">${esc(c.name ?? '')}</span>
            <span class="trend-cap">${c.market_cap_rank ? `Market cap rank ${c.market_cap_rank}` : 'Unranked'}</span>
          </article>`,
          )
          .join('')}
      </div>`;
  } catch {
    box.remove();
  }
}

async function renderExchanges() {
  document.title = 'Exchanges: Firstprint';
  $('#app-main').innerHTML = `
    <h1 class="page-title">Exchanges</h1>
    <p class="page-lede">Live 24-hour volume, trust scores, and traded pairs for Binance, Bybit, and MEXC. More exchanges are clearly marked Soon.</p>
    <section class="trending" id="trending" aria-label="Trending coins"></section>
    <dl class="summary-stats" id="ex-stats"></dl>
    <div class="toolbar">
      <div class="toolbar-left">
        <input class="input" id="ex-search" type="search" placeholder="Search exchanges" aria-label="Search exchanges" value="${esc(state.search)}" />
        <select class="select" id="ex-sort" aria-label="Sort exchanges">
          <option value="volume"${state.sort === 'volume' ? ' selected' : ''}>Highest volume</option>
          <option value="trust"${state.sort === 'trust' ? ' selected' : ''}>Trust score</option>
          <option value="name"${state.sort === 'name' ? ' selected' : ''}>Name</option>
        </select>
      </div>
      <div id="ex-note"></div>
    </div>
    <div id="ex-body"><p class="muted">Loading live exchange data</p></div>`;

  if (!state.list) {
    state.list = EXCHANGES.map((ex) => ({ ...ex, country: null, trust: null, volumeUsd: null }));
    try {
      await loadExchanges();
    } catch {
      state.live = false;
    }
  }
  renderExchangesBody(true);
  startRefresh();
  renderTrending();
}

function startRefresh() {
  stopRefresh();
  state.timer = setInterval(async () => {
    if (document.hidden) return;
    const r = parseRoute();
    if (r.view !== 'app' || r.tab !== 'exchanges' || r.exchange) return;
    try {
      await loadExchanges();
      renderExchangesBody();
    } catch {
      /* keep the last good data */
    }
  }, REFRESH_MS);
}

function stopRefresh() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// ------------------------------------------------------------------ Exchange detail

async function renderExchangeDetail(id) {
  const ex = EXCHANGES.find((e) => e.id === id);
  const main = $('#app-main');
  if (!ex) {
    main.innerHTML = `<a class="back" href="#/app/exchanges">All exchanges</a><div class="empty">We don’t cover that exchange yet.</div>`;
    return;
  }
  if (!ex.liveData) {
    document.title = `${ex.name}: coming soon on Firstprint`;
    const site = safeUrl(ex.url);
    main.innerHTML = `
      <a class="back" href="#/app/exchanges">← All exchanges</a>
      <div class="detail-head">
        ${exchangeMark(ex, `${ex.name} logo`)}
        <div><span class="radar-pill off">Soon</span><h1 class="page-title">${esc(ex.name)}</h1><p class="muted">This live data feed is not enabled in the public beta yet.</p></div>
        <div class="actions">${site ? `<a class="btn magnetic" href="${site}" target="_blank" rel="noopener noreferrer">Visit website</a>` : ''}</div>
      </div>
      <section class="panel"><div class="panel-box"><p>Firstprint is starting with three reliable live feeds: Binance, Bybit, and MEXC.</p><p><a class="btn btn-solid magnetic" href="#/app/exchanges">View live exchanges</a></p></div></section>`;
    $$('.magnetic', main).forEach(magnetic);
    return;
  }
  document.title = `${ex.name}: Firstprint`;
  const site = safeUrl(ex.url);
  main.innerHTML = `
    <a class="back" href="#/app/exchanges">← All exchanges</a>
    <div class="detail-head">
      ${exchangeMark(ex, `${ex.name} logo`)}
      <div><h1 class="page-title">${esc(ex.name)}</h1><p class="muted" id="ex-meta">Founded ${esc(ex.founded)}</p></div>
      <div class="actions">${site ? `<a class="btn magnetic" href="${site}" target="_blank" rel="noopener noreferrer">Visit website</a>` : ''}</div>
    </div>
    <dl class="detail-stats" id="detail-stats">
      <div><dt>24h volume</dt><dd><span class="skeleton"></span></dd></div>
      <div><dt>Trust score</dt><dd><span class="skeleton"></span></dd></div>
      <div><dt>Founded</dt><dd>${esc(ex.founded)}</dd></div>
      <div><dt>Pairs in top list</dt><dd><span class="skeleton"></span></dd></div>
    </dl>
    <div class="detail-cols">
      <section class="panel">
        <h2>Most traded pairs</h2>
        <div id="pairs"><p class="muted">Loading live pairs</p></div>
      </section>
      <aside>
        <section class="panel">
          <h2>Listing radar</h2>
          <div class="panel-box">
            ${
              ex.radar.length
                ? `<p>Firstprint will track new ${esc(ex.name)} listings from day one using:</p><ul class="check-list">${ex.radar.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
                : `<p>Listing tracking for ${esc(ex.name)} is planned after launch.</p>`
            }
            <p class="muted">The listing radar is coming soon.</p>
          </div>
        </section>
        <section class="panel">
          <h2>Prediction markets</h2>
          <div class="panel-box">
            <p>Try a simulated 72-hour prediction with free points saved to your wallet-authenticated profile.</p>
            <p><a class="btn magnetic" href="/beta/">Open wallet beta</a></p>
          </div>
        </section>
      </aside>
    </div>`;
  $$('.magnetic', main).forEach(magnetic);

  try {
    const d = state.detail.get(ex.id) ?? (await cg(`/exchanges/${encodeURIComponent(ex.cg)}`));
    state.detail.set(ex.id, d);
    if (parseRoute().exchange !== id) return;
    const btc = state.btcUsd ?? (await cg('/simple/price?ids=bitcoin&vs_currencies=usd').then((p) => p?.bitcoin?.usd).catch(() => null));
    const volUsd = d.trade_volume_24h_btc && btc ? d.trade_volume_24h_btc * btc : null;
    const meta = [d.country, `founded ${d.year_established ?? ex.founded}`].filter(Boolean).join(', ');
    $('#ex-meta').textContent = meta.charAt(0).toUpperCase() + meta.slice(1);

    const tickers = Array.isArray(d.tickers) ? d.tickers : [];
    $('#detail-stats').innerHTML = `
      <div><dt>24h volume</dt><dd>${usd(volUsd)}</dd></div>
      <div><dt>Trust score</dt><dd>${d.trust_score ?? '–'}${d.trust_score ? '<span class="muted" style="font-size:16px">/10</span>' : ''}</dd></div>
      <div><dt>Founded</dt><dd>${esc(d.year_established ?? ex.founded)}</dd></div>
      <div><dt>Pairs in top list</dt><dd>${tickers.length || '–'}</dd></div>`;

    const top = [...tickers]
      .filter((t) => t?.converted_volume?.usd)
      .sort((a, b) => b.converted_volume.usd - a.converted_volume.usd)
      .slice(0, 15);
    $('#pairs').innerHTML = top.length
      ? `<div class="table-scroll"><table class="ex-table pairs">
          <thead><tr><th>Pair</th><th class="right">Price</th><th class="right">24h volume</th><th class="right hide-sm">Spread</th></tr></thead>
          <tbody>${top
            .map((t, i) => {
              const link = safeUrl(t.trade_url);
              const pair = `${esc(t.base)}/${esc(t.target)}`;
              return `<tr${REDUCED ? '' : ` class="row-in" style="animation-delay:${Math.min(i * 30, 400)}ms"`}>
                <td>${link ? `<a href="${link}" target="_blank" rel="noopener noreferrer"><b>${pair}</b></a>` : `<b>${pair}</b>`}</td>
                <td class="right num">${usd(t.converted_last?.usd, false)}</td>
                <td class="right num">${usd(t.converted_volume?.usd)}</td>
                <td class="right hide-sm">${Number.isFinite(t.bid_ask_spread_percentage) ? `${t.bid_ask_spread_percentage.toFixed(2)}%` : '–'}</td>
              </tr>`;
            })
            .join('')}</tbody></table></div>
          <p class="muted" style="margin-top:12px;font-size:14px">Live from CoinGecko. Pair links open ${esc(ex.name)}.</p>`
      : '<div class="empty">No pair data available right now.</div>';
  } catch (err) {
    $$('.skeleton', $('#detail-stats')).forEach((s) => (s.outerHTML = '–'));
    $('#pairs').innerHTML = `<div class="empty">Live pair data couldn’t load (${esc(err.message)}). <button class="btn" data-action="retry">Try again</button></div>`;
  }
}

// ------------------------------------------------------------------ Coming soon

function followLinks() {
  const out = [
    ['Join the waitlist', CONFIG.waitlistUrl, true],
    ['Follow on X', CONFIG.links?.x],
    ['Join Telegram', CONFIG.links?.telegram],
    ['Join Discord', CONFIG.links?.discord],
  ]
    .map(([label, url, solid]) => {
      const safe = safeUrl(url);
      return safe ? `<a class="btn magnetic${solid ? ' btn-solid' : ''}" href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>` : '';
    })
    .join('');
  return out || '<a class="btn btn-solid magnetic" href="#/app/exchanges">Explore exchanges</a>';
}

function renderPredictionsSoon() {
  document.title = 'Practice predictions: Firstprint';
  $('#app-main').innerHTML = `
    <section class="soon-page">
      <div>
        <span class="soon soon-badge">Practice beta live</span>
        <h1>Test the first<br />72 hours now.</h1>
        <p class="lede">Sign in with a Solana wallet and use free persistent points to call Crash, Down, Flat, Up, or Moon in a simulated market.</p>
        <ul class="check-list">
          <li>Start immediately with 1,000 points</li>
          <li>Claim 100 practice points daily</li>
          <li>Test predictions, settlement, and leaderboards</li>
          <li>No deposits, transactions, or real money</li>
        </ul>
        <div class="hero-actions"><a class="btn btn-solid magnetic" href="/beta/">Open wallet beta</a><a class="btn magnetic" href="#/app/exchanges">Explore exchanges</a></div>
      </div>
      <div class="preview-card" aria-label="Preview of a prediction market">
        <div class="hm-head">
          <div><span class="chip">Preview</span><p class="hm-title"><b>NOVA</b><span>Lists in 2 hours</span></p></div>
          <div class="hm-clock"><span class="muted">Your pick</span><b style="color:var(--up)">Up</b></div>
        </div>
        <p class="hm-question">Where will NOVA trade 72 hours after listing?</p>
        <ol class="hm-ladder">
          <li style="--c: var(--moon); --share: 18%"><b>Moon</b><span>+50% or better</span><em>18%</em></li>
          <li style="--c: var(--up); --share: 31%" class="won"><b>Up</b><span>+10% to +50%</span><em>31%</em></li>
          <li style="--c: var(--flat); --share: 22%"><b>Flat</b><span>−10% to +10%</span><em>22%</em></li>
          <li style="--c: var(--down); --share: 19%"><b>Down</b><span>−50% to −10%</span><em>19%</em></li>
          <li style="--c: var(--crash); --share: 10%"><b>Crash</b><span>−50% or worse</span><em>10%</em></li>
        </ol>
      </div>
    </section>`;
  $$('.magnetic').forEach(magnetic);
}

function renderRadarSoon() {
  document.title = 'Listing radar: coming soon on Firstprint';
  const tracked = EXCHANGES.filter((e) => e.radar.length);
  $('#app-main').innerHTML = `
    <section class="soon-page">
      <div>
        <span class="soon soon-badge">Coming soon</span>
        <h1>Every listing,<br />as it’s announced.</h1>
        <p class="lede">The radar watches exchange announcements and new trading pairs, then shows each upcoming listing with its trading start time.</p>
        <p class="muted" style="margin-bottom:10px">Tracking at launch</p>
        <ul class="check-list">${tracked.map((e) => `<li>${esc(e.name)}: ${esc(e.radar.join(', ').toLowerCase())}</li>`).join('')}</ul>
        <div class="hero-actions">${followLinks()}</div>
      </div>
      <div class="preview-card" aria-label="Preview of the listing radar">
        <span class="chip">Preview</span>
        <ul class="radar-preview blur-rows" aria-hidden="true">
          <li><b>NOVA</b><span>in 5h 12m</span><small>Announcement, new spot listing</small></li>
          <li><b>ARCO</b><span>in 1d 5h</span><small>Announcement, new spot listing</small></li>
          <li><b>TIDE</b><span>in 1d 19h</span><small>New trading pair detected</small></li>
          <li><b>MOSS</b><span>in 2d 3h</span><small>Announcement, new spot listing</small></li>
        </ul>
      </div>
    </section>`;
  $$('.magnetic').forEach(magnetic);
}

// ------------------------------------------------------------------ Events

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'wallet-soon') return toast('Wallet sign-in arrives with predictions. Coming soon.');
  if (action === 'retry') {
    cache.clear();
    state.list = null;
    state.detail.clear();
    return onRoute();
  }
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a')) location.hash = row.dataset.href;
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'ex-search') {
    state.search = e.target.value;
    $('#ex-body').innerHTML = exchangesTable();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'ex-sort') {
    state.sort = e.target.value;
    $('#ex-body').innerHTML = exchangesTable(true);
  }
});

setInterval(() => {
  if (document.hidden) return;
  $$('[data-ago]').forEach((el) => (el.textContent = ago(Number(el.dataset.ago))));
}, 5_000);

window.addEventListener('hashchange', onRoute);
initLanding();
onRoute();
