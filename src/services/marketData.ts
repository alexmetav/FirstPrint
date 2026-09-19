/** Shared upstream cache with request coalescing and bounded stale responses. */
export class MarketData {
  private cache = new Map<string, { data: unknown; updatedAt: number }>();
  private pending = new Map<string, Promise<unknown>>();
  private retryAfter = new Map<string, number>();
  private fetcher: typeof fetch;
  private now: () => number;
  constructor(fetcher: typeof fetch = fetch, now = Date.now) {
    this.fetcher = fetcher;
    this.now = now;
  }
  async get(path: string) {
    const allowed = /^(\/exchanges\?per_page=100&page=1|\/simple\/price\?ids=bitcoin&vs_currencies=usd|\/search\/trending|\/exchanges\/(binance|gdax|okex|bybit_spot|upbit|bitget|gate|kucoin|mxc|kraken|huobi|crypto_com|bitfinex))$/;
    if (!allowed.test(path)) throw new Error('Unsupported market data request');
    const cached = this.cache.get(path);
    const result = (entry: { data: unknown; updatedAt: number }, stale: boolean) => ({ ...entry, stale });
    if (cached && this.now() - cached.updatedAt < 60_000) return result(cached, false);
    if ((this.retryAfter.get(path) ?? 0) > this.now()) {
      if (cached && this.now() - cached.updatedAt < 3_600_000) return result(cached, true);
      throw new Error('Market data temporarily unavailable');
    }
    if (this.pending.has(path)) return this.pending.get(path);
    const work = (async () => {
      try {
        const res = await this.fetcher(`https://api.coingecko.com/api/v3${path}`, {
          signal: AbortSignal.timeout(10_000),
          headers: process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {},
        });
        if (!res.ok) throw new Error(`Provider returned ${res.status}`);
        const entry = { data: await res.json(), updatedAt: this.now() };
        this.cache.set(path, entry);
        this.retryAfter.delete(path);
        return result(entry, false);
      } catch {
        this.retryAfter.set(path, this.now() + 60_000);
        if (cached && this.now() - cached.updatedAt < 3_600_000) return result(cached, true);
        throw new Error('Market data temporarily unavailable');
      } finally { this.pending.delete(path); }
    })();
    this.pending.set(path, work);
    return work;
  }
}
