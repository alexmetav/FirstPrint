// Partnership loop, square X cut. The partner is swapped from the URL, nothing else changes:
//   stage-sq.html?v=xp&name=LETSBURN&logo=partners/letsburn.png
// "new partnership" → the Firstprint mark meets the partner logo (each with its own glow) →
// "firstprint × partner" → the two tiles meet and a green wipe opens → "better together" →
// the wipe shrinks into the end card's pill dot. Starts and ends on black, so it loops cleanly.
import { el, logo, bigMark, ep, ease, lerp, clamp } from './lib.js';

const B = 60 / 104; // one beat of the music bed
export const DURATION = 16 * B; // four bars, so the music loops with the picture

const q = new URLSearchParams(location.search);
const NAME = q.get('name') || 'Partner';
const LOGO = q.get('logo') || 'partners/letsburn.png';

/** Sound cues: only where something happens on screen. */
export const SFX = [
  [0.3, 'blip', 0],
  [0.55, 'blip', 2],
  [1.95, 'shimmer'],
  [2.75, 'pop'],
  [3.25, 'blip', 0],
  [3.45, 'blip', 1],
  [3.65, 'blip', 3],
  [4.95, 'tap'],
  [5.0, 'success'],
  [6.6, 'pop'],
  [7.05, 'chime'],
];

const CX = 540;
const CY = 540;
const TILE = 200;

export async function preload() {
  const img = new Image();
  img.src = LOGO;
  await img.decode().catch(() => {});
}

function scene(root, extra = '') {
  const n = el(`<div class="abs" style="left:0;top:0;width:1080px;height:1080px;display:flex;flex-direction:column;align-items:center;justify-content:center;${extra}"></div>`);
  root.append(n);
  return n;
}

function line(words, { size = 60, weight = 500, color = 'var(--text)', gap = 0.26 } = {}) {
  const node = el(`<div style="display:flex;align-items:center;justify-content:center;gap:${gap}em;font-size:${size}px;font-weight:${weight};letter-spacing:-0.035em;line-height:1.1;color:${color};white-space:nowrap">${words
    .map((w) => `<span class="w" style="display:inline-flex;align-items:center">${w}</span>`)
    .join('')}</div>`);
  return { node, spans: [...node.querySelectorAll('.w')] };
}

function wordIn(sp, t, at, dur = 0.34) {
  const k = ep(t, at, at + dur, ease.outQuint);
  sp.style.opacity = String(clamp(k * 1.3));
  sp.style.transform = `translateY(${(1 - k) * 0.38}em)`;
  sp.style.filter = k < 1 ? `blur(${(1 - k) * 9}px)` : 'none';
}

/** Shrinks a line's font until it fits the width (long partner names). */
function fit(node, max) {
  let size = parseFloat(node.style.fontSize);
  while (node.getBoundingClientRect().width > max && size > 28) {
    size -= 2;
    node.style.fontSize = `${size}px`;
  }
}

const show = (n, on) => (n.style.display = on ? 'flex' : 'none');
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Frosted tile holding the partner logo. */
function partnerTile(size) {
  return el(`<div class="abs" style="width:${size}px;height:${size}px;border-radius:${size * 0.28}px;display:flex;align-items:center;justify-content:center;padding:${size * 0.17}px;
    background:rgba(255,255,255,0.07);backdrop-filter:blur(30px) saturate(170%);
    box-shadow:inset 0 0 0 1.5px rgba(255,255,255,0.16), inset 0 1.5px 0 rgba(255,255,255,0.28), 0 30px 70px -20px rgba(0,0,0,0.8)">
    <img src="${LOGO}" style="width:100%;height:100%;object-fit:contain;display:block"></div>`);
}

