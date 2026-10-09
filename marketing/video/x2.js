// Video 2, square X cut: "three taps to make a call", rebuilt in the video 1 style.
// Native 1080×1080: word-by-word lines that grow, three tap dots that become the SOL coin,
// the coin becomes the card's token, rows cascade, the Up tap dives into an Up pill, point chips
// cascade, the 100 chip flies into a counting payout, the payout becomes the Predict button,
// and the Predict tap opens the green wipe that shrinks into the end card's "Testnet live" dot.
import { stage, el, ico, logo, outcomeRows, tap, keys, ep, p, ease, lerp, clamp, fmt, pressScale, oIcon } from './lib.js';
import { TOKENS } from './tokens.js';

export const DURATION = 22;

/** Sound cues: only where something happens on screen. */
export const SFX = [
  ...[0, 1, 2].map((i) => [1.6 + i * 0.12, 'blip', i]),
  [2.75, 'swell'],
  [2.85, 'land'],
  ...[0, 1, 2, 3, 4].map((i) => [4.0 + i * 0.14, 'blip', i]),
  [6.2, 'tap'],
  [6.95, 'pop'],
  ...[0, 1, 2, 3].map((i) => [7.75 + i * 0.1, 'blip', i + 1]),
  [8.7, 'tap'],
  [9.5, 'land'],
  [10.25, 'shimmer'],
  [11.25, 'pop'],
  [11.4, 'blip', 3],
  [11.55, 'blip', 4],
  [12.55, 'land'],
  [13.45, 'tap'],
  [13.5, 'pop'],
  [14.1, 'success'],
  [15.05, 'pop'],
  [17.35, 'pop'],
  [17.85, 'chime'],
];

const CX = 540;
const CY = 540;
const SOL = (px) => TOKENS.sol.replace('<svg', `<svg width="${px}" height="${px}" style="display:block"`);

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

/** Scene exit: scale + blur + fade. */
function exit(n, out, base, dir = 1) {
  n.style.transform = `scale(${base * (1 + 0.25 * dir * out)})`;
  n.style.opacity = String(1 - out);
  n.style.filter = out > 0 ? `blur(${out * 12}px)` : 'none';
}

const show = (n, on) => (n.style.display = on ? 'flex' : 'none');
const box = (n) => n.getBoundingClientRect();
const mid = (r) => [r.left + r.width / 2, r.top + r.height / 2];

