/**
 * Token banners for the Telegram channel: one per market and post type (new market, last hour,
 * result), drawn as SVG and rendered to PNG on the server with resvg and the Geist fonts in
 * assets/fonts. No outside service is involved.
 */
import { Resvg } from '@resvg/resvg-js';
import { mascot } from './mascots.ts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const W = 1280;
const H = 720;
const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const FONTS = ['Geist-Regular.ttf', 'Geist-SemiBold.ttf', 'Geist-Bold.ttf', 'GeistMono-Medium.ttf'].map((f) => FONT_DIR + f).filter((f) => existsSync(f));

const C = { bg: '#07080c', text: '#f5f5f7', muted: '#9a9aa3', line: 'rgba(255,255,255,0.10)', card: 'rgba(255,255,255,0.045)' };
export const OUTCOME_COLORS: Record<string, string> = { moon: '#7dff3a', up: '#30d158', flat: '#a1a1aa', down: '#ff9f0a', crash: '#ff453a' };
const OUTCOME_NAMES: Record<string, string> = { moon: 'Moon', up: 'Up', flat: 'Flat', down: 'Down', crash: 'Crash' };

export interface BannerMarket {
  symbol: string;
  name: string | null;
  exchange: string;
  outcomes: string;
  basePrice: number | null;
  /** The start price is the price when predictions close (not known yet while they are open). */
  startAtClose?: boolean;
  closeAt: number;
  settleAt: number;
  pool?: number;
  predictors?: number;
  result?: { winningBucket: string | null; returnPct: number | null; basePrice: number | null; finalPrice: number | null; pool: number } | null;
}

export type BannerKind = 'live' | 'closing' | 'result';

/**
 * Text the Geist fonts can draw: Latin letters (with accents), digits and common punctuation.
 * Anything else (Chinese, emoji, …) would come out as empty boxes, so it is never put on a banner.
 */
