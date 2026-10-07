// Shared motion helpers and Firstprint UI pieces for the launch videos.
// Every visual state is a pure function of time t (seconds), so each frame renders exactly.
import { ico, OUTCOME_ICONS } from './icons.js';
export { ico };

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, k) => a + (b - a) * k;
/** 0→1 progress of t between a and b. */
export const p = (t, a, b) => clamp((t - a) / (b - a));
export const ease = {
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  out: (k) => 1 - Math.pow(1 - k, 3),
  outQuint: (k) => 1 - Math.pow(1 - k, 5),
  in: (k) => k * k * k,
  // A small settle past the target, then back (for pops).
  back: (k) => {
    const c1 = 1.4, c3 = c1 + 1;
    return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
  },
  smooth: (k) => k * k * (3 - 2 * k),
};
export const ep = (t, a, b, e = ease.inOut) => e(p(t, a, b));

/** Keyframes [[time, value], ...] of numbers or flat objects of numbers, eased between keys. */
export function keys(t, frames, e = ease.inOut) {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [t1, v1] = frames[i];
    const [t0, v0] = frames[i - 1];
    if (t <= t1) {
      const k = e((t - t0) / (t1 - t0));
      if (typeof v0 === 'number') return lerp(v0, v1, k);
      const o = {};
      for (const key of Object.keys(v0)) o[key] = lerp(v0[key], v1[key], k);
      return o;
    }
  }
  return frames[frames.length - 1][1];
}

/** Deterministic random numbers (so every render of a frame is identical). */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const fmt = (n) => Math.round(n).toLocaleString('en-US');

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** The stage: a camera-driven world layer plus a fixed overlay for captions. */
/** Frame height (1920 vertical, 1080 square) and camera tweaks for the square cut. */
export const H = Number(globalThis.STAGE_H) || 1920;
// Read on every frame, so the square cut can set them after the video module loads.
const zmul = () => Number(globalThis.ZMUL) || 1;
const yoff = () => Number(globalThis.YOFF) || 0;
/** Scales a y position designed for the 1920-tall frame to this frame. */
export const sy = (y) => Math.round((y * H) / 1920);

export function stage() {
  const root = $('#stage');
  const world = el('<div id="world"></div>');
  const overlay = el(`<div class="layer" style="z-index:30;height:${H}px"></div>`);
  root.append(world, overlay);
  return {
    root,
    world,
    overlay,
    /** Camera looks at (x, y) of the world with zoom z, optional rotation in degrees. */
    camera(x, y, z = 1, rot = 0) {
      world.style.transform = `translate(540px, ${H / 2}px) rotate(${rot}deg) scale(${z * zmul()}) translate(${-x}px, ${-(y + yoff())}px)`;
    },
    add(node, layer = 'world') {
      (layer === 'world' ? world : overlay).append(node);
      return node;
    },
  };
}

export function setT(node, { x = 0, y = 0, s = 1, o = 1, r = 0 } = {}) {
  node.style.transform = `translate(${x}px, ${y}px) rotate(${r}deg) scale(${s})`;
  node.style.opacity = String(o);
}

/**
 * A caption: lines slide up out of a mask, staggered, then leave upwards. Each entry is
 * [text, className]. Returns render(t).
 */
export function caption(s, { top, lines, inAt, outAt, stagger = 0.09, layer = 'overlay', align = 'left' }) {
  const node = el(`<div class="cap" style="top:${sy(top) - (H < 1920 ? 40 : 0)}px;text-align:${align}">${lines
    .map(([txt, cls]) => `<span class="ln ${cls}"><span>${txt}</span></span>`)
    .join('')}</div>`);
  s.add(node, layer);
  const inner = [...node.querySelectorAll('.ln > span')];
  return (t) => {
    inner.forEach((sp, i) => {
      const a = ep(t, inAt + i * stagger, inAt + i * stagger + 0.7, ease.outQuint);
      const b = outAt == null ? 0 : ep(t, outAt + i * 0.05, outAt + i * 0.05 + 0.5, ease.in);
      sp.style.transform = `translateY(${(1 - a) * 110 - b * 110}%)`;
      sp.style.opacity = String(Math.min(a, 1 - b));
    });
  };
}

/** A dark fade at the top of the frame so captions read cleanly over the UI. */
export function scrim(s, { inAt, outAt, height = 700 }) {
  const node = s.add(el(`<div class="abs" style="left:0;top:0;width:1080px;height:${sy(height)}px;background:linear-gradient(180deg,#09090b 0%,#09090b 62%,rgba(9,9,11,0) 100%);pointer-events:none"></div>`), 'overlay');
  return (t) => {
    node.style.opacity = String(Math.min(ep(t, inAt - 0.2, inAt + 0.3), 1 - ep(t, outAt, outAt + 0.5)));
  };
}

