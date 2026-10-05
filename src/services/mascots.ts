/**
 * The characters on the result banner, one per outcome, drawn as plain SVG in a 300 × 300 box:
 * Moon a meme dog riding a rocket, Up a bull, Flat a sleeping bear, Down a grumpy bear, Crash a
 * dizzy bear. Flat shapes in the outcome colours, so they match the Firstprint mark.
 */

const FUR = '#8a5a3b';
const FUR_DARK = '#6b4429';
const MUZZLE = '#e0ae84';
const INK = '#1b1210';

/** The soft disc behind every character. */
function disc(color: string) {
  return `<circle cx="150" cy="150" r="140" fill="${color}" fill-opacity="0.10"/>
    <circle cx="150" cy="150" r="140" fill="none" stroke="${color}" stroke-opacity="0.28" stroke-width="2"/>`;
}

/** A bear's head; the face (eyes, mouth) is passed in. */
function bearHead(face: string, tilt = 0) {
  return `<g transform="rotate(${tilt} 150 170)">
    <circle cx="86" cy="104" r="30" fill="${FUR_DARK}"/><circle cx="86" cy="104" r="15" fill="${MUZZLE}"/>
    <circle cx="214" cy="104" r="30" fill="${FUR_DARK}"/><circle cx="214" cy="104" r="15" fill="${MUZZLE}"/>
    <ellipse cx="150" cy="170" rx="90" ry="80" fill="${FUR}"/>
    <ellipse cx="150" cy="204" rx="38" ry="28" fill="${MUZZLE}"/>
    <ellipse cx="150" cy="190" rx="13" ry="9" fill="${INK}"/>
    ${face}
  </g>`;
}

/** A small four-point sparkle (drawn as a path: the banner font has no star glyph). */
const star = (x: number, y: number, r: number, color: string, op = 1) =>
  `<path d="M${x} ${y - r} Q${x + r * 0.2} ${y - r * 0.2} ${x + r} ${y} Q${x + r * 0.2} ${y + r * 0.2} ${x} ${y + r} Q${x - r * 0.2} ${y + r * 0.2} ${x - r} ${y} Q${x - r * 0.2} ${y - r * 0.2} ${x} ${y - r} Z" fill="${color}" fill-opacity="${op}"/>`;
