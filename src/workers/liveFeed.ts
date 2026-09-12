import type { FirstprintService } from '../services/firstprint.ts';
import { venueMedian } from '../engine/engine.ts';

export type LiveListener = (event: string, data: Record<string, unknown>) => void;

/**
 * Polls live tickers for trading markets and fans out events to connected
 * browsers (Server-Sent Events). Price events include the live return and the
 * outcome it would currently settle in.
 */
export class LiveFeed {
  service: FirstprintService;
  private listeners = new Set<LiveListener>();

  constructor(service: FirstprintService) {
    this.service = service;
    service.onEvent = (type, data) => this.emit(type, data);
  }

  subscribe(fn: LiveListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get connections() {
    return this.listeners.size;
  }

  emit(event: string, data: Record<string, unknown>) {
    for (const fn of this.listeners) {
      try {
        fn(event, data);
      } catch {
        this.listeners.delete(fn);
      }
    }
  }

  async poll() {
    for (const m of this.service.tradingMarkets()) {
      const quotes = await Promise.all(
        m.venues.map(async (ref) => {
          const venue = this.service.venues.get(ref.venue);
          try {
            const t = venue ? await venue.fetchTicker(ref.symbol) : null;
            return t ? { venue: ref.venue, price: t.price, volume: 1, ts: t.ts } : null;
          } catch (err) {
            this.service.log(`ticker failed ${m.id} ${ref.venue}: ${(err as Error).message}`);
            return null;
          }
        }),
      );
      const valid = quotes.filter((q): q is NonNullable<typeof q> => q !== null);
      const price = venueMedian(valid);
      if (price === null) continue;
      const ts = Math.max(...valid.map((q) => q.ts));
      this.service.livePrices.set(m.id, { price, ts });
      const live = this.service.getMarket(m.id).live;
      this.emit('price', {
        marketId: m.id,
        price,
        ts,
        basePrice: live?.basePrice ?? null,
        returnPct: live?.returnPct ?? null,
        projectedBucket: live?.projectedBucket ?? null,
      });
    }
  }
}
