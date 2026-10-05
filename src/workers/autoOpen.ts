import type { FirstprintService, MarketRow, VenueRef } from '../services/firstprint.ts';
import type { Venue } from '../exchanges/types.ts';

const MINUTE = 60_000;
/** How long after the set time to keep waiting for trading to start before handing it back to the admin. */
const MAX_WAIT_MS = 3 * 60 * MINUTE;
/** The live price must be this close to the last minutes of trading, so a first-minute spike is never the start price. */
const MAX_DRIFT = 0.1;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (n: number) => `$${n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : Number(n.toPrecision(4))}`;

/**
 * Opens upcoming-token markets the admin scheduled (checked, with logo and times) once their
 * token is really trading. The start price is the live exchange price, taken only after three
 * full minutes of trades and only when it agrees with them, so players never predict against a
 * price from the first-second spike or from before trading began. If trading hasn't started,
 * it waits and tries again; after 3 hours, or if the market is no longer ready, it leaves the
 * market as a draft and tells the admin.
 */
export class AutoOpener {
  private running = false;
  private service: FirstprintService;
  private venues: Map<string, Venue>;
  private alert: (text: string) => void;

  constructor(service: FirstprintService, venues: Venue[], alert: (text: string) => void = () => {}) {
    this.service = service;
    this.venues = new Map(venues.map((v) => [v.id, v]));
    this.alert = alert;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (const m of this.service.autoOpenDue()) {
        try {
          await this.tryOpen(m);
        } catch (err) {
          this.service.log(`auto-open ${m.id} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async tryOpen(m: MarketRow) {
    const now = this.service.clock.now();
    const giveUp = (why: string) => {
      this.service.noteAutoOpen(m.id, `Not opened: ${why}`, true);
      this.service.log(`auto-open ${m.id} stopped: ${why}`);
      this.alert(`⚠️ <b>${m.symbol} did not open by itself</b>\n${why}\nIt is still a draft in Admin → Markets: check it and publish it yourself.`);
    };
    if (!m.logo_url) return giveUp('its logo was removed.');
    if (m.listing_at < now + 15 * MINUTE) return giveUp('predictions would close in under 15 minutes. Move the close time later.');

    const found: { name: string; price: number }[] = [];
    const waiting: string[] = [];
    for (const ref of JSON.parse(m.venues) as VenueRef[]) {
      const venue = this.venues.get(ref.venue);
      if (!venue) continue;
      const r = await this.priceOn(venue, ref.symbol, now);
      if (typeof r === 'number') found.push({ name: venue.name, price: r });
      else waiting.push(`${venue.name}: ${r}`);
    }

    if (found.length) {
      const start = median(found.map((f) => f.price));
      const from = found.map((f) => f.name).join(', ');
      this.service.autoOpen(m.id, start, `Opened by itself at ${fmt(start)} (live price on ${from}).`);
      this.alert(`✅ <b>${m.symbol} is open</b>\nTrading started, so predictions opened by themselves. Start price ${fmt(start)} (live on ${from}).`);
      return;
    }
    if (now - (m.auto_open_at ?? now) > MAX_WAIT_MS) return giveUp(`trading hadn’t started 3 hours after the set time (${waiting.join('; ') || 'no exchange answered'}).`);
    this.service.noteAutoOpen(m.id, `Waiting for trading to start. ${waiting.join('; ')}`);
  }

  /** The start price on one exchange, or why there isn't one yet. */
  private async priceOn(venue: Venue, pair: string, now: number): Promise<number | string> {
    try {
      const candles = (await venue.fetchCandles(pair, now - 10 * MINUTE, now)).filter((c) => c.volume > 0 && (c.trades ?? 1) > 0);
      if (candles.length < 3) return candles.length ? `${candles.length} minute${candles.length === 1 ? '' : 's'} of trading so far, waiting for 3` : 'no trades yet';
      const closes = candles.slice(-3).map((c) => c.close);
      if (Math.max(...closes) / Math.min(...closes) > 1 + 2 * MAX_DRIFT) return 'price still swinging, waiting for it to settle';
      const ticker = await venue.fetchTicker(pair);
      if (!ticker || !(ticker.price > 0)) return 'no live price yet';
      const ref = median(closes);
      if (Math.abs(ticker.price - ref) / ref > MAX_DRIFT) return `live price ${fmt(ticker.price)} is far from the last minutes (${fmt(ref)}), waiting`;
      return ticker.price;
    } catch (err) {
      return `couldn’t read prices (${(err as Error).message.slice(0, 80)})`;
    }
  }
}