const eye = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="9" fill="${INK}"/><circle cx="${x + 3}" cy="${y - 3}" r="3" fill="#fff"/>`;
const line = (d: string, color = INK, w = 6) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** Flat: a bear asleep on a flat line. */
function sleepingBear(c: string) {
  return `${disc(c)}
    ${line('M40 262 H260', c, 7)}
    ${bearHead(`${line('M108 160 q15 11 30 0')}${line('M162 160 q15 11 30 0')}
      ${line('M150 199 v9', INK, 5)}${line('M138 214 q12 6 24 0', INK, 5)}
      <circle cx="104" cy="190" r="10" fill="#ff8fa3" fill-opacity="0.45"/><circle cx="196" cy="190" r="10" fill="#ff8fa3" fill-opacity="0.45"/>`, -8)}
    <text x="214" y="86" font-size="40" font-weight="700" fill="${c}">Z</text>
    <text x="244" y="56" font-size="30" font-weight="700" fill="${c}" fill-opacity="0.8">z</text>
    <text x="266" y="34" font-size="22" font-weight="700" fill="${c}" fill-opacity="0.6">z</text>`;
}

/** Down: a grumpy bear beside a falling line. */
function grumpyBear(c: string) {
  return `${disc(c)}
    ${line('M200 46 L226 80 L244 66 L272 112', c, 8)}${line('M252 112 H272 V92', c, 8)}
    ${bearHead(`${eye(122, 160)}${eye(178, 160)}
      ${line('M104 136 L136 146', INK, 6)}${line('M196 136 L164 146', INK, 6)}
      ${line('M134 220 q16 -12 32 0', INK, 5)}`)}`;
}

/** Crash: a dizzy bear, a line diving off a cliff, a drop of sweat. */
function dizzyBear(c: string) {
  const x = (cx: number, cy: number) => `${line(`M${cx - 10} ${cy - 10} L${cx + 10} ${cy + 10}`, INK, 6)}${line(`M${cx + 10} ${cy - 10} L${cx - 10} ${cy + 10}`, INK, 6)}`;
  return `${disc(c)}
    ${line('M200 40 L224 60 L236 52 L272 150', c, 8)}${line('M254 146 L272 150 L278 132', c, 8)}
    ${bearHead(`${x(122, 160)}${x(178, 160)}
      ${line('M128 220 q6 -8 11 0 q6 8 11 0 q6 -8 11 0 q6 8 11 0', INK, 5)}
      <path d="M222 120 q12 18 0 26 q-12 -8 0 -26 z" fill="#7cc7ff"/>`, 10)}
    ${star(66, 110, 14, c)}${star(40, 150, 8, c, 0.7)}`;
}

/** Up: a bull with a gold nose ring and a line going up. */
function bull(c: string) {
  return `${disc(c)}
    <path d="M92 118 C60 112 42 88 48 56 C64 82 84 92 108 96 Z" fill="#f3e3c3"/>
    <path d="M208 118 C240 112 258 88 252 56 C236 82 216 92 192 96 Z" fill="#f3e3c3"/>
    <ellipse cx="78" cy="136" rx="26" ry="13" transform="rotate(-24 78 136)" fill="#5a3826"/>
    <ellipse cx="222" cy="136" rx="26" ry="13" transform="rotate(24 222 136)" fill="#5a3826"/>
    <path d="M96 104 Q150 82 204 104 Q222 170 200 214 Q150 238 100 214 Q78 170 96 104 Z" fill="#6e4630"/>
    <path d="M118 100 Q150 116 182 100 Q166 128 150 130 Q134 128 118 100 Z" fill="#5a3826"/>
    ${eye(126, 152)}${eye(174, 152)}
    ${line('M110 134 L138 142', INK, 6)}${line('M190 134 L162 142', INK, 6)}
    <ellipse cx="150" cy="212" rx="50" ry="34" fill="${MUZZLE}"/>
    <ellipse cx="132" cy="206" rx="8" ry="10" fill="${INK}"/><ellipse cx="168" cy="206" rx="8" ry="10" fill="${INK}"/>
    <circle cx="150" cy="238" r="14" fill="none" stroke="#ffd60a" stroke-width="6"/>
    ${line('M214 262 L234 242 L248 252 L270 222', c, 8)}${line('M252 222 H270 V240', c, 8)}`;
}

/** Moon: a meme dog riding a rocket past the moon. */
function rocketDog(c: string) {
  return `${disc(c)}
    <path d="M236 52 a34 34 0 1 0 22 54 a26 26 0 1 1 -22 -54 z" fill="${c}" fill-opacity="0.9"/>
    ${star(56, 72, 12, c)}${star(252, 192, 9, c)}${star(96, 40, 7, c, 0.7)}
    <g transform="rotate(38 150 160)">
      <path d="M134 238 Q150 292 166 238 Z" fill="#ff9f0a"/><path d="M141 238 Q150 270 159 238 Z" fill="${c}"/>
      <path d="M120 196 L96 236 L124 228 Z" fill="${c}"/><path d="M180 196 L204 236 L176 228 Z" fill="${c}"/>
      <path d="M150 52 C186 84 190 160 178 236 H122 C110 160 114 84 150 52 Z" fill="#f5f5f7"/>
      <path d="M150 52 C162 62 170 76 175 92 H125 C130 76 138 62 150 52 Z" fill="#ff453a"/>
      <circle cx="150" cy="152" r="34" fill="#cfe8ff" stroke="#9aa4b2" stroke-width="5"/>
      <g transform="rotate(-38 150 152)">
        <path d="M128 140 L132 116 L146 134 Z" fill="#d98c3a"/><path d="M172 140 L168 116 L154 134 Z" fill="#d98c3a"/>
        <ellipse cx="150" cy="154" rx="25" ry="22" fill="#e8a54b"/>
        <ellipse cx="150" cy="164" rx="15" ry="11" fill="#fff4e3"/>
        <circle cx="141" cy="150" r="3.5" fill="${INK}"/><circle cx="159" cy="150" r="3.5" fill="${INK}"/>
        <ellipse cx="150" cy="160" rx="4.5" ry="3.2" fill="${INK}"/>
        ${line('M144 168 q6 5 12 0', INK, 2.5)}
      </g>
    </g>`;
}

const DRAW: Record<string, (color: string) => string> = { moon: rocketDog, up: bull, flat: sleepingBear, down: grumpyBear, crash: dizzyBear };

/** The character for a winning outcome (Yes/No markets use the bull and the grumpy bear), placed with its top-left at x, y and scaled to size. */
export function mascot(bucket: string, color: string, x: number, y: number, size = 300) {
  const draw = DRAW[bucket] ?? DRAW.flat;
  return `<g transform="translate(${x},${y}) scale(${size / 300})">${draw(color)}</g>`;
}
