import { MINUTE, type Venue } from './venues.ts';

/** How far back a source may go for the last trade before the moment (a quiet minute has no candle). */
const LOOKBACK_MS = 10 * MINUTE;
/** CoinGecko has a point about every 5 minutes, so it may need a little longer. */
const PRICE_ONLY_LOOKBACK_MS = 30 * MINUTE;

/**
 * The price on one source at an exact moment: the close of the 1-minute candle that ends at that
 * moment, which is the last trade before it. If that minute had no trades, the last trade in the
 * minutes before (still the price at that moment). Never a price from after it.
 * Returns why there is none instead, as plain text for the admin.
 */
export async function priceAt(venue: Venue, pair: string, at: number): Promise<{ price: number; ts: number } | string> {
  try {
    const from = at - (venue.priceOnly ? PRICE_ONLY_LOOKBACK_MS : LOOKBACK_MS);
    const candles = (await venue.fetchCandles(pair, from, at)).filter(
      (c) => c.ts < at && c.close > 0 && Number.isFinite(c.close) && (venue.priceOnly || (c.volume > 0 && (c.trades ?? 1) > 0)),
    );
    if (!candles.length) return venue.priceOnly ? 'no price in the 30 minutes before' : 'no trades in the 10 minutes before';
    const last = candles[candles.length - 1];
    return { price: last.close, ts: venue.priceOnly ? last.ts : last.ts + MINUTE };
  } catch (err) {
    return `couldn’t read prices (${(err as Error).message.slice(0, 80)})`;
  }
}

export interface CheckLink {
  venue: string;
  name: string;
  url: string;
  /** Where the price is in what the link shows. */
  hint: string;
}

const enc = encodeURIComponent;

/**
 * Public links to each source's own data for the 1-minute candle ending at `at`, so the admin can
 * read the exact price themselves when the server couldn't (an exchange blocking the server, say).
 */
export function checkLinks(venues: { venue: string; name: string; pair: string }[], at: number): CheckLink[] {
  const open = at - MINUTE;
  const s = Math.floor(open / 1000);
  const fifth = 'the close is the 5th number';
  const third = 'the close is the 3rd number';
  const out: CheckLink[] = [];
  for (const v of venues) {
    const p = enc(v.pair);
    const link = (url: string, hint: string) => out.push({ venue: v.venue, name: v.name, url, hint });
    switch (v.venue) {
      case 'binance':
        link(`https://api.binance.com/api/v3/klines?symbol=${p}&interval=1m&startTime=${open}&limit=1`, fifth);
        break;
      case 'mexc':
        link(`https://api.mexc.com/api/v3/klines?symbol=${p}&interval=1m&startTime=${open}&limit=1`, fifth);
        break;
      case 'bybit':
        link(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${p}&interval=1&start=${open}&end=${at - 1}&limit=1`, fifth);
        break;
      case 'okx':
        link(`https://www.okx.com/api/v5/market/history-candles?instId=${p}&bar=1m&after=${at}&limit=1`, fifth);
        break;
      case 'gate':
        link(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${p}&interval=1m&from=${s}&to=${s}`, third);
        break;
      case 'bitget':
        link(`https://api.bitget.com/api/v2/spot/market/candles?symbol=${p}&granularity=1min&startTime=${open}&endTime=${at - 1}&limit=1`, fifth);
        break;
      case 'kucoin':
        link(`https://api.kucoin.com/api/v1/market/candles?type=1min&symbol=${p}&startAt=${s}&endAt=${s + 59}`, third);
        break;
      case 'coingecko':
        link(
          `https://api.coingecko.com/api/v3/coins/${p}/market_chart/range?vs_currency=usd&from=${Math.floor(at / 1000) - 1800}&to=${Math.floor(at / 1000)}`,
          'use the last [time, price] pair under "prices"',
        );
        break;
    }
  }
  return out;
}
