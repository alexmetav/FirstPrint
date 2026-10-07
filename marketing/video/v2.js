// Video 2: Make a call in three taps.
import { stage, el, ico, caption, scrim, outcomeRows, OUTCOMES, oIcon, tap, endCard, fades, keys, ep, ease, lerp, setT, fmt, pressScale } from './lib.js';

export const DURATION = 15;
/** Framing for the square (X) cut. */
export const SQ = { z: 0.52, yo: 440 };
/** Sound cues in video time: [t, kind, variant]. */
export const SFX = [[0.45,'swell'],[2.2,'tap'],[2.45,'whoosh'],[3.3,'swish'],[5.0,'tap'],[5.1,'blip',2],[5.3,'blip',3],[5.45,'blip',4],[8.4,'tap'],[8.6,'tick'],[8.85,'tick'],[9.15,'success'],[9.6,'whoosh'],[10.45,'pop'],[10.6,'blip',5],[13.0,'chime']];
export const HOOK = ["Three taps", "to make a call."];

export function build() {
  const s = stage();

  // Outcome list card (as on the market page).
  const card = el(`<div class="card" style="left:80px;top:700px;width:920px;overflow:hidden">
    <div style="display:flex;align-items:center;gap:22px;padding:34px 40px 26px">
      <div class="avatar" style="width:84px;height:84px;font-size:38px">P</div>
      <div style="font-size:56px;font-weight:600;letter-spacing:-0.03em">PEAK</div>
      <span class="pill pill-open" style="margin-left:auto"><i class="dot"></i>Open</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:6px 40px 16px"><span class="eyebrow" style="font-size:22px">Final price vs start</span><span class="eyebrow" style="font-size:22px">Crowd</span></div>
  </div>`);
  const { node: rowsNode, rows } = outcomeRows([13, 46, 24, 11, 6]);
  card.append(rowsNode);
  rows.forEach((r, i) => (r.querySelector('.bar').style.width = `${[13, 46, 24, 11, 6][i]}%`));
  s.add(card);
  const up = rows[1];
  up.querySelector('.you').innerHTML = '<span class="tag-you">You 100</span>';
  const tag = up.querySelector('.tag-you');
  const poolLine = el('<div class="mono muted" style="position:absolute;left:80px;top:1610px;font-size:30px">Pool <span class="v" style="color:var(--text)">760</span> pts · <span class="n" style="color:var(--text)">2</span> participants</div>');
  s.add(poolLine);

  // The prediction sheet.
  const sheet = el(`<div class="abs" style="left:0;top:0;width:1080px;padding:44px 64px 80px;background:#111114;border-top-left-radius:52px;border-top-right-radius:52px;box-shadow:inset 0 1.5px 0 #35353e, 0 -40px 90px -30px rgba(0,0,0,0.9)">
    <div style="width:90px;height:8px;border-radius:8px;background:#35353e;margin:0 auto 34px"></div>
    <div style="display:flex;align-items:center;gap:16px;font-size:46px;font-weight:600;letter-spacing:-0.02em"><span style="font-size:44px;display:inline-flex">${ico('target')}</span>Predict PEAK</div>
    <div class="picker" style="display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-top:34px">${OUTCOMES.map(
      (o) => `<div data-pick="${o.b}" style="--c:${o.c};display:grid;justify-items:center;gap:8px;padding:20px 0;border-radius:24px;border:2px solid var(--line-strong);color:var(--c);font-size:28px;font-weight:600"><span style="font-size:40px;display:inline-flex">${oIcon(o.b)}</span>${o.name}</div>`,
    ).join('')}</div>
    <div class="eyebrow" style="margin-top:40px;font-size:24px">Stake</div>
    <div class="stake" style="display:flex;align-items:center;justify-content:space-between;height:112px;margin-top:14px;padding:0 34px;border-radius:24px;border:2px solid var(--line-strong);background:#0c0c0f"><span class="mono v" style="font-size:52px">0</span><span class="muted" style="font-size:32px">pts</span></div>
    <div class="chips" style="display:flex;gap:14px;margin-top:20px">${['25', '50', '100', '250', 'Max'].map((v) => `<div data-chip="${v}" style="flex:1;display:grid;place-items:center;height:84px;border-radius:999px;border:2px solid var(--line-strong);font-family:var(--mono);font-size:32px">${v}</div>`).join('')}</div>
    <div class="summary" style="margin-top:34px;padding:30px 34px;border-radius:24px;background:#0c0c0f;display:grid;gap:18px">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-size:32px;display:inline-flex;align-items:center;gap:12px;color:var(--up)"><span style="display:inline-flex;font-size:32px">${oIcon('up')}</span>If Up wins</span><span class="mono pay" style="font-size:46px;font-weight:600">about 0 pts</span></div>
      <div style="display:flex;justify-content:space-between;font-size:30px"><span class="muted">Return on stake</span><span class="mono ret">–</span></div>
      <div style="display:flex;justify-content:space-between;font-size:30px"><span class="muted">Early bonus</span><span class="mono bonus">–</span></div>
    </div>
    <div class="cta btn btn-white" style="width:100%;height:116px;margin-top:34px;font-size:40px"><span class="cta-t">Predict Up for 0 pts</span></div>
  </div>`);
  s.add(sheet);
  const pickUp = sheet.querySelector('[data-pick="up"]');
  const chip100 = sheet.querySelector('[data-chip="100"]');
  const stakeV = sheet.querySelector('.stake .v');
  const pay = sheet.querySelector('.pay');
  const ret = sheet.querySelector('.ret');
  const bonus = sheet.querySelector('.bonus');
  const cta = sheet.querySelector('.cta');
  const ctaT = sheet.querySelector('.cta-t');

  const SHEET_Y = 640; // resting top of the sheet
  s.camera(540, 960, 1);
  setT(sheet, { y: SHEET_Y });
  const box = (n) => n.getBoundingClientRect();
  const upB = box(up);
  const chipB = box(chip100);
  const ctaB = box(cta);
  const sumB = box(sheet.querySelector('.summary'));
  const rowsMidY = (box(rows[0]).top + box(rows[4]).bottom) / 2;

  const sc = scrim(s, { inAt: 0.4, outAt: 12.4, height: 600 });
  const c1 = caption(s, { top: 200, inAt: 0.45, outAt: 2.9, lines: [['Pick where the price lands.', 'cap-h']] });
  const c2 = caption(s, { top: 200, inAt: 3.3, outAt: 9.7, lines: [['Choose your points.', 'cap-h'], ['Early picks get a bonus.', 'cap-s']] });
  const c3 = caption(s, { top: 200, inAt: 10.3, outAt: 12.4, lines: [['Your call is in.', 'cap-h'], ['The result settles it.', 'cap-s']] });
  const t1 = tap(s, upB.left + 200, upB.top + upB.height / 2, 2.2);
  const t2 = tap(s, chipB.left + chipB.width / 2, chipB.top + chipB.height / 2, 5.0);
  const t3 = tap(s, ctaB.left + ctaB.width / 2, ctaB.top + ctaB.height / 2, 8.4);
  const end = endCard(s, 13.0);
  const fade = fades(s, DURATION);

  return (t) => {
    sc(t);
    c1(t);
    c2(t);
    c3(t);

    // Tap 1: Up.
    t1(t);
    const picked = t >= 2.2;
    up.classList.toggle('sel', picked && t < 3.2);
    up.style.transform = `scale(${pressScale(t, 2.2)})`;

    // The sheet rises after the pick and drops away once the prediction is placed.
    const rise = ep(t, 2.45, 3.25, ease.outQuint);
    const drop = ep(t, 9.6, 10.25, ease.in);
    setT(sheet, { y: lerp(1960, SHEET_Y, rise) + drop * 1400 });
    pickUp.style.background = 'rgba(48,209,88,0.14)';
    pickUp.style.borderColor = 'var(--up)';

    // Tap 2: 100.
    t2(t);
    const on100 = t >= 5.0;
    chip100.style.background = on100 ? 'var(--text)' : 'transparent';
    chip100.style.color = on100 ? '#09090b' : 'var(--text)';
    chip100.style.borderColor = on100 ? 'var(--text)' : 'var(--line-strong)';
    chip100.style.transform = `scale(${pressScale(t, 5.0)})`;
    const k = ep(t, 5.05, 5.75, ease.out);
    stakeV.textContent = fmt(100 * k);
    pay.textContent = `about ${fmt(770 * ep(t, 5.25, 6.2, ease.out))} pts`;
    ret.textContent = t >= 5.3 ? `${(7.7 * ep(t, 5.3, 6.2, ease.out)).toFixed(2)}×` : '–';
    bonus.textContent = t >= 5.4 ? `${(1 + 0.42 * ep(t, 5.4, 6.3, ease.out)).toFixed(2)}×` : '–';

    // Tap 3: predict. Label → placing → placed.
    t3(t);
    cta.style.transform = `scale(${pressScale(t, 8.4)})`;
    if (t < 8.45) ctaT.innerHTML = `Predict Up for ${fmt(100 * k)} pts`;
    else if (t < 9.15) ctaT.innerHTML = `<span style="display:inline-block;width:38px;height:38px;border-radius:50%;border:4px solid rgba(9,9,11,0.25);border-top-color:#09090b;transform:rotate(${(t - 8.45) * 720}deg)"></span>Placing prediction`;
    else ctaT.innerHTML = `<span style="display:inline-flex;font-size:44px">${ico('check')}</span>Prediction placed`;
    const ok = ep(t, 9.15, 9.45);
    cta.style.background = `color-mix(in srgb, var(--up) ${ok * 100}%, var(--text))`;

    // Back on the list: the You tag lands on Up and the pool ticks up.
    const tk = ep(t, 10.45, 10.95, ease.back);
    tag.style.display = t >= 10.45 ? 'inline-flex' : 'none';
    tag.style.transform = `scale(${lerp(0.3, 1, tk)})`;
    tag.style.opacity = String(Math.min(1, tk * 2));
    up.classList.toggle('sel', (picked && t < 3.2) || t >= 10.45);
    const pk = ep(t, 10.6, 11.4, ease.out);
    poolLine.querySelector('.v').textContent = fmt(760 + 100 * pk);
    poolLine.querySelector('.n').textContent = t >= 10.6 ? '3' : '2';
    const listOut = ep(t, 12.4, 13.0, ease.in);
    setT(card, { o: 1 - listOut, y: -listOut * 60 });
    setT(poolLine, { o: 1 - listOut });

    const cam = keys(t, [
      [0, { x: 540, y: rowsMidY - 160, z: 1.1, r: 0 }],
      [2.0, { x: 540, y: upB.top - 20, z: 1.16, r: -0.5 }],
      [2.6, { x: 540, y: upB.top - 20, z: 1.16, r: -0.5 }],
      [3.4, { x: 540, y: 1180, z: 1.0, r: 0 }],
      [4.4, { x: 540, y: chipB.top - 190, z: 1.13, r: 0.4 }],
      [5.6, { x: 540, y: chipB.top - 170, z: 1.15, r: 0.2 }],
      [6.5, { x: 540, y: sumB.top + sumB.height / 2 - 250, z: 1.14, r: 0 }],
      [7.6, { x: 540, y: sumB.top + sumB.height / 2 - 230, z: 1.15, r: 0 }],
      [8.2, { x: 540, y: ctaB.top - 300, z: 1.13, r: -0.3 }],
      [9.5, { x: 540, y: ctaB.top - 290, z: 1.14, r: 0 }],
      [10.4, { x: 540, y: upB.top - 130, z: 1.12, r: 0 }],
      [12.2, { x: 540, y: upB.top - 120, z: 1.15, r: 0.3 }],
      [13.0, { x: 540, y: 1050, z: 1.0, r: 0 }],
    ]);
    s.camera(cam.x, cam.y, cam.z, cam.r);
    end(t);
    fade(t);
  };
}
