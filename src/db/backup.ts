import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from './db.ts';

/**
 * Keeps the SQLite database alive on hosts without a persistent disk (for example
 * Render's free plan) by copying it to a private Supabase Storage bucket and
 * restoring it at start-up. Works with any project on Supabase's free plan.
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
  const bytes = Buffer.from(await res.arrayBuffer());
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
  private busy = false;
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
  async runOnce(force = false): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const tmp = `${this.path}.snapshot`;
    try {
      const changes = (this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      if (!force && changes === this.lastChanges) return false;
      rmSync(tmp, { force: true });
      this.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const bytes = readFileSync(tmp);
      await this.upload(this.cfg.object, bytes);
      const day = new Date().toISOString().slice(0, 10);
      if (day !== this.lastDaily) {
        await this.upload(this.cfg.object.replace(/(\.db)?$/, `-${day}$1`), bytes); // one dated copy per day, in case of a bad write
        this.lastDaily = day;
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
      this.busy = false;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.runOnce();
  }

  private async upload(name: string, bytes: Buffer) {
    const res = await this.fetchFn(objectUrl(this.cfg, name), {
      method: 'POST',
      headers: { ...headers(this.cfg), 'content-type': 'application/octet-stream', 'x-upsert': 'true' },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`upload ${name} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
