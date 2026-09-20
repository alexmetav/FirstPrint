type Fetch = typeof fetch;

export interface MexcFocusResult {
  configured: boolean;
  pairsSeen?: number;
  marketsCreated?: number;
  marketsSettled?: number;
  baseline?: boolean;
  skipped?: boolean;
}

interface MexcSymbol { symbol: string; baseAsset: string; quoteAsset: string }

/** Keeps the beta focused on at most two newly detected MEXC/USDT pairs daily. */
export class MexcFocusWorker {
  private running?: Promise<MexcFocusResult>;
  private lastRun = 0;
  private readonly options: {
    supabaseUrl?: string;
    serviceRoleKey?: string;
    fetch?: Fetch;
    now?: () => number;
    minIntervalMs?: number;
  };

  constructor(options: {
    supabaseUrl?: string;
    serviceRoleKey?: string;
    fetch?: Fetch;
    now?: () => number;
    minIntervalMs?: number;
  } = {}) { this.options = options; }

  run(force = false): Promise<MexcFocusResult> {
    if (this.running) return this.running;
    const now = (this.options.now ?? Date.now)();
    if (!force && now - this.lastRun < (this.options.minIntervalMs ?? 60_000)) {
      return Promise.resolve({ configured: this.configured(), skipped: true });
    }
    this.lastRun = now;
    this.running = this.sync(now).finally(() => { this.running = undefined; });
    return this.running;
  }

  private configured() { return Boolean(this.options.supabaseUrl && this.options.serviceRoleKey); }

  private async sync(now: number): Promise<MexcFocusResult> {
    if (!this.configured()) return { configured: false };
    const request = this.options.fetch ?? fetch;
    const [exchangeInfo, tickers] = await Promise.all([
      json<{ symbols?: MexcSymbol[] }>(request, 'https://api.mexc.com/api/v3/exchangeInfo'),
      json<Array<{ symbol: string; price: string }>>(request, 'https://api.mexc.com/api/v3/ticker/price'),
    ]);
    const prices = new Map(tickers.map((row) => [row.symbol, Number(row.price)]));
    const pairs = (exchangeInfo.symbols ?? [])
      .filter((row) => row.quoteAsset === 'USDT' && /^[A-Z0-9]{2,30}USDT$/.test(row.symbol))
      .map((row) => ({ pair: row.symbol, base: row.baseAsset, price: prices.get(row.symbol) ?? null }));

    const sync = await this.rpc<{ baseline?: boolean; created?: number }>(request, 'fp_admin_sync_mexc_pairs', {
      p_pairs: pairs,
      p_observed_at: new Date(now).toISOString(),
    });
    const due = await this.rest<Array<{ id: string; pair: string }>>(
      request,
      `/rest/v1/fp_markets?select=id,pair&exchange=eq.MEXC&status=eq.open&settles_at=lte.${encodeURIComponent(new Date(now).toISOString())}`,
    );
    let settled = 0;
    for (const market of due) {
      const closePrice = prices.get(market.pair);
      if (!closePrice || closePrice <= 0) continue;
      await this.rpc(request, 'fp_admin_settle_mexc_market', { p_market_id: market.id, p_close_price: closePrice });
      settled += 1;
    }
    return { configured: true, pairsSeen: pairs.length, marketsCreated: sync.created ?? 0, marketsSettled: settled, baseline: Boolean(sync.baseline) };
  }

  private rpc<T = unknown>(request: Fetch, name: string, body: unknown): Promise<T> {
    return json<T>(request, `${this.options.supabaseUrl}/rest/v1/rpc/${name}`, this.init('POST', body));
  }

  private rest<T>(request: Fetch, path: string): Promise<T> {
    return json<T>(request, `${this.options.supabaseUrl}${path}`, this.init('GET'));
  }

  private init(method: string, body?: unknown): RequestInit {
    const key = this.options.serviceRoleKey!;
    return { method, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
  }
}

async function json<T>(request: Fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await request(url, init);
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`);
  return response.json() as Promise<T>;
}
