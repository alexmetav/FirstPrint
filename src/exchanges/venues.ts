/**
 * Exchange adapters: 1-minute candles, live tickers, spot pairs, and new-listing
 * announcements, using each exchange's public REST API (no API keys needed).
 *
 * ⚠️ Exchanges change these APIs. Before production, check every endpoint
 * against current docs and each exchange's terms for commercial data use.
 * Parsing is covered by fixture tests in test/exchanges.test.ts.
 */
import type { Candle } from '../engine/engine.ts';

export const MINUTE = 60_000;

export type Http = (url: string) => Promise<unknown>;

export interface Pair {
  pair: string;
  base: string;
  quote: string;
  /** Trading start time, if the exchange publishes it. */
  listingAt: number | null;
}

export interface Ticker {
  price: number;
  ts: number;
}

export interface Announcement {
  exchange: string;
  id: string;
  title: string;
  url: string | null;
  publishedAt: number | null;
  /** Trading start time if the exchange provides or the text states it. */
  listingAt: number | null;
  symbols: string[];
}

export interface Venue {
  id: string;
  name: string;
  /** Venue trading symbol for a USDT spot pair, e.g. XYZ → XYZUSDT or XYZ-USDT. */
  pair(base: string): string;
  fetchCandles(pair: string, startMs: number, endMs: number): Promise<Candle[]>;
  fetchTicker(pair: string): Promise<Ticker | null>;
  listPairs(): Promise<Pair[]>;
  /** New-listing announcements, newest first. Not every exchange offers this. */
  fetchAnnouncements?(): Promise<Announcement[]>;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const defaultHttp: Http = async (url) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'Firstprint/0.2 (+listing tracker)' },
      signal: AbortSignal.timeout(12_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${new URL(url).host}${new URL(url).pathname}`);
    return res.json();
  }
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const NOT_SYMBOLS = new Set(['USDT', 'USDC', 'USD', 'UTC', 'SPOT', 'NEW', 'API', 'APR', 'VIP', 'KYC', 'AMA', 'EVM', 'ETF', 'FAQ', 'P2P', 'CEX', 'DEX', 'TGE', 'HODL']);

/** Pulls ticker symbols from an announcement title or body. */
export function extractSymbols(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\(([A-Z0-9]{2,15})\)/g)) found.add(m[1]);
  for (const m of text.matchAll(/\b([A-Z0-9]{2,15})\s*[/_-]\s*USDT\b/g)) found.add(m[1]);
  for (const m of text.matchAll(/\b([A-Z0-9]{2,15})USDT\b/g)) found.add(m[1]);
  return [...found].filter((s) => !NOT_SYMBOLS.has(s) && /[A-Z]/.test(s));
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Finds a UTC date-time in announcement text, preferring one near the word
 * "trading". Supports "2026-09-20 10:00 (UTC)", "2026/09/20 10:00 UTC",
 * "Sep 20, 2026, 10:00 (UTC)", and "10:00 (UTC) on September 20, 2026".
 */
export function extractListingTime(text: string): number | null {
  const candidates: { ts: number; index: number }[] = [];
  const push = (y: number, mo: number, d: number, h: number, mi: number, ampm: string | undefined, index: number) => {
    let hour = h;
    if (ampm) {
      const pm = ampm.toLowerCase() === 'pm';
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    const ts = Date.UTC(y, mo, d, hour, mi);
    if (Number.isFinite(ts) && mo >= 0 && mo < 12 && d >= 1 && d <= 31 && hour < 24 && mi < 60) candidates.push({ ts, index });
  };

  for (const m of text.matchAll(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\s*\(?UTC\)?/gi)) {
    push(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6], m.index!);
  }
  for (const m of text.matchAll(/([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4}),?(?: at)? (\d{1,2}):(\d{2})\s*(am|pm)?\s*\(?UTC\)?/gi)) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)];
    if (mo !== undefined) push(+m[3], mo, +m[2], +m[4], +m[5], m[6], m.index!);
  }
  for (const m of text.matchAll(/(\d{1,2}):(\d{2})\s*(am|pm)?\s*\(?UTC\)?,? on ([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})/gi)) {
    const mo = MONTHS[m[4].toLowerCase().slice(0, 3)];
    if (mo !== undefined) push(+m[6], mo, +m[5], +m[1], +m[2], m[3], m.index!);
  }
  if (candidates.length === 0) return null;

  const tradingAt = text.search(/trad(e|ing)/i);
  if (tradingAt >= 0) {
    // Prefer the first time after the word "trading"; otherwise the closest one before it.
    const after = candidates.filter((c) => c.index > tradingAt).sort((a, b) => a.index - b.index);
    if (after.length) return after[0].ts;
    return candidates.sort((a, b) => b.index - a.index)[0].ts;
  }
  return candidates.sort((a, b) => a.index - b.index)[0].ts;
}

const num = (v: unknown) => Number(v);
const toMs = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

function finalize(candles: Candle[], startMs: number, endMs: number): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const c of candles) {
    if (c.ts >= startMs && c.ts < endMs && c.ts + MINUTE <= Date.now() + 1 && Number.isFinite(c.close) && c.close > 0) byTs.set(c.ts, c);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

function announcement(exchange: string, id: unknown, title: unknown, url: unknown, publishedAt: unknown, body = '', listingAt: number | null = null): Announcement {
  const t = String(title ?? '');
  return {
    exchange,
    id: String(id ?? t),
    title: t,
    url: url ? String(url) : null,
    publishedAt: toMs(publishedAt),
    listingAt: listingAt ?? extractListingTime(`${t}\n${body}`),
    symbols: extractSymbols(t).length ? extractSymbols(t) : extractSymbols(body),
  };
}

// ---------------------------------------------------------------------------
// Binance-compatible APIs (Binance, MEXC)
// ---------------------------------------------------------------------------

function binanceCompatible(opts: { id: string; name: string; base: string; limit: number; tradesIndex: number | null; http: Http }): Venue {
  const { http } = opts;
  return {
    id: opts.id,
    name: opts.name,
    pair: (b) => `${b.toUpperCase()}USDT`,

    async fetchCandles(pair, startMs, endMs) {
      const out: Candle[] = [];
      let cursor = Math.floor(startMs / MINUTE) * MINUTE;
      while (cursor < endMs) {
        const rows = (await http(`${opts.base}/api/v3/klines?symbol=${pair}&interval=1m&startTime=${cursor}&endTime=${endMs - 1}&limit=${opts.limit}`)) as unknown[][];
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const r of rows) {
          out.push({ ts: num(r[0]), close: num(r[4]), volume: num(r[7]), trades: opts.tradesIndex === null ? undefined : num(r[opts.tradesIndex]) });
        }
        const next = num(rows[rows.length - 1][0]) + MINUTE;
        if (next <= cursor || rows.length < opts.limit) break;
        cursor = next;
      }
      return finalize(out, startMs, endMs);
    },

    async fetchTicker(pair) {
      const d = (await http(`${opts.base}/api/v3/ticker/price?symbol=${pair}`)) as { price?: string };
      return d?.price ? { price: num(d.price), ts: Date.now() } : null;
    },

    async listPairs() {
      const d = (await http(`${opts.base}/api/v3/exchangeInfo`)) as { symbols?: { symbol: string; baseAsset: string; quoteAsset: string }[] };
      return (d.symbols ?? [])
        .filter((s) => s.quoteAsset === 'USDT')
        .map((s) => ({ pair: s.symbol, base: s.baseAsset, quote: s.quoteAsset, listingAt: null }));
    },
  };
}

export function binance(http: Http = defaultHttp): Venue {
  const v = binanceCompatible({ id: 'binance', name: 'Binance', base: 'https://api.binance.com', limit: 1000, tradesIndex: 8, http });
  v.fetchAnnouncements = async () => {
    // Binance website CMS feed, catalog 48 = "New Cryptocurrency Listing". Unofficial; verify before relying on it.
    const d = (await http('https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=48&pageNo=1&pageSize=20')) as {
      data?: { catalogs?: { articles?: { id: number; code: string; title: string; releaseDate: number }[] }[] };
    };
    const articles = d.data?.catalogs?.[0]?.articles ?? [];
    return articles.map((a) => announcement('binance', a.id, a.title, `https://www.binance.com/en/support/announcement/detail/${a.code}`, a.releaseDate));
  };
  return v;
}