export function build() {
  const root = document.querySelector('#stage');

  // --- Glows: green behind Firstprint, the partner's own logo blurred behind theirs ---
  const glowL = el('<div class="abs" style="left:40px;top:190px;width:560px;height:520px;border-radius:50%;background:radial-gradient(50% 50% at 50% 50%, rgba(125,255,58,0.55), rgba(48,209,88,0.15) 60%, transparent 75%);filter:blur(60px)"></div>');
  const glowR = el(`<img class="abs" src="${LOGO}" style="left:560px;top:200px;width:480px;height:480px;object-fit:contain;filter:blur(90px) saturate(170%)">`);
  root.append(glowL, glowR);

  // --- Scene 1: "new partnership" ---
  const s1 = scene(root);
  const l1 = line(['new', 'partnership'], { size: 76, weight: 600 });
  s1.append(l1.node);

  // --- Scene 2: the two marks meet, names underneath ---
  const s2 = scene(root);
  const fp = bigMark(TILE);
  const fpBars = [...fp.querySelectorAll('[data-bar]')];
  const pt = partnerTile(TILE);
  const x = el('<div class="abs" style="font-size:64px;font-weight:400;color:var(--muted);width:80px;margin-left:-40px;text-align:center;line-height:1">×</div>');
  const l2 = line(['firstprint', '<span style="color:var(--muted);font-weight:400">×</span>', esc(NAME)], { size: 74, weight: 600, gap: 0.3 });
  l2.node.style.position = 'absolute';
  l2.node.style.top = '640px';
  s2.append(fp, pt, x, l2.node);
  fit(l2.node, 960);

  // --- Green wipe from where the tiles meet ---
  const wipe = el('<div class="abs" style="left:0;top:0;border-radius:50%;background:var(--up);z-index:55"></div>');
  root.append(wipe);
  const s3 = scene(root, 'z-index:56');
  const l3 = line(['better', 'together'], { size: 104, weight: 600, color: '#09090b' });
  s3.append(l3.node);

  // --- End card: pill from the wipe's dot, both logos, names, url ---
  const s4 = scene(root, 'gap:44px;z-index:57');
  const endPill = el(`<div style="display:flex;align-items:center;gap:14px;height:58px;padding:0 26px 0 22px;border-radius:999px;background:rgba(48,209,88,0.1);box-shadow:inset 0 0 0 1.5px rgba(48,209,88,0.38);overflow:hidden;white-space:nowrap">
    <i class="dot" style="flex:none;width:14px;height:14px;border-radius:50%;background:var(--up);box-shadow:0 0 0 6px rgba(48,209,88,0.2)"></i>
    <span class="pt" style="font-size:26px;font-weight:500;color:#8ef0a8">New partnership</span></div>`);
  const endRow = el(`<div style="display:flex;align-items:center;gap:30px">
    <div style="width:150px;height:150px;display:flex;align-items:center;justify-content:center">${logo(150)}</div>
    <span style="font-size:52px;color:var(--muted)">×</span>
    <div class="pslot" style="position:relative;width:150px;height:150px"></div></div>`);
  const endTile = partnerTile(150);
  endTile.style.left = '0';
  endTile.style.top = '0';
  endRow.querySelector('.pslot').append(endTile);
  const endName = el(`<div style="font-size:64px;font-weight:600;letter-spacing:-0.035em;white-space:nowrap">Firstprint <span style="color:var(--muted);font-weight:400">×</span> ${esc(NAME)}</div>`);
  const endUrl = el('<div class="btn btn-white" style="height:96px;padding:0 50px;font-size:40px">firstprint.fun</div>');
  s4.append(endPill, endRow, endName, endUrl);
  fit(endName, 960);
  const endPillW = endPill.getBoundingClientRect().width;
  const endDot = endPill.querySelector('.dot').getBoundingClientRect();
  const endDotC = [endDot.left + endDot.width / 2, endDot.top + endDot.height / 2];
  const endPillText = endPill.querySelector('.pt');
  const endParts = [endRow, endName, endUrl];

  const black = el('<div class="abs" style="left:0;top:0;width:1080px;height:1080px;background:#000;z-index:60;pointer-events:none"></div>');
  root.append(black);

  const MEET = 4.95; // tiles touch, wipe starts
  return (t) => {
    // Glows follow scene 2 and the end card.
    const gIn = ep(t, 1.95, 3.1, ease.out);
    const gOut = ep(t, MEET - 0.2, MEET + 0.2);
    const gEnd = ep(t, 7.0, 7.8, ease.out) * (1 - ep(t, DURATION - 0.6, DURATION));
    const gk = Math.max(gIn * (1 - gOut), gEnd * 0.75);
    glowL.style.opacity = String(gk * clamp(ep(t, 1.95, 2.6) * 1.2));
    glowR.style.opacity = String(gk * ep(t, 2.7, 3.5) * 0.9);
    const drift = Math.sin(t * 0.9) * 14;
    glowL.style.transform = `translate(${drift}px, ${-drift * 0.6}px) scale(${1 + 0.06 * gk})`;
    glowR.style.transform = `translate(${-drift}px, ${drift * 0.5}px) scale(${1 + 0.06 * gk})`;

    // Scene 1 (0.25–2.05).
    show(s1, t < 2.1);
    if (t < 2.1) {
      l1.spans.forEach((sp, i) => wordIn(sp, t, 0.3 + i * 0.25));
      const grow = ep(t, 1.0, 1.7, ease.inOut);
      const out = ep(t, 1.72, 2.05, ease.in);
      s1.style.transform = `scale(${(1 + 0.03 * t) * lerp(1, 1.3, grow) * (1 + 0.25 * out)})`;
      s1.style.opacity = String(1 - out);
      s1.style.filter = out > 0 ? `blur(${out * 12}px)` : 'none';
    }

    // Scene 2 (1.9–5.1).
    show(s2, t > 1.88 && t < 5.3);
    if (t > 1.88 && t < 5.3) {
      const Y = 450;
      // Firstprint mark: draws in at centre, then steps left for the partner.
      const mIn = ep(t, 1.92, 2.45, ease.back);
      fpBars.forEach((b, i) => (b.style.transform = `scaleX(${ep(t, 1.98 + i * 0.06, 2.45 + i * 0.06, ease.outQuint)})`));
      const side = ep(t, 2.45, 3.0, ease.inOut);
      const meet = ep(t, MEET - 0.4, MEET, ease.in);
      const off = lerp(0, 190, side) * (1 - meet) + meet * (TILE / 2 - 4);
      fp.style.left = `${CX - off - TILE / 2}px`;
      fp.style.top = `${Y - TILE / 2}px`;
      fp.style.transform = `scale(${lerp(0.5, 1, mIn)})`;
      fp.style.opacity = String(clamp(ep(t, 1.92, 2.1) * 1));
      // Partner tile pops in on the right.
      const pIn = ep(t, 2.72, 3.2, ease.back);
      const poff = 190 * (1 - meet) + meet * (TILE / 2 - 4);
      pt.style.left = `${CX + poff - TILE / 2}px`;
      pt.style.top = `${Y - TILE / 2}px`;
      pt.style.transform = `scale(${lerp(0.3, 1, pIn)}) rotate(${(1 - pIn) * 12}deg)`;
      pt.style.opacity = String(clamp(ep(t, 2.72, 2.9)));
      // The × between them.
      const xk = ep(t, 2.95, 3.3, ease.outQuint) * (1 - ep(t, MEET - 0.5, MEET - 0.25));
      x.style.left = `${CX}px`;
      x.style.top = `${Y - 34}px`;
      x.style.opacity = String(xk);
      x.style.transform = `scale(${lerp(0.4, 1, xk)})`;
      // Names, word by word, then they leave before the meet.
      l2.spans.forEach((sp, i) => wordIn(sp, t, 3.25 + i * 0.2));
      const nOut = ep(t, MEET - 0.55, MEET - 0.3, ease.in);
      l2.node.style.opacity = String(1 - nOut);
      l2.node.style.filter = nOut > 0 ? `blur(${nOut * 10}px)` : 'none';
      s2.style.transform = `scale(${1 + 0.035 * ep(t, 1.9, MEET)})`;
      s2.style.opacity = String(1 - ep(t, MEET + 0.12, MEET + 0.3));
    }

    // Green wipe: opens where the tiles meet, holds, then shrinks into the end pill's dot.
    const meetC = [CX, 450 * 1.035 - 540 * 0.035];
    const grow = ep(t, MEET, MEET + 0.5, ease.in);
    const SH = 6.55;
    const shrink = ep(t, SH, SH + 0.5, ease.inOut);
    const R = t < SH ? lerp(8, 900, grow) : lerp(900, 7, shrink);
    const wc = t < SH ? [CX, lerp(meetC[1], CY, ep(t, MEET, MEET + 0.5))] : [lerp(CX, endDotC[0], shrink), lerp(CY, endDotC[1], shrink)];
    const wipeOn = t > MEET && t < SH + 0.55;
    wipe.style.display = wipeOn ? 'block' : 'none';
    wipe.style.width = wipe.style.height = `${R * 2}px`;
    wipe.style.left = `${wc[0] - R}px`;
    wipe.style.top = `${wc[1] - R}px`;

    // Scene 3 on green (5.35–6.6).
    show(s3, t > 5.35 && t < 6.65);
    if (t > 5.35 && t < 6.65) {
      l3.spans.forEach((sp, i) => wordIn(sp, t, 5.42 + i * 0.2));
      const out = ep(t, 6.4, 6.62, ease.in);
      s3.style.opacity = String(1 - out);
      s3.style.transform = `scale(${(1 + 0.05 * (t - 5.4)) * (1 - 0.2 * out)})`;
    }

    // Scene 4: end card (7.0–end), out through blur into black so the loop restarts cleanly.
    show(s4, t > 6.95);
    if (t > 6.95) {
      const pk = ep(t, 7.02, 7.5, ease.outQuint);
      endPill.style.width = `${lerp(14 + 22 + 26, endPillW, pk)}px`;
      endPill.style.background = `rgba(48,209,88,${0.1 * ep(t, 7.02, 7.25)})`;
      endPill.style.boxShadow = `inset 0 0 0 1.5px rgba(48,209,88,${0.38 * ep(t, 7.02, 7.25)})`;
      endPillText.style.opacity = String(ep(t, 7.2, 7.5));
      endParts.forEach((n, i) => {
        const k = ep(t, 7.25 + i * 0.18, 7.85 + i * 0.18, ease.outQuint);
        n.style.opacity = String(k);
        n.style.transform = `translateY(${(1 - k) * 30}px)`;
        n.style.filter = k < 1 ? `blur(${(1 - k) * 10}px)` : 'none';
      });
      const out = ep(t, DURATION - 0.55, DURATION - 0.1, ease.in);
      s4.style.transform = `scale(${(1 + 0.03 * ep(t, 7.0, DURATION)) * (1 + 0.08 * out)})`;
      s4.style.filter = out > 0 ? `blur(${out * 12}px)` : 'none';
    }

    black.style.opacity = String(Math.max(1 - ep(t, 0, 0.2, ease.out), ep(t, DURATION - 0.35, DURATION, ease.in)));
  };
}
