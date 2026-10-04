import type { FirstprintService } from '../services/firstprint.ts';
import type { Venue } from '../exchanges/types.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A pair found after trading began still gets a market if it opened less than this long ago. */
const LATEST_START_MS = 40 * MINUTE;

/**
 * Finds new exchange listings two ways:
 *  1. Announcement feeds (Binance, Bybit, OKX, Bitget, KuCoin) — usually hours or days ahead.
 *  2. Pair diffs on every exchange — a new USDT pair appears in the exchange's symbol list.
 *     OKX and Gate also publish the trading start time for each pair.
 *
 * Detections wait for admin approval, unless autoCreate is on and the
 * detection has a symbol and a trading start time that is still ahead, or
 * started so recently that the start-price hour is mostly still to come.
 * Automatic markets are published straight away, up to maxPerDay in any 24 hours.
 */
export class ListingTracker {
  service: FirstprintService;
  venues: Venue[];
  autoCreate: boolean;
  maxPerDay: number;
  durationMs: number | undefined;
  /** Checked on every run, so an admin can switch automatic markets off without a restart. */
  enabled: () => boolean;

  constructor(
    service: FirstprintService,
    venues: Venue[],
    opts: { autoCreate: boolean; maxPerDay?: number; durationMs?: number; enabled?: () => boolean },
  ) {
    this.service = service;
    this.venues = venues;
    this.autoCreate = opts.autoCreate;
    this.maxPerDay = opts.maxPerDay ?? Infinity;
    this.durationMs = opts.durationMs;
    this.enabled = opts.enabled ?? (() => true);
  }

  async run() {
    if (!this.enabled()) return { detected: 0 };
    const created: number[] = [];
    const names = new Map<number, string>();
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
          if (id) {
            created.push(id);
            if (p.name) names.set(id, p.name);
          }
        }
        this.service.rememberPairs(venue.id, pairs.filter((p) => p.listingAt === null || p.listingAt <= now).map((p) => p.pair));
      } catch (err) {
        this.service.log(`pairs failed ${venue.id}: ${(err as Error).message}`);
      }
    }

    if (this.autoCreate) {
      const now = this.service.clock.now();
      const fresh = this.service
        .detections({ status: 'pending', limit: 200 })
        .filter((d) => created.includes(d.id) && d.symbol && d.listingAt && d.listingAt > now - LATEST_START_MS)
        .sort((a, b) => (a.listingAt ?? 0) - (b.listingAt ?? 0));
      let room = this.maxPerDay - this.service.listingMarketsSince(now - DAY);
      for (const d of fresh) {
        if (this.service.hasActiveMarket(d.symbol!)) {
          this.service.log(`auto-create skipped ${d.symbol}: it already has a market`);
          continue;
        }
        if (room <= 0) {
          this.service.log(`auto-create skipped ${d.symbol}: daily limit of ${this.maxPerDay} reached`);
          continue;
        }
        try {
          const marketId = this.service.approveDetection(d.id, {
            name: names.get(d.id),
            allowStarted: true,
            config: this.durationMs ? { durationMs: this.durationMs } : undefined,
          });
          room--;
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
