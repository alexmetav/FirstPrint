// Video 1, square X cut, rebuilt with kinetic type and object-led transitions.
// Native 1080×1080: word-by-word text that grows, logo-in-word, tokens orbiting into the card,
// rows cascading in, coloured outcome words, a circle wipe from the Up pick, and a dot that
// becomes the end card's "Testnet live" pill.
import { stage, el, ico, logo, bigMark, marketCard, tap, keys, ep, p, ease, lerp, clamp, setT, fmt, pressScale, OUTCOMES, oIcon } from './lib.js';
import { TOKENS } from './tokens.js';

export const DURATION = 22;
const B = 60 / 104; // one beat of the music bed

/** Sound cues: only where something happens on screen. */
export const SFX = [
  [3.2, 'shimmer'],
  [3.72, 'pop'],
  [5.0, 'swell'],
  [7.1, 'land'],
  ...[0, 1, 2, 3, 4].map((i) => [8.45 + i * 0.14, 'blip', i]),
  ...[12.3, 12.5, 12.68, 12.84, 12.98, 13.16].map((t, i) => [t, 'blip', i]),
  [14.3, 'tap'],
  [14.36, 'pop'],
  [15.95, 'success'],
  [17.35, 'pop'],
  [17.85, 'chime'],
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

const show = (n, on) => (n.style.display = on ? 'flex' : 'none');

export function build() {
  const root = document.querySelector('#stage');
  // A faint green glow low in the frame, under everything.
  root.append(el('<div class="abs" style="left:-200px;top:560px;width:1480px;height:900px;background:radial-gradient(50% 50% at 50% 50%, rgba(48,209,88,0.09), transparent 70%);pointer-events:none"></div>'));

  // --- Card world (scenes 4 and 6) ---
  const s = stage();
  const { node: card, rows } = marketCard({ sym: 'SOL', name: 'Solana', letter: '', pcts: [13, 46, 24, 11, 6] });
  // The card's token is the same SOL coin that flies out of the orbit.
  const cardAv = card.querySelector('.avatar');
  cardAv.style.background = 'none';
  cardAv.style.overflow = 'hidden';
  cardAv.style.boxShadow = '0 0 0 2px rgba(255,255,255,0.14)';
  cardAv.innerHTML = TOKENS.sol.replace('<svg', '<svg width="116" height="116" style="display:block"');
  card.style.left = '80px';
  card.style.top = '300px';
  s.add(card);
  const pcts = [13, 46, 24, 11, 6];
  const barEls = rows.map((r) => r.querySelector('.bar'));
  const pcEls = rows.map((r) => r.querySelector('.pc'));
  const up = rows[1];
  up.querySelector('.you').innerHTML = '<span class="tag-you">You 100</span>';
  const tagEl = up.querySelector('.tag-you');
  s.camera(CX, CY, 1);
  const box = (n) => n.getBoundingClientRect();
  const av = box(card.querySelector('.avatar'));
  const avC = [av.left + av.width / 2, av.top + av.height / 2];
  const head = box(card);
  const r0 = box(rows[0]);
  const r4 = box(rows[4]);
  const upIcon = box(up.querySelector('.nm .i'));
  const upC = [upIcon.left + upIcon.width / 2, upIcon.top + upIcon.height / 2];
  const upRow = box(up);
  const cardMid = [head.left + head.width / 2, (head.top + r4.bottom) / 2];
  const tapUp = tap(s, upRow.left + 260, upRow.top + upRow.height / 2, 14.3);

  // --- Scene 1: "call where crypto lands", word by word, then it grows ---
  const s1 = scene(root);
  const l1 = line(['call', 'where', 'crypto', 'lands'], { size: 62 });
  s1.append(l1.node);

  // --- Scene 2: "the [logo]firstprint testnet" + a pill that grows out of a dot ---
  const s2 = scene(root, 'gap:34px');
  const l2 = line(['the', `<span class="wordmark" style="gap:16px;font-weight:600">${logo(56)}<span>firstprint</span></span>`, 'testnet'], { size: 62 });
  const pill = el(`<div style="display:flex;align-items:center;gap:20px;height:92px;padding:0 34px 0 30px;border-radius:999px;background:rgba(48,209,88,0.12);box-shadow:inset 0 0 0 2px rgba(48,209,88,0.4);overflow:hidden;white-space:nowrap">
    <i style="flex:none;width:22px;height:22px;border-radius:50%;background:var(--up);box-shadow:0 0 0 8px rgba(48,209,88,0.2)"></i>
    <span class="pt" style="font-size:52px;font-weight:600;letter-spacing:-0.03em;color:#8ef0a8">is live</span></div>`);
  s2.append(l2.node, pill);
  const pillW = pill.getBoundingClientRect().width;
  const pillText = pill.querySelector('.pt');
  const logoMark = l2.spans[1].querySelector('.mark');

  // --- Scene 3: tokens orbit the mark, then gather into it ---
  const s3 = scene(root);
  const mark = bigMark(170);
  mark.style.left = `${CX - 85}px`;
  mark.style.top = `${CY - 85}px`;
  s3.append(mark);
  const markBars = [...mark.querySelectorAll('[data-bar]')];
  const HERO = 2; // sol
  const toks = ['btc', 'eth', 'sol', 'bnb', 'xrp', 'doge', 'ada', 'link'].map((k) => TOKENS[k]).map((svg) => {
    const n = el(`<div class="abs" style="width:116px;height:116px;margin:-58px 0 0 -58px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 2px rgba(255,255,255,0.14), 0 18px 40px -16px rgba(0,0,0,0.9)">${svg.replace('<svg', '<svg width="116" height="116" style="display:block"')}</div>`);
    s3.append(n);
    return n;
  });
  const sub3 = line(['new', 'listings,', 'trending', 'tokens,', 'majors'], { size: 40, weight: 400, color: 'var(--muted)', gap: 0.3 });
  sub3.node.style.position = 'absolute';
  sub3.node.style.top = '880px';
  s3.append(sub3.node);

  // --- Scene 5: "pick where the price lands" + the five outcomes in colour ---
  const s5 = scene(root, 'gap:40px');
  const l5 = line(['pick', 'where', 'the', 'price', 'lands'], { size: 58 });
  // The outcomes roll through one slot, slot-machine style, and settle on Up.
  const SLOT = [...OUTCOMES, OUTCOMES[1]];
  const SLOT_H = 120;
  const SLOT_AT = [12.3, 12.5, 12.68, 12.84, 12.98, 13.16];
  const slot = el(`<div style="height:${SLOT_H}px;overflow:hidden;position:relative;width:640px"><div class="reel">${SLOT.map(
    (o) => `<div style="height:${SLOT_H}px;display:flex;align-items:center;justify-content:center;gap:22px;color:${o.c};font-size:96px;font-weight:600;letter-spacing:-0.04em"><span style="display:inline-flex;font-size:0.72em">${oIcon(o.b)}</span>${o.name}</div>`,
  ).join('')}</div></div>`);
  const reel = slot.querySelector('.reel');
  s5.append(l5.node, slot);

  // --- Scene 6 overlay: circle wipe from the Up pick ---
  const wipe = el('<div class="abs" style="left:0;top:0;border-radius:50%;background:var(--up);z-index:55"></div>');
  root.append(wipe);
  const s6 = scene(root, 'z-index:56');
  const l6 = line(['free', 'to', 'play'], { size: 92, weight: 600, color: '#09090b' });
  s6.append(l6.node);

  // --- Scene 7: end card. The wipe's dot becomes the pill's dot ---
  const s7 = scene(root, 'gap:40px;z-index:57');
  const endPill = el(`<div style="display:flex;align-items:center;gap:14px;height:58px;padding:0 26px 0 22px;border-radius:999px;background:rgba(48,209,88,0.1);box-shadow:inset 0 0 0 1.5px rgba(48,209,88,0.38);overflow:hidden;white-space:nowrap">
    <i class="dot" style="flex:none;width:14px;height:14px;border-radius:50%;background:var(--up);box-shadow:0 0 0 6px rgba(48,209,88,0.2)"></i>
    <span class="pt" style="font-size:26px;font-weight:500;color:#8ef0a8">Testnet live on Solana</span></div>`);
  const endWord = el(`<div class="wordmark" style="font-size:128px;gap:34px">${logo(140)}<span>Firstprint</span></div>`);
  const endUrl = el('<div class="btn btn-white" style="height:104px;padding:0 54px;font-size:44px;margin-top:6px">firstprint.fun</div>');
  s7.append(endPill, endWord, endUrl);
  const endPillW = endPill.getBoundingClientRect().width;
  const endDot = endPill.querySelector('.dot').getBoundingClientRect();
  const endDotC = [endDot.left + endDot.width / 2, endDot.top + endDot.height / 2];
  const endPillText = endPill.querySelector('.pt');

  const black = el('<div class="abs" style="left:0;top:0;width:1080px;height:1080px;background:#000;z-index:60;pointer-events:none"></div>');
  root.append(black);

  let upScreen = [CX, CY];
  return (t) => {
    // Scene 1 (0–2.65).
    show(s1, t < 2.7);
    if (t < 2.7) {
      l1.spans.forEach((sp, i) => wordIn(sp, t, 0.3 + i * (B / 2)));
      const grow = ep(t, 1.45, 2.2, ease.inOut);
      const out = ep(t, 2.3, 2.65, ease.in);
      s1.style.transform = `scale(${(1 + 0.03 * t) * lerp(1, 1.45, grow) * (1 + 0.25 * out)})`;
      s1.style.opacity = String(1 - out);
      s1.style.filter = out > 0 ? `blur(${out * 12}px)` : 'none';
    }

    // Scene 2 (2.6–4.75).
    show(s2, t > 2.55 && t < 4.8);
    if (t > 2.55 && t < 4.8) {
      l2.spans.forEach((sp, i) => wordIn(sp, t, 2.65 + i * 0.26));
      const mk = ep(t, 3.12, 3.55, ease.back);
      logoMark.style.transform = `scale(${(56 / 32) * lerp(0.2, 1, mk)}) rotate(${(1 - mk) * -40}deg)`;
      const pk = ep(t, 3.68, 4.15, ease.outQuint);
      pill.style.opacity = String(clamp(ep(t, 3.62, 3.75) * 1));
      pill.style.width = `${lerp(92, pillW, pk)}px`;
      pill.style.transform = `scale(${lerp(0.4, 1, ep(t, 3.62, 3.85, ease.back))})`;
      pillText.style.opacity = String(ep(t, 3.85, 4.15));
      const out = ep(t, 4.45, 4.78, ease.in);
      s2.style.transform = `scale(${(1 + 0.02 * (t - 2.6)) * (1 - 0.35 * out)})`;
      s2.style.opacity = String(1 - out);
      s2.style.filter = out > 0 ? `blur(${out * 10}px)` : 'none';
    }

    // Scene 3 (4.55–7.2): orbit, then gather into the middle.
    show(s3, t > 4.5 && t < 7.25);
    if (t > 4.5 && t < 7.25) {
      const inK = ep(t, 4.55, 5.3, ease.outQuint);
      const gather = ep(t, 6.55, 7.1, ease.in);
      markBars.forEach((b, i) => (b.style.transform = `scaleX(${ep(t, 4.6 + i * 0.07, 5.1 + i * 0.07, ease.outQuint)})`));
      const mScale = lerp(0.6, 1, ep(t, 4.55, 5.2, ease.back)) * (1 - 0.5 * gather) * (1 + 0.04 * (t - 4.55));
      mark.style.transform = `scale(${mScale})`;
      mark.style.opacity = String(1 - ep(t, 6.6, 6.95));
      const s3Scale = 1 + 0.05 * ep(t, 4.55, 7.2);
      toks.forEach((n, i) => {
        const a = (i / toks.length) * Math.PI * 2 + (t - 4.55) * 0.75;
        const hero = i === HERO;
        const g = hero ? 0 : gather;
        const rx = lerp(900, 360, inK) * (1 - g);
        const ry = lerp(600, 170, inK) * (1 - g);
        const depth = (Math.sin(a) + 1) / 2; // 0 back, 1 front
        const x = CX + Math.cos(a) * rx;
        const y = CY + Math.sin(a) * ry - 10;
        const sc = lerp(0.62, 1.12, depth) * lerp(1, 0.3, g);
        if (hero) {
          // SOL leaves the orbit, comes to the front and grows into the card's token.
          const f = ep(t, 6.3, 7.0, ease.inOut);
          n.style.left = `${lerp(x, CX, f)}px`;
          n.style.top = `${lerp(y, CY, f)}px`;
          n.style.transform = `scale(${lerp(sc, 2.6 / s3Scale, f)})`;
          n.style.zIndex = String(f > 0 ? 6 : depth > 0.5 ? 3 : 1);
          n.style.filter = `blur(${(1 - depth) * 3.5 * (1 - f)}px) brightness(${lerp(lerp(0.6, 1, depth), 1, f)})`;
          n.style.opacity = String(clamp(inK * 1.5) * (1 - ep(t, 7.12, 7.24)));
          return;
        }
        n.style.left = `${x}px`;
        n.style.top = `${y}px`;
        n.style.transform = `scale(${sc})`;
        n.style.zIndex = String(depth > 0.5 ? 3 : 1);
        n.style.filter = `blur(${(1 - depth) * 3.5 + gather * 4}px) brightness(${lerp(0.6, 1, depth)})`;
        n.style.opacity = String(clamp(inK * 1.5) * (1 - ep(t, 6.85, 7.05)));
      });
      mark.style.zIndex = '2';
      sub3.spans.forEach((sp, i) => wordIn(sp, t, 5.35 + i * 0.16));
      sub3.node.style.opacity = String(1 - ep(t, 6.4, 6.7));
      s3.style.transform = `scale(${s3Scale})`;
    }

    // Card world: scene 4 (7.05–11.5) and scene 6 (13.45–15.7).
    const cardOn = (t > 7.0 && t < 11.6) || (t > 13.4 && t < 16.1);
    s.world.style.display = cardOn ? 'block' : 'none';
    if (cardOn) {
      rows.forEach((r, i) => {
        const k = ep(t, 8.4 + i * 0.14, 8.85 + i * 0.14, ease.outQuint);
        r.style.opacity = String(k);
        r.style.transform = `translateY(${(1 - k) * 50}px) scale(${i === 1 ? pressScale(t, 14.3) : 1})`;
        const f = ep(t, 8.7 + i * 0.14, 9.7 + i * 0.14, ease.outQuint);
        const extra = i === 1 ? ep(t, 14.45, 15.0) : 0;
        barEls[i].style.width = `${pcts[i] * f + extra}%`;
        pcEls[i].textContent = `${fmt(pcts[i] * f + extra)}%`;
      });
      const cIn = ep(t, 7.0, 7.25, ease.out);
      card.style.opacity = String(cIn);
      card.style.filter = cIn < 1 ? `blur(${(1 - cIn) * 14}px)` : 'none';
      const sel = t >= 14.3;
      up.classList.toggle('sel', sel);
      const tk = ep(t, 14.36, 14.8, ease.back);
      tagEl.style.display = sel ? 'inline-flex' : 'none';
      tagEl.style.transform = `scale(${lerp(0.4, 1, tk)})`;
      tagEl.style.opacity = String(clamp(tk * 2));
      card.querySelector('.pool').textContent = `${fmt(760 + 100 * ep(t, 14.4, 15.0))} pts`;
      tapUp(t);
      let cam;
      if (t < 12) {
        cam = keys(t, [
          [7.0, { x: avC[0], y: avC[1], z: 2.6, r: 0 }],
          [7.9, { x: avC[0] + 200, y: avC[1] + 20, z: 1.5, r: -0.8 }],
          [8.6, { x: CX, y: r0.top + 120, z: 1.18, r: 0 }],
          [9.9, { x: CX, y: (r0.top + r4.bottom) / 2 - 20, z: 1.08, r: 0.4 }],
          [10.9, { x: cardMid[0], y: cardMid[1], z: 0.84, r: 0 }],
          [11.6, { x: cardMid[0], y: cardMid[1], z: 0.8, r: 0 }],
        ]);
      } else {
        cam = keys(t, [
          [13.4, { x: upC[0] + 220, y: upC[1] - 60, z: 1.95, r: 0.8 }],
          [14.1, { x: upC[0] + 230, y: upC[1] - 20, z: 1.55, r: 0 }],
          [14.9, { x: upC[0] + 200, y: upC[1], z: 1.6, r: 0 }],
          [15.45, { x: upC[0], y: upC[1], z: 1.9, r: 0 }],
        ]);
      }
      s.camera(cam.x, cam.y, cam.z, cam.r);
      upScreen = [CX + (upC[0] - cam.x) * cam.z, CY + (upC[1] - cam.y) * cam.z];
      const wOut = ep(t, 11.15, 11.55, ease.in);
      const wIn = ep(t, 13.4, 13.85, ease.outQuint);
      const o = t < 12 ? 1 - wOut : wIn;
      s.world.style.opacity = String(o);
      s.world.style.filter = o < 1 ? `blur(${(1 - o) * 12}px)` : 'none';
    }

    // Scene 5 (11.4–13.5).
    show(s5, t > 11.35 && t < 13.65);
    if (t > 11.35 && t < 13.65) {
      l5.spans.forEach((sp, i) => wordIn(sp, t, 11.45 + i * 0.15));
      // Reel: first word rises in, then each step snaps to the next outcome.
      const enter = ep(t, SLOT_AT[0], SLOT_AT[0] + 0.25, ease.outQuint);
      let pos = 0;
      let blur = (1 - enter) * 8;
      for (let k = 1; k < SLOT_AT.length; k++) {
        const q = p(t, SLOT_AT[k], SLOT_AT[k] + 0.13);
        pos += ease.outQuint(q);
        if (q > 0 && q < 1) blur = Math.max(blur, (1 - q) * 6);
      }
      reel.style.transform = `translateY(${-pos * SLOT_H + (1 - enter) * SLOT_H}px)`;
      reel.style.filter = blur > 0.05 ? `blur(${blur}px)` : 'none';
      slot.style.opacity = String(clamp(enter * 1.5));
      slot.style.transform = `scale(${lerp(1, 1.08, ep(t, 13.16, 13.3, ease.out)) * lerp(1, 1 / 1.08, ep(t, 13.3, 13.45))})`;
      const out = ep(t, 13.45, 13.62, ease.in);
      s5.style.transform = `scale(${(1 + 0.03 * (t - 11.4)) * (1 + 0.08 * out)})`;
      s5.style.opacity = String(1 - out);
      s5.style.filter = out > 0 ? `blur(${out * 10}px)` : 'none';
    }

    // Circle wipe: grows out of the Up pick, holds green, then shrinks into the end pill's dot.
    const grow = ep(t, 15.4, 15.95, ease.in);
    const shrink = ep(t, 16.85, 17.35, ease.inOut);
    const R = t < 16.85 ? lerp(10, 900, grow) : lerp(900, 7, shrink);
    const wc = t < 16.85 ? [lerp(upScreen[0], CX, ep(t, 15.4, 15.95)), lerp(upScreen[1], CY, ep(t, 15.4, 15.95))] : [lerp(CX, endDotC[0], shrink), lerp(CY, endDotC[1], shrink)];
    const wipeOn = t > 15.4 && t < 17.4;
    wipe.style.display = wipeOn ? 'block' : 'none';
    wipe.style.width = wipe.style.height = `${R * 2}px`;
    wipe.style.left = `${wc[0] - R}px`;
    wipe.style.top = `${wc[1] - R}px`;
    show(s6, t > 15.85 && t < 16.95);
    if (t > 15.85 && t < 16.95) {
      l6.spans.forEach((sp, i) => wordIn(sp, t, 15.92 + i * 0.16));
      const out = ep(t, 16.7, 16.92, ease.in);
      s6.style.opacity = String(1 - out);
      s6.style.transform = `scale(${(1 + 0.04 * (t - 15.9)) * (1 - 0.2 * out)})`;
    }

    // Scene 7: end card (17.3–22).
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
