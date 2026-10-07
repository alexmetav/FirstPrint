// Video 4: Free points every day.
import { stage, el, H, ico, logo, caption, scrim, coins, tap, endCard, fades, keys, ep, ease, lerp, setT, fmt, pressScale } from './lib.js';

export const DURATION = 15;
/** Framing for the square (X) cut. */
export const SQ = { z: 0.62, yo: 120 };
/** Sound cues in video time: [t, kind, variant]. */
export const SFX = [[0.45,'swell'],[1.0,'blip',0],[1.55,'blip',1],[2.1,'blip',2],[2.65,'blip',3],[3.2,'blip',4],[3.75,'blip',5],[4.3,'blip',6],[1.1,'coins',4],[1.65,'coins',4],[2.2,'coins',4],[2.75,'coins',4],[3.3,'coins',4],[3.85,'coins',4],[4.4,'coins',4],[5.7,'whoosh'],[7.3,'tap'],[7.6,'tick'],[8.6,'tick'],[9.5,'success'],[9.7,'coins',14],[10.1,'cash'],[13.0,'chime']];
export const HOOK = ["Free points,", "every day."];
const DAYS = [50, 75, 100, 125, 150, 175, 200];

export function build() {
  const s = stage();

  // A slice of the app's top bar: logo, streak flame and points.
  const bar = el(`<div class="abs" style="left:80px;top:600px;width:920px;display:flex;align-items:center;gap:16px">
    <span class="wordmark" style="font-size:48px">${logo(64)}<span>Firstprint</span></span>
    <span class="chip flame" style="margin-left:auto">${ico('flame').replace('class="i"', 'class="i" style="color:#ff9f0a"')}<span class="n">0</span></span>
    <span class="chip pts">${ico('coins')}<span class="v">1,000</span><span class="muted" style="font-size:26px">pts</span></span>
  </div>`);
  s.add(bar);
  const flameN = bar.querySelector('.flame .n');
  const ptsV = bar.querySelector('.pts .v');
  const ptsChip = bar.querySelector('.pts');

  // Daily streak card.
  const streak = el(`<div class="card" style="left:80px;top:760px;width:920px;padding:40px 44px 46px">
    <div style="display:flex;align-items:center;gap:22px">
      <span style="display:grid;place-items:center;width:84px;height:84px;border-radius:24px;background:rgba(255,159,10,0.14);color:#ff9f0a;font-size:44px">${ico('flame')}</span>
      <div><div class="eyebrow" style="font-size:24px">Daily streak</div><div class="title" style="font-size:52px;font-weight:600;letter-spacing:-0.03em;margin-top:4px">No streak yet</div></div>
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:44px">${DAYS.map(
      (v) => `<div style="display:grid;justify-items:center;gap:14px"><span class="dot" style="display:grid;place-items:center;width:92px;height:92px;border-radius:50%;border:3px solid #35353e;color:#09090b;font-size:46px"></span><span class="mono lbl" style="font-size:28px;color:var(--muted)">+${v}</span></div>`,
    ).join('')}</div>
    <div class="muted" style="font-size:28px;margin-top:34px">One claim a day (UTC). Miss a day and it resets.</div>
  </div>`);
  s.add(streak);
  const dots = [...streak.querySelectorAll('.dot')];
  const lbls = [...streak.querySelectorAll('.lbl')];
  const title = streak.querySelector('.title');

  // Task card.
  const task = el(`<div class="card" style="left:80px;top:800px;width:920px;padding:40px 40px">
    <div class="eyebrow" style="font-size:24px">Tasks</div>
    <div style="display:flex;align-items:center;gap:26px;margin-top:26px">
      <span style="display:grid;place-items:center;width:96px;height:96px;border-radius:26px;background:#1d1d22;box-shadow:inset 0 0 0 2px #35353e;font-size:46px">${ico('userPlus')}</span>
      <div style="flex:1"><div style="font-size:40px;font-weight:600;letter-spacing:-0.02em">Follow @firstprintapp on X</div><div style="font-size:32px;color:var(--up);margin-top:6px;font-weight:500">+500 points</div></div>
    </div>
    <div style="display:flex;gap:18px;margin-top:34px">
      <div class="btn btn-ghost" style="flex:1"><span style="display:inline-flex">${ico('external')}</span>Open</div>
      <div class="btn btn-white verify" style="flex:1.4"><span class="vt"></span></div>
    </div>
  </div>`);
  s.add(task);
  const verify = task.querySelector('.verify');
  const vt = task.querySelector('.vt');

  s.camera(540, 960, 1);
  const vb = verify.getBoundingClientRect();
  const taskBox = task.getBoundingClientRect();

  const sc = scrim(s, { inAt: 0.4, outAt: 12.4, height: 560 });
  const c1 = caption(s, { top: 190, inAt: 0.45, outAt: 5.3, lines: [['Claim free points', 'cap-h'], ['every day.', 'cap-h'], ['Keep the streak and it grows to 200 a day.', 'cap-s']] });
  const c2 = caption(s, { top: 190, inAt: 5.8, outAt: 12.4, lines: [['Finish a task for', 'cap-h'], ['500 more.', 'cap-h'], ['Straight into your balance.', 'cap-s']] });
  const t1 = tap(s, vb.left + vb.width / 2, vb.top + vb.height / 2, 7.3);
  // Coins: each day's claim drops a few into the balance; the task sends a full spray.
  const dayCoins = DAYS.map((_, i) =>
    coins(s, {
      at: 1.0 + i * 0.55 + 0.1,
      count: 4,
      seed: 30 + i,
      dur: 0.8,
      from: () => {
        const b = dots[i].getBoundingClientRect();
        return [b.left + b.width / 2, b.top + b.height / 2];
      },
      to: () => {
        const b = ptsChip.getBoundingClientRect();
        return [b.left + 40, b.top + b.height / 2];
      },
    }),
  );
  const taskCoins = coins(s, {
    at: 9.7,
    count: 14,
    seed: 11,
    from: () => {
      const b = verify.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    },
    to: () => {
      const b = ptsChip.getBoundingClientRect();
      return [b.left + 40, b.top + b.height / 2];
    },
  });
  const end = endCard(s, 13.0);
  const fade = fades(s, DURATION);

  return (t) => {
    sc(t);
    c1(t);
    c2(t);

    // Streak: one circle a step, each landing its points in the balance.
    let claimed = 0;
    let pts = 1000;
    dots.forEach((d, i) => {
      const at = 1.0 + i * 0.55;
      const k = ep(t, at, at + 0.35, ease.back);
      const on = t >= at;
      if (on) claimed = i + 1;
      d.style.background = on ? '#30d158' : 'transparent';
      d.style.borderColor = on ? '#30d158' : i === claimed ? '#ff9f0a' : '#35353e';
      d.innerHTML = on ? ico('check') : '';
      d.style.transform = `scale(${on ? lerp(0.6, 1, k) : 1})`;
      lbls[i].style.color = on ? 'var(--text)' : 'var(--muted)';
      // Points arrive as that day's coins land.
      pts += DAYS[i] * ep(t, at + 0.7, at + 1.0, ease.out);
    });
    title.textContent = claimed ? `${claimed} day${claimed === 1 ? '' : 's'}` : 'No streak yet';
    flameN.textContent = String(claimed);
    dayCoins.forEach((c) => c(t));

    // Streak card leaves, task card arrives.
    const sOut = ep(t, 5.3, 5.9, ease.in);
    setT(streak, { o: 1 - sOut, y: -sOut * 120 });
    const tIn = ep(t, 5.7, 6.5, ease.outQuint);
    const tOut = ep(t, 12.3, 12.9, ease.in);
    setT(task, { o: tIn * (1 - tOut), y: (1 - tIn) * 180 - tOut * 60 });

    // Verify: press, a spinner counting seconds, then done.
    t1(t);
    verify.style.transform = `scale(${pressScale(t, 7.3)})`;
    if (t < 7.35) vt.innerHTML = `<span style="display:inline-flex;align-items:center;gap:14px"><span style="display:inline-flex">${ico('check')}</span>Verify</span>`;
    else if (t < 9.5)
      vt.innerHTML = `<span style="display:inline-flex;align-items:center;gap:16px"><span style="display:inline-block;width:36px;height:36px;border-radius:50%;border:4px solid rgba(9,9,11,0.2);border-top-color:#09090b;transform:rotate(${(t - 7.35) * 720}deg)"></span>Verifying<span class="mono" style="font-size:28px;opacity:0.6">${Math.floor(t - 7.35) + 1}s</span></span>`;
    else vt.innerHTML = `<span style="display:inline-flex;align-items:center;gap:14px"><span style="display:inline-flex">${ico('checkCircle')}</span>Done</span>`;
    const done = ep(t, 9.5, 9.75);
    verify.style.background = `color-mix(in srgb, var(--up) ${done * 100}%, var(--text))`;
    taskCoins(t);
    pts += 500 * ep(t, 10.0, 11.0, ease.out);
    ptsV.textContent = fmt(pts);
    const hit = Math.max(...DAYS.map((_, i) => ep(t, 1.7 + i * 0.55, 1.8 + i * 0.55) * (1 - ep(t, 1.8 + i * 0.55, 2.1 + i * 0.55))), ep(t, 10.1, 10.25) * (1 - ep(t, 10.25, 10.7)));
    ptsChip.style.transform = `scale(${1 + 0.1 * hit})`;
    const barOut = ep(t, 12.3, 12.9, ease.in);
    setT(bar, { o: 1 - barOut });

    const cam = keys(t, [
      [0, { x: 540, y: (1000) - 220, z: 1.0, r: 0 }],
      [1.0, { x: 540, y: (1010) - 220, z: 1.08, r: -0.3 }],
      [4.9, { x: 540, y: (1020) - 220, z: 1.14, r: 0.3 }],
      [6.3, { x: 540, y: (taskBox.top + taskBox.height / 2 - 120) - 220, z: 1.06, r: 0 }],
      [7.0, { x: 540, y: (vb.top - 180) - 220, z: 1.15, r: -0.3 }],
      [9.5, { x: 540, y: (vb.top - 170) - 220, z: 1.16, r: 0 }],
      [10.4, { x: 540, y: (980) - 220, z: 1.02, r: 0 }],
      [12.3, { x: 540, y: (990) - 220, z: 1.06, r: 0.3 }],
      [13.0, { x: 540, y: (960) - 220, z: 1.0, r: 0 }],
    ]);
    // Square cut: the task part sits lower in the world, so the camera follows it down there.
    const sqShift = H < 1920 ? 220 * ep(t, 5.6, 6.5) * (1 - ep(t, 12.3, 12.9)) + 210 * ep(t, 6.4, 7.0) * (1 - ep(t, 12.3, 12.9)) - 600 * ep(t, 9.5, 10.4) * (1 - ep(t, 12.3, 12.9)) : 0;
    s.camera(cam.x, cam.y + sqShift, cam.z, cam.r);
    end(t);
    fade(t);
  };
}
