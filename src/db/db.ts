import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export type DB = DatabaseSync;

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  // With WAL, NORMAL is safe (no corruption) and much faster for many small writes.
  if (path !== ':memory:') db.exec('PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(schema);
  migrate(db);
  widenTaskKinds(db);
  return db;
}

/**
 * Databases made before the Telegram task allow only the older task kinds (a CHECK rule, which
 * SQLite can't change in place): the table is rebuilt with the same rows. Task completions point to
 * tasks by id, so foreign keys are paused while the old table is swapped out.
 */
function widenTaskKinds(db: DB) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'telegram'")) return;
  const create = (schema.match(/CREATE TABLE IF NOT EXISTS tasks \([\s\S]*?\n\);/) ?? [])[0];
  if (!create) throw new Error('tasks table missing from schema.sql');
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    tx(db, () => {
      db.exec(create.replace('CREATE TABLE IF NOT EXISTS tasks (', 'CREATE TABLE tasks_new ('));
      db.exec('INSERT INTO tasks_new (id, kind, title, target, points, max_completions, active, created_at) SELECT id, kind, title, target, points, max_completions, active, created_at FROM tasks');
      db.exec('DROP TABLE tasks');
      db.exec('ALTER TABLE tasks_new RENAME TO tasks');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

/** Adds columns introduced after a database was first created. */
function migrate(db: DB) {
  const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const ensure = (table: string, column: string, ddl: string) => {
    if (!cols(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
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
  // How a session signed in (email, google, wallet, password): only verified emails count for admin access.
  ensure('sessions', 'via', 'via TEXT');
  // Upcoming tokens the admin scheduled to open by themselves when trading starts.
  ensure('markets', 'auto_open_at', 'auto_open_at INTEGER');
  ensure('markets', 'auto_open_note', 'auto_open_note TEXT');
  // Settled markets the admin cleared out: hidden from lists, price data dropped, players' records kept.
  ensure('markets', 'archived_at', 'archived_at INTEGER');
  // Upcoming markets get their opening price from the exchange; the admin is asked for the result
  // only when it is due. Markets already past their close were alerted then, so they count as done.
  if (!cols('markets').includes('result_alerted_at')) {
    db.exec('ALTER TABLE markets ADD COLUMN result_alerted_at INTEGER');
    db.exec("UPDATE markets SET result_alerted_at = created_at WHERE status != 'open' AND base_price IS NOT NULL");
  }
  // Wallet accounts were named "sol_<address start>" until the player picked a name; they are now
  // named with the address start alone. Names players chose themselves are left as they are.
  const solNamed = db.prepare("SELECT id, username FROM users WHERE needs_username = 1 AND username LIKE 'sol\\_%' ESCAPE '\\'").all() as { id: string; username: string }[];
  for (const u of solNamed) {
    const base = u.username.slice(4);
    let name = base;
    for (let i = 2; db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id <> ?').get(name, u.id); i++) name = `${base}${i}`;
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, u.id);
  }
  // Firstprint wallets made for players who sign up without one (key sealed, see solana/vault.ts).
  db.exec(`CREATE TABLE IF NOT EXISTS embedded_wallets (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    address TEXT NOT NULL UNIQUE,
    secret_sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // TestFPT the server mints on its own (daily streak), one row per transaction, so each can be
  // retried safely and shown with its explorer link.
  db.exec(`CREATE TABLE IF NOT EXISTS chain_mints (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    wallet TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'submitted', 'confirmed', 'failed')),
    signature TEXT,
    last_valid_height INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, kind, ref)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS chain_mints_status ON chain_mints(status)');
  // Stakes, payouts and refunds on chain: the prediction they belong to (for the memo and the market).
  ensure('chain_mints', 'subject', 'subject TEXT');
  // People the owner gave admin-console access from Settings → Team (by email or wallet).
  db.exec(`CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('email', 'wallet')),
    value TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'listings', 'tasks')),
    added_at INTEGER NOT NULL
  )`);
  ensure('markets', 'opening_price_failed', 'opening_price_failed INTEGER NOT NULL DEFAULT 0');
  ensure('markets', 'reminded_at', 'reminded_at INTEGER');
  // 1: the start price is the live price when predictions close, read by the server then.
  ensure('markets', 'start_at_close', 'start_at_close INTEGER NOT NULL DEFAULT 0');
  ensure('users', 'x_username', 'x_username TEXT');
  ensure('users', 'referral_code', 'referral_code TEXT');
  ensure('users', 'referred_by', 'referred_by TEXT');
  // X account checks (GetXAPI): 1 once the player proved the username is theirs (a code in their bio
  // or a post); the username and code waiting for that proof.
  ensure('users', 'x_verified', 'x_verified INTEGER NOT NULL DEFAULT 0');
  ensure('users', 'x_pending', 'x_pending TEXT');
  ensure('users', 'x_code', 'x_code TEXT');
  // Telegram account (for the "join the channel" task): the player's Telegram user ID, found when
  // they press Start in our bot with their code, and that code while it waits.
  // Where the player signed up from: the two-letter country Cloudflare sees (CF-IPCountry), for
  // the analytics page. Only the country, never the address.
  ensure('users', 'country', 'country TEXT');
  ensure('users', 'tg_id', 'tg_id TEXT');
  ensure('users', 'tg_code', 'tg_code TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_tg ON users(tg_id) WHERE tg_id IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_x ON users(x_username COLLATE NOCASE) WHERE x_username IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_ref ON users(referral_code) WHERE referral_code IS NOT NULL');
  // Analytics groups predictions and daily claims by time.
  db.exec('CREATE INDEX IF NOT EXISTS predictions_time ON predictions(placed_at)');
  db.exec('CREATE INDEX IF NOT EXISTS ledger_reason_time ON ledger(reason, created_at)');
  // New accounts per network (a salted hash, never the address), for the daily sign-up limit.
  db.exec('CREATE TABLE IF NOT EXISTS signups (network TEXT NOT NULL, at INTEGER NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS signups_network ON signups(network, at)');
  // Clean-ups and background checks that run often (expired sign-ins, unclaimed rewards, claims confirming).
  db.exec('CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS auth_nonces_expiry ON auth_nonces(expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS rewards_unclaimed ON rewards(user_id) WHERE claim_id IS NULL');
  db.exec('CREATE INDEX IF NOT EXISTS claims_status ON claims(status)');
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
