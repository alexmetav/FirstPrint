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
