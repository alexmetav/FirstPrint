/**
 * Helps admins find tokens to make markets for: what is trending on CoinGecko right now, and what
 * just listed on each exchange (from the listing tracker), with live and opening prices.
 *
 * CoinGecko's public trending list needs no key (set COINGECKO_API_KEY to use a free demo key and a
 * higher rate limit). CoinMarketCap needs a paid key for the same data, so it is linked, not fetched.
 */
import { AppError, type FirstprintService } from './firstprint.ts';

const TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending';
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;
const MINUTE = 60_000;

export interface TrendingCoin {
  id: string;
  symbol: string;
  name: string;
  logo: string | null;
  priceUsd: number | null;
  change24h: number | null;
  rank: number | null;
  url: string;
}

export interface NewListing {
  id: number;
  symbol: string;
  name: string | null;
  pair: string | null;
  exchange: string;
  exchangeName: string;
  listingAt: number | null;
  status: string;
  marketId: string | null;
  /** The opening price: the median close of the 2nd to 4th minute of trading (the 1st is usually a spike). */
  openPrice: number | null;
  price: number | null;
}

/** "$0.0123" or 0.0123 → 0.0123; anything else → null. */
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[^0-9.eE-]/g, '')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no answer')), ms))]);

export class Discover {
  private service: FirstprintService;
  private fetchImpl: typeof fetch;
  private apiKey: string | null;
  private cache: { at: number; coins: TrendingCoin[] } | null = null;

  constructor(service: FirstprintService, opts: { fetchImpl?: typeof fetch; apiKey?: string | null } = {}) {
    this.service = service;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiKey = opts.apiKey ?? null;
  }

  /** The tokens trending on CoinGecko now (cached for five minutes, so the button can be pressed freely). */
  async trending(): Promise<{ coins: TrendingCoin[]; fetchedAt: number; source: string }> {
    const now = this.service.clock.now();
    if (this.cache && now - this.cache.at < CACHE_MS) return { coins: this.cache.coins, fetchedAt: this.cache.at, source: 'CoinGecko' };
    let body: { coins?: { item?: Record<string, unknown> }[] };
    try {
      const res = await this.fetchImpl(TRENDING_URL, {
        headers: { accept: 'application/json', ...(this.apiKey ? { 'x-cg-demo-api-key': this.apiKey } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429) throw new AppError(429, 'rate_limited', 'CoinGecko is busy (too many requests). Try again in a minute.');
      if (!res.ok) throw new AppError(502, 'source_failed', `CoinGecko answered with an error (${res.status}).`);
      body = (await res.json()) as typeof body;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(502, 'source_failed', 'CoinGecko didn’t answer. Try again in a moment.');
    }
    const coins = (body.coins ?? [])
      .map(({ item }) => item ?? {})
      .map((c): TrendingCoin => {
        const data = (c.data ?? {}) as Record<string, unknown>;
        const change = (data.price_change_percentage_24h ?? {}) as Record<string, unknown>;
        const id = String(c.id ?? '');
        return {
          id,
          symbol: String(c.symbol ?? '').toUpperCase(),
          name: String(c.name ?? ''),
          logo: typeof c.large === 'string' ? c.large : typeof c.small === 'string' ? c.small : null,
          priceUsd: num(data.price),
          change24h: typeof change.usd === 'number' ? change.usd / 100 : null,
          rank: typeof c.market_cap_rank === 'number' ? c.market_cap_rank : null,
          url: `https://www.coingecko.com/en/coins/${encodeURIComponent(String(c.slug ?? id))}`,
        };
      })
      .filter((c) => c.symbol && c.name);
    this.cache = { at: now, coins };
    return { coins, fetchedAt: now, source: 'CoinGecko' };
  }

  /** What the listing tracker found on one exchange in the last week, with live and opening prices. */
  async exchangeListings(venueId: string): Promise<{ listings: NewListing[] }> {
    const venue = this.service.venues.get(venueId);
    if (!venue) throw new AppError(404, 'unknown_exchange', 'That exchange isn’t set up on this server.');
    const now = this.service.clock.now();
    const recent = this.service
      .detections({ status: 'all', limit: 200 })
      .filter((d) => d.exchange === venueId && d.symbol && d.status !== 'ignored' && (d.listingAt ?? d.detectedAt) > now - 7 * 24 * 60 * MINUTE)
      .slice(0, 15);
    const listings = await Promise.all(
      recent.map(async (d): Promise<NewListing> => {
        const pair = d.pair || venue.pair(d.symbol!);
        const [price, openPrice] = await Promise.all([
          within(venue.fetchTicker(pair), TIMEOUT_MS).then((t) => (t && t.price > 0 ? t.price : null), () => null),
          d.listingAt && d.listingAt + 5 * MINUTE < now
            ? within(venue.fetchCandles(pair, d.listingAt, d.listingAt + 6 * MINUTE), TIMEOUT_MS).then(
                (candles) => median(candles.filter((c) => c.close > 0).slice(1, 4).map((c) => c.close)),
                () => null,
              )
            : Promise.resolve(null),
        ]);
        return { id: d.id, symbol: d.symbol!, name: d.name, pair, exchange: d.exchange, exchangeName: d.exchangeName, listingAt: d.listingAt, status: d.status, marketId: d.marketId, openPrice, price };
      }),
    );
    return { listings };
  }
}
