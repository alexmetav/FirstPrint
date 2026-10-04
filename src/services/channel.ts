import { readFileSync } from 'node:fs';
import type { FirstprintService } from './firstprint.ts';
import { closingSoonText, marketLiveText, marketResultText, type Telegram } from './telegram.ts';
import { renderBanner, type BannerKind } from './banner.ts';

/** Telegram allows about 20 posts a minute to one channel; stay well under it. */
const GAP_MS = 3_500;

/** The fixed banner, used for a new market only if its own banner can't be drawn. */
function loadBanner(): Uint8Array | null {
  try {
    return readFileSync(new URL('../../assets/telegram/new-market.png', import.meta.url));
  } catch {
    return null;
  }
}

/**
 * Posts to the public channel players join: new markets, results, last-hour reminders,
 * and (on request) open markets that were never posted. Does nothing until a channel is set.
 */
export class ChannelPoster {
  private queue: Promise<void> = Promise.resolve();
  /** Reminders queued but not yet sent, so the minute timer doesn't queue them twice. */
  private reminding = new Set<string>();
  private service: FirstprintService;
  private telegram: Telegram | null;
  private appUrl: string;
  private log: (msg: string) => void;
  private gapMs: number;
  private banner: Uint8Array | null;

  constructor(service: FirstprintService, telegram: Telegram | null, appUrl: string, log: (msg: string) => void = () => {}, gapMs = GAP_MS) {
    this.service = service;
    this.telegram = telegram;
    this.appUrl = appUrl;
    this.log = log;
    this.gapMs = gapMs;
    this.banner = loadBanner();
  }

  get channel() {
    return this.telegram ? this.service.getSetting('telegram_channel') : null;
  }

  private link(id: string) {
    return `${this.appUrl}#/market/${encodeURIComponent(id)}`;
  }

  /** The market's own banner (logo, ticker, details), or the fixed one for a new market, or nothing. */
  private bannerFor(kind: BannerKind, id: string, m: Parameters<typeof renderBanner>[1]): Uint8Array | null {
    try {
      return renderBanner(kind, m, this.service.logoPng(id));
    } catch (err) {
      this.log(`banner for ${id} could not be drawn: ${(err as Error).message}`);
      return kind === 'live' ? this.banner : null;
    }
  }

  /** Sends with the banner when there is one; if Telegram refuses the photo, sends the text alone. */
  private async post(channel: string, banner: Uint8Array | null, text: string, button: { text: string; url: string }) {
    if (banner) {
      try {
        await this.telegram!.sendPhotoTo(`@${channel}`, banner, text, button);
        return;
      } catch (err) {
        this.log(`banner post failed, sending text only: ${(err as Error).message}`);
      }
    }
    await this.telegram!.sendTo(`@${channel}`, text, button);
  }

  /** Posts one market as live now. Throws if Telegram refuses. */
  async postLive(id: string) {
    const channel = this.channel;
    if (!this.telegram || !channel) throw new Error('No player channel is set.');
    const m = this.service.getMarket(id, undefined, true);
    if (!m.published || m.status !== 'open') throw new Error('Only open, published markets can be posted.');
    await this.post(channel, this.bannerFor('live', id, m), marketLiveText(m), { text: 'Predict now', url: this.link(id) });
    this.service.markAnnounced(id);
  }

  async postResult(id: string) {
    const channel = this.channel;
    if (!this.telegram || !channel) return;
    const m = this.service.getMarket(id);
    const text = marketResultText(m);
    if (text) await this.post(channel, this.bannerFor('result', id, m), text, { text: 'See the result', url: this.link(id) });
  }

  /** Posts open markets (only never-posted ones unless `again`), a few seconds apart, in the background. */
  postAllOpen(again = false): number {
    if (!this.channel) throw new Error('No player channel is set.');
    const ids = this.service.channelMarkets(!again).slice(0, 20);
    ids.forEach((id, i) => this.later(() => this.postLive(id), i === 0 ? 0 : this.gapMs));
    return ids.length;
  }

  /** Last-hour reminders for markets about to close. Called every minute. */
  remindClosing() {
    const channel = this.channel;
    if (!this.telegram || !channel) return;
    for (const id of this.service.marketsClosingSoon()) {
      if (this.reminding.has(id)) continue;
      this.reminding.add(id);
      const m = this.service.getMarket(id);
      // Marked only once Telegram accepts it, so a failed send is tried again on the next minute.
      this.later(async () => {
        try {
          await this.post(channel, this.bannerFor('closing', id, m), closingSoonText(m), { text: 'Predict now', url: this.link(id) });
          this.service.markReminded(id);
        } finally {
          this.reminding.delete(id);
        }
      }, this.gapMs);
    }
  }

  /** Runs posts one after another, so a burst never trips Telegram's limit. */
  later(fn: () => Promise<unknown>, waitMs = 0) {
    this.queue = this.queue
      .then(() => (waitMs ? new Promise((r) => setTimeout(r, waitMs)) : undefined))
      .then(fn)
      .then(
        () => {},
        (err: Error) => this.log(`telegram channel post failed: ${err.message}`),
      );
    return this.queue;
  }
}
