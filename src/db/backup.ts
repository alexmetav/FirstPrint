import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DB } from './db.ts';

/**
 * Keeps the SQLite database alive on hosts without a persistent disk (for example
 * Render's free plan) by copying it to a private Supabase Storage bucket and
 * restoring it at start-up. Works with any project on Supabase's free plan.
 *
 * Copies are gzip-compressed (a SQLite file shrinks about 5×) and taken every minute when
 * something changed, plus one on shutdown. A deploy starts the new server from the latest copy
 * before the old one stops, so the gap between copies is what a deploy can lose: a minute keeps
 * it small while staying inside a free host's monthly bandwidth.
 * One dated copy is kept per day for the last 30 days.
 */
export interface BackupConfig {
  /** https://<project>.supabase.co */
  url: string;
  /** The project's service_role key. Secret: it bypasses row security. Keep it only in the host's environment. */
  serviceKey: string;
  bucket: string;
  object: string;
}

type Fetch = typeof fetch;
const SQLITE_MAGIC = 'SQLite format 3\u0000';
const KEEP_DAILY = 30;
const isGzip = (b: Buffer) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

export function backupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupConfig | null {
  const url = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const serviceKey = (env.SUPABASE_SERVICE_KEY ?? '').trim();
  if (!url || !serviceKey) return null;
  if (!/^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(url)) {
    throw new Error('SUPABASE_URL must look like https://<project>.supabase.co');
  }
  return { url, serviceKey, bucket: env.BACKUP_BUCKET || 'firstprint-backups', object: env.BACKUP_OBJECT || 'firstprint.db' };
}

const headers = (cfg: BackupConfig) => ({ authorization: `Bearer ${cfg.serviceKey}`, apikey: cfg.serviceKey });
const objectUrl = (cfg: BackupConfig, name: string, authenticated = false) =>
  `${cfg.url}/storage/v1/object/${authenticated ? 'authenticated/' : ''}${encodeURIComponent(cfg.bucket)}/${encodeURIComponent(name)}`;

/**
 * Downloads the latest backup if there is no local database yet.
 * Throws if the backup exists but can't be fetched: starting empty would let the next
 * backup overwrite good data with an empty database, so it's better to refuse to start.
 */
