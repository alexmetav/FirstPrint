// Firstprint website: the landing page, its animated example market and the practice market.
// The prediction app itself lives at /app/ (web/).

const CONFIG = window.FIRSTPRINT_CONFIG ?? { links: {} };
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ Helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
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
  if (REDUCED) return (el.textContent = `${to.toLocaleString('en-US')}${suffix}`);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = `${Math.round(easeOut(t) * to).toLocaleString('en-US')}${suffix}`;
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
 * The example market plays its own life: predictions build, predictions close,
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
    sub.textContent = 'Newly listed token';
    clockLabel.textContent = 'Closes in';
    clock.textContent = '02:14:09';
    clock.style.color = '';
    foot.textContent = 'Share of the pool on each outcome';
    setShares([0, 0, 0, 0, 0]);

    at(300, () => setShares(r.shares));

    at(3400, () => {
      phase.textContent = 'Predictions closed';
      sub.textContent = 'Waiting for the final price';
      clockLabel.textContent = 'Result in';
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
    subEl.textContent = 'Made-up token, random result';
    question.textContent = `Where will ${sym} land at the result?`;
    chip.textContent = 'Practice market';
  }

  function play(choice, button) {
    picks.classList.add('locked');
    chart.classList.remove('idle');
    buttons.forEach((b) => (b.disabled = true));
    button.setAttribute('aria-checked', 'true');
    chip.textContent = 'Predictions closed';
    subEl.textContent = 'Waiting for the final price';
    result.textContent = 'Playing out the market…';

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


// ------------------------------------------------------------------ Landing

function initLanding() {
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

/**
 * Links from when the app lived at the site root (shared markets, the admin page, portfolio)
 * go to the same page in the app, wherever the "Launch app" button points. Links to the
 * old exchange explorer (#/app/...) just open the landing page.
 */
function redirectOldAppLinks() {
  const home = document.querySelector('[data-app-home]')?.getAttribute('href');
  if (home && /^#\/(market\/|leaderboard|portfolio|dashboard|admin|radar)/.test(location.hash)) {
    location.replace(home + location.hash);
    return true;
  }
  if (location.hash.startsWith('#/app')) history.replaceState(null, '', location.pathname + location.search);
  return false;
}

window.addEventListener('hashchange', redirectOldAppLinks);
if (!redirectOldAppLinks()) initLanding();