export function build() {
  const root = document.querySelector('#stage');
  root.append(el('<div class="abs" style="left:-200px;top:560px;width:1480px;height:900px;background:radial-gradient(50% 50% at 50% 50%, rgba(48,209,88,0.09), transparent 70%);pointer-events:none"></div>'));

  // --- Card world (scene 2): the outcome list, as on the market page ---
  const s = stage();
  const PCTS = [13, 46, 24, 11, 6];
  const card = el(`<div class="card" style="left:80px;top:300px;width:920px;overflow:hidden">
    <div style="display:flex;align-items:center;gap:26px;padding:36px 40px 28px">
      <div class="avatar" style="width:116px;height:116px;background:none;overflow:hidden;box-shadow:0 0 0 2px rgba(255,255,255,0.14)">${SOL(116)}</div>
      <div><div style="font-size:64px;font-weight:600;letter-spacing:-0.03em;line-height:1">SOL</div><div class="muted" style="font-size:28px;margin-top:8px">Solana</div></div>
      <span class="pill pill-open" style="margin-left:auto"><i class="dot"></i>Open</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:6px 40px 16px"><span class="eyebrow" style="font-size:22px">Final price vs start</span><span class="eyebrow" style="font-size:22px">Crowd</span></div>
  </div>`);
  const { node: rowsNode, rows } = outcomeRows(PCTS);
  card.append(rowsNode);
  s.add(card);
  const barEls = rows.map((r) => r.querySelector('.bar'));
  const pcEls = rows.map((r) => r.querySelector('.pc'));
  const up = rows[1];
  s.camera(CX, CY, 1);
  const avC = mid(box(card.querySelector('.avatar')));
  const upRow = box(up);
  const upName = mid(box(up.querySelector('.nm')));
  const cardB = box(card);
  const cardMidY = (cardB.top + cardB.bottom) / 2;
  const camFull = cardMidY - 95 / 0.98; // card sits a little low, under the line
  const tapUp = tap(s, upRow.left + 250, upRow.top + upRow.height / 2, 6.2);

  // --- Scene 1: "three taps to make a call" + three tap dots ---
  const s1 = scene(root);
  const l1 = line(['three', 'taps', 'to', 'make', 'a', 'call'], { size: 64 });
  s1.append(l1.node);
  const sC = scene(root, 'z-index:5');
  const dots = [0, 1, 2].map((i) => {
    const d = el(`<div class="abs" style="left:${CX + (i - 1) * 76 - 14}px;top:${CY + 96 - 14}px;width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,0.9);box-shadow:0 0 0 7px rgba(255,255,255,0.16)"></div>`);
    sC.append(d);
    return d;
  });
  const coin = el(`<div class="abs" style="left:${CX - 58}px;top:${CY - 58}px;width:116px;height:116px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 2px rgba(255,255,255,0.14), 0 18px 40px -16px rgba(0,0,0,0.9)">${SOL(116)}</div>`);
  sC.append(coin);

  // --- Scene 2 overlay: "pick where the price lands" above the card ---
  const s2 = scene(root, 'justify-content:flex-start;padding-top:96px;z-index:4');
  const l2 = line(['pick', 'where', 'the', 'price', 'lands'], { size: 58 });
  s2.append(l2.node);

  // --- Scene 3: Up pill, "now choose your points", chips cascade ---
  const s3 = scene(root, 'gap:44px');
  const upPill = el(`<div style="display:flex;align-items:center;gap:16px;height:96px;padding:0 40px 0 32px;border-radius:999px;background:rgba(48,209,88,0.12);box-shadow:inset 0 0 0 2.5px var(--up);color:var(--up);font-size:52px;font-weight:600;letter-spacing:-0.03em"><span style="display:inline-flex;font-size:52px">${oIcon('up')}</span>Up</div>`);
  const l3 = line(['now', 'choose', 'your', 'points'], { size: 62 });
  const CHIPS = ['25', '50', '100', '250'];
  const chipRow = el(`<div style="display:flex;gap:24px">${CHIPS.map((v) => `<div class="ch mono" style="display:grid;place-items:center;width:184px;height:112px;border-radius:999px;border:2.5px solid var(--line-strong);background:var(--surface);font-size:48px;font-weight:500"><span class="cv">${v}</span></div>`).join('')}</div>`);
  s3.append(upPill, l3.node, chipRow);
  const chips = [...chipRow.querySelectorAll('.ch')];
  const chip100 = chips[2];
  const pillC = mid(box(upPill));
  const chipC = mid(box(chip100.querySelector('.cv')));
  const tap100 = el('<div class="tap"></div>');
  root.append(tap100);
  tap100.style.left = `${chipC[0]}px`;
  tap100.style.top = `${chipC[1]}px`;
  tap100.style.zIndex = '20';
  const tapAt = (n, at) => (t) => {
    const k = p(t, at - 0.18, at + 0.55);
    if (k <= 0 || k >= 1) return (n.style.opacity = '0');
    const press = p(t, at - 0.18, at);
    const release = p(t, at, at + 0.55);
    n.style.transform = `scale(${release > 0 ? lerp(0.8, 1.7, ease.out(release)) : lerp(1.1, 0.8, ease.out(press))})`;
    n.style.opacity = String(release > 0 ? 1 - ease.out(release) : ease.out(press) * 0.95);
  };
  const tap2 = tapAt(tap100, 8.7);

  // --- Scene 4: the 100 becomes the payout, counting up ---
  const s4 = scene(root, 'gap:18px');
  const l4 = line(['if', 'up', 'wins,', '100', 'pts', 'becomes', 'about'], { size: 50, color: 'var(--text)', gap: 0.24 });
  l4.spans[1].style.color = 'var(--up)';
  const big = el('<div style="display:flex;align-items:baseline;gap:22px;line-height:1"><span class="mono num" style="font-size:210px;font-weight:600;letter-spacing:-0.05em">100</span><span class="pts" style="font-size:64px;font-weight:500;color:var(--muted)">pts</span></div>');
  const num = big.querySelector('.num');
  const ptsLabel = big.querySelector('.pts');
  const stats = el(`<div style="display:flex;gap:18px;margin-top:22px">
    <div class="st chip" style="height:72px;font-size:30px;background:transparent"><span class="muted" style="font-family:var(--display)">Return</span><span class="ret">1.00×</span></div>
    <div class="st chip" style="height:72px;font-size:30px;background:transparent;color:var(--gold);border-color:rgba(255,214,10,0.35)"><span style="font-family:var(--display);color:var(--muted)">Early bonus</span><span class="bon">1.00×</span></div></div>`);
  const statEls = [...stats.querySelectorAll('.st')];
  const retEl = stats.querySelector('.ret');
  const bonEl = stats.querySelector('.bon');
  s4.append(l4.node, big, stats);
  const numC = mid(box(num));
  const bigC = mid(box(big));

  // --- Scene 5: the payout becomes the Predict button ---
  const s5 = scene(root, 'gap:56px');
  const l5 = line(['one', 'more', 'tap', 'to', 'place', 'it'], { size: 60 });
  const cta = el(`<div class="btn btn-white" style="height:132px;padding:0;font-size:50px;overflow:hidden;white-space:nowrap"><span class="ct" style="display:inline-flex;align-items:center;gap:18px;padding:0 64px"><span style="display:inline-flex;color:var(--up)">${oIcon('up')}</span>Predict Up for 100 pts</span><span class="ok abs" style="inset:0;display:flex;align-items:center;justify-content:center;gap:16px;opacity:0"><span style="display:inline-flex;font-size:58px">${ico('check')}</span>Placed</span></div>`);
  s5.append(l5.node, cta);
  const ctaW = box(cta).width;
  const ctaC = mid(box(cta));
  const ctaT = cta.querySelector('.ct');
  const ctaOk = cta.querySelector('.ok');
  const ctaTapPt = [ctaC[0] + 60, ctaC[1]];
  const tap3n = el('<div class="tap"></div>');
  root.append(tap3n);
  tap3n.style.left = `${ctaTapPt[0]}px`;
  tap3n.style.top = `${ctaTapPt[1]}px`;
  tap3n.style.zIndex = '20';
  const tap3 = tapAt(tap3n, 13.45);

  // --- Scene 6: the green wipe from the Predict tap ---
  const wipe = el('<div class="abs" style="left:0;top:0;border-radius:50%;background:var(--up);z-index:55"></div>');
  root.append(wipe);
  const s6 = scene(root, 'z-index:56;gap:40px');
  const l6 = line(['your', 'call', 'is', 'in'], { size: 96, weight: 600, color: '#09090b' });
  const youTag = el(`<div style="display:flex;align-items:center;gap:14px;height:84px;padding:0 34px 0 28px;border-radius:999px;background:#09090b;color:#8ef0a8;font-size:40px;font-weight:600;letter-spacing:-0.02em"><span style="display:inline-flex;font-size:42px">${oIcon('up')}</span>You 100 on Up</div>`);
  const pool = el('<div class="mono" style="font-size:34px;color:rgba(9,9,11,0.72)">pool <span class="pv">760</span> pts</div>');
  s6.append(l6.node, youTag, pool);
  const poolV = pool.querySelector('.pv');

  // --- Scene 7: end card. The wipe's dot becomes the pill's dot (as in video 1) ---
  const s7 = scene(root, 'gap:40px;z-index:57');
  const endPill = el(`<div style="display:flex;align-items:center;gap:14px;height:58px;padding:0 26px 0 22px;border-radius:999px;background:rgba(48,209,88,0.1);box-shadow:inset 0 0 0 1.5px rgba(48,209,88,0.38);overflow:hidden;white-space:nowrap">
    <i class="dot" style="flex:none;width:14px;height:14px;border-radius:50%;background:var(--up);box-shadow:0 0 0 6px rgba(48,209,88,0.2)"></i>
    <span class="pt" style="font-size:26px;font-weight:500;color:#8ef0a8">Testnet live on Solana</span></div>`);
  const endWord = el(`<div class="wordmark" style="font-size:128px;gap:34px">${logo(140)}<span>Firstprint</span></div>`);
  const endUrl = el('<div class="btn btn-white" style="height:104px;padding:0 54px;font-size:44px;margin-top:6px">firstprint.fun</div>');
  s7.append(endPill, endWord, endUrl);
  const endPillW = endPill.getBoundingClientRect().width;
  const endDotC = mid(endPill.querySelector('.dot').getBoundingClientRect());
  const endPillText = endPill.querySelector('.pt');

  const black = el('<div class="abs" style="left:0;top:0;width:1080px;height:1080px;background:#000;z-index:60;pointer-events:none"></div>');
  root.append(black);

  return (t) => {
    // Scene 1 (0–2.7): words, grow, three tap dots; the middle dot becomes the SOL coin.
    show(s1, t < 2.7);
    if (t < 2.7) {
      l1.spans.forEach((sp, i) => wordIn(sp, t, 0.3 + i * 0.22));
      const grow = ep(t, 1.35, 2.0, ease.inOut);
      const out = ep(t, 2.12, 2.42, ease.in);
      exit(s1, out, (1 + 0.03 * t) * lerp(1, 1.3, grow));
    }
    show(sC, t > 1.55 && t < 3.0);
    if (t > 1.55 && t < 3.0) {
      const merge = ep(t, 2.1, 2.4, ease.inOut);
      dots.forEach((d, i) => {
        const k = ep(t, 1.6 + i * 0.12, 1.9 + i * 0.12, ease.back);
        const dx = (1 - i) * 76 * merge;
        const lift = i === 1 ? -96 * ep(t, 2.25, 2.75, ease.inOut) : 0;
        d.style.transform = `translate(${dx}px, ${lift}px) scale(${lerp(0.2, 1, k)})`;
        d.style.opacity = String(clamp(k * 2) * (1 - ep(t, 2.3, 2.45)));
      });
      // The coin grows out of the merged dot and lands at the card token's on-screen size.
      const c = ep(t, 2.25, 2.75, ease.inOut);
      coin.style.opacity = String(ep(t, 2.27, 2.4) * (1 - ep(t, 2.85, 2.95)));
      coin.style.transform = `translateY(${(1 - c) * 96}px) scale(${lerp(0.24, 2.6, c)})`;
      coin.style.filter = c > 0 && c < 1 ? `blur(${Math.sin(c * Math.PI) * 4}px)` : 'none';
    }

    // Card world, scene 2 (2.75–6.95).
    const cardOn = t > 2.75 && t < 7.0;
    s.world.style.display = cardOn ? 'block' : 'none';
    if (cardOn) {
      rows.forEach((r, i) => {
        const k = ep(t, 4.0 + i * 0.14, 4.45 + i * 0.14, ease.outQuint);
        r.style.opacity = String(k);
        r.style.transform = `translateY(${(1 - k) * 50}px) scale(${i === 1 ? pressScale(t, 6.2) : 1})`;
        r.style.filter = k < 0.9 ? `blur(${(1 - k) * 8}px)` : 'none';
        const f = ep(t, 4.3 + i * 0.14, 5.3 + i * 0.14, ease.outQuint);
        barEls[i].style.width = `${PCTS[i] * f}%`;
        pcEls[i].textContent = `${fmt(PCTS[i] * f)}%`;
      });
      up.classList.toggle('sel', t >= 6.2);
      tapUp(t);
      const cam = keys(t, [
        [2.75, { x: avC[0], y: avC[1], z: 2.6, r: 0 }],
        [3.6, { x: avC[0] + 230, y: avC[1] + 30, z: 1.45, r: -0.8 }],
        [4.4, { x: CX, y: camFull, z: 0.98, r: 0 }],
        [6.05, { x: CX, y: camFull + 10, z: 1.03, r: 0.3 }],
        [6.4, { x: CX + 20, y: camFull - 20, z: 1.1, r: 0 }],
        [6.95, { x: upName[0], y: upName[1], z: 2.9, r: 0 }],
      ]);
      s.camera(cam.x, cam.y, cam.z, cam.r);
      const wIn = ep(t, 2.75, 2.95, ease.out);
      const wOut = ep(t, 6.6, 6.95, ease.in);
      const o = Math.min(wIn, 1 - wOut);
      s.world.style.opacity = String(o);
      s.world.style.filter = o < 1 ? `blur(${(1 - o) * 12}px)` : 'none';
    }
    show(s2, t > 4.3 && t < 6.1);
    if (t > 4.3 && t < 6.1) {
      l2.spans.forEach((sp, i) => wordIn(sp, t, 4.4 + i * 0.15));
      exit(s2, ep(t, 5.8, 6.05, ease.in), 1 + 0.02 * (t - 4.4), -1);
    }

    // Scene 3 (6.75–9.35): the Up pill arrives from the dive, chips cascade, tap 100.
    show(s3, t > 6.75 && t < 9.4);
    if (t > 6.75 && t < 9.4) {
      const pk = ep(t, 6.75, 7.2, ease.outQuint);
      upPill.style.transform = `translate(${(upName[0] - pillC[0]) * 0 * (1 - pk)}px, ${(CY - pillC[1]) * (1 - pk)}px) scale(${lerp(2.4, 1, pk)})`;
      upPill.style.opacity = String(clamp(pk * 2));
      upPill.style.filter = pk < 1 ? `blur(${(1 - pk) * 10}px)` : 'none';
      l3.spans.forEach((sp, i) => wordIn(sp, t, 7.1 + i * 0.15));
      chips.forEach((c, i) => {
        const k = ep(t, 7.75 + i * 0.1, 8.2 + i * 0.1, ease.outQuint);
        const on = i === 2 && t >= 8.7;
        c.style.opacity = String(clamp(k * 1.4) * (i === 2 ? 1 : 1 - ep(t, 8.95, 9.2)));
        const blur = (1 - k) * 10 + (i === 2 ? 0 : ep(t, 8.95, 9.2) * 8);
        c.style.filter = blur > 0.05 ? `blur(${blur}px)` : 'none';
        c.style.background = on ? 'var(--text)' : 'var(--surface)';
        c.style.color = on ? '#09090b' : 'var(--text)';
        c.style.borderColor = on ? 'var(--text)' : 'var(--line-strong)';
        let tr = `translateX(${(1 - k) * 160}px) scale(${i === 2 ? pressScale(t, 8.7) : 1})`;
        if (i === 2) {
          // The chosen chip flies into the middle and becomes the big number.
          // Targets are corrected for scene 3's push-in so the hand-off to scene 4 lines up.
          const f = ep(t, 8.95, 9.35, ease.inOut);
          const sc3 = 1 + 0.02 * (t - 6.75);
          const tx = (numC[0] - CX) / sc3 + CX - chipC[0];
          const ty = (numC[1] - CY) / sc3 + CY - chipC[1];
          tr = `translate(${tx * f}px, ${ty * f}px) scale(${pressScale(t, 8.7) * lerp(1, 210 / 48 / sc3, f)})`;
          if (on) {
            c.style.background = `rgba(245,245,247,${1 - ep(t, 8.95, 9.2)})`;
            c.style.borderColor = `rgba(245,245,247,${1 - ep(t, 8.95, 9.2)})`;
            if (f > 0.15) c.style.color = 'var(--text)';
          }
          if (f > 0 && f < 1) c.style.filter = `blur(${Math.sin(f * Math.PI) * 5}px)`;
          c.style.fontWeight = f > 0 ? '600' : '500';
          c.style.opacity = String(t < 9.35 ? clamp(k * 1.4) : 0);
        }
        c.style.transform = tr;
      });
      const out = ep(t, 8.95, 9.3, ease.in);
      upPill.style.opacity = String(clamp(pk * 2) * (1 - out));
      l3.node.style.opacity = String(1 - out);
      l3.node.style.filter = out > 0 ? `blur(${out * 12}px)` : 'none';
      l3.node.style.transform = `scale(${1 + 0.2 * out})`;
      s3.style.transform = `scale(${1 + 0.02 * (t - 6.75)})`;
    }
    tap2(t);

    // Scene 4 (9.3–12.55): the number counts from the stake to the payout.
    show(s4, t > 9.3 && t < 12.6);
    if (t > 9.3 && t < 12.6) {
      num.style.opacity = t >= 9.35 ? '1' : '0';
      const c = ep(t, 10.2, 11.25, ease.inOut);
      num.textContent = fmt(lerp(100, 770, c));
      const land = ep(t, 11.25, 11.4, ease.out) * (1 - ep(t, 11.4, 11.6));
      num.style.color = c > 0 ? `color-mix(in srgb, var(--up) ${c * 100}%, var(--text))` : 'var(--text)';
      big.style.transform = `scale(${1 + 0.06 * land})`;
      const pl = ep(t, 9.35, 9.7, ease.outQuint);
      ptsLabel.style.opacity = String(pl);
      ptsLabel.style.transform = `translateX(${(1 - pl) * -30}px)`;
      l4.spans.forEach((sp, i) => wordIn(sp, t, 9.55 + i * 0.1));
      statEls.forEach((n, i) => {
        const k = ep(t, 11.4 + i * 0.15, 11.8 + i * 0.15, ease.outQuint);
        n.style.opacity = String(k);
        n.style.transform = `translateY(${(1 - k) * 30}px)`;
        n.style.filter = k < 1 ? `blur(${(1 - k) * 8}px)` : 'none';
      });
      retEl.textContent = `${(1 + 6.7 * ep(t, 11.4, 12.1, ease.out)).toFixed(2)}×`;
      bonEl.textContent = `${(1 + 0.42 * ep(t, 11.55, 12.2, ease.out)).toFixed(2)}×`;
      // Exit: the words and stats blur away; the number shrinks into the button.
      const out = ep(t, 12.2, 12.5, ease.in);
      [l4.node, stats].forEach((n) => {
        n.style.opacity = String(1 - out);
        n.style.filter = out > 0 ? `blur(${out * 12}px)` : 'none';
      });
      num.style.opacity = String((t >= 9.35 ? 1 : 0) * (1 - ep(t, 12.3, 12.55)));
      ptsLabel.style.opacity = String(pl * (1 - out));
      big.style.transform = `translateY(${(ctaC[1] - bigC[1]) * out}px) scale(${(1 + 0.06 * land) * lerp(1, 0.3, out)})`;
      big.style.filter = out > 0 ? `blur(${out * 6}px)` : 'none';
      s4.style.transform = `scale(${1 + 0.02 * (t - 9.3)})`;
    }

    // Scene 5 (12.3–13.95): the Predict button grows, one more tap.
    show(s5, t > 12.3 && t < 14.1);
    if (t > 12.3 && t < 14.1) {
      const g = ep(t, 12.35, 12.85, ease.outQuint);
      cta.style.width = `${lerp(132, ctaW, g)}px`;
      cta.style.opacity = String(ep(t, 12.3, 12.45));
      ctaT.style.opacity = String(ep(t, 12.42, 12.7) * (1 - ep(t, 13.45, 13.55)));
      ctaOk.style.opacity = String(ep(t, 13.5, 13.62));
      cta.style.background = `color-mix(in srgb, var(--up) ${ep(t, 13.45, 13.6) * 100}%, var(--text))`;
      cta.style.transform = `scale(${pressScale(t, 13.45) * lerp(0.9, 1, g)})`;
      l5.spans.forEach((sp, i) => wordIn(sp, t, 12.7 + i * 0.12));
      l5.node.style.opacity = String(1 - ep(t, 13.55, 13.8));
      s5.style.transform = `scale(${1 + 0.03 * (t - 12.3)})`;
    }
    tap3(t);

    // Circle wipe: grows out of the Predict tap, holds green, then shrinks into the end pill's dot.
    const grow = ep(t, 13.55, 14.1, ease.in);
    const shrink = ep(t, 16.85, 17.35, ease.inOut);
    const R = t < 16.85 ? lerp(40, 900, grow) : lerp(900, 7, shrink);
    const gc = ep(t, 13.55, 14.1);
    const wc = t < 16.85 ? [lerp(ctaTapPt[0], CX, gc), lerp(ctaTapPt[1], CY, gc)] : [lerp(CX, endDotC[0], shrink), lerp(CY, endDotC[1], shrink)];
    const wipeOn = t > 13.55 && t < 17.4;
    wipe.style.display = wipeOn ? 'block' : 'none';
    wipe.style.width = wipe.style.height = `${R * 2}px`;
    wipe.style.left = `${wc[0] - R}px`;
    wipe.style.top = `${wc[1] - R}px`;

    // Scene 6 (14.05–16.9): on green.
    show(s6, t > 14.0 && t < 16.95);
    if (t > 14.0 && t < 16.95) {
      l6.spans.forEach((sp, i) => wordIn(sp, t, 14.1 + i * 0.16));
      const tk = ep(t, 15.05, 15.45, ease.back);
      youTag.style.opacity = String(clamp(tk * 2));
      youTag.style.transform = `scale(${lerp(0.4, 1, tk)})`;
      const pk = ep(t, 15.35, 15.7, ease.outQuint);
      pool.style.opacity = String(pk);
      pool.style.transform = `translateY(${(1 - pk) * 20}px)`;
      poolV.textContent = fmt(760 + 100 * ep(t, 15.5, 16.2, ease.out));
      const out = ep(t, 16.65, 16.9, ease.in);
      s6.style.opacity = String(1 - out);
      s6.style.transform = `scale(${(1 + 0.04 * (t - 14.05)) * (1 - 0.2 * out)})`;
      s6.style.filter = out > 0 ? `blur(${out * 8}px)` : 'none';
    }

    // Scene 7: end card (17.3–22), as in video 1.
    show(s7, t > 17.3);
    if (t > 17.3) {
      const pk = ep(t, 17.35, 17.85, ease.outQuint);
      endPill.style.width = `${lerp(14 + 22 + 26, endPillW, pk)}px`;
      endPill.style.background = `rgba(48,209,88,${0.1 * ep(t, 17.35, 17.6)})`;
      endPill.style.boxShadow = `inset 0 0 0 1.5px rgba(48,209,88,${0.38 * ep(t, 17.35, 17.6)})`;
      endPillText.style.opacity = String(ep(t, 17.55, 17.9));
      const wk = ep(t, 17.6, 18.3, ease.outQuint);
      endWord.style.opacity = String(wk);
      endWord.style.transform = `translateY(${(1 - wk) * 30}px)`;
      endWord.style.filter = wk < 1 ? `blur(${(1 - wk) * 10}px)` : 'none';
      const uk = ep(t, 17.95, 18.6, ease.outQuint);
      endUrl.style.opacity = String(uk);
      endUrl.style.transform = `translateY(${(1 - uk) * 30}px) scale(${lerp(0.94, 1, uk)})`;
      s7.style.transform = `scale(${1 + 0.025 * ep(t, 17.3, 22)})`;
    }

    black.style.opacity = String(Math.max(1 - ep(t, 0, 0.25, ease.out), ep(t, DURATION - 0.5, DURATION, ease.in)));
  };
}
