import type { FirstprintService } from '../services/firstprint.ts';
import type { Venue } from '../exchanges/types.ts';

const MINUTE = 60_000;

/**
 * Finds new exchange listings two ways:
 *  1. Announcement feeds (Binance, Bybit, OKX, Bitget, KuCoin) — usually hours or days ahead.
 *  2. Pair diffs on every exchange — a new USDT pair appears in the exchange's symbol list.
 *     OKX and Gate also publish the trading start time for each pair.
 *
 * Detections wait for admin approval, unless autoCreate is on and the
 * detection has both a symbol and a future trading start time.
 */
export class ListingTracker {
  service: FirstprintService;
  venues: Venue[];
  autoCreate: boolean;

  constructor(service: FirstprintService, venues: Venue[], opts: { autoCreate: boolean }) {
    this.service = service;
    this.venues = venues;
    this.autoCreate = opts.autoCreate;
  }

  async run() {
    const created: number[] = [];
    for (const venue of this.venues) {
      if (venue.fetchAnnouncements) {
        try {
          for (const a of await venue.fetchAnnouncements()) {
            const symbols = a.symbols.length ? a.symbols : [null];
            for (const symbol of symbols) {
              const id = this.service.recordDetection({
                exchange: venue.id,
                symbol,
                pair: symbol ? venue.pair(symbol) : null,
                source: 'announcement',
                title: a.title,
                url: a.url,
                listingAt: a.listingAt,
                publishedAt: a.publishedAt,
                dedupeKey: `ann:${venue.id}:${a.id}:${symbol ?? '-'}`,
              });
              if (id) created.push(id);
            }
          }
        } catch (err) {
          this.service.log(`announcements failed ${venue.id}: ${(err as Error).message}`);
        }
      }

      try {
        const pairs = await venue.listPairs();
        const known = this.service.knownPairs(venue.id);
        const firstRun = known.size === 0;
        const now = this.service.clock.now();
        for (const p of pairs) {
          if (known.has(p.pair)) continue;
          // On the first run, only flag pairs that haven't started trading yet.
          const upcoming = p.listingAt !== null && p.listingAt > now;
          if (firstRun && !upcoming) continue;
          const id = this.service.recordDetection({
            exchange: venue.id,
            symbol: p.base.toUpperCase(),
            pair: p.pair,
            source: 'symbol_diff',
            title: `${p.base.toUpperCase()}/${p.quote} pair added on ${venue.name}`,
            url: null,
            listingAt: p.listingAt,
            publishedAt: null,
            dedupeKey: `pair:${venue.id}:${p.pair}`,
          });
          if (id) created.push(id);
        }
        this.service.rememberPairs(venue.id, pairs.filter((p) => p.listingAt === null || p.listingAt <= now).map((p) => p.pair));
      } catch (err) {
        this.service.log(`pairs failed ${venue.id}: ${(err as Error).message}`);
      }
    }

    if (this.autoCreate) {
      const now = this.service.clock.now();
      for (const d of this.service.detections({ status: 'pending', limit: 200 })) {
        if (!created.includes(d.id) || !d.symbol || !d.listingAt || d.listingAt < now + 10 * MINUTE) continue;
        try {
          const marketId = this.service.approveDetection(d.id);
          this.service.log(`auto-created ${marketId} from detection ${d.id}`);
        } catch (err) {
          this.service.log(`auto-create failed for detection ${d.id}: ${(err as Error).message}`);
        }
      }
    }

    if (created.length) this.service.log(`listing tracker: ${created.length} new detection(s)`);
    return { detected: created.length };
  }
}
