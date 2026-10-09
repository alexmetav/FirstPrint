// Video 4, square X cut: free points every day, rebuilt in the video 1 style.
// Native 1080×1080: word-by-word lines that grow, a flame pill that becomes the first streak
// circle, the streak filling +50 … +200, the "500" of a line flying into the task card, a Verify
// tap whose green Done button floods the screen, and the end card from video 1.
import { stage, el, ico, logo, coins, tap, keys, ep, ease, lerp, clamp, fmt, pressScale } from './lib.js';

export const DURATION = 22;
const B = 60 / 104; // one beat of the music bed

const DAYS = [50, 75, 100, 125, 150, 175, 200];
const FILL_AT = DAYS.map((_, i) => 5.15 + i * 0.38);
const TAP_AT = 11.6;
const DONE_AT = 12.9;
const COIN_AT = 13.0;
const COIN_DUR = 0.95;
const COIN_N = 12;
// gen_audio.py lands a 'coins' cue at t + (0.95 + i·0.045) × 1.22 (STRETCH, meant for the v-videos),
// so the cue goes early by that amount to chime when these coins actually land.
const COIN_CUE = COIN_AT + COIN_DUR - 0.95 * 1.22;

/** Sound cues: only where something happens on screen. */
export const SFX = [
  [0.95, 'shimmer'],
  [3.32, 'pop'],
  [4.62, 'swell'],
  ...FILL_AT.map((t, i) => [t, 'blip', i]),
  [FILL_AT[6] + 0.08, 'shimmer'],
  [10.45, 'land'],
  ...[0, 1, 2].map((i) => [10.6 + i * 0.15, 'blip', i + 2]),
  [TAP_AT, 'tap'],
  [TAP_AT + 1.05, 'tick'],
  [DONE_AT, 'success'],
  [COIN_CUE, 'coins', COIN_N],
  [14.05, 'cash'],
  [15.45, 'swell'],
  [16.9, 'pop'],
  [17.4, 'chime'],
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
const blurOf = (v) => (v > 0.05 ? `blur(${v}px)` : 'none');
const flame = (style = '') => ico('flame').replace('class="i"', `class="i" style="color:#ff9f0a;${style}"`);
const xMark = (size) => ico('x').replace('class="i i-fill"', `class="i" style="fill:currentColor;stroke:none;width:${size}px;height:${size}px"`);

/** Screen position of a world rect centre under camera (x, y, z), rotation ignored (it is tiny). */
const toScreen = (c, cam) => [CX + (c[0] - cam.x) * cam.z, CY + (c[1] - cam.y) * cam.z];

export function build() {
  const root = document.querySelector('#stage');
  // A faint warm glow low in the frame, under everything.
  root.append(el('<div class="abs" style="left:-200px;top:560px;width:1480px;height:900px;background:radial-gradient(50% 50% at 50% 50%, rgba(48,209,88,0.08), transparent 70%);pointer-events:none"></div>'));

  // --- Streak world (scene 3) ---
  const sa = stage();
  const streak = el(`<div class="card" style="left:80px;top:300px;width:920px;padding:40px 44px 44px">
    <div style="display:flex;align-items:center;gap:22px">
      <span style="display:grid;place-items:center;width:84px;height:84px;border-radius:24px;background:rgba(255,159,10,0.14);font-size:44px">${flame()}</span>
      <div><div class="eyebrow" style="font-size:24px">Daily streak</div><div class="title" style="font-size:52px;font-weight:600;letter-spacing:-0.03em;margin-top:4px">No streak yet</div></div>
      <span class="chip fl" style="margin-left:auto">${flame()}<span class="n">0</span></span>
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:44px">${DAYS.map(
      (v) => `<div style="display:grid;justify-items:center;gap:14px"><span class="dot" style="display:grid;place-items:center;width:92px;height:92px;border-radius:50%;border:3px solid #35353e;color:#09090b;font-size:46px"></span><span class="mono lbl" style="font-size:28px;color:var(--muted)">+${v}</span></div>`,
    ).join('')}</div>
    <div class="muted" style="font-size:28px;margin-top:34px">One claim a day (UTC). Miss a day and it resets.</div>
  </div>`);
  sa.add(streak);
  const dots = [...streak.querySelectorAll('.dot')];
  const lbls = [...streak.querySelectorAll('.lbl')];
  const sTitle = streak.querySelector('.title');
  const sFlameN = streak.querySelector('.fl .n');
  const sFlameChip = streak.querySelector('.fl');
  sa.camera(CX, CY, 1);
  const dotC = dots.map((d) => {
    const b = d.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  });
  const sBox = streak.getBoundingClientRect();
  const sMid = [sBox.left + sBox.width / 2, sBox.top + sBox.height / 2];
  const Z0 = 1.6; // camera zoom when the pill lands on the first circle

  // --- Task world (scene 5) ---
  const sb = stage();
  const bar = el(`<div class="abs" style="left:80px;top:250px;width:920px;display:flex;align-items:center;gap:16px">
    <span class="wordmark" style="font-size:44px">${logo(58)}<span>Firstprint</span></span>
    <span class="chip" style="margin-left:auto">${flame()}<span>7</span></span>
    <span class="chip pts">${ico('coins')}<span class="v">1,000</span><span class="muted" style="font-size:26px">pts</span></span>
  </div>`);
  sb.add(bar);
  const ptsChip = bar.querySelector('.pts');
  const ptsV = bar.querySelector('.pts .v');
  const tile = (inner, s = 96) => `<span style="flex:none;display:grid;place-items:center;width:${s}px;height:${s}px;border-radius:${s * 0.27}px;background:#1d1d22;box-shadow:inset 0 0 0 2px #35353e;font-size:${s * 0.46}px">${inner}</span>`;
  const task = el(`<div class="card" style="left:80px;top:370px;width:920px;overflow:hidden">
    <div style="padding:38px 40px 40px">
      <div class="eyebrow" style="font-size:24px">Tasks</div>
      <div style="display:flex;align-items:center;gap:26px;margin-top:26px">
        ${tile(xMark(42))}
        <div style="flex:1"><div style="font-size:40px;font-weight:600;letter-spacing:-0.02em">Follow @firstprintapp on X</div><div class="rw" style="font-size:34px;color:var(--up);margin-top:6px;font-weight:600;display:flex"><span class="rwa">+</span><span class="n500">500</span><span class="rwa" style="margin-left:0.25em">points</span></div></div>
      </div>
      <div class="btns" style="display:flex;gap:18px;margin-top:32px">
        <div class="btn btn-ghost" style="flex:1"><span style="display:inline-flex">${ico('external')}</span>Open</div>
        <div class="btn btn-white verify" style="flex:1.4"><span class="vt"></span></div>
      </div>
    </div>
    ${[
      ['telegram', 'Join the Telegram group', '+300'],
      ['userPlus', 'Invite a friend', '+250'],
    ]
      .map(
        ([ic, txt, v]) => `<div class="trow" style="display:flex;align-items:center;gap:24px;height:120px;padding:0 40px;border-top:1.5px solid var(--line)">${tile(ico(ic), 72)}<span style="flex:1;font-size:34px;font-weight:500;color:#d4d4d8">${txt}</span><span class="mono" style="font-size:32px;color:var(--up)">${v}</span></div>`,
      )
      .join('')}
  </div>`);
  sb.add(task);
  const verify = task.querySelector('.verify');
  const vt = task.querySelector('.vt');
  const n500 = task.querySelector('.n500');
  const rwA = [...task.querySelectorAll('.rwa')];
  const trows = [...task.querySelectorAll('.trow')];
  const btns = task.querySelector('.btns');
  sb.camera(CX, CY, 1);
  const cOf = (n) => {
    const b = n.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  };
  const n500C = cOf(n500);
  const vC = cOf(verify);
  const chipC = cOf(ptsChip);
  const tBox = task.getBoundingClientRect();
  const allMid = [CX, (chipC[1] - 45 + tBox.bottom) / 2];
  const tapV = tap(sb, vC[0] + 80, vC[1], TAP_AT);
  const taskCam = (t) =>
    keys(t, [
      [9.9, { x: n500C[0] + 40, y: n500C[1] - 20, z: 1.75, r: -0.6 }],
      [10.45, { x: n500C[0] + 40, y: n500C[1] - 20, z: 1.6, r: 0 }],
      [11.05, { x: allMid[0], y: allMid[1] - 40, z: 1.04, r: 0.3 }],
      [11.5, { x: vC[0] - 60, y: vC[1] - 80, z: 1.32, r: 0 }],
      [12.95, { x: vC[0] - 60, y: vC[1] - 90, z: 1.4, r: -0.3 }],
      [13.35, { x: CX, y: (chipC[1] + vC[1]) / 2, z: 1.08, r: 0 }],
      [14.95, { x: CX, y: (chipC[1] + vC[1]) / 2 - 10, z: 1.14, r: 0.2 }],
    ]);
  const taskCoins = coins(sb, {
    at: COIN_AT,
    count: COIN_N,
    seed: 11,
    dur: COIN_DUR,
    from: () => cOf(verify),
    to: () => {
      const b = ptsChip.getBoundingClientRect();
      return [b.left + 44, b.top + b.height / 2];
    },
  });

  // --- Scene 1: "free [coin] points, every day" ---
  const s1 = scene(root);
  const coinIcon = '<i class="cn" style="display:inline-block;width:0.78em;height:0.78em;margin-right:0.2em;border-radius:50%;background:radial-gradient(circle at 35% 30%, #fff3a8, #ffd60a 45%, #c79a00 100%);box-shadow:0 0 0 2px rgba(0,0,0,0.25) inset, 0 8px 22px -8px rgba(255,214,10,0.7)"></i>';
  const l1 = line(['free', `${coinIcon}<span>points,</span>`, 'every', 'day'], { size: 66 });
  s1.append(l1.node);
  const cn = l1.spans[1].querySelector('.cn');

  // --- Scene 2: "keep the streak going" + a flame pill that grows out of a dot ---
  const s2 = scene(root, 'gap:38px');
  const l2 = line(['keep', 'the', 'streak', 'going'], { size: 62 });
  const pill = el(`<div style="display:flex;align-items:center;justify-content:center;gap:18px;height:92px;padding:0 34px 0 28px;border-radius:999px;background:rgba(255,159,10,0.12);box-shadow:inset 0 0 0 2px rgba(255,159,10,0.5);overflow:hidden;white-space:nowrap">
    <span class="fi" style="flex:none;display:inline-flex;font-size:44px">${flame()}</span>
    <span class="pt" style="font-size:46px;font-weight:600;letter-spacing:-0.03em;color:#ffc56b">up to +200 a day</span></div>`);
  s2.append(l2.node, pill);
  const pillW = pill.getBoundingClientRect().width;
  const pillText = pill.querySelector('.pt');
  const pillIcon = pill.querySelector('.fi');
  const pb = pill.getBoundingClientRect();
  const pillDy = CY - (pb.top + pb.height / 2);

  // --- Scene 4: "finish a task for 500 more", the 500 flies into the task card ---
  const s4 = scene(root);
  const l4 = line(['finish', 'a', 'task', 'for', '<span style="color:var(--up);font-weight:600">500</span>', 'more'], { size: 60 });
  s4.append(l4.node);
  const sp500 = l4.spans[4];
  const s4Scale = (t) => (1 + 0.03 * (t - 8.5)) * lerp(1, 1.16, ep(t, 9.3, 9.85, ease.inOut));
  const b500 = sp500.getBoundingClientRect();
  const c500 = [b500.left + b500.width / 2, b500.top + b500.height / 2];
  const flyer = el('<div class="abs" style="left:0;top:0;z-index:40;font-size:60px;font-weight:600;letter-spacing:-0.035em;color:var(--up);line-height:1.1;white-space:nowrap;transform-origin:50% 50%">500</div>');
  root.append(flyer);
  const fb = flyer.getBoundingClientRect();
  const nb = n500.getBoundingClientRect();

  // --- Green wipe from the Done button, then the end card ---
  const wipe = el('<div class="abs" style="left:0;top:0;border-radius:50%;background:var(--up);z-index:55"></div>');
  root.append(wipe);
  const s6 = scene(root, 'z-index:56');
  const l6 = line(['start', 'your', 'streak'], { size: 96, weight: 600, color: '#09090b' });
  s6.append(l6.node);

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

  const W0 = 14.9; // wipe starts
  const W1 = 16.4; // wipe starts shrinking
  const E = 16.85; // end card

  const streakCam = (t) => {
    // Hold on the first circle, glide along the row with the fills, then pull back to the card.
    const k = ease.smooth(clamp((t - (FILL_AT[0] - 0.25)) / (FILL_AT[6] - FILL_AT[0] + 0.25)));
    const along = {
      x: lerp(dotC[0][0] + 60, dotC[6][0] - 60, k),
      y: dotC[0][1] - 40 * k,
      z: lerp(Z0, 1.42, ep(t, 4.65, FILL_AT[3])),
      r: 0.6 * Math.sin(Math.PI * k),
    };
    const hold = ep(t, 4.65, FILL_AT[0], ease.inOut);
    const a = { x: lerp(dotC[0][0], along.x, hold), y: lerp(dotC[0][1], along.y, hold), z: along.z, r: along.r };
    const back = ep(t, FILL_AT[6] + 0.2, 8.1, ease.inOut);
    const zEnd = lerp(1.02, 1.07, ep(t, 8.1, 8.6));
    return { x: lerp(a.x, sMid[0], back), y: lerp(a.y, sMid[1], back), z: lerp(a.z, zEnd, back), r: lerp(a.r, 0, back) };
  };

  return (t) => {
    // Scene 1 (0–2.65).
    show(s1, t < 2.7);
    if (t < 2.7) {
      l1.spans.forEach((sp, i) => wordIn(sp, t, 0.3 + i * (B / 2)));
      const ck = ep(t, 0.75, 1.15, ease.back);
      cn.style.transform = `scale(${lerp(0.2, 1, ck)}) rotateY(${(1 - ep(t, 0.6, 1.25, ease.out)) * 540}deg)`;
      const grow = ep(t, 1.45, 2.2, ease.inOut);
      const out = ep(t, 2.3, 2.65, ease.in);
      s1.style.transform = `scale(${(1 + 0.03 * t) * lerp(1, 1.4, grow) * (1 + 0.25 * out)})`;
      s1.style.opacity = String(1 - out);
      s1.style.filter = blurOf(out * 12);
    }

    // Scene 2 (2.6–4.8): the line, then the pill; the pill collapses into the first streak circle.
    show(s2, t > 2.55 && t < 4.62);
    if (t > 2.55 && t < 4.62) {
      l2.spans.forEach((sp, i) => wordIn(sp, t, 2.65 + i * 0.18));
      const lOut = ep(t, 4.25, 4.55, ease.in);
      l2.node.style.opacity = String(1 - lOut);
      l2.node.style.filter = blurOf(lOut * 10);
      l2.node.style.transform = `scale(${1 + 0.02 * (t - 2.6) - 0.2 * lOut})`;
      // Pill: a dot that opens into the pill, holds, then closes back to a circle at the centre.
      const open = ep(t, 3.32, 3.78, ease.outQuint);
      const close = ep(t, 4.25, 4.6, ease.inOut);
      pill.style.opacity = String(clamp(ep(t, 3.25, 3.37)));
      pill.style.width = `${lerp(92, pillW, open * (1 - close))}px`;
      pill.style.padding = `0 ${lerp(34, 0, close)}px 0 ${lerp(28, 0, close)}px`;
      pillText.style.opacity = String(ep(t, 3.5, 3.8) * (1 - ep(t, 4.25, 4.4)));
      pillText.style.display = close > 0.6 || open < 0.05 ? 'none' : '';
      pillIcon.style.opacity = String(1 - ep(t, 4.45, 4.65));
      const pop = lerp(0.4, 1, ep(t, 3.25, 3.52, ease.back));
      pill.style.transform = `translateY(${pillDy * close}px) scale(${pop * lerp(1, Z0, close)})`;
      pill.style.background = `rgba(255,159,10,${lerp(0.12, 0, ep(t, 4.5, 4.7))})`;
      pill.style.boxShadow = `inset 0 0 0 ${lerp(2, 3 / 1, close)}px rgba(255,159,10,${lerp(0.5, 1, close)})`;
      s2.style.transform = `scale(${lerp(1 + 0.015 * (t - 2.6), 1, close)})`;
      // Once the card has faded in around it, the pill hands over to the circle underneath.
      s2.style.opacity = t >= 4.62 ? '0' : '1';
    }

    // Scene 3 (4.45–8.55): the streak card.
    const sOn = t > 4.6 && t < 8.6;
    sa.world.style.display = sOn ? 'block' : 'none';
    if (sOn) {
      let claimed = 0;
      dots.forEach((d, i) => {
        const at = FILL_AT[i];
        const on = t >= at;
        if (on) claimed = i + 1;
        const k = ep(t, at, at + 0.35, ease.back);
        d.style.background = on ? '#30d158' : 'transparent';
        d.style.borderColor = on ? '#30d158' : i === claimed ? '#ff9f0a' : '#35353e';
        d.innerHTML = on ? ico('check') : '';
        d.style.transform = `scale(${on ? lerp(0.6, 1, k) : 1})`;
        lbls[i].style.color = on ? 'var(--text)' : 'var(--muted)';
      });
      // The rest of the row cascades in after the first circle (which the pill became).
      dots.forEach((d, i) => {
        const col = d.parentElement;
        if (i === 0) return;
        const k = ep(t, 4.75 + i * 0.06, 5.15 + i * 0.06, ease.outQuint);
        col.style.opacity = String(k);
        col.style.translate = `0 ${(1 - k) * 40}px`;
      });
      sTitle.textContent = claimed ? `${claimed} day${claimed === 1 ? '' : 's'}` : 'No streak yet';
      sFlameN.textContent = String(claimed);
      const hit = Math.max(...FILL_AT.map((a) => ep(t, a, a + 0.08) * (1 - ep(t, a + 0.08, a + 0.35))));
      sFlameChip.style.transform = `scale(${1 + 0.1 * hit})`;
      const cam = streakCam(t);
      const prev = streakCam(t - 1 / 60);
      const out = ep(t, 8.2, 8.55, ease.in);
      sa.camera(cam.x, cam.y, cam.z * (1 + 0.15 * out), cam.r);
      const speed = Math.hypot(cam.x - prev.x, cam.y - prev.y) * cam.z + Math.abs(cam.z - prev.z) * 600;
      const cIn = ep(t, 4.62, 4.95, ease.out);
      // Fade in everything but the first circle: the card's own surface comes up around it.
      streak.style.opacity = '1';
      [...streak.children].forEach((ch, i) => {
        if (i === 1) return;
        ch.style.opacity = String(cIn);
      });
      streak.style.background = `rgba(17,17,20,${cIn})`;
      streak.style.borderColor = `rgba(37,37,43,${cIn})`;
      dots[0].parentElement.querySelector('.lbl').style.opacity = String(cIn);
      sa.world.style.opacity = String(1 - out);
      sa.world.style.filter = blurOf(Math.min(3, Math.max(0, speed - 10) * 0.2) + out * 12);
    }

    // Scene 4 (8.45–10.2).
    show(s4, t > 8.45 && t < 10.25);
    if (t > 8.45 && t < 10.25) {
      l4.spans.forEach((sp, i) => wordIn(sp, t, 8.5 + i * 0.15));
      const out = ep(t, 9.85, 10.12, ease.in);
      s4.style.transform = `scale(${s4Scale(t) * (1 + 0.15 * out)})`;
      l4.spans.forEach((sp, i) => {
        if (i === 4) return;
        sp.style.opacity = String(Math.min(Number(sp.style.opacity || 1), 1 - out));
        if (out > 0) sp.style.filter = blurOf(out * 12);
      });
      sp500.style.visibility = t >= 9.85 ? 'hidden' : 'visible';
    }

    // The 500 flies from the line into the card's "+500 points" (9.85–10.45).
    const fOn = t >= 9.85 && t < 10.47;
    flyer.style.display = fOn ? 'block' : 'none';
    if (fOn) {
      const sc0 = s4Scale(9.85);
      const from = [CX + (c500[0] - CX) * sc0, CY + (c500[1] - CY) * sc0];
      const cam = taskCam(t);
      const to = toScreen([nb.left + nb.width / 2, nb.top + nb.height / 2], cam);
      const k = ep(t, 9.85, 10.45, ease.inOut);
      const x = lerp(from[0], to[0], k);
      const y = lerp(from[1], to[1], k);
      const s = lerp(sc0, (cam.z * nb.height) / fb.height, k);
      flyer.style.transform = `translate(${x - fb.width / 2}px, ${y - fb.height / 2}px) scale(${s})`;
      const v = Math.sin(Math.PI * k);
      flyer.style.filter = blurOf(v * 5);
    }

    // Scene 5 (10.0–15.5): the task card.
    const tOn = t > 9.95 && t < 15.5;
    sb.world.style.display = tOn ? 'block' : 'none';
    if (tOn) {
      const cIn = ep(t, 10.08, 10.45, ease.out);
      n500.style.visibility = t >= 10.45 ? 'visible' : 'hidden';
      const rk = ep(t, 10.4, 10.7);
      rwA.forEach((r) => (r.style.opacity = String(rk)));
      // The task rows and the buttons cascade in below.
      const cascade = [btns, ...trows];
      cascade.forEach((n, i) => {
        const k = ep(t, 10.5 + i * 0.15, 10.95 + i * 0.15, ease.outQuint);
        n.style.opacity = String(k);
        n.style.translate = `0 ${(1 - k) * 50}px`;
      });
      bar.style.opacity = String(ep(t, 10.7, 11.1));
      // Verify: press, a spinner counting seconds, then done.
      tapV(t);
      verify.style.transform = `scale(${pressScale(t, TAP_AT)})`;
      if (t < TAP_AT + 0.05) vt.innerHTML = `<span style="display:inline-flex;align-items:center;gap:14px"><span style="display:inline-flex">${ico('check')}</span>Verify</span>`;
      else if (t < DONE_AT)
        vt.innerHTML = `<span style="display:inline-flex;align-items:center;gap:16px"><span style="display:inline-block;width:36px;height:36px;border-radius:50%;border:4px solid rgba(9,9,11,0.2);border-top-color:#09090b;transform:rotate(${(t - TAP_AT) * 720}deg)"></span>Verifying<span class="mono" style="font-size:28px;opacity:0.6">${Math.floor(t - TAP_AT - 0.05) + 1}s</span></span>`;
      else vt.innerHTML = `<span style="display:inline-flex;align-items:center;gap:14px"><span style="display:inline-flex">${ico('checkCircle')}</span>Done</span>`;
      const done = ep(t, DONE_AT, DONE_AT + 0.25);
      verify.style.background = `color-mix(in srgb, var(--up) ${done * 100}%, var(--text))`;
      // Coins fly into the points chip, which counts 1,000 → 1,500.
      const land = COIN_AT + COIN_DUR;
      ptsV.textContent = fmt(1000 + 500 * ep(t, land, land + 0.65, ease.out));
      const hit = ep(t, land, land + 0.1) * (1 - ep(t, land + 0.1, land + 0.7));
      ptsChip.style.transform = `scale(${1 + 0.12 * hit})`;
      ptsChip.style.borderColor = hit > 0 ? `rgba(255,214,10,${0.7 * hit})` : '';
      const cam = taskCam(t);
      const prev = taskCam(t - 1 / 60);
      sb.camera(cam.x, cam.y, cam.z, cam.r);
      const speed = Math.hypot(cam.x - prev.x, cam.y - prev.y) * cam.z + Math.abs(cam.z - prev.z) * 600;
      task.style.opacity = String(cIn);
      sb.world.style.filter = blurOf(Math.min(3, Math.max(0, speed - 10) * 0.2) + (1 - cIn) * 14);
    }

    taskCoins(t); // coins live in the screen overlay, so they run outside the task world's switch

    // Circle wipe: grows out of the green Done button, holds, then shrinks into the end pill's dot.
    const vS = toScreen(vC, taskCam(Math.min(t, W0)));
    const grow = ep(t, W0, W0 + 0.55, ease.in);
    const shrink = ep(t, W1, W1 + 0.5, ease.inOut);
    const R = t < W1 ? lerp(40, 900, grow) : lerp(900, 7, shrink);
    const wc = t < W1 ? [lerp(vS[0], CX, ep(t, W0, W0 + 0.55, ease.in)), lerp(vS[1], CY, ep(t, W0, W0 + 0.55, ease.in))] : [lerp(CX, endDotC[0], shrink), lerp(CY, endDotC[1], shrink)];
    const wipeOn = t > W0 && t < W1 + 0.55;
    wipe.style.display = wipeOn ? 'block' : 'none';
    wipe.style.width = wipe.style.height = `${R * 2}px`;
    wipe.style.left = `${wc[0] - R}px`;
    wipe.style.top = `${wc[1] - R}px`;
    show(s6, t > W0 + 0.45 && t < W1 + 0.1);
    if (t > W0 + 0.45 && t < W1 + 0.1) {
      l6.spans.forEach((sp, i) => wordIn(sp, t, W0 + 0.52 + i * 0.16));
      const out = ep(t, W1 - 0.2, W1 + 0.05, ease.in);
      s6.style.opacity = String(1 - out);
      s6.style.transform = `scale(${(1 + 0.04 * (t - W0)) * (1 - 0.2 * out)})`;
    }

    // Scene 7: end card.
    show(s7, t > E);
    if (t > E) {
      const pk = ep(t, E + 0.05, E + 0.55, ease.outQuint);
      endPill.style.width = `${lerp(14 + 22 + 26, endPillW, pk)}px`;
      endPill.style.background = `rgba(48,209,88,${0.1 * ep(t, E + 0.05, E + 0.3)})`;
      endPill.style.boxShadow = `inset 0 0 0 1.5px rgba(48,209,88,${0.38 * ep(t, E + 0.05, E + 0.3)})`;
      endPillText.style.opacity = String(ep(t, E + 0.25, E + 0.6));
      const wk = ep(t, E + 0.3, E + 1.0, ease.outQuint);
      endWord.style.opacity = String(wk);
      endWord.style.transform = `translateY(${(1 - wk) * 30}px)`;
      endWord.style.filter = blurOf((1 - wk) * 10);
      const uk = ep(t, E + 0.65, E + 1.3, ease.outQuint);
      endUrl.style.opacity = String(uk);
      endUrl.style.transform = `translateY(${(1 - uk) * 30}px) scale(${lerp(0.94, 1, uk)})`;
      s7.style.transform = `scale(${1 + 0.025 * ep(t, E, DURATION)})`;
    }

    black.style.opacity = String(Math.max(1 - ep(t, 0, 0.25, ease.out), ep(t, DURATION - 0.5, DURATION, ease.in)));
  };
}
