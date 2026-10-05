import { readFileSync } from 'node:fs';
import type { FirstprintService } from './firstprint.ts';
import { closingSoonText, marketLiveText, marketResultText, type Telegram } from './telegram.ts';
import { logoToPng, renderBanner, type BannerKind } from './banner.ts';
import { fetchImage } from '../api/fetchImage.ts';

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
  /** Downloads a logo (swappable in tests). */
  fetchLogo: (url: string) => Promise<{ contentType: string; data: string }> = (url) => fetchImage(url);

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

  /**
   * The token's own banner (logo, ticker, details). When token banners are switched off in
   * Settings (`telegram_token_banners` = '0'), or the banner can't be drawn (a ticker in a script
   * the font lacks), a new market gets the fixed banner and other posts are plain text.
   */
  private async bannerFor(kind: BannerKind, id: string, m: Parameters<typeof renderBanner>[1]): Promise<Uint8Array | null> {
    if (!this.service.tokenBannersEnabled()) return kind === 'live' ? this.banner : null;
    const logo = await this.logoFor(id);
    try {
      return renderBanner(kind, m, logo);
    } catch (err) {
      this.log(`banner for ${id} could not be drawn: ${(err as Error).message}`);
    }
    // A logo the renderer chokes on shouldn't cost the whole banner: try again with the letter.
    if (logo) {
      try {
        return renderBanner(kind, m, null);
      } catch {
        /* the ticker itself can't be drawn */
      }
    }
    return kind === 'live' ? this.banner : null;
  }

  /**
   * The logo for a market's banners. The admin's browser normally saves a PNG copy; when it
   * couldn't (blocked download, an SVG, a JPEG), the server fetches the logo itself, converts it,
   * and keeps the copy so it is done once.
   */
  private async logoFor(id: string): Promise<string | null> {
    const saved = this.service.logoPng(id);
    if (saved) return saved;
    const src = (this.service.getMarket(id, undefined, true) as { logoUrl?: string | null }).logoUrl ?? '';
    if (!src) return null;
    try {
      const data = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(src);
      const img = data ? { contentType: data[1].toLowerCase(), data: data[2] } : await this.fetchLogo(src);
      const png = logoToPng(img.contentType, img.data);
      if (png) this.service.setLogoPng(id, png);
      else this.log(`logo for ${id} couldn't be converted (${img.contentType})`);
      return png;
    } catch (err) {
      this.log(`logo for ${id} couldn't be fetched: ${(err as Error).message}`);
      return null;
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
    await this.post(channel, await this.bannerFor('live', id, m), marketLiveText(m, this.link(id)), { text: 'Predict now', url: this.link(id) });
    this.service.markAnnounced(id);
  }

  async postResult(id: string) {
    const channel = this.channel;
    if (!this.telegram || !channel) return;
    const m = this.service.getMarket(id);
    const text = marketResultText(m, this.link(id));
    if (text) await this.post(channel, await this.bannerFor('result', id, m), text, { text: 'See the result', url: this.link(id) });
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
      // Marked only once Telegram accepts it, so a failed send is tried again on the next minute.
      this.later(async () => {
        try {
          // Read when it is sent, so the time left on the banner is right.
          const m = this.service.getMarket(id);
          await this.post(channel, await this.bannerFor('closing', id, m), closingSoonText(m, this.link(id)), { text: 'Predict now', url: this.link(id) });
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
