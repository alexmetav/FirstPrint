import type { FirstprintService } from '../services/firstprint.ts';

export type Detection = ReturnType<FirstprintService['detections']>[number];
import type { Venue } from '../exchanges/types.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A pair found after trading began still gets a market if it opened less than this long ago. */
const LATEST_START_MS = 40 * MINUTE;
/** Announcements older than this are skipped, so a newly watched exchange doesn't alert its whole back catalogue. */
const OLDEST_ANNOUNCEMENT_MS = 2 * DAY;

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
 *
 * With review on, new listings wait in the admin's review queue instead, and onNew
 * is told about each one (for a Telegram alert). Tokens that already have a market or are
 * already waiting for review (found on another exchange, or announced first), and pairs
 * that opened more than a day ago (an old pair switched back on), are skipped.
 */
export class ListingTracker {
  service: FirstprintService;
  venues: Venue[];
  autoCreate: boolean;
  maxPerDay: number;
  durationMs: number | undefined;
  /** Checked on every run, so an admin can switch automatic markets off without a restart. */
  enabled: () => boolean;
  /** Checked on every run, so an admin can stop watching one exchange without a restart. */
  venueEnabled: (id: string) => boolean;
  review: boolean;
  onNew: (detections: Detection[]) => void | Promise<void>;

  constructor(
    service: FirstprintService,
    venues: Venue[],
    opts: {
      autoCreate: boolean;
      maxPerDay?: number;
      durationMs?: number;
      enabled?: () => boolean;
      venueEnabled?: (id: string) => boolean;
      review?: boolean;
      onNew?: (detections: Detection[]) => void | Promise<void>;
    },
  ) {
    this.service = service;
    this.venues = venues;
    this.autoCreate = opts.autoCreate;
    this.maxPerDay = opts.maxPerDay ?? Infinity;
    this.durationMs = opts.durationMs;
    this.enabled = opts.enabled ?? (() => true);
    this.venueEnabled = opts.venueEnabled ?? (() => true);
    this.review = opts.review ?? false;
    this.onNew = opts.onNew ?? (() => {});
  }

  async run() {
    if (!this.enabled()) return { detected: 0 };
    const created: number[] = [];
    const names = new Map<number, string>();
    for (const venue of this.venues) {
      if (venue.priceOnly || !this.venueEnabled(venue.id)) continue;
      if (venue.fetchAnnouncements) {
        try {
          const oldest = this.service.clock.now() - OLDEST_ANNOUNCEMENT_MS;
          for (const a of await venue.fetchAnnouncements()) {
            if (a.publishedAt !== null && a.publishedAt < oldest) continue;
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
            name: p.name ?? null,
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

    if (this.review) this.service.expireDetections(this.service.clock.now() - 3 * DAY);
    if (this.review && created.length) {
      const now = this.service.clock.now();
      const fresh: Detection[] = [];
      const pending = this.service.detections({ status: 'pending', limit: 200 });
      // Symbols already waiting for review from earlier runs: the same token on another exchange is a repeat.
      const waiting = new Set(pending.filter((d) => !created.includes(d.id) && d.symbol).map((d) => d.symbol!.toUpperCase()));
      // Oldest first, so the first exchange to show a token is the one kept.
      for (const d of [...pending].sort((a, b) => a.id - b.id)) {
        if (!created.includes(d.id)) continue;
        const stale = d.listingAt !== null && d.listingAt < now - DAY;
        const repeat = d.symbol !== null && waiting.has(d.symbol.toUpperCase());
        if (!d.symbol || stale || repeat || this.service.hasActiveMarket(d.symbol)) this.service.ignoreDetection(d.id);
        else {
          waiting.add(d.symbol.toUpperCase());
          fresh.push(d);
        }
      }
      if (fresh.length) {
        try {
          await this.onNew(fresh);
        } catch (err) {
          this.service.log(`new listing alert failed: ${(err as Error).message}`);
        }
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
