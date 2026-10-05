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

/**
 * Text the Geist fonts can draw: Latin letters (with accents), digits and common punctuation.
 * Anything else (Chinese, emoji, …) would come out as empty boxes, so it is never put on a banner.
 */
export const drawable = (s: string) => /^[\x20-\x7e\u00a0-\u024f\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u00b7]*$/.test(s);

/** "MEXC" or "MEXC +2 more", so a market on many exchanges still fits on one line. */
function exchangeLabel(exchange: string) {
  const names = exchange.split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
  return names.length > 2 ? `${names[0]} +${names.length - 1} more` : names.join(' and ');
}

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


/** The token: logo (or a letter avatar), the ticker, and its name and exchange underneath. */
function tokenBlock(m: BannerMarket, logoPng: string | null, y: number) {
  const size = 160;
  const x = 80;
  const sym = m.symbol.toUpperCase();
  const symSize = Math.max(60, Math.min(110, Math.floor(780 / (Math.max(sym.length + 1, 4) * 0.64))));
  // A name the font can't draw is left off; the ticker is checked before drawing (see renderBanner).
  const name = drawable((m.name ?? '').trim()) ? (m.name ?? '').trim() : '';
  const shortName = name.length > 30 ? `${name.slice(0, 29)}…` : name;
  const cx = x + size / 2;
  const cy = y + size / 2;
  const avatar = logoPng
    ? `<clipPath id="logo"><circle cx="${cx}" cy="${cy}" r="${size / 2}"/></clipPath>
       <image href="${logoPng}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#logo)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${size / 2}" fill="${avatarColor(sym)}"/>
       <text x="${cx}" y="${cy + 28}" text-anchor="middle" font-size="80" font-weight="700" fill="#ffffff">${esc(sym.slice(0, 1))}</text>`;
  const tx = x + size + 40;
  return `${avatar}
    <text x="${tx}" y="${y + 92}" font-size="${symSize}" font-weight="700" fill="${C.text}" letter-spacing="-2.5">${esc(sym)}</text>
    <text x="${tx + 3}" y="${y + 142}" font-size="30" fill="${C.muted}">${esc(shortName ? `${shortName} · ` : '')}on ${esc(exchangeLabel(m.exchange))}</text>`;
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

/**
 * The SVG for a market's banner (exported for tests and previews). Clean and minimal, like an
 * exchange listing notice: the status, one plain headline, the token, and the key facts.
 * No slogans.
 */
export function bannerSvg(kind: BannerKind, m: BannerMarket, logoPng: string | null = null) {
  const upcoming = m.basePrice === null;
  const status =
    kind === 'live'
      ? upcoming
        ? { text: 'UPCOMING', color: '#ff9f0a' }
        : { text: 'LIVE', color: '#30d158' }
      : kind === 'closing'
        ? { text: 'CLOSING SOON', color: '#ff9f0a' }
        : { text: 'RESULT', color: OUTCOME_COLORS[m.result?.winningBucket ?? 'flat'] ?? '#3987e5' };
  let headline: string;
  let items: [string, string][];
  if (kind === 'live') {
    headline = 'New Market Listed';
    items = [
      ['Start price', upcoming ? 'At listing' : price(m.basePrice!)],
      ['Predictions close', utc(m.closeAt)],
      ['Result', utc(m.settleAt)],
    ];
  } else if (kind === 'closing') {
    headline = 'Last Hour to Predict';
    items = [
      ['Predictions close', utc(m.closeAt)],
      ['Predictors', (m.predictors ?? 0).toLocaleString('en-US')],
      ['Pool', `${(m.pool ?? 0).toLocaleString('en-US')} pts`],
    ];
  } else {
    const r = m.result;
    const won = r?.winningBucket ? (m.outcomes === 'binary' ? (r.winningBucket === 'up' ? 'Yes' : 'No') : OUTCOME_NAMES[r.winningBucket]) : 'Settled';
    const pct = r?.returnPct != null ? ` ${r.returnPct >= 0 ? '+' : ''}${(r.returnPct * 100).toFixed(1)}%` : '';
    headline = 'Market Settled';
    items = [
      ['Outcome', `${won}${pct}`],
      ...(r?.basePrice != null && r?.finalPrice != null ? [['Price', `${price(r.basePrice)} → ${price(r.finalPrice)}`] as [string, string]] : []),
      ['Paid out', `${(r?.pool ?? 0).toLocaleString('en-US')} pts`],
    ];
  }
  const pillW = status.text.length * 14 + 62;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Geist">
    <defs>
      <radialGradient id="glow" cx="0.9" cy="0" r="0.6"><stop offset="0" stop-color="${status.color}" stop-opacity="0.10"/><stop offset="1" stop-color="${status.color}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="${C.bg}"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    ${brand(80, 64)}
    <g transform="translate(${W - 80 - pillW},70)">
      <rect width="${pillW}" height="48" rx="24" fill="${status.color}" fill-opacity="0.12" stroke="${status.color}" stroke-opacity="0.5"/>
      <circle cx="28" cy="24" r="6" fill="${status.color}"/>
      <text x="46" y="31" font-family="Geist Mono" font-size="19" font-weight="500" fill="${status.color}" letter-spacing="2">${esc(status.text)}</text>
    </g>
    <text x="80" y="232" font-size="56" font-weight="600" fill="${C.text}" letter-spacing="-1.4">${esc(headline)}</text>
    ${tokenBlock(m, logoPng, 286)}
    <line x1="80" y1="524" x2="${W - 80}" y2="524" stroke="${C.line}" stroke-width="1.5"/>
    ${facts(items, 576)}
    <text x="${W - 80}" y="${H - 34}" text-anchor="end" font-family="Geist Mono" font-size="17" fill="${C.muted}" letter-spacing="1">firstprint.fun</text>
  </svg>`;
}

/**
 * Renders a market's banner to PNG bytes. Throws for a ticker the font can't draw (such as
 * 币安人生), so the caller sends the fixed banner or plain text instead of a broken image.
 */
export function renderBanner(kind: BannerKind, m: BannerMarket, logoPng: string | null = null): Uint8Array {
  if (!drawable(m.symbol)) throw new Error(`the banner font can't draw the ticker ${m.symbol}`);
  const logo = logoPng && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(logoPng) ? logoPng : null;
  const resvg = new Resvg(bannerSvg(kind, m, logo), {
    fitTo: { mode: 'width', value: W },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Geist' },
  });
  return resvg.render().asPng();
}
