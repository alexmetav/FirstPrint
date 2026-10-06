/**
 * One budget for every CoinGecko call the server makes, so admin tools never use up the requests
 * that live markets need (a market's start price at its close, and its final price).
 *
 * CoinGecko's free API allows only a few calls a minute (about 30 with a demo key), and answers
 * 429 when that runs out. Calls come in two lanes:
 * - market work (the default): start and result prices. May use the whole budget; when the minute
 *   is full or CoinGecko has just said 429, it waits a little for room instead of failing.
 * - admin tools (anything run inside asAdmin): price checks, trending, logo lookups. May use only
 *   part of the budget, and stop for two minutes after a 429. They fail fast with a "busy" error
 *   (a 429), which the admin page already shows as "try again in a minute".
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const MINUTE = 60_000;
const lane = new AsyncLocalStorage<'admin'>();

/** Runs fn as admin-tool work: its CoinGecko calls use the smaller share of the budget. */
export const asAdmin = <T>(fn: () => T): T => lane.run('admin', fn);
const isAdmin = () => lane.getStore() === 'admin';

export class CoinGeckoBusy extends Error {
  status = 429;
  constructor() {
    super('429 CoinGecko busy: saving requests for live markets, try again in a minute');
  }
}

export class CoinGeckoGate {
  readonly perMinute: number;
  /** The most of each minute's budget admin tools may use; the rest is kept for live markets. */
  readonly adminShare: number;
  private calls: number[] = [];
  private adminCalls: number[] = [];
  private coolUntil = 0;
  private adminCoolUntil = 0;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: { perMinute: number; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    this.perMinute = Math.max(2, Math.floor(opts.perMinute));
    this.adminShare = Math.max(1, Math.floor(this.perMinute * 0.5));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private trim(t: number) {
    while (this.calls.length && this.calls[0] <= t - MINUTE) this.calls.shift();
    while (this.adminCalls.length && this.adminCalls[0] <= t - MINUTE) this.adminCalls.shift();
  }

  /** Waits for (market work) or claims (admin tools) a slot in this minute's budget. */
  async take(): Promise<void> {
    const admin = isAdmin();
    for (let waited = 0; ; ) {
      const t = this.now();
      this.trim(t);
      const cooling = t < this.coolUntil;
      if (admin) {
        if (t < this.adminCoolUntil || this.adminCalls.length >= this.adminShare || this.calls.length >= this.perMinute) throw new CoinGeckoBusy();
        this.adminCalls.push(t);
        this.calls.push(t);
        return;
      }
      if (!cooling && this.calls.length < this.perMinute) {
        this.calls.push(t);
        return;
      }
      // Market work waits for room, up to about a minute; the workers retry on their next tick after that.
      const wait = Math.max(250, cooling ? this.coolUntil - t : this.calls[0] + MINUTE - t + 50);
      if (waited + wait > 75_000) throw new CoinGeckoBusy();
      waited += wait;
      await this.sleep(wait);
    }
  }

  /** CoinGecko said 429: hold admin tools for two minutes and market work for 30 seconds. */
  limited() {
    const t = this.now();
    this.coolUntil = Math.max(this.coolUntil, t + 30_000);
    this.adminCoolUntil = Math.max(this.adminCoolUntil, t + 2 * MINUTE);
  }
  /** For the admin page: how much of the minute is used, and whether CoinGecko is cooling down. */
  status() {
    const t = this.now();
    this.trim(t);
    return { perMinute: this.perMinute, usedLastMinute: this.calls.length, coolingDown: t < Math.max(this.coolUntil, this.adminCoolUntil) };
  }

  /** Runs one CoinGecko request through the budget, noting a 429 if CoinGecko answers with one. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.take();
    try {
      return await fn();
    } catch (err) {
      if (/\b429\b/.test(String((err as Error)?.message ?? '')) && !(err instanceof CoinGeckoBusy)) this.limited();
      throw err;
    }
  }
}

/** The server's one gate. COINGECKO_PER_MIN overrides the budget (default 10 a minute, 25 with a demo key). */
export function defaultPerMinute(env: Record<string, string | undefined> = process.env): number {
  const set = Number(env.COINGECKO_PER_MIN);
  if (Number.isFinite(set) && set >= 2) return set;
  return env.COINGECKO_API_KEY?.trim() ? 25 : 10;
}

export const coingeckoGate = new CoinGeckoGate({ perMinute: defaultPerMinute() });
