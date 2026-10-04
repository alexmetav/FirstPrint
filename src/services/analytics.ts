import type { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

// Real players signed in with an email (Google or code) or a wallet. Seeded demo accounts have neither.
const REAL = `SELECT id FROM users WHERE email IS NOT NULL OR id IN (SELECT user_id FROM wallets)`;

type Row = Record<string, number | string | null>;

/**
 * Aggregate numbers for the analytics dashboard and the read-only partner link.
 * Nothing here identifies a player: only counts, sums and public market names.
 */
export function analytics(db: DatabaseSync, now: number, days = 30) {
  days = [7, 30, 90].includes(days) ? days : 30;
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const start = today - (days - 1) * DAY;
  const prevStart = start - days * DAY;
  const one = (sql: string, ...args: (number | string)[]) => (db.prepare(sql).get(...args) as Row | undefined) ?? {};
  const all = (sql: string, ...args: (number | string)[]) => db.prepare(sql).all(...args) as Row[];
  const n = (v: unknown) => Number(v ?? 0);

  const players = n(one(`SELECT COUNT(*) c FROM (${REAL})`).c);
  const newPlayers = (from: number, to: number) => n(one(`SELECT COUNT(*) c FROM users WHERE id IN (${REAL}) AND created_at >= ? AND created_at < ?`, from, to).c);
  // Active = made a prediction or claimed daily points that day.
  const activeSql = `SELECT user_id, date(placed_at / 1000, 'unixepoch') d FROM predictions WHERE placed_at >= ? AND placed_at < ? AND user_id IN (${REAL})
    UNION SELECT user_id, ref d FROM ledger WHERE reason = 'daily' AND created_at >= ? AND created_at < ? AND user_id IN (${REAL})`;
  const active = (from: number, to: number) => n(one(`SELECT COUNT(DISTINCT user_id) c FROM (${activeSql})`, from, to, from, to).c);
  const preds = (from: number, to: number) =>
    one(`SELECT COUNT(*) c, COALESCE(SUM(stake), 0) s, COUNT(DISTINCT market_id) m FROM predictions WHERE placed_at >= ? AND placed_at < ? AND user_id IN (${REAL})`, from, to);
  const end = today + DAY;
  const cur = preds(start, end);
  const prev = preds(prevStart, start);
  const activeNow = active(start, end);
  const returning = n(
    one(`SELECT COUNT(DISTINCT a.user_id) c FROM (${activeSql}) a JOIN users u ON u.id = a.user_id WHERE u.created_at < ?`, start, end, start, end, start).c,
  );

  // Day by day.
  const byDay = (sql: string, ...args: number[]) => new Map(all(sql, ...args).map((r) => [String(r.d), r]));
  const signups = byDay(`SELECT date(created_at / 1000, 'unixepoch') d, COUNT(*) c FROM users WHERE id IN (${REAL}) AND created_at >= ? GROUP BY d`, start);
  const predDays = byDay(`SELECT date(placed_at / 1000, 'unixepoch') d, COUNT(*) c, SUM(stake) s FROM predictions WHERE placed_at >= ? AND user_id IN (${REAL}) GROUP BY d`, start);
  const activeDays = byDay(`SELECT d, COUNT(DISTINCT user_id) c FROM (${activeSql}) GROUP BY d`, start, end, start, end);
  const series = [];
  for (let t = start; t < end; t += DAY) {
    const d = isoDay(t);
    series.push({ day: d, newPlayers: n(signups.get(d)?.c), active: n(activeDays.get(d)?.c), predictions: n(predDays.get(d)?.c), staked: n(predDays.get(d)?.s) });
  }

  // How players sign in.
  const methods = one(`SELECT
      SUM(CASE WHEN email IS NOT NULL AND w IS NULL THEN 1 ELSE 0 END) emailOnly,
      SUM(CASE WHEN email IS NULL AND w IS NOT NULL THEN 1 ELSE 0 END) walletOnly,
      SUM(CASE WHEN email IS NOT NULL AND w IS NOT NULL THEN 1 ELSE 0 END) both
    FROM (SELECT u.email, (SELECT 1 FROM wallets x WHERE x.user_id = u.id LIMIT 1) w FROM users u WHERE u.id IN (${REAL}))`);

  // Markets with the most points staked in the period.
  const topMarkets = all(
    `SELECT m.symbol, m.name, m.exchange, m.status, COUNT(*) predictions, COUNT(DISTINCT p.user_id) predictors, SUM(p.stake) staked
     FROM predictions p JOIN markets m ON m.id = p.market_id
     WHERE p.placed_at >= ? AND m.published = 1 AND p.user_id IN (${REAL})
     GROUP BY m.id ORDER BY staked DESC LIMIT 8`,
    start,
  ).map((r) => ({ symbol: String(r.symbol), name: r.name ? String(r.name) : null, exchange: String(r.exchange), status: String(r.status), predictions: n(r.predictions), predictors: n(r.predictors), staked: n(r.staked) }));

  // Live daily streaks (claimed today or yesterday), grouped.
  const yesterday = isoDay(today - DAY);
  const streakRows = all(`SELECT streak FROM users WHERE id IN (${REAL}) AND last_claim_day IN (?, ?)`, isoDay(today), yesterday);
  const streaks = { '1 day': 0, '2–3 days': 0, '4–6 days': 0, '7+ days': 0 } as Record<string, number>;
  for (const r of streakRows) {
    const s = Math.max(1, n(r.streak));
    streaks[s >= 7 ? '7+ days' : s >= 4 ? '4–6 days' : s >= 2 ? '2–3 days' : '1 day']++;
  }

  const markets = one(`SELECT
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN status IN ('resolved', 'void') THEN 1 ELSE 0 END) settled,
      COUNT(*) total FROM markets WHERE published = 1 AND kind = 'listing'`);
  const totals = one(`SELECT COUNT(*) c, COALESCE(SUM(stake), 0) s FROM predictions WHERE user_id IN (${REAL})`);
  const wallets = n(one(`SELECT COUNT(DISTINCT user_id) c FROM wallets WHERE user_id IN (${REAL})`).c);
  const referred = n(one(`SELECT COUNT(*) c FROM users WHERE referred_by IS NOT NULL AND id IN (${REAL})`).c);
  const tasks = n(one(`SELECT COUNT(*) c FROM task_completions WHERE completed_at IS NOT NULL AND user_id IN (${REAL})`).c);
  const claimed = one(`SELECT COUNT(DISTINCT user_id) u, COALESCE(SUM(amount), 0) a FROM claims WHERE status = 'confirmed' AND user_id IN (${REAL})`);

  return {
    generatedAt: now,
    days,
    from: isoDay(start),
    to: isoDay(today),
    period: {
      newPlayers: newPlayers(start, end),
      newPlayersPrev: newPlayers(prevStart, start),
      active: activeNow,
      activePrev: active(prevStart, start),
      returning,
      predictions: n(cur.c),
      predictionsPrev: n(prev.c),
      staked: n(cur.s),
      stakedPrev: n(prev.s),
      marketsPlayed: n(cur.m),
    },
    totals: {
      players,
      walletsLinked: wallets,
      predictions: n(totals.c),
      staked: n(totals.s),
      marketsOpen: n(markets.open),
      marketsSettled: n(markets.settled),
      marketsTotal: n(markets.total),
      referred,
      tasksDone: tasks,
      testfptClaimers: n(claimed.u),
      testfptClaimed: n(claimed.a),
    },
    signIn: { emailOnly: n(methods.emailOnly), walletOnly: n(methods.walletOnly), both: n(methods.both) },
    series,
    topMarkets,
    streaks: Object.entries(streaks).map(([label, count]) => ({ label, count })),
  };
}