/** MEXC has no public announcements API; new listings are found by pair diffs. */
export function mexc(http: Http = defaultHttp): Venue {
  return binanceCompatible({ id: 'mexc', name: 'MEXC', base: 'https://api.mexc.com', limit: 500, tradesIndex: null, http });
}

// ---------------------------------------------------------------------------
// Bybit (v5)
// ---------------------------------------------------------------------------

export function bybit(http: Http = defaultHttp): Venue {
  const base = 'https://api.bybit.com';
  return {
    id: 'bybit',
    name: 'Bybit',
    pair: (b) => `${b.toUpperCase()}USDT`,

    async fetchCandles(pair, startMs, endMs) {
      const out: Candle[] = [];
      let end = endMs - 1;
      for (let page = 0; page < 20 && end >= startMs; page++) {
        const d = (await http(`${base}/v5/market/kline?category=spot&symbol=${pair}&interval=1&start=${startMs}&end=${end}&limit=1000`)) as { result?: { list?: string[][] } };
        const rows = d.result?.list ?? [];
        if (rows.length === 0) break;
        for (const r of rows) out.push({ ts: num(r[0]), close: num(r[4]), volume: num(r[6]) });
        const oldest = Math.min(...rows.map((r) => num(r[0])));
        if (rows.length < 1000) break;
        end = oldest - 1;
      }
      return finalize(out, startMs, endMs);
    },

    async fetchTicker(pair) {
      const d = (await http(`${base}/v5/market/tickers?category=spot&symbol=${pair}`)) as { time?: number; result?: { list?: { lastPrice: string }[] } };
      const t = d.result?.list?.[0];
      return t ? { price: num(t.lastPrice), ts: d.time ?? Date.now() } : null;
    },

    async listPairs() {
      const out: Pair[] = [];
      let cursor = '';
      for (let page = 0; page < 10; page++) {
        const d = (await http(`${base}/v5/market/instruments-info?category=spot&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)) as {
          result?: { list?: { symbol: string; baseCoin: string; quoteCoin: string }[]; nextPageCursor?: string };
        };
        for (const s of d.result?.list ?? []) if (s.quoteCoin === 'USDT') out.push({ pair: s.symbol, base: s.baseCoin, quote: s.quoteCoin, listingAt: null });
        cursor = d.result?.nextPageCursor ?? '';
        if (!cursor) break;
      }
      return out;
    },

    async fetchAnnouncements() {
      const d = (await http(`${base}/v5/announcements/index?locale=en-US&type=new_crypto&limit=20`)) as {
        result?: { list?: { title: string; description: string; url: string; dateTimestamp: number; startDateTimestamp?: number }[] };
      };
      return (d.result?.list ?? []).map((a) =>
        announcement('bybit', a.url, a.title, a.url, a.dateTimestamp, a.description, a.startDateTimestamp && a.startDateTimestamp > a.dateTimestamp ? a.startDateTimestamp : null),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// OKX (v5)
// ---------------------------------------------------------------------------

export function okx(http: Http = defaultHttp): Venue {
  const base = 'https://www.okx.com';
  return {
    id: 'okx',
    name: 'OKX',
    pair: (b) => `${b.toUpperCase()}-USDT`,

    async fetchCandles(pair, startMs, endMs) {
      const out: Candle[] = [];
      let after = endMs; // OKX "after" returns records older than this timestamp
      for (let page = 0; page < 60; page++) {
        // /market/candles serves roughly the latest day quickly; older data needs /history-candles.
        const path = after > Date.now() - 20 * 60 * MINUTE ? 'candles' : 'history-candles';
        const d = (await http(`${base}/api/v5/market/${path}?instId=${pair}&bar=1m&after=${after}&limit=100`)) as { data?: string[][] };
        const rows = d.data ?? [];
        if (rows.length === 0) break;
        for (const r of rows) if (r[8] !== '0') out.push({ ts: num(r[0]), close: num(r[4]), volume: num(r[7]) });
        const oldest = Math.min(...rows.map((r) => num(r[0])));
        if (oldest <= startMs || rows.length < 100) break;
        after = oldest;
      }
      return finalize(out, startMs, endMs);
    },

    async fetchTicker(pair) {
      const d = (await http(`${base}/api/v5/market/ticker?instId=${pair}`)) as { data?: { last: string; ts: string }[] };
      const t = d.data?.[0];
      return t ? { price: num(t.last), ts: num(t.ts) } : null;
    },

    async listPairs() {
      const d = (await http(`${base}/api/v5/public/instruments?instType=SPOT`)) as { data?: { instId: string; baseCcy: string; quoteCcy: string; listTime: string }[] };
      return (d.data ?? [])
        .filter((s) => s.quoteCcy === 'USDT')
        .map((s) => ({ pair: s.instId, base: s.baseCcy, quote: s.quoteCcy, listingAt: toMs(s.listTime) }));
    },

    async fetchAnnouncements() {
      const d = (await http(`${base}/api/v5/support/announcements?annType=announcements-new-listings`)) as {
        data?: { details?: { title: string; url: string; pTime: string }[] }[];
      };
      return (d.data?.[0]?.details ?? []).map((a) => announcement('okx', a.url, a.title, a.url, a.pTime));
    },
  };
}

// ---------------------------------------------------------------------------
// Gate (v4)
// ---------------------------------------------------------------------------

export function gate(http: Http = defaultHttp): Venue {
  const base = 'https://api.gateio.ws';
  return {
    id: 'gate',
    name: 'Gate',
    pair: (b) => `${b.toUpperCase()}_USDT`,

    async fetchCandles(pair, startMs, endMs) {
      const out: Candle[] = [];
      for (let from = startMs; from < endMs; from += 900 * MINUTE) {
        const to = Math.min(endMs, from + 900 * MINUTE);
        const rows = (await http(`${base}/api/v4/spot/candlesticks?currency_pair=${pair}&interval=1m&from=${Math.floor(from / 1000)}&to=${Math.floor((to - 1) / 1000)}`)) as string[][];
        if (!Array.isArray(rows)) break;
        for (const r of rows) if (r[7] !== 'false') out.push({ ts: num(r[0]) * 1000, close: num(r[2]), volume: num(r[1]) });
      }
      return finalize(out, startMs, endMs);
    },

    async fetchTicker(pair) {
      const d = (await http(`${base}/api/v4/spot/tickers?currency_pair=${pair}`)) as { last: string }[];
      return Array.isArray(d) && d[0] ? { price: num(d[0].last), ts: Date.now() } : null;
    },

    async listPairs() {
      const d = (await http(`${base}/api/v4/spot/currency_pairs`)) as { id: string; base: string; quote: string; buy_start?: number }[];
      return (Array.isArray(d) ? d : [])
        .filter((s) => s.quote === 'USDT')
        .map((s) => ({ pair: s.id, base: s.base, quote: s.quote, listingAt: s.buy_start ? s.buy_start * 1000 : null }));
    },
  };
}

// ---------------------------------------------------------------------------
// Bitget (v2)
// ---------------------------------------------------------------------------

export function bitget(http: Http = defaultHttp): Venue {
  const base = 'https://api.bitget.com';
  return {
    id: 'bitget',
    name: 'Bitget',
    pair: (b) => `${b.toUpperCase()}USDT`,

    async fetchCandles(pair, startMs, endMs) {
      const out: Candle[] = [];
      let cursor = startMs;
      for (let page = 0; page < 10 && cursor < endMs; page++) {
        const d = (await http(`${base}/api/v2/spot/market/candles?symbol=${pair}&granularity=1min&startTime=${cursor}&endTime=${endMs}&limit=1000`)) as { data?: string[][] };
        const rows = d.data ?? [];
        if (rows.length === 0) break;
        for (const r of rows) out.push({ ts: num(r[0]), close: num(r[4]), volume: num(r[6]) });
        const newest = Math.max(...rows.map((r) => num(r[0])));
        if (rows.length < 1000 || newest + MINUTE <= cursor) break;
        cursor = newest + MINUTE;
      }
      return finalize(out, startMs, endMs);
    },

    async fetchTicker(pair) {
      const d = (await http(`${base}/api/v2/spot/market/tickers?symbol=${pair}`)) as { data?: { lastPr: string; ts: string }[] };
      const t = d.data?.[0];
      return t ? { price: num(t.lastPr), ts: num(t.ts) } : null;
    },

    async listPairs() {
      const d = (await http(`${base}/api/v2/spot/public/symbols`)) as { data?: { symbol: string; baseCoin: string; quoteCoin: string }[] };
      return (d.data ?? []).filter((s) => s.quoteCoin === 'USDT').map((s) => ({ pair: s.symbol, base: s.baseCoin, quote: s.quoteCoin, listingAt: null }));
    },

    async fetchAnnouncements() {
      // Bitget's path really is spelled "annoucements".
      const d = (await http(`${base}/api/v2/public/annoucements?language=en_US&annType=coin_listings`)) as {
        data?: { annId: string; annTitle: string; annDesc?: string; annUrl: string; cTime: string }[];
      };
      return (d.data ?? []).map((a) => announcement('bitget', a.annId, a.annTitle, a.annUrl, a.cTime, a.annDesc ?? ''));
    },
  };
}

// ---------------------------------------------------------------------------
// KuCoin
// ---------------------------------------------------------------------------

export function kucoin(http: Http = defaultHttp): Venue {
  const base = 'https://api.kucoin.com';
  return {
    id: 'kucoin',
    name: 'KuCoin',
    pair: (b) => `${b.toUpperCase()}-USDT`,

    async fetchCandles(pair, startMs, endMs) {
      const out: Candle[] = [];
      for (let from = startMs; from < endMs; from += 1400 * MINUTE) {
        const to = Math.min(endMs, from + 1400 * MINUTE);
        const d = (await http(`${base}/api/v1/market/candles?type=1min&symbol=${pair}&startAt=${Math.floor(from / 1000)}&endAt=${Math.floor(to / 1000)}`)) as { data?: string[][] };
        for (const r of d.data ?? []) out.push({ ts: num(r[0]) * 1000, close: num(r[2]), volume: num(r[6]) });
      }
      return finalize(out, startMs, endMs);
    },

    async fetchTicker(pair) {
      const d = (await http(`${base}/api/v1/market/orderbook/level1?symbol=${pair}`)) as { data?: { price: string; time: number } };
      return d.data?.price ? { price: num(d.data.price), ts: d.data.time } : null;
    },

    async listPairs() {
      const d = (await http(`${base}/api/v2/symbols`)) as { data?: { symbol: string; baseCurrency: string; quoteCurrency: string }[] };
      return (d.data ?? []).filter((s) => s.quoteCurrency === 'USDT').map((s) => ({ pair: s.symbol, base: s.baseCurrency, quote: s.quoteCurrency, listingAt: null }));
    },

    async fetchAnnouncements() {
      const d = (await http(`${base}/api/v3/announcements?annType=new-listings&lang=en_US&pageSize=20`)) as {
        data?: { items?: { annId: number; annTitle: string; annDesc?: string; annUrl: string; cTime: number }[] };
      };
      return (d.data?.items ?? []).map((a) => announcement('kucoin', a.annId, a.annTitle, a.annUrl, a.cTime, a.annDesc ?? ''));
    },
  };
}

export function allVenues(http: Http = defaultHttp): Venue[] {
  return [binance(http), mexc(http), bybit(http), okx(http), gate(http), bitget(http), kucoin(http)];
}
