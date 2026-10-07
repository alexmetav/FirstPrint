// Video 3: The clock decides.
import { stage, el, H, ico, caption, scrim, outcomeRows, coins, pointsChip, endCard, fades, keys, ep, p, ease, lerp, setT, fmt } from './lib.js';

export const DURATION = 15;
/** Framing for the square (X) cut. */
export const SQ = { z: 0.62, yo: 20 };
/** Sound cues in video time: [t, kind, variant]. */
export const SFX = [[0.4,'tick'],[0.92,'tick'],[1.44,'tick'],[1.96,'tick'],[2.48,'tick'],[3.0,'tick'],[3.65,'lock'],[5.2,'whoosh'],[5.6,'riser',3.0],[8.85,'impact'],[10.2,'pop'],[10.25,'success'],[10.9,'coins',14],[11.3,'cash'],[13.0,'chime']];
export const HOOK = ["The clock", "decides."];

const pad = (n) => String(Math.max(0, Math.floor(n))).padStart(2, '0');
function parts(sec) {
  const s = Math.max(0, Math.round(sec));
  return [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60];
}

export function build() {
  const s = stage();

  // The big countdown (as on the market page).
  const cd = el(`<div class="card" style="left:80px;top:760px;width:920px;padding:40px 44px 44px">
    <div class="eyebrow lbl" style="display:flex;align-items:center;gap:14px;font-size:28px"><span class="ic" style="display:inline-flex;font-size:34px"></span><span class="tx"></span></div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:30px">${['days', 'hours', 'min', 'sec']
      .map((u, i) => `${i ? '<span class="mono sep" style="font-size:96px;line-height:1;color:#52525b">:</span>' : ''}<div style="display:grid;justify-items:center;gap:10px;min-width:160px"><b class="mono d" style="font-size:130px;line-height:1;font-weight:600;letter-spacing:-0.03em">00</b><small class="eyebrow" style="font-size:24px">${u}</small></div>`)
      .join('')}</div>
  </div>`);
  s.add(cd);
  const digits = [...cd.querySelectorAll('.d')];
  const lblIc = cd.querySelector('.ic');
  const lblTx = cd.querySelector('.tx');

  // Start price, with a lock that clicks shut.
  const price = el(`<div class="card" style="left:80px;top:1320px;width:920px;padding:40px 44px;display:flex;align-items:center;gap:34px">
    <div class="lock" style="position:relative;width:96px;height:96px;flex:none">
      <svg viewBox="0 0 24 24" class="i" style="position:absolute;inset:0;width:96px;height:96px;color:var(--gold)"><rect x="3" y="11" width="18" height="11" rx="2"/></svg>
      <svg viewBox="0 0 24 24" class="i shackle" style="position:absolute;inset:0;width:96px;height:96px;color:var(--gold)"><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    </div>
    <div><div class="eyebrow" style="font-size:26px">Start price, locked</div><div class="mono" style="font-size:84px;font-weight:600;letter-spacing:-0.03em;margin-top:6px">$0.0001822</div></div>
  </div>`);
  s.add(price);
  const shackle = price.querySelector('.shackle');

  // The result.
  const result = el(`<div class="card" style="left:80px;top:640px;width:920px;overflow:hidden">
    <div style="padding:40px 44px 30px">
      <div class="eyebrow" style="font-size:26px">Result posted</div>
      <div style="display:flex;align-items:baseline;gap:26px;margin-top:16px"><span class="mono" style="font-size:72px;font-weight:600;letter-spacing:-0.03em">$0.0002951</span><span class="mono pct" style="font-size:60px;font-weight:600;color:var(--moon)">+0.0%</span></div>
      <div class="muted" style="font-size:30px;margin-top:12px">From a start price of $0.0001822</div>
    </div>
  </div>`);
  const { node: rowsNode, rows } = outcomeRows([6, 13, 63, 12, 6]);
  result.append(rowsNode);
  rows.forEach((r, i) => (r.querySelector('.bar').style.width = `${[6, 13, 63, 12, 6][i]}%`));
  const moon = rows[0];
  moon.querySelector('.you').innerHTML = '<span class="tag-you">You 100</span><span class="tag-you win" style="margin-left:10px;background:var(--moon);color:#09090b;box-shadow:none">Winner</span>';
  const win = moon.querySelector('.win');
  const moonPc = moon.querySelector('.pc');
  s.add(result);

  const chip = s.add(pointsChip(1000), 'overlay');
  chip.style.position = 'absolute';
  chip.style.right = '64px';
  chip.style.top = `${H - 260}px`;
  chip.style.transformOrigin = '100% 50%';
  const chipV = chip.querySelector('.v');

  s.camera(540, 960, 1);
  const sc = scrim(s, { inAt: 0.4, outAt: 12.5, height: 640 });
  const c1 = caption(s, { top: 200, inAt: 0.45, outAt: 4.9, lines: [['Predictions close,', 'cap-h'], ['and the start price locks.', 'cap-h']] });
  const c2 = caption(s, { top: 200, inAt: 5.4, outAt: 8.6, lines: [['Then the clock runs', 'cap-h'], ['to the result.', 'cap-h']] });
  const c3 = caption(s, { top: 200, inAt: 9.1, outAt: 12.5, lines: [['Call it right and you', 'cap-h'], ['share the pool.', 'cap-h']] });
  const coin = coins(s, {
    at: 10.9,
    count: 14,
    from: () => {
      const b = moon.getBoundingClientRect();
      return [b.left + b.width * 0.7, b.top + b.height / 2];
    },
    to: () => {
      const b = chip.getBoundingClientRect();
      return [b.left + 40, b.top + b.height / 2];
    },
  });
  const end = endCard(s, 13.0);
  const fade = fades(s, DURATION);

  return (t) => {
    sc(t);
    c1(t);
    c2(t);
    c3(t);

    // Phase 1: the close counts down from 5 seconds, in real time.
    // Phase 2: the result clock races from 7 days to zero.
    const closing = t < 3.4;
    const resultClock = t >= 5.2;
    let secs;
    if (t < 3.0) secs = Math.ceil(lerp(5, 0, p(t, 0.4, 3.0)));
    else if (!resultClock) secs = 0;
    else secs = 7 * 86400 * (1 - ep(t, 5.6, 8.6, (k) => 1 - Math.pow(1 - k, 2.2)));
    parts(secs).forEach((v, i) => (digits[i].textContent = pad(v)));
    const green = closing && !resultClock;
    cd.style.borderColor = green ? 'rgba(48,209,88,0.35)' : 'rgba(255,214,10,0.35)';
    cd.style.background = green ? 'color-mix(in srgb, #30d158 6%, #111114)' : 'color-mix(in srgb, #ffd60a 6%, #111114)';
    lblIc.innerHTML = ico(t >= 3.0 && !resultClock ? 'lock' : 'clock');
    lblIc.style.color = green ? 'var(--up)' : 'var(--gold)';
    lblTx.textContent = t < 3.0 ? 'Predictions close in' : !resultClock ? 'Predictions closed' : 'Result in';
    // A pulse on each tick of the last seconds.
    const tick = t < 3.0 ? 1 - ((t - 0.4) % 0.52) / 0.52 : 0;
    digits[3].style.transform = `scale(${1 + 0.04 * ease.in(tick)})`;
    digits.forEach((d) => (d.style.color = resultClock && t > 8.2 && t < 8.9 ? 'var(--gold)' : 'var(--text)'));

    // Start price card arrives at the close, the lock clicks shut.
    const pin = ep(t, 3.05, 3.8, ease.outQuint);
    const pout = ep(t, 8.6, 9.0, ease.in);
    setT(price, { y: (1 - pin) * 140, o: pin * (1 - pout) });
    const shut = ep(t, 3.6, 3.95, ease.back);
    shackle.style.transform = `translateY(${(1 - shut) * -14}px)`;

    // Countdown leaves for the result.
    const cout = ep(t, 8.6, 9.0, ease.in);
    setT(cd, { o: 1 - cout, y: -cout * 80, s: 1 - cout * 0.04 });

    // Result.
    const rin = ep(t, 8.85, 9.6, ease.outQuint);
    const rout = ep(t, 12.4, 13.0, ease.in);
    setT(result, { y: (1 - rin) * 200 - rout * 60, o: rin * (1 - rout) });
    result.querySelector('.pct').textContent = `+${(62 * ep(t, 9.2, 10.2, ease.out)).toFixed(1)}%`;
    const wk = ep(t, 10.2, 10.6, ease.back);
    win.style.transform = `scale(${lerp(0.3, 1, wk)})`;
    win.style.opacity = String(Math.min(1, wk * 2));
    moon.classList.toggle('sel', t >= 10.2);
    moonPc.textContent = t >= 10.2 ? '15.4×' : '6%';
    coin(t);
    const gain = ep(t, 11.2, 12.2, ease.out);
    chipV.textContent = fmt(1000 + 1540 * gain);
    const hit = ep(t, 11.3, 11.5) * (1 - ep(t, 11.5, 11.9));
    chip.style.transform = `scale(${1.45 * (1 + 0.08 * hit)})`;
    const chipIn = ep(t, 9.6, 10.2, ease.outQuint);
    const chipOut = ep(t, 12.5, 12.9, ease.in);
    chip.style.opacity = String(chipIn * (1 - chipOut));

    const cam = keys(t, [
      [0, { x: 540, y: 1000, z: 1.0, r: 0 }],
      [2.8, { x: 540, y: 1010, z: 1.1, r: -0.4 }],
      [3.6, { x: 540, y: 1120, z: 1.0, r: 0 }],
      [5.0, { x: 540, y: 1130, z: 1.02, r: 0.3 }],
      [5.8, { x: 540, y: 990, z: 1.12, r: 0 }],
      [8.5, { x: 540, y: 1000, z: 1.16, r: 0.4 }],
      [9.4, { x: 540, y: 1020, z: 1.0, r: 0 }],
      [12.4, { x: 540, y: 1040, z: 1.06, r: -0.3 }],
      [13.0, { x: 540, y: 1000, z: 1.0, r: 0 }],
    ]);
    s.camera(cam.x, cam.y, cam.z, cam.r);
    end(t);
    fade(t);
  };
}
