import type { DB } from '../db/db.ts';

/**
 * Problems worth an admin's attention, kept in the database and shown in Admin → Errors: requests
 * that failed on the server (5xx), background work that failed (chain sends, backups, Telegram,
 * email, X checks, prices), and errors players hit in the app. The same problem repeating is one
 * row with a count, so a flood stays readable. Rows stay until marked fixed.
 */
export type ErrorSource = 'server' | 'background' | 'app';
export interface ErrorInput {
  source: ErrorSource;
  /** Short kind, e.g. server_error, chain, backup, telegram, email, x, price, client_error. */
  code: string;
  message: string;
  /** Where: "POST /api/me/claims", a page path, or the background job. */
  where?: string | null;
  userId?: string | null;
  detail?: string | null;
}
export interface ErrorRow {
  id: number;
  source: ErrorSource;
  code: string;
  message: string;
  where_: string | null;
  user_id: string | null;
  detail: string | null;
  count: number;
  first_at: number;
  last_at: number;
  resolved_at: number | null;
}

const MAX_ROWS = 2000;
const clip = (s: string | null | undefined, n: number) => (s == null ? null : String(s).slice(0, n));

export class ErrorLog {
  private db: DB;
  private now: () => number;
  /** Writes in the last second, to cap a flood (errors in a tight loop) at a few rows a second. */
  private burst = { at: 0, n: 0 };

  constructor(db: DB, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  record(e: ErrorInput) {
    try {
      const t = this.now();
      if (t - this.burst.at > 1000) this.burst = { at: t, n: 0 };
      if (++this.burst.n > 20) return;
      const message = clip(e.message, 400) || 'Unknown error';
      // Numbers and ids vary between repeats of the same problem; leave them out of the match.
      const fingerprint = `${e.source}|${e.code}|${e.where ?? ''}|${message.replace(/[0-9a-f]{8,}|\d+/gi, '#').slice(0, 160)}`;
      const open = this.db.prepare('SELECT id FROM error_log WHERE fingerprint = ? AND resolved_at IS NULL').get(fingerprint) as { id: number } | undefined;
      if (open) {
        this.db
          .prepare('UPDATE error_log SET count = count + 1, last_at = ?, message = ?, user_id = COALESCE(?, user_id), detail = COALESCE(?, detail) WHERE id = ?')
          .run(t, message, e.userId ?? null, clip(e.detail, 4000), open.id);
        return;
      }
      this.db
        .prepare('INSERT INTO error_log (fingerprint, source, code, message, where_, user_id, detail, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .run(fingerprint, e.source, clip(e.code, 40) || 'error', message, clip(e.where, 200), e.userId ?? null, clip(e.detail, 4000), t, t);
      const total = (this.db.prepare('SELECT COUNT(*) AS n FROM error_log').get() as { n: number }).n;
      if (total > MAX_ROWS) {
        this.db.prepare('DELETE FROM error_log WHERE id IN (SELECT id FROM error_log ORDER BY resolved_at IS NULL, last_at LIMIT ?)').run(total - MAX_ROWS);
      }
    } catch {
      // Logging an error must never cause one.
    }
  }

  list(open = true, limit = 200) {
    const rows = this.db
      .prepare(`SELECT * FROM error_log WHERE resolved_at IS ${open ? '' : 'NOT '}NULL ORDER BY last_at DESC LIMIT ?`)
      .all(Math.min(500, Math.max(1, limit))) as unknown as ErrorRow[];
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      code: r.code,
      message: r.message,
      where: r.where_,
      userId: r.user_id,
      detail: r.detail,
      count: r.count,
      firstAt: r.first_at,
      lastAt: r.last_at,
      resolvedAt: r.resolved_at,
    }));
  }

  /** Open problems, and how many were seen in the last day. */
  counts() {
    const open = (this.db.prepare('SELECT COUNT(*) AS n FROM error_log WHERE resolved_at IS NULL').get() as { n: number }).n;
    const today = (this.db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM error_log WHERE last_at > ?').get(this.now() - 86_400_000) as { n: number }).n;
    return { open, today };
  }

  resolve(id: number) {
    return this.db.prepare('UPDATE error_log SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(this.now(), id).changes === 1;
  }

  resolveAll() {
    return this.db.prepare('UPDATE error_log SET resolved_at = ? WHERE resolved_at IS NULL').run(this.now()).changes;
  }

  clearResolved() {
    return this.db.prepare('DELETE FROM error_log WHERE resolved_at IS NOT NULL').run().changes;
  }
}

/** Which kind of background problem a log line is, or null when it isn't one. */
export function classifyLogLine(msg: string): string | null {
  if (!/\b(fail(ed|s|ure)?|error|could ?n[o’']t|unable|rejected|timed out|timeout)\b/i.test(msg)) return null;
  if (/^500 /.test(msg)) return null; // recorded with the request instead
  if (/telegram|bot\b|banner|channel post/i.test(msg)) return 'telegram';
  if (/backup|restore|lease|hand-?over|supabase/i.test(msg)) return 'backup';
  if (/mail|resend/i.test(msg)) return 'email';
  if (/getxapi|\bx check|\bon x\b|twitter/i.test(msg)) return 'x';
  if (/claim|mint|chain|solana|testfpt|airdrop/i.test(msg)) return 'chain';
  if (/price|coingecko|cmc|mexc|gate|binance|venue|exchange/i.test(msg)) return 'price';
  return 'other';
}
