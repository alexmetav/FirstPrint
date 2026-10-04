import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export type DB = DatabaseSync;

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(schema);
  migrate(db);
  return db;
}

/** Adds columns introduced after a database was first created. */
function migrate(db: DB) {
  const ensure = (table: string, column: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  ensure('users', 'needs_username', "needs_username INTEGER NOT NULL DEFAULT 0");
  ensure('markets', 'kind', "kind TEXT NOT NULL DEFAULT 'listing'");
  ensure('markets', 'mode', "mode TEXT NOT NULL DEFAULT 'auto'");
  ensure('markets', 'published', 'published INTEGER NOT NULL DEFAULT 1');
  ensure('markets', 'base_price', 'base_price REAL');
  ensure('markets', 'note', 'note TEXT');
  ensure('markets', 'logo_url', 'logo_url TEXT');
  ensure('detected_listings', 'name', 'name TEXT');
  ensure('users', 'streak', 'streak INTEGER NOT NULL DEFAULT 0');
  ensure('markets', 'announced_at', 'announced_at INTEGER');
  ensure('markets', 'logo_png', 'logo_png TEXT');
  ensure('markets', 'reminded_at', 'reminded_at INTEGER');
  ensure('users', 'x_username', 'x_username TEXT');
  ensure('users', 'referral_code', 'referral_code TEXT');
  ensure('users', 'referred_by', 'referred_by TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_x ON users(x_username COLLATE NOCASE) WHERE x_username IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_ref ON users(referral_code) WHERE referral_code IS NOT NULL');
  // Analytics groups predictions and daily claims by time.
  db.exec('CREATE INDEX IF NOT EXISTS predictions_time ON predictions(placed_at)');
  db.exec('CREATE INDEX IF NOT EXISTS ledger_reason_time ON ledger(reason, created_at)');
  backfillStreaks(db);
}

/**
 * Streaks started counting after players had already claimed for days. Once, rebuild each player's
 * streak from their daily claims in the ledger, so a run of consecutive days carries over.
 */
function backfillStreaks(db: DB) {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'streaks_backfilled'").get()) return;
  const rows = db.prepare("SELECT user_id, ref FROM ledger WHERE reason = 'daily' ORDER BY user_id, ref DESC").all() as { user_id: string; ref: string }[];
  const last = new Map(
    (db.prepare('SELECT id, last_claim_day, streak FROM users WHERE last_claim_day IS NOT NULL').all() as { id: string; last_claim_day: string; streak: number }[]).map((u) => [u.id, u]),
  );
  const byUser = new Map<string, string[]>();
  for (const r of rows) (byUser.get(r.user_id) ?? byUser.set(r.user_id, []).get(r.user_id)!).push(r.ref);
  const update = db.prepare('UPDATE users SET streak = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const [id, days] of byUser) {
      const u = last.get(id);
      if (!u || days[0] !== u.last_claim_day) continue;
      let run = 1;
      for (let i = 1; i < days.length; i++) {
        const gap = (Date.parse(`${days[i - 1]}T00:00:00Z`) - Date.parse(`${days[i]}T00:00:00Z`)) / 86_400_000;
        if (gap !== 1) break;
        run++;
      }
      if (run > (u.streak ?? 0)) update.run(run, id);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('streaks_backfilled', '1')").run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Runs fn inside a transaction; rolls back if it throws. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
