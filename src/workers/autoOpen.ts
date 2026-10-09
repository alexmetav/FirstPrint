import type { FirstprintService, MarketRow, Notification, VenueRef } from '../services/firstprint.ts';
import type { Venue } from '../exchanges/types.ts';
import { checkLinks } from '../exchanges/priceAt.ts';

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
/** How long after predictions close to keep trying to read the price at the close before asking the admin. */
const CLOSE_WAIT_MS = 2 * 60 * MINUTE;
/** How long after the result time to keep trying to read the price then before asking the admin. */
const RESULT_WAIT_MS = 2 * 60 * MINUTE;
/** Between reads of the result price for one market, so a slow source isn't asked every 30 seconds. */
const RESULT_RETRY_MS = 2 * MINUTE;
/** Between reads once the admin has been asked: the price may still turn up (an exchange back from an outage). */
const LATE_RESULT_RETRY_MS = 15 * MINUTE;

/** "9 Oct, 12:00 UTC" */
export function utcTime(ts: number) {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
  private onSettled: (notes: Notification[]) => Promise<void>;
  private resultTried = new Map<string, number>();

  constructor(
    service: FirstprintService,
    venues: Venue[],
    alert: (text: string) => void = () => {},
    resultDue: (marketId: string) => string = (id) => `Result due: ${id}`,
    /** Results posted by themselves: the players' notifications (emails), like an admin's result. */
    onSettled: (notes: Notification[]) => Promise<void> = async () => {},
  ) {
    this.service = service;
    this.venues = new Map(venues.map((v) => [v.id, v]));
    this.alert = alert;
    this.resultDue = resultDue;
    this.onSettled = onSettled;
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
      // Result time come: the price then is read and the result posted with no admin step. Only if
      // no source has it is the admin asked, with links to check the price at that exact time.
      for (const { m, at } of this.service.resultPriceDue()) {
        try {
          await this.fillResultPrice(m, at);
        } catch (err) {
          this.service.log(`result price ${m.id} failed: ${(err as Error).message}`);
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
      if (m.start_at_close === 1) {
        this.service.autoOpen(m.id, start, `Opened by itself (trading at ${fmt(start)} on ${from}). The start price is taken when predictions close.`);
        this.alert(`✅ <b>${m.symbol} is open</b>\nTrading started (${fmt(start)} on ${from}), so predictions opened by themselves. The start price is the price when predictions close.`);
      } else {
        this.service.autoOpen(m.id, start, `Opened by itself at ${fmt(start)} (live price on ${from}).`);
        this.alert(`✅ <b>${m.symbol} is open</b>\nTrading started, so predictions opened by themselves. Start price ${fmt(start)} (live on ${from}).`);
      }
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
    if (m.start_at_close === 1) return this.fillClosePrice(m);
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

  /**
   * A market priced at the close: its start price is the price at the exact moment predictions
   * closed (the last trade before it; the median of the market's sources), so nobody gains from
   * watching the chart while predictions are open. If no source answers within two hours, the admin
   * is asked to add it.
   */
  private async fillClosePrice(m: MarketRow) {
    const now = this.service.clock.now();
    // Let the last minute before the close finish on the exchanges first.
    if (now < m.listing_at + 2 * MINUTE) return;
    const r = await this.service.readPriceAt(m.id, m.listing_at);
    if (r.price !== null) {
      this.service.setStartPrice(m.id, r.price);
      this.service.noteAutoOpen(m.id, `Start price ${fmt(r.price)} set by itself: the price at ${utcTime(m.listing_at)} when predictions closed, on ${r.from.join(', ')}.`);
      return;
    }
    if (now - m.listing_at > CLOSE_WAIT_MS) {
      const why = `no price for the close (${r.missing.join('; ') || 'no source answered'}).`;
      this.service.openingPriceFailed(m.id, `Start price not found: ${why}`);
      this.service.markResultAlerted(m.id);
      this.alert(`⚠️ <b>${m.symbol}: add its start price</b>\nThe price at ${utcTime(m.listing_at)} when predictions closed couldn’t be read: ${escHtml(why)}\nAdd it in Admin → Markets → Awaiting result, with the result.${this.linkLines(m, m.listing_at)}`);
      return;
    }
    this.service.noteAutoOpen(m.id, `Reading the price at the close. ${r.missing.join('; ')}`);
  }

  /**
   * The result time has come: the final price is the price at that exact moment (the median of the
   * market's sources). With it the result is posted by itself: the winning outcome comes from the
   * change since the start price, winners are paid, and the result goes to the channel. If no source
   * has the price within two hours, the admin is asked to enter it (with links to check it).
   */
  private async fillResultPrice(m: MarketRow, at: number) {
    const now = this.service.clock.now();
    // Let the last minute before the result time finish on the exchanges first.
    if (now < at + 2 * MINUTE) return;
    const asked = m.result_price_failed === 1;
    if (now - (this.resultTried.get(m.id) ?? 0) < (asked ? LATE_RESULT_RETRY_MS : RESULT_RETRY_MS)) return;
    this.resultTried.set(m.id, now);
    const r = await this.service.readPriceAt(m.id, at);
    if (r.price !== null) {
      this.resultTried.delete(m.id);
      const note = `Final price ${fmt(r.price)}: the price at ${utcTime(at)} on ${r.from.join(', ')}.`;
      const { summary, notes } = this.service.resolveManualMarket(m.id, { finalPrice: r.price, note }, 'auto');
      this.service.noteAutoOpen(m.id, `Result posted by itself${asked ? ' (found after the admin was asked)' : ''}. ${note}`);
      const what = summary.voidReason
        ? `It was cancelled and refunded (${summary.voidReason}).`
        : `${summary.winningBucket ? summary.winningBucket[0].toUpperCase() + summary.winningBucket.slice(1) : '?'} won (${summary.returnPct >= 0 ? '+' : ''}${(summary.returnPct * 100).toFixed(2)}%), ${summary.winnerCount} winner${summary.winnerCount === 1 ? '' : 's'} paid.`;
      this.alert(`✅ <b>${m.symbol} result posted</b>\n${escHtml(note)}\n${escHtml(what)}`);
      await this.onSettled(notes);
      return;
    }
    if (asked) {
      // Already asked: keep the admin's note, and quietly try again later.
      this.service.noteAutoOpen(m.id, `Final price not found yet, still checking every 15 minutes: ${r.missing.join('; ') || 'no source answered'}`);
      return;
    }
    if (now - at > RESULT_WAIT_MS) {
      const why = r.missing.join('; ') || 'no source answered';
      this.service.resultPriceFailed(m.id, `Final price not found: no price at ${utcTime(at)} (${why}).`);
      this.service.markResultAlerted(m.id);
      this.alert(`${this.resultDue(m.id)}\n\nThe price at ${utcTime(at)} couldn’t be read (${escHtml(why)}).${this.linkLines(m, at)}`);
      return;
    }
    this.service.noteAutoOpen(m.id, `Reading the price at the result time. ${r.missing.join('; ')}`);
  }

  /** Links for a Telegram alert to each source's 1-minute candle ending at `at`. */
  private linkLines(m: MarketRow, at: number) {
    const refs = (JSON.parse(m.venues) as VenueRef[]).map((v) => ({ venue: v.venue, name: this.venues.get(v.venue)?.name ?? v.venue, pair: v.symbol }));
    const links = checkLinks(refs, at);
    return links.length ? `\n\nCheck the price at ${utcTime(at)}:\n${links.map((l) => `• <a href="${escHtml(l.url)}">${escHtml(l.name)}</a> (${l.hint})`).join('\n')}` : '';
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