export async function restoreIfMissing(
  path: string,
  cfg: BackupConfig,
  log: (msg: string) => void,
  fetchFn: Fetch = fetch,
): Promise<'skipped' | 'none' | 'restored'> {
  if (existsSync(path)) return 'skipped';
  const res = await fetchFn(objectUrl(cfg, cfg.object, true), { headers: headers(cfg), signal: AbortSignal.timeout(30_000) });
  if (res.status === 404 || res.status === 400) {
    // Storage answers 400 with "Object not found" for a missing object; check the body before trusting it.
    const text = await res.text();
    if (res.status === 404 || /not.?found/i.test(text)) {
      log('backup: none found, starting with a new database');
      return 'none';
    }
    throw new Error(`backup restore refused: ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`backup restore failed: HTTP ${res.status}. Not starting, to avoid replacing good data with an empty database.`);
  const raw = Buffer.from(await res.arrayBuffer());
  // Older copies were stored uncompressed; both are accepted.
  let bytes: Buffer;
  try {
    bytes = isGzip(raw) ? gunzipSync(raw) : raw;
  } catch {
    throw new Error('backup restore failed: the downloaded copy is damaged (could not decompress).');
  }
  if (bytes.length < 100 || bytes.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
    throw new Error('backup restore failed: the downloaded file is not a SQLite database.');
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  log(`backup: restored ${bytes.length} bytes`);
  return 'restored';
}

export class DbBackup {
  private db: DB;
  private path: string;
  private cfg: BackupConfig;
  private log: (msg: string) => void;
  private fetchFn: Fetch;
  private timer: NodeJS.Timeout | null = null;
  private lastChanges = -1;
  private lastDaily = '';
  private inFlight: Promise<boolean> | null = null;
  lastOkAt: number | null = null;
  lastError: string | null = null;

  constructor(db: DB, path: string, cfg: BackupConfig, log: (msg: string) => void, fetchFn: Fetch = fetch) {
    this.db = db;
    this.path = path;
    this.cfg = cfg;
    this.log = log;
    this.fetchFn = fetchFn;
  }

  start(everyMs = 60_000) {
    this.timer = setInterval(() => void this.runOnce(), everyMs);
    this.timer.unref();
  }

  status() {
    return { enabled: true, lastOkAt: this.lastOkAt, lastError: this.lastError };
  }

  /** Uploads a consistent snapshot if anything changed since the last one (or always with force). */
  runOnce(force = false): Promise<boolean> {
    if (this.inFlight) return Promise.resolve(false);
    this.inFlight = this.snapshot(force).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async snapshot(force: boolean): Promise<boolean> {
    const tmp = `${this.path}.snapshot`;
    try {
      const changes = (this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      if (!force && changes === this.lastChanges) return false;
      rmSync(tmp, { force: true });
      this.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const bytes = gzipSync(readFileSync(tmp), { level: 6 });
      await this.upload(this.cfg.object, bytes);
      const day = new Date().toISOString().slice(0, 10);
      if (day !== this.lastDaily) {
        // One dated copy per day, in case of a bad write. Never overwritten: after a restart the
        // first copy of the day may already exist, and it must keep that day's earliest good state.
        await this.upload(this.dailyName(day), bytes, { overwrite: false });
        this.lastDaily = day;
        await this.pruneDaily(day).catch((err: Error) => this.log(`backup: removing old daily copies failed: ${err.message}`));
      }
      this.lastChanges = changes;
      this.lastOkAt = Date.now();
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log(`backup failed: ${this.lastError}`);
      return false;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** Final copy before shutdown. Waits for a copy already in progress, then takes one that includes everything since. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
    await this.runOnce();
  }

  private dailyName(day: string) {
    return this.cfg.object.replace(/(\.db)?$/, `-${day}$1`);
  }

  /** Deletes dated copies older than KEEP_DAILY days, so the free storage doesn't fill up. */
  private async pruneDaily(today: string) {
    const stem = this.cfg.object.replace(/\.db$/, '');
    const res = await this.fetchFn(`${this.cfg.url}/storage/v1/object/list/${encodeURIComponent(this.cfg.bucket)}`, {
      method: 'POST',
      headers: { ...headers(this.cfg), 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: '', search: `${stem}-`, limit: 1000 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`);
    const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - KEEP_DAILY * 86_400_000).toISOString().slice(0, 10);
    const old = ((await res.json()) as { name?: string }[])
      .map((o) => String(o.name ?? ''))
      .filter((name) => {
        const m = name.match(/-(\d{4}-\d{2}-\d{2})(\.db)?$/);
        return name.startsWith(`${stem}-`) && m && m[1] < cutoff;
      });
    if (!old.length) return;
    const del = await this.fetchFn(`${this.cfg.url}/storage/v1/object/${encodeURIComponent(this.cfg.bucket)}`, {
      method: 'DELETE',
      headers: { ...headers(this.cfg), 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: old }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!del.ok) throw new Error(`delete failed: HTTP ${del.status}`);
    this.log(`backup: removed ${old.length} daily cop${old.length === 1 ? 'y' : 'ies'} older than ${KEEP_DAILY} days`);
  }

  private async upload(name: string, bytes: Buffer, { overwrite = true } = {}) {
    const res = await this.fetchFn(objectUrl(this.cfg, name), {
      method: 'POST',
      headers: { ...headers(this.cfg), 'content-type': 'application/octet-stream', 'x-upsert': String(overwrite) },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(30_000),
    });
    // Storage answers 409 (or 400 "Duplicate") when a create-only upload already exists.
    if (!overwrite && (res.status === 409 || res.status === 400)) {
      const text = await res.text();
      if (res.status === 409 || /duplicate|already exists/i.test(text)) return;
      throw new Error(`upload ${name} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`upload ${name} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