/** A press ripple at (x, y) in world space at time `at`. */
export function tap(s, x, y, at, layer = 'world') {
  const node = s.add(el('<div class="tap"></div>'), layer);
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  return (t) => {
    const k = p(t, at - 0.18, at + 0.55);
    if (k <= 0 || k >= 1) return (node.style.opacity = '0');
    const press = p(t, at - 0.18, at);
    const release = p(t, at, at + 0.55);
    const sc = release > 0 ? lerp(0.8, 1.7, ease.out(release)) : lerp(1.1, 0.8, ease.out(press));
    node.style.transform = `scale(${sc})`;
    node.style.opacity = String(release > 0 ? 1 - ease.out(release) : ease.out(press) * 0.95);
  };
}

/** Press feedback on a node: a quick scale dip around `at`. */
export function pressScale(t, at) {
  const d = p(t, at - 0.12, at) * (1 - p(t, at, at + 0.3));
  return 1 - 0.05 * ease.smooth(d);
}

/** Coins spraying from (sx, sy) and sweeping into (ex, ey), in the given layer. */
export function coins(s, { from, to, at, count = 12, seed = 7, layer = 'overlay', dur = 0.95 }) {
  const r = rng(seed);
  const list = Array.from({ length: count }, (_, i) => {
    const node = s.add(el('<i class="coin"></i>'), layer);
    const a = -Math.PI / 2 + (r() - 0.5) * 2.2;
    const burst = 90 + r() * 120;
    return { node, delay: i * 0.045, a, burst, bend: (r() - 0.5) * 260, lift: 80 + r() * 140, size: 0.8 + r() * 0.4 };
  });
  return (t) => {
    const [sx, sy] = typeof from === 'function' ? from(t) : from;
    const [ex, ey] = typeof to === 'function' ? to(t) : to;
    for (const c of list) {
      const k = p(t, at + c.delay, at + c.delay + dur);
      if (k <= 0 || k >= 1) {
        c.node.style.opacity = '0';
        continue;
      }
      const bx = sx + Math.cos(c.a) * c.burst;
      const by = sy + Math.sin(c.a) * c.burst;
      let x, y, sc;
      if (k < 0.28) {
        const q = ease.out(k / 0.28);
        x = lerp(sx, bx, q);
        y = lerp(sy, by, q);
        sc = lerp(0.2, c.size, q);
      } else {
        const q = ease.inOut((k - 0.28) / 0.72);
        const kx = (bx + ex) / 2 + c.bend;
        const ky = Math.min(by, ey) - c.lift;
        x = (1 - q) ** 2 * bx + 2 * (1 - q) * q * kx + q * q * ex;
        y = (1 - q) ** 2 * by + 2 * (1 - q) * q * ky + q * q * ey;
        sc = c.size * (1 - q * 0.55);
      }
      c.node.style.opacity = '1';
      c.node.style.transform = `translate(${x}px, ${y}px) scale(${sc}) rotateY(${k * 900}deg)`;
    }
  };
}

// --- Firstprint UI pieces -------------------------------------------------------------

export const OUTCOMES = [
  { b: 'moon', name: 'Moon', c: 'var(--moon)', range: '+50% or better' },
  { b: 'up', name: 'Up', c: 'var(--up)', range: '+10% to +50%' },
  { b: 'flat', name: 'Flat', c: 'var(--flat)', range: '−10% to +10%' },
  { b: 'down', name: 'Down', c: 'var(--down)', range: '−50% to −10%' },
  { b: 'crash', name: 'Crash', c: 'var(--crash)', range: '−50% or worse' },
];

export const oIcon = (b) => ico(OUTCOME_ICONS[b]);

export function logo(size = 32) {
  const k = size / 32;
  return `<span class="mark" style="transform:scale(${k});transform-origin:0 0;margin-right:${size - 32}px;margin-bottom:${size - 32}px"><i></i><i></i><i></i><i></i><i></i></span>`;
}

/** The big logo: five bars that can be drawn in one by one. */
export function bigMark(size) {
  const k = size / 32;
  return el(`<div class="abs" style="width:${size}px;height:${size}px;border-radius:${9 * k}px;background:#111114;box-shadow:inset 0 0 0 ${Math.max(1, k)}px #35353e;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${2.5 * k}px">
    ${[20, 15, 10, 15, 20].map((w, i) => `<i data-bar="${i}" style="display:block;height:${3 * k}px;width:${w * k}px;border-radius:${2 * k}px;background:${['var(--moon)', 'var(--up)', 'var(--flat)', 'var(--down)', 'var(--crash)'][i]};transform-origin:center"></i>`).join('')}
  </div>`);
}

