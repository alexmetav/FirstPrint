import type { Candle } from '../engine/engine.ts';
import type { Clock } from '../clock.ts';
import { MINUTE, type Venue } from './types.ts';

/**
 * Simulated venue for local development, demos, and tests. Prices are
 * deterministic: the same symbol and minute always give the same candle.
 */
export interface SimProfile {
  /** Trading starts at this time. */
  listingAt: number;
  startPrice: number;
  /** Total return reached at `horizonMs` (e.g. -0.3 for a 30% drop). */
  targetReturn: number;
  horizonMs: number;
  /** Relative noise around the trend (0.05 = ±5%). */
  noise: number;
  /** Average quote volume per minute. */
  volume: number;
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

export function simPrice(symbol: string, p: SimProfile, ts: number): number {
  const m = Math.max(0, (ts - p.listingAt) / p.horizonMs);
  const trend = p.startPrice * Math.pow(1 + p.targetReturn, Math.min(m, 1.2));
  const n = (hash01(`${symbol}:${ts}`) - 0.5) * 2 * p.noise;
  // Listing-day spike in the first minutes, fading quickly.
  const spike = ts - p.listingAt < 5 * MINUTE ? 1 + 0.4 * hash01(`${symbol}:spike:${ts}`) : 1;
  return Math.max(1e-9, trend * (1 + n) * spike);
}

export class SimVenue implements Venue {
  id: string;
  name = 'Simulator';
  private profiles = new Map<string, SimProfile>();
  private clock: Clock;
  private resolve: ((symbol: string) => SimProfile | undefined) | null;

  constructor(id: string, clock: Clock, resolve?: (symbol: string) => SimProfile | undefined) {
    this.id = id;
    this.clock = clock;
    this.resolve = resolve ?? null;
  }

  add(symbol: string, profile: SimProfile) {
    this.profiles.set(symbol, profile);
  }

  async fetchCandles(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
    const p = this.profiles.get(symbol) ?? this.resolve?.(symbol);
    if (!p) return [];
    const nowFloor = Math.floor(this.clock.now() / MINUTE) * MINUTE;
    const from = Math.max(Math.ceil(startMs / MINUTE) * MINUTE, p.listingAt);
    const to = Math.min(endMs, nowFloor);
    const out: Candle[] = [];
    for (let ts = from; ts < to; ts += MINUTE) {
      out.push({
        ts,
        close: simPrice(symbol, p, ts),
        volume: Math.round(p.volume * (0.5 + hash01(`${symbol}:v:${ts}`))),
        trades: 3 + Math.floor(hash01(`${symbol}:t:${ts}`) * 40),
      });
    }
    return out;
  }

  pair(base: string) {
    return `${base.toUpperCase()}USDT`;
  }

  async fetchTicker(symbol: string) {
    const p = this.profiles.get(symbol) ?? this.resolve?.(symbol);
    const now = this.clock.now();
    if (!p || now < p.listingAt) return null;
    return { price: simPrice(symbol, p, Math.floor(now / 5_000) * 5_000), ts: now };
  }

  async listPairs() {
    return [...this.profiles.keys()].map((pair) => ({ pair, base: pair.replace(/USDT$/, ''), quote: 'USDT', listingAt: this.profiles.get(pair)!.listingAt }));
  }
}

const SIM_OUTCOMES = [-0.72, -0.34, -0.04, 0.22, 0.85];

/**
 * Derives a simulated price path for any market that uses the "sim" venue,
 * so local markets keep working across server restarts.
 */
export function simProfileFromDb(db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } }) {
  return (symbol: string): SimProfile | undefined => {
    const rows = db
      .prepare("SELECT listing_at, config, venues FROM markets WHERE venues LIKE ? ORDER BY created_at DESC LIMIT 5")
      .all(`%"${symbol}"%`) as { listing_at: number; config: string; venues: string }[];
    const row = rows.find((r) => (JSON.parse(r.venues) as { venue: string; symbol: string }[]).some((v) => v.venue === 'sim' && v.symbol === symbol));
    if (!row) {
      // No market yet (e.g. admin checking the symbol): a steady synthetic price.
      return { listingAt: Date.UTC(2026, 0, 1), startPrice: Number((0.01 + hash01(symbol) * 2).toFixed(4)), targetReturn: 0, horizonMs: 72 * 3_600_000, noise: 0.02, volume: 5_000 };
    }
    const cfg = JSON.parse(row.config) as { durationMs: number };
    const h = hash01(symbol);
    return {
      listingAt: row.listing_at,
      startPrice: Number((0.01 + h * 2).toFixed(4)),
      targetReturn: SIM_OUTCOMES[Math.floor(hash01(`${symbol}:outcome`) * SIM_OUTCOMES.length)],
      horizonMs: cfg.durationMs,
      noise: 0.03,
      volume: 2_000 + Math.round(h * 20_000),
    };
  };
}
