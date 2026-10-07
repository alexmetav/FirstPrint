// Video 5: Get in early.
import { stage, el, ico, logo, caption, scrim, endCard, fades, keys, ep, ease, lerp, setT, fmt } from './lib.js';

export const DURATION = 15;
/** Framing for the square (X) cut. */
export const SQ = { z: 0.62, yo: 60 };
/** Sound cues in video time: [t, kind, variant]. */
export const SFX = [[0.6,'whoosh'],[1.3,'blip',0],[1.55,'blip',1],[1.8,'blip',2],[4.5,'whoosh'],[5.2,'riser',1.2],[6.4,'pop'],[6.6,'swish'],[7.5,'swish'],[8.9,'whoosh'],[10.0,'blip',1],[10.4,'blip',2],[10.8,'blip',3],[11.2,'blip',4],[11.6,'blip',5],[11.8,'success'],[13.0,'chime']];
export const HOOK = ["Get in", "early."];

export function build() {
  const s = stage();

  // 1. A new-market alert, as the Telegram channel posts it.
  const post = el(`<div class="abs" style="left:80px;top:760px;width:920px">
    <div style="display:flex;align-items:center;gap:20px;margin-bottom:18px">
      ${logo(76)}
      <div><div style="font-size:36px;font-weight:600">Firstprint</div><div class="muted" style="font-size:26px">Telegram channel · now</div></div>
    </div>
    <div style="padding:40px 44px;border-radius:12px 40px 40px 40px;background:#1d1d22;box-shadow:inset 0 0 0 1.5px #2b2b33">
      <div style="font-size:48px;font-weight:700;letter-spacing:-0.02em">Peak $PEAK</div>
      <div style="display:grid;gap:20px;margin-top:28px;font-size:34px">
        ${[['coins', 'Start price', 'at the close'], ['clock', 'Predictions close', 'Oct 9, 18:00 UTC'], ['trophy', 'Result', 'Oct 16, 18:00 UTC']]
          .map(([ic, a, b], i) => `<div class="ln" style="display:flex;align-items:center;gap:18px"><span style="display:inline-flex;color:${['var(--gold)', 'var(--up)', 'var(--moon)'][i]}">${ico(ic)}</span><span class="muted">${a}</span><span style="margin-left:auto" class="mono">${b}</span></div>`)
          .join('')}
      </div>
    </div>
  </div>`);
  s.add(post);
  const postLines = [...post.querySelectorAll('.ln')];

  // 2. Early bonus: a timeline from open to close with the weight falling.
  const early = el(`<div class="card" style="left:80px;top:760px;width:920px;padding:44px">
    <div class="eyebrow" style="font-size:24px">Early bonus</div>
    <div style="display:flex;align-items:baseline;gap:20px;margin-top:14px"><span class="mono w" style="font-size:150px;font-weight:600;letter-spacing:-0.04em;line-height:1">1.00×</span><span class="muted" style="font-size:32px">weight on your points</span></div>
    <div style="position:relative;height:16px;border-radius:16px;background:#25252b;margin-top:56px">
      <i class="fill" style="position:absolute;left:0;top:0;bottom:0;border-radius:16px;background:linear-gradient(90deg,var(--moon),var(--up) 45%,#35353e)"></i>
      <i class="knob" style="position:absolute;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:#f5f5f7;box-shadow:0 0 0 8px rgba(245,245,247,0.15)"></i>
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:24px" class="eyebrow"><span style="font-size:22px">Market opens</span><span style="font-size:22px">Predictions close</span></div>
  </div>`);
  s.add(early);
  const weight = early.querySelector('.w');
  const knob = early.querySelector('.knob');
  const fill = early.querySelector('.fill');

  // 3. Leaderboard.
  const players = [
    ['satoshi_fan', 8420],
    ['moonwalker', 7915],
    ['chartgazer', 7300],
    ['early_bird', 6880],
    ['flatline', 6410],
  ];
  const ROW = 118;
  const board = el(`<div class="card" style="left:80px;top:700px;width:920px;height:${150 + ROW * 6}px;overflow:hidden">
    <div style="display:flex;align-items:center;gap:18px;padding:36px 40px 20px"><span style="display:inline-flex;font-size:44px;color:var(--gold)">${ico('trophy')}</span><span style="font-size:44px;font-weight:600;letter-spacing:-0.02em">Leaderboard</span><span class="eyebrow" style="margin-left:auto;font-size:22px">This week</span></div>
  </div>`);
  const rowHtml = (name, pts, me) => `<div class="lb" style="position:absolute;left:0;right:0;height:${ROW}px;display:flex;align-items:center;gap:26px;padding:0 40px;border-top:1.5px solid #25252b;${me ? 'background:color-mix(in srgb, #30d158 12%, #111114);box-shadow:inset 0 0 0 3px var(--up);border-radius:20px;z-index:2' : ''}">
      <span class="mono rk" style="width:70px;font-size:36px;color:var(--muted)"></span>
      <span class="avatar" style="width:68px;height:68px;font-size:30px;${me ? 'background:linear-gradient(140deg,#30d158,#7dff3a);color:#09090b' : 'background:#2b2b33'}">${name[0].toUpperCase()}</span>
      <span style="font-size:38px;font-weight:${me ? 700 : 500}">${name}</span>
      <span class="mono pts" style="margin-left:auto;font-size:36px">${fmt(pts)}</span>
    </div>`;
  players.forEach(([n, pt]) => board.append(el(rowHtml(n, pt, false))));
  board.append(el(rowHtml('you', 5200, true)));
  s.add(board);
  const lbRows = [...board.querySelectorAll('.lb')];
  const me = lbRows[5];
  const mePts = me.querySelector('.pts');

  // Your points over time, and when you pass each player.
  const ptsAt = (t) => lerp(5200, 8900, ep(t, 9.8, 11.8, ease.inOut));
  const cross = players.map(([, pt]) => {
    for (let x = 9.8; x <= 11.8; x += 1 / 240) if (ptsAt(x) > pt) return x;
    return 99;
  });

  s.camera(540, 960, 1);
  const sc = scrim(s, { inAt: 0.4, outAt: 12.5, height: 600 });
  const c1 = caption(s, { top: 190, inAt: 0.45, outAt: 4.2, lines: [['New markets open', 'cap-h'], ['all the time.', 'cap-h'], ['Get the alert on Telegram.', 'cap-s']] });
  const c2 = caption(s, { top: 190, inAt: 4.7, outAt: 8.6, lines: [['Early picks count for more', 'cap-h'], ['when the pool is split.', 'cap-h']] });
  const c3 = caption(s, { top: 190, inAt: 9.1, outAt: 12.5, lines: [['Climb the leaderboard.', 'cap-h'], ['Every call is on the record.', 'cap-s']] });
  const end = endCard(s, 13.0);
  const fade = fades(s, DURATION);

  return (t) => {
    sc(t);
    c1(t);
    c2(t);
    c3(t);

    // 1. The alert drops in, its lines one by one.
    const pin = ep(t, 0.6, 1.4, ease.outQuint);
    const pout = ep(t, 4.1, 4.6, ease.in);
    setT(post, { y: (1 - pin) * -160 - pout * 100, o: pin * (1 - pout), s: lerp(0.94, 1, pin) });
    postLines.forEach((l, i) => {
      const k = ep(t, 1.3 + i * 0.25, 1.9 + i * 0.25, ease.outQuint);
      setT(l, { x: (1 - k) * 40, o: k });
    });

    // 2. Early bonus: the knob starts early (1.50×), slides towards the close as the weight falls,
    // then comes back to the early spot.
    const ein = ep(t, 4.5, 5.2, ease.outQuint);
    const eout = ep(t, 8.6, 9.0, ease.in);
    setT(early, { y: (1 - ein) * 160 - eout * 80, o: ein * (1 - eout) });
    const pos = keys(t, [[5.0, 0.04], [6.6, 0.04], [7.5, 0.86], [8.3, 0.08]]);
    knob.style.left = `${pos * 100}%`;
    fill.style.width = `${pos * 100}%`;
    weight.textContent = `${(1.5 - 0.5 * pos).toFixed(2)}×`;
    weight.style.color = pos < 0.3 ? 'var(--moon)' : 'var(--text)';
    const countUp = ep(t, 5.2, 6.4, ease.out);
    if (t < 6.6) weight.textContent = `${(1 + 0.5 * countUp).toFixed(2)}×`;

    // 3. Leaderboard: you start 6th and climb to 1st as your points grow.
    const bin = ep(t, 8.9, 9.6, ease.outQuint);
    const bout = ep(t, 12.4, 13.0, ease.in);
    setT(board, { y: (1 - bin) * 160 - bout * 80, o: bin * (1 - bout) });
    const myPts = ptsAt(t);
    mePts.textContent = fmt(myPts);
    // Each time you pass a player, the two rows swap places over 0.35 s.
    let mySlot = 5;
    players.forEach(([, pt], j) => {
      const k = ease.inOut(Math.min(1, Math.max(0, (t - cross[j]) / 0.35)));
      mySlot -= k;
      lbRows[j].style.top = `${120 + (j + k) * ROW}px`;
      lbRows[j].querySelector('.rk').textContent = `#${j + 1 + (t >= cross[j] + 0.17 ? 1 : 0)}`;
    });
    me.style.top = `${120 + mySlot * ROW}px`;
    const meRank = 1 + players.filter((_, j) => t < cross[j] + 0.17).length;
    me.querySelector('.rk').textContent = `#${meRank}`;
    me.querySelector('.rk').style.color = meRank === 1 ? 'var(--gold)' : 'var(--up)';

    const cam = keys(t, [
      [0, { x: 540, y: 800, z: 1.0, r: 0 }],
      [3.9, { x: 540, y: 820, z: 1.1, r: 0.4 }],
      [4.8, { x: 540, y: 760, z: 1.04, r: 0 }],
      [8.4, { x: 540, y: 770, z: 1.13, r: -0.3 }],
      [9.3, { x: 540, y: 930, z: 1.02, r: 0 }],
      [12.3, { x: 540, y: 920, z: 1.08, r: 0.3 }],
      [13.0, { x: 540, y: 900, z: 1.0, r: 0 }],
    ]);
    s.camera(cam.x, cam.y, cam.z, cam.r);
    end(t);
    fade(t);
  };
}
