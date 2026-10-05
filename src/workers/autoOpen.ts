import type { FirstprintService, MarketRow, VenueRef } from '../services/firstprint.ts';
import type { Venue } from '../exchanges/types.ts';

const MINUTE = 60_000;
/** How long after the set time to keep waiting for trading to start before handing it back to the admin. */
const MAX_WAIT_MS = 3 * 60 * MINUTE;
/** How long after predictions close to keep looking for the first trades of an upcoming token. */
const OPENING_WAIT_MS = 24 * 60 * MINUTE;
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
  private resultDue: (marketId: string) => string;

  constructor(service: FirstprintService, venues: Venue[], alert: (text: string) => void = () => {}, resultDue: (marketId: string) => string = (id) => `Result due: ${id}`) {
    this.service = service;
    this.venues = new Map(venues.map((v) => [v.id, v]));
    this.alert = alert;
    this.resultDue = resultDue;
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
      for (const m of this.service.awaitingOpeningPrice()) {
        try {
          await this.fillOpeningPrice(m);
        } catch (err) {
          this.service.log(`opening price ${m.id} failed: ${(err as Error).message}`);
        }
      }
      // Upcoming tokens: the admin is asked for the result only once it is due.
      for (const m of this.service.resultAlertsDue()) {
        this.alert(this.resultDue(m.id));
        this.service.markResultAlerted(m.id);
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

  /**
   * An upcoming token whose predictions closed at its listing time: its start price is the opening
   * price, read from the first minutes of real trading (the very first minute is skipped, it is
   * usually a spike). Nothing for the admin to do; if no trades appear within a day, they are told.
   */
  private async fillOpeningPrice(m: MarketRow) {
    const now = this.service.clock.now();
    const found: { name: string; price: number }[] = [];
    const waiting: string[] = [];
    for (const ref of JSON.parse(m.venues) as VenueRef[]) {
      const venue = this.venues.get(ref.venue);
      if (!venue) continue;
      const r = await this.openingOn(venue, ref.symbol, m.listing_at, now);
      if (typeof r === 'number') found.push({ name: venue.name, price: r });
      else waiting.push(`${venue.name}: ${r}`);
    }
    if (found.length) {
      const price = median(found.map((f) => f.price));
      const from = found.map((f) => f.name).join(', ');
      this.service.setStartPrice(m.id, price);
      this.service.noteAutoOpen(m.id, `Opening price ${fmt(price)} set by itself from the first minutes of trading on ${from}.`);
      return;
    }
    if (now - m.listing_at > OPENING_WAIT_MS) {
      const why = `no trades a day after predictions closed (${waiting.join('; ') || 'no exchange answered'}).`;
      this.service.openingPriceFailed(m.id, `Opening price not found: ${why}`);
      this.service.markResultAlerted(m.id);
      this.alert(`⚠️ <b>${m.symbol}: add its opening price</b>\nIt couldn’t be read from the exchange: ${why}\nAdd it in Admin → Markets → Awaiting result, with the result.`);
      return;
    }
    this.service.noteAutoOpen(m.id, `Waiting for trading to start to set the opening price. ${waiting.join('; ')}`);
  }

  /** The opening price on one exchange: the middle of its 2nd to 4th minutes of trading. */
  private async openingOn(venue: Venue, pair: string, listingAt: number, now: number): Promise<number | string> {
    try {
      const from = listingAt - 5 * MINUTE;
      const candles = (await venue.fetchCandles(pair, from, Math.min(now, from + OPENING_WAIT_MS + 10 * MINUTE))).filter((c) => c.volume > 0 && (c.trades ?? 1) > 0);
      if (candles.length < 4) return candles.length ? `${candles.length} minute${candles.length === 1 ? '' : 's'} of trading so far, waiting for 4` : 'no trades yet';
      return median(candles.slice(1, 4).map((c) => c.close));
    } catch (err) {
      return `couldn’t read prices (${(err as Error).message.slice(0, 80)})`;
    }
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