export const drawable = (s: string) => /^[\x20-\x7e\u00a0-\u024f\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u00b7]*$/.test(s);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function utc(ts: number) {
  const d = new Date(ts);
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${d.getUTCDate()} ${m}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function price(n: number) {
  return `$${n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : Number(n.toPrecision(4))}`;
}

/** A stable colour for the letter avatar when there is no logo. */
function avatarColor(symbol: string) {
  const palette = ['#3987e5', '#d95926', '#199e70', '#9085e9', '#d55181', '#c98500'];
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function brand(x: number, y: number) {
  const bars = [
    [40, '#7dff3a'],
    [30, '#3fd69a'],
    [20, '#9faac0'],
    [30, '#ff8a5c'],
    [40, '#ff4d6a'],
  ] as const;
  return `<g transform="translate(${x},${y})">
    <rect width="60" height="60" rx="15" fill="#0b0f2a" stroke="#313b80" stroke-width="1.5"/>
    ${bars.map(([w, c], i) => `<rect x="${30 - w / 2}" y="${10 + i * 9.6}" width="${w}" height="6.4" rx="3.2" fill="${c}"/>`).join('')}
    <text x="78" y="41" font-size="34" font-weight="600" fill="${C.text}" letter-spacing="-0.6">Firstprint</text>
  </g>`;
}


/**
 * Result: a small token line ("MOLT result"), then the price move as the big number in the winning
 * outcome's colour, with the winning outcome beside it.
 */
function resultHero(m: BannerMarket, logoPng: string | null, won: string, pct: string, color: string, bucket: string | null) {
  const sym = m.symbol.toUpperCase();
  const size = 64;
  const x = 80;
  const y = 176;
  const logo = logoPng
    ? `<clipPath id="logo"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath>
       <image href="${logoPng}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#logo)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="${avatarColor(sym)}"/>
       <text x="${x + size / 2}" y="${y + size / 2 + 12}" text-anchor="middle" font-size="34" font-weight="700" fill="#ffffff">${esc(sym.slice(0, 1))}</text>`;
  const big = pct || won;
  // Left: the move, big. Right: the winning outcome's character with "Up wins" under it.
  const bigSize = big.length > 7 ? 150 : big.length > 6 ? 170 : 190;
  const cx = 1050;
  return `${logo}
    <text x="${x + size + 22}" y="${y + 45}" font-size="40" font-weight="600" fill="${C.text}" letter-spacing="-0.8">${esc(sym)} <tspan fill="${C.muted}" font-weight="400">result</tspan></text>
    <text x="${x - 6}" y="440" font-size="${bigSize}" font-weight="700" fill="${color}" letter-spacing="-6">${esc(big)}</text>
    ${bucket ? mascot(bucket, color, cx - 125, 150, 250) : ''}
    ${pct ? `<text x="${cx}" y="464" text-anchor="middle" font-size="40" font-weight="600" fill="${C.text}">${esc(won)} <tspan fill="${C.muted}" font-weight="400">wins</tspan></text>` : ''}`;
}

/** "47 min" or "1h 05m": the time left, for the last-hour banner. */
function timeLeft(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h}h ${String(min % 60).padStart(2, '0')}m`;
}

/**
 * Last hour: the token small at the top, then the time left as the big number in the middle, so the
 * post reads at a glance as "47 min left to predict".
 */
function closingHero(m: BannerMarket, logoPng: string | null, left: string, color: string) {
  const sym = m.symbol.toUpperCase();
  const name = displayName(m, 28);
  const bigSize = left.length > 6 ? 170 : 196;
  return `${centredLogo(sym, logoPng, W / 2, 186, 84, color)}
    <text x="${W / 2}" y="278" text-anchor="middle" font-size="34" font-weight="600" fill="${C.text}" letter-spacing="-0.6">${esc(sym)}${name ? ` <tspan fill="${C.muted}" font-weight="400">${esc(name)}</tspan>` : ''}</text>
    <text x="${W / 2}" y="${306 + bigSize * 0.86}" text-anchor="middle" font-size="${bigSize}" font-weight="700" fill="${color}" letter-spacing="-6">${esc(left)}</text>
    <text x="${W / 2}" y="${306 + bigSize * 0.86 + 52}" text-anchor="middle" font-size="36" font-weight="600" fill="${C.text}">left <tspan fill="${C.muted}" font-weight="400">to predict</tspan></text>`;
}

/** Up to three label / value pairs along the bottom, like an exchange listing notice. */
function facts(items: [string, string][], y: number) {
  return items
    .slice(0, 3)
    .map(
      ([label, value], i) => `<g transform="translate(${80 + i * 340},${y})">
        <text font-family="Geist Mono" font-size="17" font-weight="500" fill="${C.muted}" letter-spacing="1.8">${esc(label.toUpperCase())}</text>
        <text y="44" font-size="30" font-weight="600" fill="${C.text}">${esc(value)}</text>
      </g>`,
    )
    .join('');
}

/** Facts in centred columns along the bottom, for the centred banners. */
function centredFacts(items: [string, string][], y: number, gap = 380) {
  const list = items.slice(0, 3);
  return list
    .map(([label, value], i) => {
      const x = W / 2 + (i - (list.length - 1) / 2) * gap;
      return `<g transform="translate(${x},${y})">
        <text text-anchor="middle" font-family="Geist Mono" font-size="16" font-weight="500" fill="${C.muted}" letter-spacing="1.8">${esc(label.toUpperCase())}</text>
        <text text-anchor="middle" y="40" font-size="28" font-weight="600" fill="${C.text}">${esc(value)}</text>
      </g>`;
    })
    .join('');
}

/** A round logo (or letter avatar) centred on cx, with a soft ring in the accent colour. */
function centredLogo(sym: string, logoPng: string | null, cx: number, cy: number, size: number, color: string) {
  const r = size / 2;
  const face = logoPng
    ? `<clipPath id="logo"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
       <image href="${logoPng}" x="${cx - r}" y="${cy - r}" width="${size}" height="${size}" clip-path="url(#logo)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${avatarColor(sym)}"/>
       <text x="${cx}" y="${cy + size * 0.17}" text-anchor="middle" font-size="${Math.round(size * 0.48)}" font-weight="700" fill="#ffffff">${esc(sym.slice(0, 1))}</text>`;
  return `<circle cx="${cx}" cy="${cy}" r="${r + 46}" fill="url(#halo)"/>
    <circle cx="${cx}" cy="${cy}" r="${r + 10}" fill="none" stroke="${color}" stroke-opacity="0.35" stroke-width="2"/>
    ${face}`;
}

/** The token's name, when the font can draw it and it isn't just the ticker again. */
function displayName(m: BannerMarket, max: number) {
  const sym = m.symbol.toUpperCase();
  const name = drawable((m.name ?? '').trim()) ? (m.name ?? '').trim() : '';
  if (!name || name.toUpperCase() === sym) return '';
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/**
 * New market: the token is the whole point, so it sits in the middle, big: logo, ticker, name.
 * A small label says what this is; when predictions close and the result comes sit small below.
 */
function liveBody(m: BannerMarket, logoPng: string | null, color: string, upcoming: boolean) {
  const sym = m.symbol.toUpperCase();
  const tickerSize = Math.max(64, Math.min(120, Math.floor(1000 / (Math.max(sym.length, 3) * 0.66))));
  const name = displayName(m, 34);
  return `<text x="${W / 2}" y="182" text-anchor="middle" font-family="Geist Mono" font-size="20" font-weight="500" fill="${color}" letter-spacing="4">${upcoming ? 'NEW MARKET · LISTS SOON' : 'NEW MARKET LISTED'}</text>
    ${centredLogo(sym, logoPng, W / 2, 292, 164, color)}
    <text x="${W / 2}" y="${name ? 500 : 516}" text-anchor="middle" font-size="${tickerSize}" font-weight="700" fill="${C.text}" letter-spacing="-3">${esc(sym)}</text>
    ${name ? `<text x="${W / 2}" y="546" text-anchor="middle" font-size="30" fill="${C.muted}">${esc(name)}</text>` : ''}`;
}

/**
 * The SVG for a market's banner (exported for tests and previews). Clean and minimal, like an
 * exchange listing notice: the status, one plain headline, the token, and the key facts.
 * No slogans.
 */
export function bannerSvg(kind: BannerKind, m: BannerMarket, logoPng: string | null = null, now = Date.now()) {
  const upcoming = m.basePrice === null && !m.startAtClose;
  const status =
    kind === 'live'
      ? upcoming
        ? { text: 'UPCOMING', color: '#ff9f0a' }
        : { text: 'LIVE', color: '#30d158' }
      : kind === 'closing'
        ? { text: 'CLOSING SOON', color: '#ff9f0a' }
        : { text: 'RESULT', color: OUTCOME_COLORS[m.result?.winningBucket ?? 'flat'] ?? '#3987e5' };
  let items: [string, string][];
  // What fills the middle: the token (new market), the time left (last hour) or the move (result).
  let body = '';
  // New market and last hour are centred on the token; the result keeps its two columns.
  let centred = false;
  if (kind === 'live') {
    centred = true;
    items = [
      ['Predictions close', utc(m.closeAt)],
      ['Result', utc(m.settleAt)],
    ];
    body = liveBody(m, logoPng, status.color, upcoming);
  } else if (kind === 'closing') {
    // The time left is the story here, not the token: it leads, big, in the status colour.
    centred = true;
    items = [
      ['Predictions close', utc(m.closeAt)],
      ['Participants', (m.predictors ?? 0).toLocaleString('en-US')],
      ['Pool', `${(m.pool ?? 0).toLocaleString('en-US')} pts`],
    ];
    body = closingHero(m, logoPng, timeLeft(m.closeAt - now), status.color);
  } else {
    const r = m.result;
    const won = r?.winningBucket ? (m.outcomes === 'binary' ? (r.winningBucket === 'up' ? 'Yes' : 'No') : OUTCOME_NAMES[r.winningBucket]) : 'Settled';
    const pct = r?.returnPct != null ? ` ${r.returnPct >= 0 ? '+' : ''}${(r.returnPct * 100).toFixed(1)}%` : '';
    // Only the token's price: start → final.
    items = r?.basePrice != null && r?.finalPrice != null ? [['Price', `${price(r.basePrice)} → ${price(r.finalPrice)}`]] : [];
    body = resultHero(m, logoPng, won, pct.trim(), status.color, r?.winningBucket ?? null);
  }
  const pillW = status.text.length * 14 + 62;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Geist">
    <defs>
      <radialGradient id="glow" cx="${centred ? 0.5 : 0.9}" cy="${centred ? 0.42 : 0}" r="0.6"><stop offset="0" stop-color="${status.color}" stop-opacity="${centred ? 0.13 : 0.1}"/><stop offset="1" stop-color="${status.color}" stop-opacity="0"/></radialGradient>
      <radialGradient id="halo"><stop offset="0.55" stop-color="${status.color}" stop-opacity="0.22"/><stop offset="1" stop-color="${status.color}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="${C.bg}"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    ${brand(80, 64)}
    <g transform="translate(${W - 80 - pillW},70)">
      <rect width="${pillW}" height="48" rx="24" fill="${status.color}" fill-opacity="0.12" stroke="${status.color}" stroke-opacity="0.5"/>
      <circle cx="28" cy="24" r="6" fill="${status.color}"/>
      <text x="46" y="31" font-family="Geist Mono" font-size="19" font-weight="500" fill="${status.color}" letter-spacing="2">${esc(status.text)}</text>
    </g>
    ${body}
    ${
      centred
        ? `<line x1="${W / 2 - 420}" y1="${kind === 'live' ? 584 : 596}" x2="${W / 2 + 420}" y2="${kind === 'live' ? 584 : 596}" stroke="${C.line}" stroke-width="1.5"/>
    ${centredFacts(items, kind === 'live' ? 628 : 636, kind === 'live' ? 400 : 360)}`
        : `<line x1="80" y1="524" x2="${W - 80}" y2="524" stroke="${C.line}" stroke-width="1.5"/>
    ${facts(items, 576)}
    <text x="${W - 80}" y="${H - 34}" text-anchor="end" font-family="Geist Mono" font-size="17" fill="${C.muted}" letter-spacing="1">firstprint.fun</text>`
    }
  </svg>`;
}

/** "3d 4h", "5h 20m" or "12 min": time left for anything up to weeks away. */
function longLeft(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${String(min % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * The "markets live" banner: the count big, the tokens' logos in a row, and when the next one
 * closes. Tickers the font can't draw are left out of the row.
 */
export function summaryBannerSvg(tokens: { symbol: string; logoPng: string | null }[], stats: { count: number; next: { symbol: string; closeAt: number } | null; pool: number; participants: number }, now = Date.now()) {
  const green = OUTCOME_COLORS.up;
  const shown = tokens.filter((t) => drawable(t.symbol)).slice(0, 6);
  const size = 104;
  const gap = 28;
  const extra = stats.count > shown.length ? `+${stats.count - shown.length}` : '';
  // The row of logos (and a "+N" for the rest) sits in the middle.
  const rowW = shown.length * size + Math.max(0, shown.length - 1) * gap + (extra ? gap + extra.length * 22 : 0);
  const x0 = W / 2 - rowW / 2;
  const y = 318;
  const row = shown
    .map((t, i) => {
      const x = x0 + i * (size + gap);
      const sym = t.symbol.toUpperCase();
      const logo = t.logoPng && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(t.logoPng) ? t.logoPng : null;
      const face = logo
        ? `<clipPath id="tk${i}"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath><image href="${logo}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#tk${i})" preserveAspectRatio="xMidYMid slice"/>`
        : `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="${avatarColor(sym)}"/><text x="${x + size / 2}" y="${y + size / 2 + 18}" text-anchor="middle" font-size="52" font-weight="700" fill="#ffffff">${esc(sym.slice(0, 1))}</text>`;
      const label = sym.length > 7 ? `${sym.slice(0, 6)}…` : sym;
      return `${face}<text x="${x + size / 2}" y="${y + size + 40}" text-anchor="middle" font-size="24" font-weight="600" fill="${C.text}">${esc(label)}</text>`;
    })
    .join('');
  const more = extra ? `<text x="${x0 + shown.length * (size + gap)}" y="${y + size / 2 + 12}" font-size="34" font-weight="600" fill="${C.muted}">${extra}</text>` : '';
  const items: [string, string][] = [
    ['Participants', stats.participants.toLocaleString('en-US')],
    ...(stats.next ? [['Closing next', `${drawable(stats.next.symbol) ? `${stats.next.symbol.toUpperCase()} · ` : ''}in ${longLeft(stats.next.closeAt - now)}`] as [string, string]] : []),
    ['In play', `${stats.pool.toLocaleString('en-US')} pts`],
  ];
  const pillText = 'LIVE NOW';
  const pillW = pillText.length * 14 + 62;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Geist">
    <defs><radialGradient id="glow" cx="0.5" cy="0.4" r="0.6"><stop offset="0" stop-color="${green}" stop-opacity="0.12"/><stop offset="1" stop-color="${green}" stop-opacity="0"/></radialGradient></defs>
    <rect width="${W}" height="${H}" fill="${C.bg}"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    ${brand(80, 64)}
    <g transform="translate(${W - 80 - pillW},70)">
      <rect width="${pillW}" height="48" rx="24" fill="${green}" fill-opacity="0.12" stroke="${green}" stroke-opacity="0.5"/>
      <circle cx="28" cy="24" r="6" fill="${green}"/>
      <text x="46" y="31" font-family="Geist Mono" font-size="19" font-weight="500" fill="${green}" letter-spacing="2">${pillText}</text>
    </g>
    <text x="${W / 2}" y="262" text-anchor="middle" font-size="64" font-weight="600" fill="${C.text}" letter-spacing="-1.6"><tspan fill="${green}" font-weight="700">${stats.count}</tspan> market${stats.count === 1 ? '' : 's'} live <tspan fill="${C.muted}" font-weight="400">· pick yours</tspan></text>
    ${row}${more}
    <line x1="${W / 2 - 420}" y1="${H - 124}" x2="${W / 2 + 420}" y2="${H - 124}" stroke="${C.line}" stroke-width="1.5"/>
    ${centredFacts(items, H - 84, 360)}
  </svg>`;
}

export function renderSummaryBanner(...args: Parameters<typeof summaryBannerSvg>): Uint8Array {
  const resvg = new Resvg(summaryBannerSvg(...args), { fitTo: { mode: 'width', value: W }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Geist' } });
  return resvg.render().asPng();
}

/**
 * Renders a market's banner to PNG bytes. Throws for a ticker the font can't draw (such as
 * 币安人生), so the caller sends the fixed banner or plain text instead of a broken image.
 */
export function renderBanner(kind: BannerKind, m: BannerMarket, logoPng: string | null = null, now = Date.now()): Uint8Array {
  if (!drawable(m.symbol)) throw new Error(`the banner font can't draw the ticker ${m.symbol}`);
  const logo = logoPng && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(logoPng) ? logoPng : null;
  const resvg = new Resvg(bannerSvg(kind, m, logo, now), {
    fitTo: { mode: 'width', value: W },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Geist' },
  });
  return resvg.render().asPng();
}

/**
 * Turns any logo (PNG, JPEG, GIF, WebP or SVG, as base64) into a 256 × 256 PNG data URL for the
 * banners, so a logo the admin's browser couldn't copy still shows. Null if it can't be drawn.
 */
export function logoToPng(contentType: string, base64: string): string | null {
  try {
    const size = 256;
    let svg: string;
    if (contentType === 'image/svg+xml') {
      svg = Buffer.from(base64, 'base64').toString('utf8');
    } else {
      if (!/^image\/(png|jpeg|jpg|gif|webp)$/.test(contentType)) return null;
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image href="data:${contentType};base64,${base64}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice"/></svg>`;
    }
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render().asPng();
    // A blank render (the image didn't decode) is no better than the letter.
    if (png.length < 400) return null;
    const url = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
    return url.length <= 300_000 ? url : null;
  } catch {
    return null;
  }
}

// --- PnL cards ----------------------------------------------------------------------

export interface PnlCard {
  username: string;
  symbol: string;
  name: string | null;
  outcomes: string;
  picks: string[];
  winningBucket: string | null;
  returnPct: number | null;
  staked: number;
  payout: number;
  profit: number;
  won: boolean;
}

const PW = 1200;
const PH = 630;

const outcomeName = (b: string, binary: boolean) => (binary ? (b === 'up' ? 'Yes' : 'No') : (OUTCOME_NAMES[b] ?? b));
const pts = (n: number) => `${Math.round(n).toLocaleString('en-US')} pts`;

/**
 * A player's result on one market, sized for X and link previews (1200 × 630): the points won or
 * lost as the big number, the return on what they staked, what they picked and what happened.
 */
export function pnlSvg(c: PnlCard, logoPng: string | null = null) {
  const binary = c.outcomes === 'binary';
  const color = c.won ? '#30d158' : '#ff453a';
  const big = `${c.profit >= 0 ? '+' : '−'}${Math.abs(Math.round(c.profit)).toLocaleString('en-US')}`;
  const roi = c.staked > 0 ? `${c.profit >= 0 ? '+' : '−'}${Math.abs((c.profit / c.staked) * 100).toFixed(Math.abs(c.profit / c.staked) >= 1 ? 0 : 1)}%` : '';
  const sym = drawable(c.symbol) ? c.symbol.toUpperCase() : '';
  const name = drawable((c.name ?? '').trim()) ? (c.name ?? '').trim() : '';
  const tokenText = sym || name || 'Token';
  const user = drawable(c.username) ? `@${c.username}` : '';
  const picked = c.picks.map((b) => outcomeName(b, binary)).join(' + ') || '–';
  const move = c.returnPct != null ? ` ${c.returnPct >= 0 ? '+' : ''}${(c.returnPct * 100).toFixed(1)}%` : '';
  const result = c.winningBucket ? `${outcomeName(c.winningBucket, binary)}${move}` : `Settled${move}`;
  const size = 72;
  const x = 72;
  const y = 150;
  const logo = logoPng
    ? `<clipPath id="logo"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath>
       <image href="${logoPng}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#logo)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="${avatarColor(tokenText)}"/>
       <text x="${x + size / 2}" y="${y + size / 2 + 13}" text-anchor="middle" font-size="36" font-weight="700" fill="#ffffff">${esc(tokenText.slice(0, 1))}</text>`;
  const bigSize = big.length > 7 ? 150 : 180;
  const em: Record<string, number> = { ',': 0.27, '−': 0.6, '+': 0.6, '1': 0.5 };
  const bigEnd = x - 6 + [...big].reduce((w, ch) => w + (em[ch] ?? 0.62) * bigSize - 6, 0);
  const tag = c.won ? 'WON' : 'LOST';
  const pillW = tag.length * 14 + 62;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}" viewBox="0 0 ${PW} ${PH}" font-family="Geist">
    <defs>
      <radialGradient id="glow" cx="0.9" cy="0" r="0.7"><stop offset="0" stop-color="${color}" stop-opacity="0.14"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${PW}" height="${PH}" fill="${C.bg}"/>
    <rect width="${PW}" height="${PH}" fill="url(#glow)"/>
    ${brand(72, 52)}
    <g transform="translate(${PW - 72 - pillW},58)">
      <rect width="${pillW}" height="48" rx="24" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-opacity="0.5"/>
      <circle cx="28" cy="24" r="6" fill="${color}"/>
      <text x="46" y="31" font-family="Geist Mono" font-size="19" font-weight="500" fill="${color}" letter-spacing="2">${tag}</text>
    </g>
    ${logo}
    <text x="${x + size + 22}" y="${y + 50}" font-size="42" font-weight="600" fill="${C.text}" letter-spacing="-0.8">${esc(tokenText)} <tspan fill="${C.muted}" font-weight="400">prediction</tspan></text>
    <text x="${x - 6}" y="${y + 250}" font-size="${bigSize}" font-weight="700" fill="${color}" letter-spacing="-6">${esc(big)}</text>
    <text x="${Math.min(bigEnd + 24, 900)}" y="${y + 250}" font-size="44" font-weight="600" fill="${C.text}">pts${roi ? ` <tspan fill="${color}">${esc(roi)}</tspan>` : ''}</text>
    <line x1="${x}" y1="470" x2="${PW - x}" y2="470" stroke="${C.line}" stroke-width="1.5"/>
    ${[
      ['Picked', picked],
      ['Result', result],
      ['Staked', pts(c.staked)],
    ]
      .map(
        ([label, value], i) => `<g transform="translate(${x + i * 330},516)">
        <text font-family="Geist Mono" font-size="16" font-weight="500" fill="${C.muted}" letter-spacing="1.8">${esc(label.toUpperCase())}</text>
        <text y="42" font-size="28" font-weight="600" fill="${C.text}">${esc(value)}</text>
      </g>`,
      )
      .join('')}
    <text x="${PW - x}" y="${PH - 30}" text-anchor="end" font-family="Geist Mono" font-size="16" fill="${C.muted}" letter-spacing="1">${esc(user ? `${user} · firstprint.fun` : 'firstprint.fun')}</text>
  </svg>`;
}

export function renderPnl(c: PnlCard, logoPng: string | null = null): Uint8Array {
  const logo = logoPng && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(logoPng) ? logoPng : null;
  const resvg = new Resvg(pnlSvg(c, logo), {
    fitTo: { mode: 'width', value: PW },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Geist' },
  });
  return resvg.render().asPng();
}
