import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/db.ts';
import { DbBackup, backupConfigFromEnv, restoreIfMissing, type BackupConfig } from '../src/db/backup.ts';

const cfg: BackupConfig = { url: 'https://proj.supabase.co', serviceKey: 'service-key', bucket: 'bk', object: 'firstprint.db' };

/** A tiny stand-in for Supabase Storage: private bucket, upsert or create-only uploads, 404 for missing objects. */
function fakeStorage(opts: { failGet?: number; failPost?: boolean; slowPost?: Promise<void> } = {}) {
  const objects = new Map<string, Buffer>();
  const calls: { method: string; name: string; auth: string | null; upsert: string | null }[] = [];
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const name = decodeURIComponent(url.pathname.split('/').pop()!);
    const h = new Headers(init.headers);
    const method = url.pathname.includes('/object/list/') ? 'LIST' : (init.method ?? 'GET');
    calls.push({ method, name, auth: h.get('authorization'), upsert: h.get('x-upsert') });
    if (url.pathname.includes('/object/list/')) {
      const { search } = JSON.parse(String(init.body ?? '{}')) as { search: string };
      return Response.json([...objects.keys()].filter((k) => k.includes(search)).map((k) => ({ name: k })));
    }
    if (method === 'DELETE') {
      for (const k of (JSON.parse(String(init.body ?? '{}')) as { prefixes: string[] }).prefixes) objects.delete(k);
      return Response.json([]);
    }
    if (method === 'POST') {
      if (opts.slowPost) await opts.slowPost;
      if (opts.failPost) return new Response('nope', { status: 500 });
      if (h.get('x-upsert') !== 'true' && objects.has(name)) return new Response('{"error":"Duplicate"}', { status: 409 });
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
  // The live copy is replaced each time; the dated daily copy is create-only.
  const posts = storage.calls.filter((c) => c.method === 'POST');
  assert.ok(posts.filter((c) => c.name === 'firstprint.db').every((c) => c.upsert === 'true'));
  assert.ok(posts.filter((c) => c.name !== 'firstprint.db').every((c) => c.upsert === 'false'));
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

test('backup: a restart never overwrites the day\'s dated copy', async () => {
  const storage = fakeStorage();
  const day = new Date().toISOString().slice(0, 10);
  storage.objects.set(`firstprint-${day}.db`, Buffer.from('earlier good copy'));
  const p = join(dir(), 'firstprint.db');
  const db = openDb(p);
  const backup = new DbBackup(db, p, cfg, quiet, storage.fetchFn);
  assert.equal(await backup.runOnce(true), true); // the existing dated copy is not an error
  assert.equal(storage.objects.get(`firstprint-${day}.db`)?.toString(), 'earlier good copy');
  assert.notEqual(storage.objects.get('firstprint.db')?.toString(), undefined);
  db.close();
});

test('backup: stop() waits for a copy in progress, then copies what was written meanwhile', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const storage = fakeStorage({ slowPost: gate });
  const p = join(dir(), 'firstprint.db');
  const db = openDb(p);
  const backup = new DbBackup(db, p, cfg, quiet, storage.fetchFn);
  const first = backup.runOnce(true); // in flight, stuck uploading
  db.exec("INSERT INTO users (id, username, points, created_at) VALUES ('late', 'late_writer', 7, 1)");
  const stopped = backup.stop();
  release();
  assert.equal(await first, true);
  await stopped;
  db.close();

  const restoredPath = join(dir(), 'r.db');
  assert.equal(await restoreIfMissing(restoredPath, cfg, quiet, storage.fetchFn), 'restored');
  const restored = new DatabaseSync(restoredPath);
  assert.ok(restored.prepare("SELECT 1 FROM users WHERE id = 'late'").get(), 'the final copy includes the late write');
  restored.close();
});

test('backups are gzip-compressed, old uncompressed copies still restore, daily copies older than 7 days are removed', async () => {
  const { gunzipSync } = await import('node:zlib');
  const storage = fakeStorage();
  const a = join(dir(), 'firstprint.db');
  const db = openDb(a);
  db.exec("INSERT INTO users (id, username, points, created_at) VALUES ('u1', 'alice', 77, 1)");
  // Dated copies left from earlier days: 10 and 3 days old.
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  storage.objects.set(`firstprint-${day(10)}.db`, Buffer.from('old'));
  storage.objects.set(`firstprint-${day(3)}.db`, Buffer.from('recent'));
  storage.objects.set('other-file.txt', Buffer.from('keep'));
  const backup = new DbBackup(db, a, cfg, quiet, storage.fetchFn);
  assert.equal(await backup.runOnce(true), true);
  const live = storage.objects.get('firstprint.db')!;
  assert.equal(live[0], 0x1f, 'gzip');
  assert.equal(gunzipSync(live).subarray(0, 15).toString('latin1'), 'SQLite format 3');
  assert.equal(storage.objects.has(`firstprint-${day(10)}.db`), false, 'older than 7 days: removed');
  assert.ok(storage.objects.has(`firstprint-${day(3)}.db`));
  assert.ok(storage.objects.has(`firstprint-${day(0)}.db`));
  assert.ok(storage.objects.has('other-file.txt'));
  db.close();

  const b = join(dir(), 'firstprint.db');
  assert.equal(await restoreIfMissing(b, cfg, quiet, storage.fetchFn), 'restored');
  assert.equal((new DatabaseSync(b).prepare("SELECT points FROM users WHERE id = 'u1'").get() as { points: number }).points, 77);

  // A copy saved before compression existed.
  storage.objects.set('firstprint.db', gunzipSync(live));
  const c = join(dir(), 'firstprint.db');
  assert.equal(await restoreIfMissing(c, cfg, quiet, storage.fetchFn), 'restored');
  assert.equal((new DatabaseSync(c).prepare("SELECT points FROM users WHERE id = 'u1'").get() as { points: number }).points, 77);
});
