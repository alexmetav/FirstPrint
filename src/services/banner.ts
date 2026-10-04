/**
 * Token banners for the Telegram channel: one per market and post type (new market, last hour,
 * result), drawn as SVG and rendered to PNG on the server with resvg and the Geist fonts in
 * assets/fonts. No outside service is involved.
 */
import { Resvg } from '@resvg/resvg-js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const W = 1280;
const H = 720;
const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const FONTS = ['Geist-Regular.ttf', 'Geist-SemiBold.ttf', 'Geist-Bold.ttf', 'GeistMono-Medium.ttf'].map((f) => FONT_DIR + f).filter((f) => existsSync(f));

const C = { bg: '#07080c', text: '#f5f5f7', muted: '#9a9aa3', line: 'rgba(255,255,255,0.10)', card: 'rgba(255,255,255,0.045)' };
export const OUTCOME_COLORS: Record<string, string> = { moon: '#ffd60a', up: '#30d158', flat: '#a1a1aa', down: '#ff9f0a', crash: '#ff453a' };
const OUTCOME_NAMES: Record<string, string> = { moon: 'Moon', up: 'Up', flat: 'Flat', down: 'Down', crash: 'Crash' };

export interface BannerMarket {
  symbol: string;
  name: string | null;
  exchange: string;
  outcomes: string;
  basePrice: number | null;
  closeAt: number;
  settleAt: number;
  pool?: number;
  predictors?: number;
  result?: { winningBucket: string | null; returnPct: number | null; basePrice: number | null; finalPrice: number | null; pool: number } | null;
}

export type BannerKind = 'live' | 'closing' | 'result';

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
    [40, '#ffc53d'],
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


function tokenBlock(m: BannerMarket, logoPng: string | null, y: number) {
  const size = 176;
  const x = 80;
  const sym = m.symbol.toUpperCase();
  const symSize = Math.max(64, Math.min(124, Math.floor(820 / (Math.max(sym.length + 1, 4) * 0.64))));
  const name = (m.name ?? '').trim();
  const shortName = name.length > 30 ? `${name.slice(0, 29)}…` : name;
  const avatar = logoPng
    ? `<clipPath id="logo"><circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}"/></clipPath>
       <circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2 + 4}" fill="#ffffff" fill-opacity="0.08"/>
       <image href="${logoPng}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#logo)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="${avatarColor(sym)}"/>
       <text x="${x + size / 2}" y="${y + size / 2 + 30}" text-anchor="middle" font-size="88" font-weight="700" fill="#ffffff">${esc(sym.slice(0, 1))}</text>`;
  const tx = x + size + 44;
  return `${avatar}
    <text x="${tx}" y="${y + 92}" font-size="${symSize}" font-weight="700" fill="${C.text}" letter-spacing="-3">$${esc(sym)}</text>
    <text x="${tx + 4}" y="${y + 150}" font-size="34" fill="${C.muted}">${esc(shortName ? `${shortName} · ` : '')}on ${esc(m.exchange)}</text>`;
}



/**
 * The SVG for a market's banner (exported for tests and previews). Kept deliberately minimal:
 * the brand, the token (logo and ticker), one headline and one line of detail. Nothing else.
 */
export function bannerSvg(kind: BannerKind, m: BannerMarket, logoPng: string | null = null) {
  const accent = kind === 'live' ? '#30d158' : kind === 'closing' ? '#ff9f0a' : OUTCOME_COLORS[m.result?.winningBucket ?? 'flat'] ?? '#3987e5';
  const tag = kind === 'live' ? 'NEW MARKET' : kind === 'closing' ? 'LAST HOUR' : 'RESULT';
  let headline = '';
  let detail = '';
  if (kind === 'live') {
    headline =
      m.outcomes === 'binary' && m.basePrice !== null
        ? `<tspan fill="${C.text}">Above ${esc(price(m.basePrice))}?</tspan> <tspan fill="${C.muted}">Yes or No.</tspan>`
        : `<tspan fill="${C.text}">Moon or Crash?</tspan> <tspan fill="${C.muted}">Call it.</tspan>`;
    detail = `${m.basePrice === null ? 'Starts at listing' : `Start ${price(m.basePrice)}`}   ·   Closes ${utc(m.closeAt)}`;
  } else if (kind === 'closing') {
    headline = `<tspan fill="${accent}">1 hour left</tspan> <tspan fill="${C.muted}">to predict.</tspan>`;
    detail = m.predictors ? `${(m.predictors ?? 0).toLocaleString('en-US')} predictor${m.predictors === 1 ? '' : 's'}   ·   ${(m.pool ?? 0).toLocaleString('en-US')} pts in the pool` : 'No picks yet. Early picks earn more.';
  } else {
    const r = m.result;
    const won = r?.winningBucket ? (m.outcomes === 'binary' ? (r.winningBucket === 'up' ? 'Yes' : 'No') : OUTCOME_NAMES[r.winningBucket]) : 'Settled';
    const pct = r?.returnPct != null ? `${r.returnPct >= 0 ? '+' : ''}${(r.returnPct * 100).toFixed(1)}%` : '';
    headline = `<tspan fill="${accent}">${esc(won)}</tspan>${pct ? ` <tspan fill="${C.muted}">${esc(pct)}</tspan>` : ''}`;
    const move = r?.basePrice != null && r?.finalPrice != null ? `${price(r.basePrice)} → ${price(r.finalPrice)}   ·   ` : '';
    detail = `${move}${(r?.pool ?? 0).toLocaleString('en-US')} pts paid out`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Geist">
    <defs>
      <radialGradient id="glow" cx="0.85" cy="0" r="0.7"><stop offset="0" stop-color="${accent}" stop-opacity="0.16"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="${C.bg}"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    ${brand(80, 70)}
    <g transform="translate(${W - 80},108)">
      <circle cx="-${tag.length * 15.4 + 22}" cy="-7" r="6" fill="${accent}"/>
      <text text-anchor="end" font-family="Geist Mono" font-size="21" font-weight="500" fill="${accent}" letter-spacing="2.6">${esc(tag)}</text>
    </g>
    ${tokenBlock(m, logoPng, 214)}
    <text x="80" y="540" font-size="60" font-weight="600" letter-spacing="-1.8">${headline}</text>
    <text x="82" y="598" font-size="28" fill="${C.muted}">${esc(detail)}</text>
    <text x="${W - 80}" y="${H - 52}" text-anchor="end" font-family="Geist Mono" font-size="18" fill="${C.muted}" letter-spacing="1">firstprint.fun</text>
  </svg>`;
}

/** Renders a market's banner to PNG bytes. */
export function renderBanner(kind: BannerKind, m: BannerMarket, logoPng: string | null = null): Uint8Array {
  const logo = logoPng && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(logoPng) ? logoPng : null;
  const resvg = new Resvg(bannerSvg(kind, m, logo), {
    fitTo: { mode: 'width', value: W },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Geist' },
  });
  return resvg.render().asPng();
}
