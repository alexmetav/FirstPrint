// Video 1: The testnet is live.
import { stage, el, bigMark, caption, scrim, marketCard, tap, endCard, fades, keys, ep, p, ease, lerp, setT, fmt, pressScale } from './lib.js';

export const DURATION = 15;
/** Framing for the square (X) cut. */
export const SQ = { z: 0.62, yo: 20 };
/** Sound cues in video time: [t, kind, variant]. */
export const SFX = [[0.3,'blip',0],[0.41,'blip',1],[0.52,'blip',2],[0.63,'blip',3],[0.74,'blip',4],[1.4,'shimmer'],[2.6,'note',2],[5.75,'land'],[7.9,'blip',0],[8.02,'blip',1],[8.14,'blip',2],[8.26,'blip',3],[8.38,'blip',4],[11.0,'tap'],[11.05,'pop'],[11.1,'blip',5],[13.05,'chime']];
export const HOOK = ["Call where", "crypto lands."];

export function build() {
  const s = stage();

  // Logo intro, centred in the world.
  const logoWrap = s.add(el('<div class="abs" style="left:0;top:0;width:1080px;height:1920px"></div>'));
  const mark = bigMark(220);
  mark.style.left = '430px';
  mark.style.top = '850px';
  const word = el('<div class="abs" style="left:0;top:880px;font-size:132px;font-weight:600;letter-spacing:-0.04em;line-height:1">Firstprint</div>');
  logoWrap.append(mark, word);
  const bars = [...mark.querySelectorAll('[data-bar]')];
  // Width of the word, to centre mark + word together.
  const wordW = word.getBoundingClientRect().width;
  const gap = 44;
  const totalW = 220 + gap + wordW;
  const markEndX = 540 - totalW / 2;

  const cap1 = caption(s, {
    top: 700,
    inAt: 2.55,
    outAt: 4.6,
    lines: [
      ['<span style="font-size:112px">The Firstprint</span>', 'cap-h'],
      ['<span style="font-size:112px">testnet is live.</span>', 'cap-h'],
      ['Predict where crypto prices land, free.', 'cap-s'],
    ],
  });

  // The market card.
  const { node: card, rows } = marketCard({ pcts: [13, 46, 24, 11, 6] });
  card.style.left = '80px';
  card.style.top = '600px';
  s.add(card);
  const pcts = [13, 46, 24, 11, 6];
  const pcEls = rows.map((r) => r.querySelector('.pc'));
  const barEls = rows.map((r) => r.querySelector('.bar'));
  const up = rows[1];
  const youEl = up.querySelector('.you');
  youEl.innerHTML = '<span class="tag-you">You 100</span>';
  const tagEl = youEl.firstElementChild;

  // Where things are, in world space (camera is at rest while measuring).
  s.camera(540, 960, 1);
  const upBox = up.getBoundingClientRect();
  const upCenter = [upBox.left + upBox.width * 0.3, upBox.top + upBox.height / 2];
  const rowsTop = rows[0].getBoundingClientRect().top;
  const rowsBottom = rows[4].getBoundingClientRect().bottom;
  const headY = card.getBoundingClientRect().top + 230;

  const sc2 = scrim(s, { inAt: 8.3, outAt: 10.7, height: 640 });
  const cap2 = caption(s, {
    top: 200,
    inAt: 8.3,
    outAt: 10.7,
    lines: [['Pick where the price lands.', 'cap-h'], ['Moon, Up, Flat, Down or Crash.', 'cap-s']],
  });
  const tapUp = tap(s, upCenter[0], upCenter[1], 11.0);
  const end = endCard(s, 13.05);
  const fade = fades(s, DURATION);

  return (t) => {
    // Logo: bars draw in, then the word arrives and the pair settles left.
    bars.forEach((b, i) => {
      const k = ep(t, 0.3 + i * 0.11, 0.85 + i * 0.11, ease.outQuint);
      b.style.transform = `scaleX(${k})`;
      b.style.opacity = String(k > 0 ? 1 : 0);
    });
    const slide = ep(t, 1.15, 1.95, ease.inOut);
    const markX = lerp(430, markEndX, slide);
    mark.style.left = `${markX}px`;
    const wk = ep(t, 1.35, 2.05, ease.outQuint);
    word.style.left = `${markX + 220 + gap}px`;
    word.style.opacity = String(wk);
    word.style.clipPath = `inset(0 ${(1 - wk) * 100}% 0 0)`;
    const pop = ep(t, 0.25, 0.9, ease.back);
    mark.style.transform = `scale(${lerp(0.6, 1, pop)})`;
    // Logo leaves upwards as the headline arrives.
    const lo = ep(t, 2.2, 2.9, ease.inOut);
    setT(logoWrap, { y: -lo * 700, s: 1, o: 1 - lo });

    cap1(t);
    sc2(t);
    cap2(t);

    // Card flies in from below with a slight tilt.
    const ci = ep(t, 5.05, 6.1, ease.outQuint);
    const co = ep(t, 12.35, 12.95, ease.in);
    setT(card, { y: (1 - ci) * 1100 + co * -80, r: (1 - ci) * 6, o: Math.min(ci * 1.6, 1) * (1 - co) });

    // Crowd bars and numbers fill in.
    rows.forEach((r, i) => {
      const k = ep(t, 7.9 + i * 0.12, 8.9 + i * 0.12, ease.outQuint);
      barEls[i].style.width = `${pcts[i] * k}%`;
      pcEls[i].textContent = `${fmt(pcts[i] * k)}%`;
    });

    // The tap on Up.
    tapUp(t);
    const sel = t >= 11.0;
    up.classList.toggle('sel', sel);
    up.style.transform = `scale(${pressScale(t, 11.0)})`;
    const tk = ep(t, 11.05, 11.5, ease.back);
    tagEl.style.display = sel ? 'inline-flex' : 'none';
    tagEl.style.transform = `scale(${lerp(0.4, 1, tk)})`;
    tagEl.style.opacity = String(Math.min(1, tk * 2));
    card.querySelector('.pool').textContent = `${fmt(760 + 100 * ep(t, 11.1, 11.7))} pts`;

    // Camera: rest, push into the card head, glide down the outcomes, pull back.
    const rowsMid = (rowsTop + rowsBottom) / 2;
    const cam = keys(t, [
      [0, { x: 540, y: 960, z: 1, r: 0 }],
      [5.5, { x: 540, y: 1150, z: 1, r: 0 }],
      [6.5, { x: 420, y: headY, z: 1.75, r: -1.2 }],
      [7.6, { x: 470, y: headY + 50, z: 1.82, r: -0.6 }],
      [8.7, { x: 540, y: rowsMid - 330, z: 1.12, r: 0 }],
      [10.6, { x: 540, y: rowsMid - 350, z: 1.15, r: 0.4 }],
      [11.4, { x: 470, y: upCenter[1] - 190, z: 1.55, r: 0 }],
      [12.3, { x: 480, y: upCenter[1] - 200, z: 1.6, r: 0 }],
      [13.0, { x: 540, y: 1250, z: 1.05, r: 0 }],
    ]);
    s.camera(cam.x, cam.y, cam.z, cam.r);

    end(t);
    fade(t);
  };
}
