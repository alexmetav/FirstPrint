import { readFileSync } from 'node:fs';
import type { FirstprintService } from './firstprint.ts';
import { closingSoonText, marketLiveText, marketResultText, type Telegram } from './telegram.ts';

/** Telegram allows about 20 posts a minute to one channel; stay well under it. */
const GAP_MS = 3_500;

/** The one banner shown on every "new market" post. */
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

  /** Posts one market as live now. Throws if Telegram refuses. */
  async postLive(id: string) {
    const channel = this.channel;
    if (!this.telegram || !channel) throw new Error('No player channel is set.');
    const m = this.service.getMarket(id, undefined, true);
    if (!m.published || m.status !== 'open') throw new Error('Only open, published markets can be posted.');
    const text = marketLiveText(m);
    const button = { text: 'Predict now', url: this.link(id) };
    if (this.banner) {
      try {
        await this.telegram.sendPhotoTo(`@${channel}`, this.banner, text, button);
        this.service.markAnnounced(id);
        return;
      } catch (err) {
        this.log(`banner post failed, sending text only: ${(err as Error).message}`);
      }
    }
    await this.telegram.sendTo(`@${channel}`, text, button);
    this.service.markAnnounced(id);
  }

  async postResult(id: string) {
    const channel = this.channel;
    if (!this.telegram || !channel) return;
    const text = marketResultText(this.service.getMarket(id));
    if (text) await this.telegram.sendTo(`@${channel}`, text, { text: 'See the result', url: this.link(id) });
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
          await this.telegram!.sendTo(`@${channel}`, closingSoonText(m), { text: 'Predict now', url: this.link(id) });
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
