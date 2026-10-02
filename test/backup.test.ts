import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/db.ts';
import { DbBackup, backupConfigFromEnv, restoreIfMissing, type BackupConfig } from '../src/db/backup.ts';

const cfg: BackupConfig = { url: 'https://proj.supabase.co', serviceKey: 'service-key', bucket: 'bk', object: 'firstprint.db' };

/** A tiny stand-in for Supabase Storage: private bucket, upsert uploads, 404 for missing objects. */
function fakeStorage(opts: { failGet?: number; failPost?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const calls: { method: string; name: string; auth: string | null; upsert: string | null }[] = [];
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const name = decodeURIComponent(url.pathname.split('/').pop()!);
    const h = new Headers(init.headers);
    const method = init.method ?? 'GET';
    calls.push({ method, name, auth: h.get('authorization'), upsert: h.get('x-upsert') });
    if (method === 'POST') {
      if (opts.failPost) return new Response('nope', { status: 500 });
      objects.set(name, Buffer.from(init.body as Uint8Array));
      return new Response('{}', { status: 200 });
    }
    if (opts.failGet) return new Response('boom', { status: opts.failGet });
    const o = objects.get(name);
    return o ? new Response(new Uint8Array(o)) : new Response('{"error":"not_found"}', { status: 404 });
  }) as typeof fetch;
  return { objects, calls, fetchFn };
}

const dir = () => mkdtempSync(join(tmpdir(), 'fp-backup-'));
const quiet = () => {};

test('config comes from the environment and is off without both values', () => {
  assert.equal(backupConfigFromEnv({}), null);
  assert.equal(backupConfigFromEnv({ SUPABASE_URL: 'https://x.supabase.co' }), null);
  assert.deepEqual(backupConfigFromEnv({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_KEY: 'k' }), {
    url: 'https://x.supabase.co',
    serviceKey: 'k',
    bucket: 'firstprint-backups',
    object: 'firstprint.db',
  });
  assert.throws(() => backupConfigFromEnv({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_KEY: 'k' }));
});

test('a real database survives a "restart": backed up, then restored into a fresh directory', async () => {
  const storage = fakeStorage();
  const a = join(dir(), 'firstprint.db');
  const db = openDb(a);
  db.exec("INSERT INTO users (id, username, points, created_at) VALUES ('u1', 'alice', 1234, 1)");
  const backup = new DbBackup(db, a, cfg, quiet, storage.fetchFn);
  assert.equal(await backup.runOnce(true), true);
  assert.ok(backup.status().lastOkAt);
  assert.equal(backup.status().lastError, null);
  db.close();

  // New container: empty disk.
  const b = join(dir(), 'nested', 'firstprint.db');
  assert.equal(await restoreIfMissing(b, cfg, quiet, storage.fetchFn), 'restored');
  const restored = new DatabaseSync(b);
  assert.deepEqual({ ...restored.prepare("SELECT username, points FROM users WHERE id = 'u1'").get() }, { username: 'alice', points: 1234 });
  assert.equal((restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  restored.close();

  // Every request is authenticated with the service key.
  assert.ok(storage.calls.every((c) => c.auth === 'Bearer service-key'));
  assert.ok(storage.calls.filter((c) => c.method === 'POST').every((c) => c.upsert === 'true'));
});

test('restore: skipped when a database exists, "none" on a first run, refuses to start when the backup is unreachable or corrupt', async () => {
  const have = join(dir(), 'firstprint.db');
  writeFileSync(have, 'existing');
  const s = fakeStorage();
  assert.equal(await restoreIfMissing(have, cfg, quiet, s.fetchFn), 'skipped');
  assert.equal(s.calls.length, 0);
  assert.equal(readFileSync(have, 'utf8'), 'existing');

  assert.equal(await restoreIfMissing(join(dir(), 'x.db'), cfg, quiet, s.fetchFn), 'none');

  const down = fakeStorage({ failGet: 503 });
  const target = join(dir(), 'y.db');
  await assert.rejects(restoreIfMissing(target, cfg, quiet, down.fetchFn), /Not starting/);
  assert.equal(existsSync(target), false); // nothing was created, so nothing can overwrite the good backup

  const junk = fakeStorage();
  junk.objects.set('firstprint.db', Buffer.from('this is not a database '.repeat(10)));
  await assert.rejects(restoreIfMissing(join(dir(), 'z.db'), cfg, quiet, junk.fetchFn), /not a SQLite database/);

  const unreachable = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  await assert.rejects(restoreIfMissing(join(dir(), 'w.db'), cfg, quiet, unreachable), /network down/);
});

test('backup: only uploads when something changed, keeps one dated copy per day, reports failures', async () => {
  const storage = fakeStorage();
  const p = join(dir(), 'firstprint.db');
  const db = openDb(p);
  const backup = new DbBackup(db, p, cfg, quiet, storage.fetchFn);

  assert.equal(await backup.runOnce(), true);
  const posts = () => storage.calls.filter((c) => c.method === 'POST').map((c) => c.name);
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(posts(), ['firstprint.db', `firstprint-${day}.db`]);

  assert.equal(await backup.runOnce(), false); // unchanged: no upload
  db.exec("INSERT INTO users (id, username, points, created_at) VALUES ('u2', 'bob', 5, 1)");
  assert.equal(await backup.runOnce(), true);
  assert.deepEqual(posts(), ['firstprint.db', `firstprint-${day}.db`, 'firstprint.db']); // dated copy not repeated

  assert.equal(await backup.runOnce(true), true); // force always uploads (used at shutdown)
  assert.equal(existsSync(`${p}.snapshot`), false); // temp file cleaned up

  const broken = fakeStorage({ failPost: true });
  const b2 = new DbBackup(db, p, cfg, quiet, broken.fetchFn);
  assert.equal(await b2.runOnce(true), false);
  assert.match(b2.status().lastError ?? '', /HTTP 500/);
});
