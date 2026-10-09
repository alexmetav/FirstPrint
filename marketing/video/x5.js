// Video 5, square X cut: "Get in early", rebuilt in the video 1 style.
// Native 1080×1080: word-by-word lines that grow, new markets flying in as real token logos,
// the SOL logo flying out of the feed into the early-bonus card, the bonus counting up to 1.50×,
// the pool split shifting your way, your row climbing the leaderboard to #1, a green circle wipe
// from your rank, and the same end card as video 1.
import { el, ico, logo, keys, ep, p, ease, lerp, clamp, fmt } from './lib.js';
import { TOKENS } from './tokens.js';

export const DURATION = 22;

/** Sound cues: only where something happens on screen. */
export const SFX = [
  ...[0, 1, 2, 3].map((i) => [3.12 + i * 0.14, 'blip', i]),
  [4.32, 'pop'],
  [5.12, 'pop'],
  [6.78, 'land'],
  ...[0, 1, 2, 3, 4].map((i) => [7.4 + i * 0.25, 'blip', i]),
  [8.62, 'chime'],
  [9.68, 'land'],
  [10.12, 'pop'],
  [11.86, 'land'],
  // Rank swaps are filled in by build() once the crossing times are known.
  [14.7, 'success'],
  [15.95, 'swell'],
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

/** Scene exit: scale + blur + fade. */
function exitStyle(n, out, base, grow = 0.2) {
  n.style.transform = `scale(${base * (1 + grow * out)})`;
  n.style.opacity = String(1 - out);
  n.style.filter = out > 0 ? `blur(${out * 12}px)` : 'none';
}

const show = (n, on) => (n.style.display = on ? 'flex' : 'none');
const coin = (k, size) => `<div class="tk" style="flex:none;width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 2px rgba(255,255,255,0.14)">${TOKENS[k].replace('<svg', `<svg width="${size}" height="${size}" style="display:block"`)}</div>`;
/** Screen position of a point inside a scene scaled about the frame centre. */
const toScreen = ([x, y], sc) => [CX + (x - CX) * sc, CY + (y - CY) * sc];
const centre = (n) => {
  const r = n.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
};

/** A floating copy of a UI element that carries it from one scene into the next. */
function flyer(root, html, size) {
  const n = el(`<div class="abs" style="left:0;top:0;width:${size}px;height:${size}px;margin:-${size / 2}px 0 0 -${size / 2}px;z-index:20;display:none">${html}</div>`);
  root.append(n);
  let last = null;
  return (t, frames, on) => {
    n.style.display = on ? 'block' : 'none';
    if (!on) return;
    const k = keys(t, frames);
    const k0 = keys(t - 1 / 60, frames);
    const v = Math.hypot(k.x - k0.x, k.y - k0.y) * 60; // px per second
    n.style.left = `${k.x}px`;
    n.style.top = `${k.y}px`;
    n.style.transform = `scale(${k.s})`;
    n.style.filter = v > 120 ? `blur(${Math.min(9, v / 260)}px)` : 'none';
    last = k;
    return last;
  };
}

export function build() {
  const root = document.querySelector('#stage');
  root.append(el('<div class="abs" style="left:-200px;top:560px;width:1480px;height:900px;background:radial-gradient(50% 50% at 50% 50%, rgba(48,209,88,0.09), transparent 70%);pointer-events:none"></div>'));

  // --- Scene 1: "new markets open all the time", which then shrinks into the feed's header ---
  const s1 = scene(root, 'gap:4px;z-index:4');
  const l1a = line(['new', 'markets', 'open'], { size: 78 });
  const l1b = line(['all', 'the', 'time'], { size: 78 });
  s1.append(l1a.node, l1b.node);
  const l1 = [...l1a.spans, ...l1b.spans];

  // --- Scene 2: a feed of markets; logos fly in, new markets keep landing on top ---
  const s2 = scene(root, 'z-index:3');
  const FEED_TOP = 300;
  const STEP = 148;
  const MK = [
    // [token, ticker, name, closes, slot offset (0 = there from the start, -1/-2 = dropped in later)]
    ['sol', 'SOL', 'Solana', 'Oct 16', -2],
    ['bnb', 'BNB', 'BNB', 'Oct 15', -1],
    ['link', 'LINK', 'Chainlink', 'Oct 12', 0],
    ['doge', 'DOGE', 'Dogecoin', 'Oct 12', 1],
    ['ada', 'ADA', 'Cardano', 'Oct 11', 2],
    ['xrp', 'XRP', 'XRP', 'Oct 11', 3],
  ];
  const DROPS = [4.3, 5.1];
  const mkRows = MK.map(([k, sym, name, closes]) => {
    const n = el(`<div class="abs" style="left:110px;top:${FEED_TOP}px;width:860px;height:128px;display:flex;align-items:center;gap:26px;padding:0 34px 0 26px;border-radius:30px;background:var(--surface);box-shadow:inset 0 0 0 1.5px var(--line), 0 30px 60px -36px rgba(0,0,0,0.9)">
      ${coin(k, 84)}
      <div><div style="font-size:42px;font-weight:600;letter-spacing:-0.03em;line-height:1">${sym}</div><div class="muted" style="font-size:26px;margin-top:6px">${name}</div></div>
      <div style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:10px">
        <span class="pill pill-open" style="height:44px;font-size:24px;padding:0 18px"><i class="dot" style="width:12px;height:12px"></i>Open</span>
        <span class="mono muted" style="font-size:24px">closes ${closes}</span>
      </div></div>`);
    s2.append(n);
    return n;
  });
  const solRowLogo = mkRows[0].querySelector('.tk');
  const solFeedC = [110 + 26 + 42, FEED_TOP + 64];

  // --- Scene 3: early bonus card, then the pool split ---
  const s3 = scene(root, 'z-index:3');
  const l3a = line(['early', 'picks', 'count', 'for', 'more'], { size: 62 });
  const l3b = line(['when', 'the', 'pool', 'is', 'split'], { size: 62 });
  for (const l of [l3a, l3b]) {
    l.node.style.position = 'absolute';
    l.node.style.top = '138px';
    s3.append(l.node);
  }
  const card = el(`<div class="card" style="left:160px;top:290px;width:760px;padding:40px 44px 44px">
    <div style="display:flex;align-items:center;gap:24px">
      <div class="av">${coin('sol', 96)}</div>
      <div><div style="font-size:52px;font-weight:600;letter-spacing:-0.03em;line-height:1">SOL</div><div class="muted" style="font-size:28px;margin-top:6px">Solana</div></div>
      <span class="pill pill-open" style="margin-left:auto"><i class="dot"></i>Open</span>
    </div>
    <div style="position:relative;height:350px;margin-top:30px;border-top:1.5px solid var(--line)">
      <div class="bA abs" style="left:0;right:0;top:34px">
        <div class="eyebrow" style="font-size:24px">Early bonus</div>
        <div class="mono num" style="font-size:150px;font-weight:600;letter-spacing:-0.05em;line-height:1;margin-top:14px;transform-origin:0 50%">1.00×</div>
        <div style="position:relative;height:14px;border-radius:14px;background:linear-gradient(90deg,var(--moon),var(--up) 40%,#35353e);margin-top:42px">
          <i class="knob" style="position:absolute;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:#f5f5f7;box-shadow:0 0 0 8px rgba(245,245,247,0.15)"></i>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:24px" class="eyebrow"><span style="font-size:20px">Market opens</span><span style="font-size:20px">Predictions close</span></div>
      </div>
      <div class="bB abs" style="left:0;right:0;top:34px">
        <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="eyebrow" style="font-size:24px">Winning pool</span><span class="mono" style="font-size:34px">1,000 pts</span></div>
        <div class="split" style="display:flex;gap:8px;height:96px;margin-top:22px">
          <div class="sgA" style="display:flex;align-items:center;padding:0 26px;border-radius:22px;background:var(--up);color:#09090b;overflow:hidden;white-space:nowrap"><span class="mono vA" style="font-size:38px;font-weight:600">500 pts</span></div>
          <div class="sgB" style="flex:1;display:flex;align-items:center;justify-content:flex-end;padding:0 26px;border-radius:22px;background:#2b2b33;overflow:hidden;white-space:nowrap"><span class="mono vB" style="font-size:38px;font-weight:500">500 pts</span></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:30px">
          <div style="display:flex;align-items:center;gap:16px"><span class="me-av avatar" style="width:52px;height:52px;font-size:24px;background:linear-gradient(140deg,#30d158,#7dff3a);color:#09090b">Y</span>
            <div><div style="font-size:30px;font-weight:600">you, early</div><div class="mono xA" style="font-size:26px;color:var(--moon);margin-top:4px">100 × 1.00</div></div></div>
          <div style="display:flex;align-items:center;gap:16px;text-align:right"><div><div style="font-size:30px;font-weight:500;color:var(--muted)">later pick</div><div class="mono" style="font-size:26px;color:var(--muted);margin-top:4px">100 × 1.00</div></div>
            <span class="avatar" style="width:52px;height:52px;font-size:24px;background:#2b2b33">L</span></div>
        </div>
      </div>
    </div>
  </div>`);
  s3.append(card);
  const cardAv = card.querySelector('.av');
  const bA = card.querySelector('.bA');
  const bB = card.querySelector('.bB');
  const num = card.querySelector('.num');
  const knob = card.querySelector('.knob');
  const sgA = card.querySelector('.sgA');
  const vA = card.querySelector('.vA');
  const vB = card.querySelector('.vB');
  const xA = card.querySelector('.xA');
  const meAv3 = card.querySelector('.me-av');
  const splitW = card.querySelector('.split').getBoundingClientRect().width - 8;
  const cardAvC = centre(cardAv);
  const meAv3C = centre(meAv3);

  // --- Scene 4: leaderboard; your row climbs from #6 to #1 ---
  const s4 = scene(root, 'z-index:3');
  const l4 = line(['climb', 'the', 'leaderboard'], { size: 62 });
  l4.node.style.position = 'absolute';
  l4.node.style.top = '138px';
  s4.append(l4.node);
  const players = [
    ['satoshi_fan', 8420],
    ['moonwalker', 7915],
    ['chartgazer', 7300],
    ['early_bird', 6880],
    ['flatline', 6410],
  ];
  const LB_TOP = 280;
  const LB_STEP = 104;
  const lbRow = (name, pts, me) => el(`<div class="abs" style="left:160px;top:${LB_TOP}px;width:760px;height:92px;display:flex;align-items:center;gap:24px;padding:0 32px 0 26px;border-radius:24px;${me ? 'background:color-mix(in srgb, #30d158 14%, #111114);box-shadow:inset 0 0 0 3px var(--up), 0 24px 50px -24px rgba(48,209,88,0.5);z-index:2' : 'background:var(--surface);box-shadow:inset 0 0 0 1.5px var(--line)'}">
      <span class="mono rk" style="width:62px;font-size:34px;font-weight:500;color:var(--muted)"></span>
      <span class="avatar lav" style="width:60px;height:60px;font-size:26px;${me ? 'background:linear-gradient(140deg,#30d158,#7dff3a);color:#09090b' : 'background:#2b2b33'}">${name[0].toUpperCase()}</span>
      <span style="font-size:36px;font-weight:${me ? 700 : 500};letter-spacing:-0.02em">${name}</span>
      ${me ? `<span class="cup" style="display:inline-flex;font-size:40px;color:var(--gold)">${ico('trophy')}</span>` : ''}
      <span class="mono pts" style="margin-left:auto;font-size:34px">${fmt(pts)}</span>
    </div>`);
  const lbRows = players.map(([n, pt]) => lbRow(n, pt, false));
  const me = lbRow('you', 5200, true);
  [...lbRows, me].forEach((r) => s4.append(r));
  const meRk = me.querySelector('.rk');
  const mePts = me.querySelector('.pts');
  const meAv4 = me.querySelector('.lav');
  const cup = me.querySelector('.cup');
  // Layout positions (rows sit at LB_TOP before any transform).
  const meAv4C = (slot) => [160 + 26 + 62 + 24 + 30, LB_TOP + slot * LB_STEP + 46];
  const meRkC = (slot) => [160 + 26 + 31, LB_TOP + slot * LB_STEP + 46];

  // Your points over time, and when you pass each player.
  const ptsAt = (t) => lerp(5200, 8900, ep(t, 12.4, 14.6, ease.inOut));
  const cross = players.map(([, pt]) => {
    for (let x = 12.4; x <= 14.6; x += 1 / 240) if (ptsAt(x) > pt) return x;
    return 99;
  });
  // One blip per overtake, rising.
  cross
    .slice()
    .reverse()
    .forEach((c, i) => SFX.push([+(c + 0.05).toFixed(3), 'blip', i]));
  SFX.sort((a, b) => a[0] - b[0]);

  // --- Flyers that carry an element across a cut ---
  const solFly = flyer(root, coin('sol', 84), 84);
  const youFly = flyer(root, '<span class="avatar" style="width:52px;height:52px;font-size:24px;background:linear-gradient(140deg,#30d158,#7dff3a);color:#09090b">Y</span>', 52);

  // --- Circle wipe from your #1 rank, then the end card (same as video 1) ---
  const wipe = el('<div class="abs" style="left:0;top:0;border-radius:50%;background:var(--up);z-index:55"></div>');
  root.append(wipe);
  const s6 = scene(root, 'z-index:56');
  const l6 = line(['get', 'in', 'early'], { size: 96, weight: 600, color: '#09090b' });
  s6.append(l6.node);

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

  const black = el('<div class="abs" style="left:0;top:0;width:1080px;height:1080px;background:#000;z-index:60;pointer-events:none"></div>');
  root.append(black);

  // Scene push-ins (also used to place the flyers).
  const sc2 = (t) => 1 + 0.02 * Math.max(0, t - 2.9);
  const sc3 = (t) => 1 + 0.022 * Math.max(0, t - 6.3);
  const sc4 = (t) => 1 + 0.025 * Math.max(0, t - 11.4);

  return (t) => {
    // Scene 1 (0–6.05): the line builds, grows, then becomes the header of the feed.
    show(s1, t < 6.1);
    if (t < 6.1) {
      l1.forEach((sp, i) => wordIn(sp, t, 0.3 + i * 0.18));
      const grow = ep(t, 1.5, 2.25, ease.inOut);
      const m = ep(t, 2.4, 3.0, ease.inOut);
      const big = (1 + 0.03 * t) * lerp(1, 1.22, grow);
      const sc = lerp(big, 0.56, m) * (1 + 0.012 * Math.max(0, t - 3));
      const out = ep(t, 5.7, 6.05, ease.in);
      s1.style.transform = `translateY(${lerp(0, -402, m)}px) scale(${sc * (1 + 0.2 * out)})`;
      s1.style.opacity = String(1 - out);
      s1.style.filter = out > 0 ? `blur(${out * 12}px)` : 'none';
      // The header dims a little so the feed leads.
      s1.style.color = m > 0 ? `color-mix(in srgb, var(--text) ${Math.round(100 - 25 * m)}%, var(--muted))` : '';
    }

    // Scene 2 (2.9–6.05): markets cascade in, then two new ones land on top.
    show(s2, t > 2.9 && t < 6.1);
    if (t > 2.9 && t < 6.1) {
      const d0 = ep(t, DROPS[0], DROPS[0] + 0.45, ease.outQuint);
      const d1 = ep(t, DROPS[1], DROPS[1] + 0.45, ease.outQuint);
      const shiftBlur = Math.sin(Math.PI * p(t, DROPS[0], DROPS[0] + 0.45)) + Math.sin(Math.PI * p(t, DROPS[1], DROPS[1] + 0.45));
      mkRows.forEach((r, i) => {
        const off = MK[i][4];
        const slot = Math.max(off + d0 + d1, -0.4);
        let o = 1;
        let x = 0;
        let s = 1;
        let blur = shiftBlur * 3;
        if (off >= 0) {
          // First cascade: slides in from the right with motion blur.
          const k = ep(t, 3.0 + off * 0.14, 3.55 + off * 0.14, ease.outQuint);
          x = (1 - k) * 640;
          o = clamp(k * 1.6);
          blur = Math.max(blur, (1 - k) * 18);
          r.querySelector('.tk').style.transform = `rotate(${(1 - k) * 220}deg)`;
        } else {
          // Dropped in from above.
          const at = DROPS[-off - 1];
          const k = ep(t, at, at + 0.45, ease.outQuint);
          o = k;
          s = lerp(0.86, 1, ep(t, at, at + 0.5, ease.back));
          blur = Math.max(blur, (1 - k) * 14);
          if (t < at) o = 0;
          // A short green ring marks the market that just opened.
          const ring = (1 - ep(t, at + 0.35, at + 1.1)) * (t >= at ? 1 : 0);
          r.style.boxShadow = `inset 0 0 0 ${lerp(1.5, 3, ring)}px ${ring > 0.01 ? `rgba(48,209,88,${lerp(0.25, 0.85, ring)})` : 'var(--line)'}, 0 30px 60px -36px rgba(0,0,0,0.9)`;
        }
        o *= 1 - clamp((slot - 3) / 0.7);
        r.style.display = o > 0.001 ? 'flex' : 'none';
        r.style.opacity = String(o);
        r.style.transform = `translate(${x}px, ${slot * STEP}px) scale(${s})`;
        r.style.filter = blur > 0.05 ? `blur(${blur}px)` : 'none';
      });
      const out = ep(t, 5.7, 6.05, ease.in);
      exitStyle(s2, out, sc2(t));
      solRowLogo.style.visibility = t >= 5.72 ? 'hidden' : 'visible';
    }

    // SOL flies out of the feed, grows in the middle, then lands in the early-bonus card.
    {
      const from = toScreen(solFeedC, sc2(5.72));
      const to = toScreen(cardAvC, sc3(6.8));
      solFly(t, [
        [5.72, { x: from[0], y: from[1], s: 1 }],
        [6.2, { x: CX, y: 520, s: 2.4 }],
        [6.78, { x: to[0], y: to[1], s: (96 / 84) * sc3(6.8) }],
      ], t >= 5.72 && t < 6.8);
    }

    // Scene 3 (6.2–11.5): early bonus, then the split.
    show(s3, t > 6.2 && t < 11.55);
    if (t > 6.2 && t < 11.55) {
      cardAv.style.visibility = t >= 6.8 ? 'visible' : 'hidden';
      const cIn = ep(t, 6.3, 6.75, ease.outQuint);
      card.style.opacity = String(cIn);
      card.style.transform = `translateY(${(1 - cIn) * 40}px)`;
      card.style.filter = cIn < 1 ? `blur(${(1 - cIn) * 14}px)` : 'none';
      l3a.spans.forEach((sp, i) => wordIn(sp, t, 6.5 + i * 0.16));
      const aOut = ep(t, 9.1, 9.4, ease.in);
      l3a.node.style.opacity = String(1 - aOut);
      l3a.node.style.filter = aOut > 0 ? `blur(${aOut * 10}px)` : 'none';
      l3a.node.style.transform = `scale(${1 + 0.15 * aOut})`;
      l3b.spans.forEach((sp, i) => wordIn(sp, t, 9.35 + i * 0.16));
      l3b.node.style.display = t > 9.3 ? 'flex' : 'none';

      // Bonus: the knob slides from the close back to the open; the weight counts up to 1.50×.
      const pos = 1 - ep(t, 7.3, 8.6, ease.inOut);
      knob.style.left = `${pos * 100}%`;
      const w = 1.5 - 0.5 * pos;
      num.textContent = `${w.toFixed(2)}×`;
      num.style.color = `color-mix(in srgb, var(--moon) ${Math.round((1 - pos) * 100)}%, var(--text))`;
      const pop = ep(t, 8.6, 8.95, ease.back);
      num.style.transform = `scale(${t < 8.6 ? 1 : lerp(1.1, 1, pop)})`;
      const ab = ep(t, 9.2, 9.55, ease.in);
      bA.style.opacity = String(1 - ab);
      bA.style.filter = ab > 0 ? `blur(${ab * 12}px)` : 'none';
      bA.style.transform = `scale(${1 - 0.05 * ab})`;
      const bb = ep(t, 9.45, 9.85, ease.outQuint);
      bB.style.opacity = String(bb);
      bB.style.filter = bb < 1 ? `blur(${(1 - bb) * 12}px)` : 'none';
      bB.style.transform = `translateY(${(1 - bb) * 24}px)`;
      // Equal stakes split 50/50, then your 1.50× shifts it to 60/40.
      const g = ep(t, 10.12, 10.7, ease.outQuint);
      const share = lerp(0.5, 0.6, g);
      sgA.style.width = `${share * splitW}px`;
      vA.textContent = `${fmt(1000 * share)} pts`;
      vB.textContent = `${fmt(1000 * (1 - share))} pts`;
      xA.textContent = t >= 10.12 ? '100 × 1.50' : '100 × 1.00';
      xA.style.display = 'block';
      xA.style.transform = `scale(${t >= 10.12 ? lerp(1.25, 1, ep(t, 10.12, 10.45, ease.back)) : 1})`;
      xA.style.transformOrigin = '0 50%';
      meAv3.style.visibility = t >= 11.15 ? 'hidden' : 'visible';
      const out = ep(t, 11.15, 11.5, ease.in);
      exitStyle(s3, out, sc3(t));
    }

    // Your avatar leaves the split and lands in your leaderboard row.
    {
      const from = toScreen(meAv3C, sc3(11.15));
      const to = toScreen(meAv4C(5), sc4(11.86));
      youFly(t, [
        [11.15, { x: from[0], y: from[1], s: 1 }],
        [11.86, { x: to[0], y: to[1], s: (60 / 52) * sc4(11.86) }],
      ], t >= 11.15 && t < 11.87);
    }

    // Scene 4 (11.35–16.1): leaderboard.
    show(s4, t > 11.35 && t < 16.1);
    if (t > 11.35 && t < 16.1) {
      l4.spans.forEach((sp, i) => wordIn(sp, t, 11.45 + i * 0.18));
      const myPts = ptsAt(t);
      mePts.textContent = fmt(myPts);
      let mySlot = 5;
      let moveBlur = 0;
      players.forEach(([, pt], j) => {
        const q = p(t, cross[j], cross[j] + 0.3);
        const k = ease.inOut(q);
        mySlot -= k;
        moveBlur = Math.max(moveBlur, Math.sin(Math.PI * q));
        const r = lbRows[j];
        const c = ep(t, 11.4 + j * 0.09, 11.85 + j * 0.09, ease.outQuint);
        r.style.opacity = String(c);
        r.style.transform = `translateY(${(j + k) * LB_STEP + (1 - c) * 60}px)`;
        const b = Math.max((1 - c) * 10, Math.sin(Math.PI * q) * 4);
        r.style.filter = b > 0.05 ? `blur(${b}px)` : 'none';
        r.querySelector('.rk').textContent = `#${j + 1 + (t >= cross[j] + 0.15 ? 1 : 0)}`;
      });
      const c = ep(t, 11.8, 12.25, ease.outQuint);
      const meRank = 1 + players.filter((_, j) => t < cross[j] + 0.15).length;
      const win = ep(t, 14.7, 15.05, ease.back);
      const mb = Math.max((1 - c) * 10, moveBlur * 5);
      me.style.opacity = String(c);
      me.style.transform = `translateY(${mySlot * LB_STEP + (1 - c) * 60}px) scale(${t >= 14.7 ? lerp(1.06, 1.03, win) : 1})`;
      me.style.filter = mb > 0.05 ? `blur(${mb}px)` : 'none';
      meAv4.style.visibility = t >= 11.86 ? 'visible' : 'hidden';
      meRk.textContent = `#${meRank}`;
      meRk.style.color = meRank === 1 ? 'var(--gold)' : 'var(--up)';
      cup.style.display = t >= 14.7 ? 'inline-flex' : 'none';
      cup.style.transform = `scale(${lerp(0.2, 1, win)}) rotate(${(1 - win) * -30}deg)`;
      s4.style.transform = `scale(${sc4(t)})`;
      s4.style.opacity = '1';
      s4.style.filter = 'none';
    }

    // Circle wipe: grows out of your #1, holds green, then shrinks into the end pill's dot.
    const rk = toScreen(meRkC(0), sc4(15.45));
    const grow = ep(t, 15.45, 16.0, ease.in);
    const shrink = ep(t, 16.85, 17.35, ease.inOut);
    const R = t < 16.85 ? lerp(10, 900, grow) : lerp(900, 7, shrink);
    const wc = t < 16.85 ? [lerp(rk[0], CX, ep(t, 15.45, 16.0)), lerp(rk[1], CY, ep(t, 15.45, 16.0))] : [lerp(CX, endDotC[0], shrink), lerp(CY, endDotC[1], shrink)];
    const wipeOn = t > 15.45 && t < 17.4;
    wipe.style.display = wipeOn ? 'block' : 'none';
    wipe.style.width = wipe.style.height = `${R * 2}px`;
    wipe.style.left = `${wc[0] - R}px`;
    wipe.style.top = `${wc[1] - R}px`;
    show(s6, t > 15.9 && t < 16.95);
    if (t > 15.9 && t < 16.95) {
      l6.spans.forEach((sp, i) => wordIn(sp, t, 15.95 + i * 0.16));
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
