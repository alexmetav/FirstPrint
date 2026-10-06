/**
 * The public, read-only API (/api/v1): open, closing and settled markets, tokens coming up, and the
 * leaderboard, for bots, dashboards and partners. No key needed. Only public fields are returned:
 * nothing about who predicted what, no emails or wallets. Documented at /api.html.
 */
import { BUCKETS, BINARY_BUCKETS, bucketRangeLabel, DEFAULT_THRESHOLDS, type Bucket, type Thresholds } from '../engine/engine.ts';

/** A market as the app's lists return it (FirstprintService.view). Only what the public API reads. */
export interface MarketView {
  id: string;
  symbol: string;
  name: string | null;
  kind: string;
  mode: string;
  status: string;
  phase: string;
  outcomes: string;
  thresholds?: Thresholds;
  venues: { id: string; name: string; pair: string }[];
  logoUrl: string | null;
  basePrice: number | null;
  startAtClose: boolean;
  listingAt: number;
  closeAt: number;
  settleAt: number;
  feeBps: number;
  pool: number;
  totals: Record<string, number>;
  predictors: number;
  result: null | { winningBucket: Bucket | null; finalPrice: number | null; basePrice: number | null; voidReason: string | null };
}

const STATUS: Record<string, string> = { open: 'open', locked: 'closed', resolved: 'settled', void: 'cancelled' };
/** The status filters the API accepts, and the app's list each one reads. */
export const PUBLIC_FILTERS = { open: 'open', closed: 'live', settled: 'settled' } as const;
export type PublicFilter = keyof typeof PUBLIC_FILTERS;

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

/** True while the token isn't trading yet: its opening price will be the start price. */
export function isUpcoming(m: MarketView, now: number) {
  return m.status === 'open' && (m.phase === 'pre_listing' || (m.mode === 'manual' && m.basePrice === null && !m.startAtClose && m.closeAt > now));
}

/** One market for the public API: what it asks, its outcomes and pool, and the result once settled. */
export function publicMarket(m: MarketView, siteUrl: string, now: number) {
  const yesNo = m.outcomes === 'yesno';
  const name = (b: Bucket) => (yesNo ? (b === 'up' ? 'yes' : 'no') : b);
  const buckets = yesNo ? BINARY_BUCKETS : BUCKETS;
  const afterFee = m.pool * (1 - m.feeBps / 10_000);
  const logo = m.logoUrl ? (m.logoUrl.startsWith('/') ? `${siteUrl}${m.logoUrl}` : m.logoUrl) : null;
  return {
    id: m.id,
    url: `${siteUrl}/app/#/market/${encodeURIComponent(m.id)}`,
    token: { symbol: m.symbol, name: m.name, logo },
    type: yesNo ? 'yes_no' : 'five_outcomes',
    category: m.kind === 'live_test' ? 'live' : 'listing',
    status: STATUS[m.status] ?? m.status,
    upcoming: isUpcoming(m, now),
    exchanges: m.venues.map((v) => ({ id: v.id, name: v.name, pair: v.pair })),
    startPrice: m.basePrice,
    // How the start price is set while it isn't known yet.
    startPriceFrom: m.basePrice !== null ? 'set' : m.startAtClose ? 'price_at_close' : 'opening_price',
    predictionsClose: iso(m.closeAt),
    resultAt: iso(m.settleAt),
    feePercent: m.feeBps / 100,
    pool: m.pool,
    participants: m.predictors,
    outcomes: buckets.map((b) => ({
      outcome: name(b),
      range: yesNo ? (b === 'up' ? 'at or above the start price' : 'below the start price') : bucketRangeLabel(b, m.thresholds ?? DEFAULT_THRESHOLDS),
      pool: m.totals[b] ?? 0,
      share: m.pool ? Math.round(((m.totals[b] ?? 0) / m.pool) * 1000) / 1000 : 0,
      // What 1 point on this outcome would return if it won, as the pool stands now.
      payout: m.totals[b] ? Math.round((afterFee / m.totals[b]) * 100) / 100 : null,
    })),
    result: m.result
      ? {
          winningOutcome: m.result.winningBucket ? name(m.result.winningBucket) : null,
          startPrice: m.result.basePrice,
          finalPrice: m.result.finalPrice,
          cancelledReason: m.result.voidReason,
        }
      : null,
  };
}
