import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/db.ts';

test('an older database gets the Telegram task kind; its tasks and completions are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-migrate-'));
  const path = join(dir, 'old.db');
  try {
    // A database made before the Telegram task: its tasks table only allows the older kinds.
    const first = openDb(path);
    first.exec('PRAGMA foreign_keys = OFF;');
    first.exec('DROP TABLE tasks');
    first.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('follow', 'repost', 'like', 'share', 'link')),
      title TEXT NOT NULL, target TEXT NOT NULL, points INTEGER NOT NULL CHECK (points > 0),
      max_completions INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`);
    first.exec('PRAGMA foreign_keys = ON;');
    first.prepare("INSERT INTO users (id, username, points, created_at) VALUES ('u1', 'ana', 0, 1)").run();
    first.prepare("INSERT INTO tasks VALUES ('t1', 'follow', 'Follow', 'firstprint', 50, 10, 1, 1)").run();
    first.prepare("INSERT INTO task_completions (task_id, user_id, started_at, completed_at) VALUES ('t1', 'u1', 1, 2)").run();
    assert.throws(() => first.prepare("INSERT INTO tasks VALUES ('t2', 'telegram', 'Join', 'fp', 5, NULL, 1, 1)").run(), /CHECK/);
    first.close();

    const db = openDb(path);
    db.prepare("INSERT INTO tasks VALUES ('t2', 'telegram', 'Join', 'fp', 5, NULL, 1, 1)").run();
    assert.deepEqual(db.prepare('SELECT id, kind, points, max_completions FROM tasks ORDER BY id').all().map((r) => ({ ...r })), [
      { id: 't1', kind: 'follow', points: 50, max_completions: 10 },
      { id: 't2', kind: 'telegram', points: 5, max_completions: null },
    ]);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_completions').get() as { n: number }).n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'completions still point at real tasks');
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    db.close();
    // Opening again changes nothing.
    new DatabaseSync(path).close();
    openDb(path).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
