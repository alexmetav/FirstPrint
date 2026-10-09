// Video 3, square X cut: "The clock decides", rebuilt in the approved video 1 style.
// Native 1080×1080: word-by-word lines that grow, an open lock that flies off the closing
// countdown and clicks shut on the start price, the price riding up into a chip while the
// result clock races, then dropping back to count up to the result. The outcomes roll to
// Moon, coins fly into the balance, a green wipe grows from the balance and shrinks into
// the end card's "Testnet live" dot.
import { el, ico, logo, ep, p, ease, lerp, clamp, fmt, OUTCOMES, oIcon, rng } from './lib.js';
import { TOKENS } from './tokens.js';

export const DURATION = 22;

// gen_audio.py stretches 'coins' and 'riser' timings by 1.22 (made for the stretched v-cuts),
// so the coin flight below uses the same stretched timing and the riser length is divided by it.
const STRETCH = 1.22;
const COIN_AT = 12.75;
const COIN_N = 14;
const COIN_DUR = 0.95 * STRETCH;
const COIN_GAP = 0.045 * STRETCH;
const RACE = [6.6, 9.3];
const REEL_AT = [10.95, 11.12, 11.28, 11.42, 11.55];
const DIGIT_AT = [0.8, 1.3, 1.8, 2.3];

/** Sound cues: only where something happens on screen. */
export const SFX = [
  ...DIGIT_AT.map((t) => [t, 'tick']),
  [3.95, 'lock'],
  [RACE[0], 'riser', (RACE[1] - RACE[0]) / STRETCH],
  [9.35, 'land'],
  [10.9, 'shimmer'],
  ...REEL_AT.map((t, i) => [t, 'blip', i]),
  [11.58, 'pop'],
  [11.7, 'success'],
  [COIN_AT, 'coins', COIN_N],
  [13.9, 'cash'],
  [15.35, 'swell'],
  [17.55, 'pop'],
  [18.05, 'chime'],
];

const CX = 540;
const CY = 540;

/** A centred scene layer. */
function scene(root, extra = '') {
  const n = el(`<div class="abs" style="left:0;top:0;width:1080px;height:1080px;display:flex;flex-direction:column;align-items:center;justify-content:center;${extra}"></div>`);
  root.append(n);
  return n;
}

/** A line of words that can be revealed one at a time. */
function line(words, { size = 60, weight = 500, color = 'var(--text)', gap = 0.26 } = {}) {
  const node = el(`<div style="display:flex;align-items:center;justify-content:center;gap:${gap}em;font-size:${size}px;font-weight:${weight};letter-spacing:-0.035em;line-height:1.1;color:${color};white-space:nowrap">${words
    .map((w) => `<span class="w" style="display:inline-flex;align-items:center">${w}</span>`)
    .join('')}</div>`);
  return { node, spans: [...node.querySelectorAll('.w')] };
}

/** Word reveal: a short rise out of a soft blur. */
function wordIn(sp, t, at, dur = 0.34) {
  const k = ep(t, at, at + dur, ease.outQuint);
  sp.style.opacity = String(clamp(k * 1.3));
  sp.style.transform = `translateY(${(1 - k) * 0.38}em)`;
  sp.style.filter = k < 1 ? `blur(${(1 - k) * 9}px)` : 'none';
}

/** Scene exit: scale, blur and fade. */
function exit(n, out, base, grow = 0.25, blur = 12) {
  n.style.transform = `scale(${base * (1 + grow * out)})`;
  n.style.opacity = String(1 - out);
  n.style.filter = out > 0 ? `blur(${out * blur}px)` : 'none';
}

const show = (n, on) => (n.style.display = on ? 'flex' : 'none');
const pad = (n) => String(Math.max(0, Math.floor(n))).padStart(2, '0');
const centre = (n) => {
  const b = n.getBoundingClientRect();
  return [b.left + b.width / 2, b.top + b.height / 2];
};

