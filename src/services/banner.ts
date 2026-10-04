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

function pill(text: string, color: string) {
  const w = 70 + text.length * 15.9;
  return `<g transform="translate(${W - 72 - w},66)">
    <rect width="${w}" height="54" rx="27" fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-opacity="0.5" stroke-width="1.5"/>
    <circle cx="27" cy="27" r="6" fill="${color}"/>
    <text x="44" y="35" font-family="Geist Mono" font-size="21" font-weight="500" fill="${color}" letter-spacing="2.6">${esc(text)}</text>
  </g>`;
}

function tokenBlock(m: BannerMarket, logoPng: string | null, y: number) {
  const size = 176;
  const x = 72;
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

function statBoxes(items: [string, string][], y: number) {
  const gap = 18;
  const w = (W - 144 - gap * (items.length - 1)) / items.length;
  return items
    .map(([label, value], i) => {
      const x = 72 + i * (w + gap);
      return `<g transform="translate(${x},${y})">
        <rect width="${w}" height="112" rx="22" fill="${C.card}" stroke="${C.line}" stroke-width="1.5"/>
        <text x="26" y="40" font-family="Geist Mono" font-size="18" font-weight="500" fill="${C.muted}" letter-spacing="2">${esc(label)}</text>
        <text x="26" y="86" font-size="${value.length > 18 ? 30 : 36}" font-weight="600" fill="${C.text}" letter-spacing="-0.5">${esc(value)}</text>
      </g>`;
    })
    .join('');
}

function outcomeChips(m: BannerMarket, y: number, highlight: string | null = null) {
  const keys = m.outcomes === 'binary' ? ['up', 'down'] : ['moon', 'up', 'flat', 'down', 'crash'];
  const label = (k: string) => (m.outcomes === 'binary' ? (k === 'up' ? 'Yes' : 'No') : OUTCOME_NAMES[k]);
  let x = 72;
  return keys
    .map((k) => {
      const text = label(k);
      const w = 70 + text.length * 17;
      const on = highlight === null || highlight === k;
      const g = `<g transform="translate(${x},${y})" opacity="${on ? 1 : 0.35}">
        <rect width="${w}" height="58" rx="18" fill="${OUTCOME_COLORS[k]}" fill-opacity="${highlight === k ? 0.22 : 0.08}" stroke="${OUTCOME_COLORS[k]}" stroke-opacity="${highlight === k ? 0.9 : 0.35}" stroke-width="${highlight === k ? 2.5 : 1.5}"/>
        <circle cx="30" cy="29" r="8" fill="${OUTCOME_COLORS[k]}"/>
        <text x="50" y="39" font-size="28" font-weight="600" fill="${OUTCOME_COLORS[k]}">${esc(text)}</text>
      </g>`;
      x += w + 14;
      return g;
    })
    .join('');
}

/** The SVG for a market's banner (exported for tests and previews). */
export function bannerSvg(kind: BannerKind, m: BannerMarket, logoPng: string | null = null) {
  const accent = kind === 'live' ? '#30d158' : kind === 'closing' ? '#ff9f0a' : OUTCOME_COLORS[m.result?.winningBucket ?? 'flat'] ?? '#3987e5';
  const tag = kind === 'live' ? 'NEW MARKET LIVE' : kind === 'closing' ? 'LAST HOUR' : 'RESULT';
  let body = '';
  if (kind === 'live') {
    const q = m.outcomes === 'binary' && m.basePrice !== null ? `Will it be at or above ${price(m.basePrice)}?` : 'Where will it trade? Call its first move.';
    body = `<text x="72" y="430" font-size="38" font-weight="500" fill="${C.text}" letter-spacing="-0.5">${esc(q)}</text>
      ${outcomeChips(m, 458)}
      ${statBoxes(
        [
          ['START PRICE', m.basePrice === null ? 'At listing' : price(m.basePrice)],
          ['PREDICTIONS CLOSE', utc(m.closeAt)],
          ['RESULT', utc(m.settleAt)],
        ],
        546,
      )}`;
  } else if (kind === 'closing') {
    body = `<text x="72" y="440" font-size="58" font-weight="700" fill="${accent}" letter-spacing="-1.5">Predictions close in 1 hour</text>
      <text x="72" y="490" font-size="32" fill="${C.muted}">${m.predictors ? 'Get your pick in before the window shuts.' : 'Nobody has picked yet. Be the first: early picks earn more.'}</text>
      ${statBoxes(
        [
          ['POOL', `${(m.pool ?? 0).toLocaleString('en-US')} pts`],
          ['PREDICTORS', (m.predictors ?? 0).toLocaleString('en-US')],
          ['CLOSES', utc(m.closeAt)],
        ],
        546,
      )}`;
  } else {
    const r = m.result;
    const won = r?.winningBucket ? (m.outcomes === 'binary' ? (r.winningBucket === 'up' ? 'Yes' : 'No') : OUTCOME_NAMES[r.winningBucket]) : 'Settled';
    const pct = r?.returnPct != null ? `${r.returnPct >= 0 ? '+' : ''}${(r.returnPct * 100).toFixed(1)}%` : '';
    const move = r?.basePrice != null && r?.finalPrice != null ? `${price(r.basePrice)} → ${price(r.finalPrice)}` : '';
    body = `<text x="72" y="452" font-size="96" font-weight="700" fill="${accent}" letter-spacing="-3">${esc(won)}</text>
      ${pct ? `<text x="${92 + won.length * 58}" y="452" font-size="56" font-weight="600" fill="${C.text}" letter-spacing="-1">${esc(pct)}</text>` : ''}
      ${outcomeChips(m, 474, r?.winningBucket ?? null)}
      ${statBoxes(
        [
          ['PRICE MOVE', move || '–'],
          ['POOL PAID OUT', `${(r?.pool ?? 0).toLocaleString('en-US')} pts`],
        ],
        552,
      )}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Geist">
    <defs>
      <radialGradient id="g1" cx="0.9" cy="0.12" r="0.55"><stop offset="0" stop-color="${accent}" stop-opacity="0.28"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
      <radialGradient id="g2" cx="0.05" cy="1" r="0.5"><stop offset="0" stop-color="#0a84ff" stop-opacity="0.18"/><stop offset="1" stop-color="#0a84ff" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="${C.bg}"/>
    <rect width="${W}" height="${H}" fill="url(#g1)"/>
    <rect width="${W}" height="${H}" fill="url(#g2)"/>
    ${brand(72, 63)}
    ${pill(tag, accent)}
    ${tokenBlock(m, logoPng, 166)}
    ${body}
    <text x="72" y="${H - 20}" font-family="Geist Mono" font-size="17" fill="${C.muted}" letter-spacing="1">firstprint.fun · free to play · points have no cash value</text>
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