/** Outcome rows (with crowd bars). Returns { node, rows }. */
export function outcomeRows(pcts) {
  const node = el(`<div>${OUTCOMES.map(
    (o, i) => `<div class="row" data-b="${o.b}" style="--c:${o.c}"><i class="bar"></i><span class="nm">${oIcon(o.b)}<span>${o.name}</span><span class="you"></span></span><span class="rg">${o.range}</span><span class="pc">${pcts[i]}%</span></div>`,
  ).join('')}</div>`);
  return { node, rows: [...node.querySelectorAll('.row')] };
}

/** A market card like the app's featured card. */
export function marketCard({ sym = 'PEAK', name = 'Peak', letter = 'P', pcts = [13, 46, 24, 11, 6], status = 'open', width = 920 } = {}) {
  const node = el(`<div class="card" style="width:${width}px;overflow:hidden">
    <div style="padding:44px 44px 34px">
      <div style="display:flex;align-items:center;gap:16px" class="eyebrow">
        ${status === 'open' ? '<span class="pill pill-open"><i class="dot"></i>Open</span>' : '<span class="pill pill-gold">' + ico('clock') + 'Result soon</span>'}
        <span style="font-size:24px">· Trending #1</span>
      </div>
      <div style="display:flex;align-items:center;gap:26px;margin-top:30px">
        <div class="avatar" style="width:116px;height:116px;font-size:52px">${letter}</div>
        <div><div style="font-size:72px;font-weight:600;letter-spacing:-0.03em;line-height:1">${sym}</div><div class="muted" style="font-size:30px;margin-top:8px">${name}</div></div>
      </div>
      <p style="margin-top:30px;font-size:36px;line-height:1.4;color:#d4d4d8">Where will ${sym} be priced at the result, compared with its price when predictions close?</p>
      <div style="display:flex;gap:56px;margin-top:30px">
        <div><div class="eyebrow" style="font-size:22px">Closes</div><div class="mono cd-close" style="font-size:38px;margin-top:8px">Oct 9</div></div>
        <div><div class="eyebrow" style="font-size:22px">Result</div><div class="mono" style="font-size:38px;margin-top:8px">Oct 16</div></div>
        <div><div class="eyebrow" style="font-size:22px">Pool</div><div class="mono pool" style="font-size:38px;margin-top:8px">760 pts</div></div>
      </div>
    </div>
    <div class="rows-head" style="display:flex;justify-content:space-between;padding:22px 40px 16px" ><span class="eyebrow" style="font-size:22px">Outcomes</span><span class="eyebrow" style="font-size:22px">Crowd</span></div>
  </div>`);
  const { node: rowsNode, rows } = outcomeRows(pcts);
  node.append(rowsNode);
  return { node, rows };
}

export function pointsChip(value) {
  return el(`<div class="chip points-chip">${ico('coins')}<span class="v">${fmt(value)}</span><span class="muted" style="font-size:26px">pts</span></div>`);
}

/** End card: logo, URL and the testnet line. */
export function endCard(s, at) {
  const node = s.add(
    el(`<div class="abs" style="left:0;top:0;width:1080px;height:${H}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px;opacity:0">
      <div style="display:inline-flex;align-items:center;gap:14px;height:56px;padding:0 26px;border-radius:999px;background:rgba(48,209,88,0.1);box-shadow:inset 0 0 0 1.5px rgba(48,209,88,0.35);color:#7ee69a;font-size:24px;font-weight:500;letter-spacing:0.01em"><i style="width:12px;height:12px;border-radius:50%;background:var(--up);box-shadow:0 0 0 5px rgba(48,209,88,0.2)"></i>Testnet live on Solana</div>
      <div class="wordmark" style="font-size:132px;gap:36px">${logo(150)}<span>Firstprint</span></div>
      <div class="btn btn-white" style="height:116px;padding:0 60px;font-size:48px;margin-top:20px">firstprint.fun</div>
    </div>`),
    'overlay',
  );
  const parts = [...node.children];
  return (t) => {
    node.style.opacity = String(ep(t, at, at + 0.25));
    parts.forEach((pt, i) => {
      const k = ep(t, at + 0.05 + i * 0.12, at + 0.75 + i * 0.12, ease.outQuint);
      pt.style.transform = `translateY(${(1 - k) * 40}px)`;
      pt.style.opacity = String(k);
    });
  };
}

/** Fades the whole frame from/to black at the edges of the video. */
export function fades(s, dur) {
  const node = s.add(el('<div class="layer" style="background:#000;z-index:60;pointer-events:none"></div>'), 'overlay');
  return (t) => {
    node.style.opacity = String(Math.max(1 - ep(t, 0, 0.35, ease.out), ep(t, dur - 0.4, dur, ease.in)));
  };
}