/** A padlock whose shackle can open and shut. */
const lockSvg = (size) => `<div class="lk" style="position:relative;width:${size}px;height:${size}px;flex:none">
  <svg viewBox="0 0 24 24" class="i" style="position:absolute;inset:0;width:${size}px;height:${size}px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M12 15.5v2.5"/></svg>
  <svg viewBox="0 0 24 24" class="i shackle" style="position:absolute;inset:0;width:${size}px;height:${size}px;transform-origin:17px 11px"><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
</div>`;

const tokenLogo = (k, size) =>
  `<span class="tok" style="flex:none;display:inline-block;width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 2px rgba(255,255,255,0.14)">${TOKENS[k].replace('<svg', `<svg width="${size}" height="${size}" style="display:block"`)}</span>`;

export function build() {
  const root = document.querySelector('#stage');
  root.append(el('<div class="abs" style="left:-200px;top:560px;width:1480px;height:900px;background:radial-gradient(50% 50% at 50% 50%, rgba(48,209,88,0.09), transparent 70%);pointer-events:none"></div>'));
  const goldGlow = el('<div class="abs" style="left:-200px;top:420px;width:1480px;height:900px;background:radial-gradient(50% 50% at 50% 50%, rgba(255,214,10,0.08), transparent 70%);pointer-events:none;opacity:0"></div>');
  root.append(goldGlow);

  // --- Scene 1: "predictions close in" over a green countdown with an open lock ---
  const s1 = scene(root, 'gap:46px');
  const l1 = line(['predictions', 'close', 'in'], { size: 64 });
  const DIG = 136;
  const panel = el(`<div style="display:flex;align-items:center;gap:34px;padding:30px 48px 30px 40px;border-radius:44px;background:color-mix(in srgb, #30d158 7%, #111114);box-shadow:inset 0 0 0 2px rgba(48,209,88,0.35), 0 40px 90px -40px rgba(0,0,0,0.9)">
    <span class="slot1" style="display:block;width:96px;height:96px;flex:none;color:var(--up)">${lockSvg(96)}</span>
    <div class="mono dg" style="display:flex;align-items:center;font-size:${DIG}px;font-weight:600;letter-spacing:-0.04em;line-height:1;color:var(--up)">00:00:0<span style="display:inline-block;height:1.08em;overflow:hidden"><span class="sreel" style="display:flex;flex-direction:column">${[4, 3, 2, 1, 0]
      .map((d) => `<span style="height:1.08em;display:flex;align-items:center">${d}</span>`)
      .join('')}</span></span></div>
  </div>`);
  s1.append(l1.node, panel);
  const sreel = panel.querySelector('.sreel');
  const digs1 = panel.querySelector('.dg');
  const slot1 = panel.querySelector('.slot1');
  slot1.querySelector('.shackle').style.transform = 'translateY(-5px)';

  // --- Scene 2: "and the start price locks" (the price row itself lives in the hero layer) ---
  const s2 = scene(root, 'gap:44px');
  const l2 = line(['and', 'the', 'start', 'price', 'locks'], { size: 64 });
  const spot2 = el('<div style="height:150px;width:10px"></div>');
  s2.append(l2.node, spot2);

  // --- Scene 3: "then the clock runs / to the result" + the gold result clock ---
  const s3 = scene(root, 'gap:0px');
  const spot3 = el('<div style="height:84px;width:10px;margin-bottom:46px"></div>');
  const l3a = line(['then', 'the', 'clock', 'runs'], { size: 64 });
  const l3b = line(['to', 'the', 'result'], { size: 64 });
  l3b.node.style.marginTop = '6px';
  const CD = 108;
  const cd = el(`<div style="margin-top:50px;display:flex;align-items:flex-start;gap:18px;padding:30px 44px 26px;border-radius:44px;background:color-mix(in srgb, #ffd60a 6%, #111114);box-shadow:inset 0 0 0 2px rgba(255,214,10,0.32), 0 40px 90px -40px rgba(0,0,0,0.9)">${['days', 'hours', 'min', 'sec']
    .map(
      (u, i) =>
        `${i ? `<span class="mono" style="font-size:${CD * 0.8}px;line-height:1;color:#52525b;margin-top:${CD * 0.06}px">:</span>` : ''}<div style="display:grid;justify-items:center;gap:12px;min-width:${CD * 1.3}px"><b class="mono d" style="font-size:${CD}px;line-height:1;font-weight:600;letter-spacing:-0.03em;color:var(--gold)">00</b><small class="eyebrow" style="font-size:22px">${u}</small></div>`,
    )
    .join('')}</div>`);
  s3.append(spot3, l3a.node, l3b.node, cd);
  const cdDigits = [...cd.querySelectorAll('.d')];

  // --- Scene 4: the outcomes roll to Moon; Winner 15.4× ---
  const s4 = scene(root, 'gap:0px');
  const spot4 = el('<div style="height:128px;width:10px;margin-bottom:40px"></div>');
  const SLOT = [...OUTCOMES].reverse(); // Crash … Moon
  const SLOT_H = 124;
  const slot = el(`<div style="height:${SLOT_H}px;overflow:hidden;position:relative;width:700px"><div class="reel">${SLOT.map(
    (o) => `<div style="height:${SLOT_H}px;display:flex;align-items:center;justify-content:center;gap:24px;color:${o.c};font-size:104px;font-weight:600;letter-spacing:-0.04em"><span style="display:inline-flex;font-size:0.72em">${oIcon(o.b)}</span>${o.name}</div>`,
  ).join('')}</div></div>`);
  const reel = slot.querySelector('.reel');
  const winPill = el(`<div style="margin-top:26px;display:flex;align-items:center;gap:18px;height:92px;padding:0 36px 0 30px;border-radius:999px;background:rgba(125,255,58,0.12);box-shadow:inset 0 0 0 2px rgba(125,255,58,0.42);white-space:nowrap">
    <span style="display:inline-flex;font-size:42px;color:var(--moon)">${ico('trophy')}</span>
    <span style="font-size:44px;font-weight:600;letter-spacing:-0.02em;color:var(--moon)">Winner</span>
    <span class="mono mult" style="font-size:44px;font-weight:600;color:#eaffdf;min-width:3.2em;text-align:right">1.0×</span></div>`);
  const multEl = winPill.querySelector('.mult');
  s4.append(spot4, slot, winPill);

  // --- Balance chip (scene 5): coins land here and it counts up ---
  const s5 = scene(root, 'justify-content:flex-start;padding-top:772px');
  const bal = el(`<div style="display:flex;align-items:center;gap:20px;height:116px;padding:0 40px 0 30px;border-radius:999px;background:var(--surface);box-shadow:inset 0 0 0 2px var(--line-strong), 0 30px 70px -30px rgba(0,0,0,0.9)">
    <span class="bic" style="display:inline-flex;font-size:52px;color:var(--gold)">${ico('coins')}</span>
    <span class="mono bv" style="font-size:60px;font-weight:600;letter-spacing:-0.03em;min-width:4.6ch;text-align:right">1,000</span>
    <span style="font-size:36px;color:var(--muted)">pts</span></div>`);
  s5.append(bal);
  const balV = bal.querySelector('.bv');
  const balIc = bal.querySelector('.bic');

  // --- Hero layer: lock + DOGE + price. Becomes the start price, the chip, then the result ---
  const hero = scene(root, 'z-index:5');
  const row = el(`<div style="display:flex;align-items:center;white-space:nowrap">
    <span class="lkw" style="display:flex;width:130px;margin-right:30px;color:var(--up)">${lockSvg(130)}</span>
    ${tokenLogo('doge', 112)}
    <span class="mono price" style="margin-left:28px;font-size:140px;font-weight:600;letter-spacing:-0.04em;line-height:1">$0.1822</span>
    <span class="pct" style="display:flex;align-items:center;margin-left:30px;height:104px;padding:0 30px;border-radius:999px;background:rgba(125,255,58,0.12);box-shadow:inset 0 0 0 2px rgba(125,255,58,0.4);overflow:hidden"><span class="mono pv" style="font-size:66px;font-weight:600;color:var(--moon)">+62.0%</span></span>
  </div>`);
  hero.append(row);
  const lkw = row.querySelector('.lkw');
  const lk = row.querySelector('.lk');
  const shackle = row.querySelector('.shackle');
  const tok = row.querySelector('.tok');
  const priceEl = row.querySelector('.price');
  const pctEl = row.querySelector('.pct');
  const pctV = row.querySelector('.pv');
  const pctW = pctEl.getBoundingClientRect().width;
  pctEl.style.display = 'none';

  // The green wipe, the line on green, and the end card (as in x1).
  const wipe = el('<div class="abs" style="left:0;top:0;border-radius:50%;background:var(--up);z-index:55"></div>');
  root.append(wipe);
  const s6 = scene(root, 'z-index:56;gap:4px');
  const l6a = line(['call', 'it', 'right'], { size: 80, weight: 600, color: '#09090b' });
  const l6b = line(['and', 'you', 'share', 'the', 'pool'], { size: 80, weight: 600, color: '#09090b' });
  s6.append(l6a.node, l6b.node);

  const s7 = scene(root, 'gap:40px;z-index:57');
  const endPill = el(`<div style="display:flex;align-items:center;gap:14px;height:58px;padding:0 26px 0 22px;border-radius:999px;background:rgba(48,209,88,0.1);box-shadow:inset 0 0 0 1.5px rgba(48,209,88,0.38);overflow:hidden;white-space:nowrap">
    <i class="dot" style="flex:none;width:14px;height:14px;border-radius:50%;background:var(--up);box-shadow:0 0 0 6px rgba(48,209,88,0.2)"></i>
    <span class="pt" style="font-size:26px;font-weight:500;color:#8ef0a8">Testnet live on Solana</span></div>`);
  const endWord = el(`<div class="wordmark" style="font-size:128px;gap:34px">${logo(140)}<span>Firstprint</span></div>`);
  const endUrl = el('<div class="btn btn-white" style="height:104px;padding:0 54px;font-size:44px;margin-top:6px">firstprint.fun</div>');
  s7.append(endPill, endWord, endUrl);
  const endPillW = endPill.getBoundingClientRect().width;
  const endDotC = centre(endPill.querySelector('.dot'));
  const endPillText = endPill.querySelector('.pt');

  // Coins: the lib.js flight, with the stretched timing gen_audio.py expects.
  const r = rng(7);
  const coinList = Array.from({ length: COIN_N }, (_, i) => {
    const node = el('<i class="coin" style="z-index:45"></i>');
    root.append(node);
    return { node, delay: i * COIN_GAP, a: (i % 2 ? 0 : Math.PI) + (r() - 0.5) * 1.1, burst: 90 + r() * 120, bend: (r() - 0.5) * 260, lift: 80 + r() * 140, size: 1.0 + r() * 0.5 };
  });

  const black = el('<div class="abs" style="left:0;top:0;width:1080px;height:1080px;background:#000;z-index:60;pointer-events:none"></div>');
  root.append(black);

  // Layout measurements (all scenes untransformed).
  const slot1C = centre(slot1);
  const spot2C = centre(spot2);
  const spot3C = centre(spot3);
  const spot4C = centre(spot4);
  const lockC = centre(lk); // hero at dy 0, scale 1
  const balIcC = centre(balIc);
  [s2, s3, s4, s5, s6, s7].forEach((n) => show(n, false));
  const H2 = spot2C[1] - CY;
  const H3 = spot3C[1] - CY;
  const H4 = spot4C[1] - CY;
  const S3 = 0.48;
  const S4 = 0.74;

  let winC = [CX, 700];
  let balC = balIcC;

  return (t) => {
    // Scene 1 (0–2.9): countdown to the close.
    show(s1, t < 2.95);
    const s1Base = 1 + 0.03 * t;
    if (t < 2.95) {
      l1.spans.forEach((sp, i) => wordIn(sp, t, 0.3 + i * 0.22));
      const grow = ep(t, 1.5, 2.3, ease.inOut);
      l1.node.style.transform = `scale(${lerp(1, 1.14, grow)})`;
      const pin = ep(t, 0.4, 0.85, ease.outQuint);
      panel.style.opacity = String(pin);
      panel.style.transform = `translateY(${(1 - pin) * 50}px) scale(${lerp(0.94, 1, pin)})`;
      panel.style.filter = pin < 1 ? `blur(${(1 - pin) * 12}px)` : 'none';
      // The seconds digit rolls like a reel, with a little motion blur on each step.
      let pos = 0;
      let blur = 0;
      DIGIT_AT.forEach((a) => {
        const q = p(t, a, a + 0.16);
        pos += ease.outQuint(q);
        if (q > 0 && q < 1) blur = Math.max(blur, (1 - q) * 6);
      });
      sreel.style.transform = `translateY(${-pos * 1.08}em)`;
      sreel.style.filter = blur > 0.05 ? `blur(${blur}px)` : 'none';
      const beat = DIGIT_AT.reduce((m, a) => Math.max(m, ep(t, a, a + 0.05) * (1 - ep(t, a + 0.05, a + 0.35))), 0);
      digs1.style.transform = `scale(${1 + 0.035 * beat})`;
      const closed = ep(t, 2.3, 2.5);
      slot1.style.opacity = t < 2.55 ? '1' : '0';
      digs1.style.color = closed > 0 ? `color-mix(in srgb, var(--gold) ${closed * 100}%, var(--up))` : 'var(--up)';
      exit(s1, ep(t, 2.55, 2.9, ease.in), s1Base, 0.25, 12);
    }

    // Hero layer (2.55–12.9).
    const heroOn = t > 2.55 && t < 12.65;
    show(hero, heroOn);
    if (heroOn) {
      const s2Base = 1 + 0.02 * (t - 2.6);
      const toChip = ep(t, 5.55, 6.2, ease.inOut);
      const toRes = ep(t, 9.35, 10.0, ease.inOut);
      let dy, sc;
      if (t < 9.35) {
        dy = lerp(H2 * s2Base, H3, toChip);
        sc = lerp(s2Base, S3 * (1 + 0.02 * (t - 6.2)), toChip);
      } else {
        const s4Base = 1 + 0.02 * (t - 10);
        dy = lerp(H3, H4 * s4Base, toRes);
        sc = lerp(S3 * (1 + 0.02 * (t - 6.2)), S4 * s4Base, toRes);
      }
      const out = ep(t, 12.25, 12.6, ease.in);
      hero.style.transform = `translateY(${dy - out * 140}px) scale(${sc * (1 + 0.2 * out)})`;
      hero.style.opacity = String(1 - out);
      hero.style.filter = out > 0 ? `blur(${out * 12}px)` : 'none';
      // Motion blur on the fast moves.
      const mv = Math.sin(Math.PI * toChip) * (1 - toRes) + Math.sin(Math.PI * toRes);
      row.style.filter = mv > 0.05 ? `blur(${mv * 4}px)` : 'none';

      // The open lock flies off the countdown and clicks shut on the start price.
      const f = ep(t, 2.55, 3.15, ease.inOut);
      const iconScreen = [CX + (slot1C[0] - CX) * (1 + 0.03 * 2.55), CY + (slot1C[1] - CY) * (1 + 0.03 * 2.55)];
      const lockScreen = [CX + (lockC[0] - CX) * sc, CY + dy + (lockC[1] - CY) * sc];
      const ox = ((iconScreen[0] - lockScreen[0]) / sc) * (1 - f);
      const oy = ((iconScreen[1] - lockScreen[1]) / sc) * (1 - f);
      const lockS = lerp(96 / 130 / sc, 1, f);
      const shut = ep(t, 3.8, 4.0, ease.back);
      const open = ep(t, 9.4, 9.7, ease.out);
      lk.style.transform = `translate(${ox}px, ${oy}px) scale(${lockS * (1 + 0.08 * ep(t, 3.95, 4.02) * (1 - ep(t, 4.02, 4.3)))})`;
      lk.style.filter = f > 0 && f < 1 ? `blur(${Math.sin(Math.PI * f) * 5}px)` : 'none';
      shackle.style.transform = `translateY(${(1 - shut) * -5 - open * 5}px)`;
      const gold = ep(t, 3.85, 4.0);
      lkw.style.color = `color-mix(in srgb, var(--gold) ${gold * 100}%, var(--up))`;
      // The lock leaves when the result comes in.
      const lgo = ep(t, 9.6, 10.0, ease.inOut);
      lkw.style.width = `${130 * (1 - lgo)}px`;
      lkw.style.marginRight = `${30 * (1 - lgo)}px`;
      lkw.style.opacity = String(1 - lgo);

      // Token and price arrive like words.
      wordIn(tok, t, 3.0);
      wordIn(priceEl, t, 3.12);
      let v;
      if (t < 3.95) {
        const step = Math.floor(t / 0.09);
        v = 0.1822 + Math.round(Math.sin(step * 12.9898) * 43758.5453 % 1 * 6) / 10000;
      } else if (t < 10.0) v = 0.1822;
      else v = lerp(0.1822, 0.2952, ep(t, 10.0, 10.9, ease.out));
      priceEl.textContent = `$${v.toFixed(4)}`;
      const res = ep(t, 10.0, 10.9);
      priceEl.style.color =
        t < 9.6 ? `color-mix(in srgb, var(--gold) ${gold * 100}%, var(--text))` : `color-mix(in srgb, var(--text) ${(1 - res) * 100}%, var(--moon))`;
      if (t > 9.6 && t < 9.9) priceEl.style.color = `color-mix(in srgb, var(--gold) ${(1 - ep(t, 9.6, 9.9)) * 100}%, var(--text))`;
      // The percentage pill grows out of the price and counts to +62%.
      const pk = ep(t, 9.95, 10.4, ease.outQuint);
      pctEl.style.display = t > 9.95 ? 'flex' : 'none';
      pctEl.style.width = `${lerp(20, pctW, pk)}px`;
      pctEl.style.opacity = String(ep(t, 9.95, 10.1));
      pctV.textContent = `+${(62 * ep(t, 10.0, 10.9, ease.out)).toFixed(1)}%`;
      pctEl.style.transform = `scale(${1 + 0.06 * ep(t, 10.88, 10.95) * (1 - ep(t, 10.95, 11.2))})`;
    }

    // Scene 2 (2.6–6.0).
    show(s2, t > 2.6 && t < 6.0);
    if (t > 2.6 && t < 6.0) {
      l2.spans.forEach((sp, i) => wordIn(sp, t, 2.85 + i * 0.16));
      l2.node.style.transform = `scale(${lerp(1, 1.1, ep(t, 4.3, 5.0, ease.inOut))})`;
      exit(s2, ep(t, 5.5, 5.95, ease.in), 1 + 0.02 * (t - 2.6), 0.25, 12);
    }

    // Scene 3 (5.9–9.75): the result clock races to zero.
    show(s3, t > 5.9 && t < 9.75);
    goldGlow.style.opacity = String(ep(t, 6.0, 6.8) * (1 - ep(t, 9.4, 10.0)));
    if (t > 5.9 && t < 9.75) {
      l3a.spans.forEach((sp, i) => wordIn(sp, t, 5.95 + i * 0.16));
      l3b.spans.forEach((sp, i) => wordIn(sp, t, 6.6 + i * 0.16));
      const grow = ep(t, 7.4, 8.2, ease.inOut);
      l3a.node.style.transform = l3b.node.style.transform = `scale(${lerp(1, 1.08, grow)})`;
      const cin = ep(t, 6.15, 6.6, ease.outQuint);
      cd.style.opacity = String(cin);
      cd.style.filter = cin < 1 ? `blur(${(1 - cin) * 12}px)` : 'none';
      const k = p(t, RACE[0], RACE[1]);
      const secs = 7 * 86400 * (1 - (1 - Math.pow(1 - k, 2.2)));
      const s = Math.max(0, Math.round(secs));
      const parts = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60];
      parts.forEach((x, i) => (cdDigits[i].textContent = pad(x)));
      const speed = k > 0 && k < 1 ? Math.pow(1 - k, 1.2) : 0;
      cdDigits.forEach((d, i) => (d.style.filter = speed * i > 0.05 ? `blur(${speed * [0, 1.2, 3, 5][i]}px)` : 'none'));
      const hit = ep(t, RACE[1], RACE[1] + 0.06) * (1 - ep(t, RACE[1] + 0.06, RACE[1] + 0.4));
      const cout = ep(t, 9.4, 9.72, ease.in);
      cd.style.transform = `translateY(${(1 - cin) * 50}px) scale(${(1 + 0.05 * hit) * lerp(0.94, 1, cin)})`;
      exit(s3, cout, 1 + 0.02 * (t - 5.9), 0.12, 12);
      if (cout === 0) s3.style.opacity = '1';
    }

    // Scene 4 (10.0–15.0): the outcomes roll to Moon, then move up for the payout.
    show(s4, t > 10.6 && t < 15.0);
    if (t > 10.6 && t < 15.0) {
      const enter = ep(t, REEL_AT[0] - 0.2, REEL_AT[0] + 0.05, ease.outQuint);
      let pos = 0;
      let blur = (1 - enter) * 8;
      for (let k = 1; k < REEL_AT.length; k++) {
        const q = p(t, REEL_AT[k], REEL_AT[k] + 0.13);
        pos += ease.outQuint(q);
        if (q > 0 && q < 1) blur = Math.max(blur, (1 - q) * 6);
      }
      reel.style.transform = `translateY(${-pos * SLOT_H + (1 - enter) * SLOT_H}px)`;
      reel.style.filter = blur > 0.05 ? `blur(${blur}px)` : 'none';
      slot.style.opacity = String(clamp(enter * 1.5));
      slot.style.transform = `scale(${lerp(1, 1.1, ep(t, 11.55, 11.68, ease.out)) * lerp(1, 1 / 1.1, ep(t, 11.68, 11.85))})`;
      const wk = ep(t, 11.65, 12.05, ease.back);
      winPill.style.opacity = String(clamp(wk * 2));
      winPill.style.transform = `scale(${lerp(0.4, 1, wk)})`;
      multEl.textContent = `${lerp(1, 15.4, ep(t, 11.75, 12.45, ease.out)).toFixed(1)}×`;
      // After the result, the outcome moves up to make room for the balance.
      const up = ep(t, 12.45, 12.95, ease.inOut);
      const base = 1 + 0.02 * (t - 10.6);
      const out = ep(t, 14.55, 14.95, ease.in);
      s4.style.transform = `translateY(${-210 * up - 40 * out}px) scale(${base * (1 + 0.15 * out)})`;
      s4.style.opacity = String(1 - out);
      s4.style.filter = out > 0 ? `blur(${out * 10}px)` : 'none';
      const wb = winPill.getBoundingClientRect();
      winC = [wb.left + wb.width * 0.72, wb.top + wb.height / 2];
    }

    // Scene 5 (12.6–15.6): coins fly into the balance and it counts up.
    show(s5, t > 12.55 && t < 15.6);
    if (t > 12.55 && t < 15.6) {
      const bin = ep(t, 12.6, 13.05, ease.outQuint);
      const hit = ep(t, 13.9, 13.98) * (1 - ep(t, 13.98, 14.3)) + ep(t, 14.62, 14.7) * (1 - ep(t, 14.7, 15.0));
      bal.style.opacity = String(bin);
      bal.style.filter = bin < 1 ? `blur(${(1 - bin) * 10}px)` : 'none';
      bal.style.transform = `translateY(${(1 - bin) * 60}px) scale(${1 + 0.07 * hit})`;
      balV.textContent = fmt(1000 + 1540 * ep(t, 13.88, 14.65, ease.out));
      s5.style.transform = `translateY(${-110 * ep(t, 12.45, 12.95, ease.inOut)}px) scale(${1 + 0.02 * (t - 12.6)})`;
      s5.style.opacity = String(1 - ep(t, 15.25, 15.5));
      balC = centre(balIc);
    }
    for (const c of coinList) {
      const k = p(t, COIN_AT + c.delay, COIN_AT + c.delay + COIN_DUR);
      if (k <= 0 || k >= 1) {
        c.node.style.opacity = '0';
        continue;
      }
      const [sx, sy] = winC;
      const [ex, ey] = balC;
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
        const ky = (by + ey) / 2 + c.lift * 0.3;
        x = (1 - q) ** 2 * bx + 2 * (1 - q) * q * kx + q * q * ex;
        y = (1 - q) ** 2 * by + 2 * (1 - q) * q * ky + q * q * ey;
        sc = c.size * (1 - q * 0.55);
      }
      c.node.style.opacity = '1';
      c.node.style.transform = `translate(${x}px, ${y}px) scale(${sc}) rotateY(${k * 900}deg)`;
    }

    // Green wipe: grows out of the balance, holds, then shrinks into the end pill's dot.
    const G0 = 14.85;
    const G1 = 15.4;
    const S0 = 17.0;
    const S1 = 17.5;
    const grow = ep(t, G0, G1, ease.in);
    const shrink = ep(t, S0, S1, ease.inOut);
    const R = t < S0 ? lerp(10, 900, grow) : lerp(900, 7, shrink);
    const wc = t < S0 ? [lerp(balC[0], CX, ep(t, G0, G1)), lerp(balC[1], CY, ep(t, G0, G1))] : [lerp(CX, endDotC[0], shrink), lerp(CY, endDotC[1], shrink)];
    const wipeOn = t > G0 && t < S1 + 0.05;
    wipe.style.display = wipeOn ? 'block' : 'none';
    wipe.style.width = wipe.style.height = `${R * 2}px`;
    wipe.style.left = `${wc[0] - R}px`;
    wipe.style.top = `${wc[1] - R}px`;
    show(s6, t > 15.3 && t < 17.1);
    if (t > 15.3 && t < 17.1) {
      l6a.spans.forEach((sp, i) => wordIn(sp, t, 15.38 + i * 0.13));
      l6b.spans.forEach((sp, i) => wordIn(sp, t, 15.8 + i * 0.13));
      const out = ep(t, 16.82, 17.05, ease.in);
      s6.style.opacity = String(1 - out);
      s6.style.transform = `scale(${(1 + 0.04 * (t - 15.4)) * (1 - 0.2 * out)})`;
    }

    // Scene 7: end card (17.45–22), as in x1.
    show(s7, t > 17.45);
    if (t > 17.45) {
      const pk = ep(t, 17.5, 18.0, ease.outQuint);
      endPill.style.width = `${lerp(14 + 22 + 26, endPillW, pk)}px`;
      endPill.style.background = `rgba(48,209,88,${0.1 * ep(t, 17.5, 17.75)})`;
      endPill.style.boxShadow = `inset 0 0 0 1.5px rgba(48,209,88,${0.38 * ep(t, 17.5, 17.75)})`;
      endPillText.style.opacity = String(ep(t, 17.7, 18.05));
      const wk = ep(t, 17.75, 18.45, ease.outQuint);
      endWord.style.opacity = String(wk);
      endWord.style.transform = `translateY(${(1 - wk) * 30}px)`;
      endWord.style.filter = wk < 1 ? `blur(${(1 - wk) * 10}px)` : 'none';
      const uk = ep(t, 18.1, 18.75, ease.outQuint);
      endUrl.style.opacity = String(uk);
      endUrl.style.transform = `translateY(${(1 - uk) * 30}px) scale(${lerp(0.94, 1, uk)})`;
      s7.style.transform = `scale(${1 + 0.025 * ep(t, 17.45, 22)})`;
    }

    black.style.opacity = String(Math.max(1 - ep(t, 0, 0.25, ease.out), ep(t, DURATION - 0.5, DURATION, ease.in)));
  };
}
