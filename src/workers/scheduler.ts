import type { FirstprintService, Notification } from '../services/firstprint.ts';
import type { ListingTracker } from './listingTracker.ts';
import type { LiveFeed } from './liveFeed.ts';

export type Notifier = (notes: Notification[]) => Promise<void>;

/**
 * Background jobs:
 *  - lifecycle (every tickMs): ingest candles → close markets → settle markets
 *  - live prices (every liveMs): tickers for trading markets → SSE
 *  - listing tracker (every trackEveryMs): announcements and new pairs
 */
export class Scheduler {
  service: FirstprintService;
  notify: Notifier;
  tracker: ListingTracker | null;
  live: LiveFeed | null;
  opts: { tickMs: number; liveMs: number; trackEveryMs: number };
  private timers: NodeJS.Timeout[] = [];
  private busy = { tick: false, live: false, track: false };

  constructor(
    service: FirstprintService,
    notify: Notifier,
    opts: { tickMs: number; liveMs?: number; trackEveryMs?: number; tracker?: ListingTracker | null; live?: LiveFeed | null },
  ) {
    this.service = service;
    this.notify = notify;
    this.tracker = opts.tracker ?? null;
    this.live = opts.live ?? null;
    this.opts = { tickMs: opts.tickMs, liveMs: opts.liveMs ?? 5_000, trackEveryMs: opts.trackEveryMs ?? 120_000 };
  }

  private async guard(key: keyof Scheduler['busy'], fn: () => Promise<void>) {
    if (this.busy[key]) return;
    this.busy[key] = true;
    try {
      await fn();
    } catch (err) {
      this.service.log(`${key} failed: ${(err as Error).stack ?? err}`);
    } finally {
      this.busy[key] = false;
    }
  }

  tick() {
    return this.guard('tick', async () => {
      await this.service.ingestPrices();
      this.service.closeDueMarkets();
      const notes = this.service.settleDueMarkets();
      if (notes.length) await this.notify(notes);
    });
  }

  pollLive() {
    return this.guard('live', async () => {
      if (this.live) await this.live.poll();
    });
  }

  track() {
    return this.guard('track', async () => {
      if (this.tracker) await this.tracker.run();
    });
  }

  start() {
    this.timers.push(setInterval(() => void this.tick(), this.opts.tickMs));
    if (this.live) this.timers.push(setInterval(() => void this.pollLive(), this.opts.liveMs));
    if (this.tracker) this.timers.push(setInterval(() => void this.track(), this.opts.trackEveryMs));
    void this.tick();
    void this.track();
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }
}
