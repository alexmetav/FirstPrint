import { randomUUID } from 'node:crypto';
import { headers, objectUrl, type BackupConfig } from './backup.ts';

/**
 * Hands the database over safely when a new version is deployed.
 *
 * On a host without a persistent disk, a deploy starts the new server from the latest backup while
 * the old one is still answering players. Anything the old server saved after that copy (a
 * prediction, a sign-up, a skipped listing) would be lost. So the two servers agree through two
 * small files next to the backup:
 *
 *   - the lease: the running server writes `{ id, beat }` every 20 seconds while it serves;
 *   - the hand-over request: a new server that finds a live lease writes `{ to: <its id>, at }`.
 *
 * The old server sees the request within seconds, stops taking changes (players see "updating"
 * for about a minute), waits for on-chain work, takes a last copy and marks the lease released.
 * Only then does the new server download the copy, so it starts with everything. The old server
 * never uploads again, so it can't overwrite the new server's data on its way out.
 *
 * A server waking up after sleeping finds an old lease and starts at once. If the old server never
 * answers, the new one starts anyway after two minutes; if the new one never takes over, the old
 * one goes back to normal after ten.
 */
export interface Lease {
  id: string;
  beat: number;
  released?: boolean;
}

type Fetch = typeof fetch;

/** A lease without a heartbeat for this long belongs to a server that has stopped (or is asleep). */
export const LEASE_STALE_MS = 75_000;
const BEAT_MS = 20_000;
const WATCH_MS = 5_000;
/** Failed lease updates or hand-over checks in a row before it is logged (and shown in Admin → Errors). */
const FAILS_BEFORE_LOG = 2;
const CLAIM_POLL_MS = 3_000;
/** How long a new server waits for the old one to hand over. */
export const CLAIM_WAIT_MS = 120_000;
/** How long an old server that handed over waits for the new one before going back to normal. */
export const TAKEOVER_WAIT_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DeployHandoff {
  readonly id = randomUUID();
  private cfg: BackupConfig;
  private log: (msg: string) => void;
  private fetchFn: Fetch;
  private now: () => number;
  private wait: (ms: number) => Promise<void>;
  private startedAt = 0;
  private beatTimer: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  /** True once this server has handed over (it must not save or upload anything after that). */
  handedOver = false;

  private beatMs: number;
  private watchMs: number;

  constructor(
    cfg: BackupConfig,
    log: (msg: string) => void,
    opts: { fetchFn?: Fetch; now?: () => number; wait?: (ms: number) => Promise<void>; beatMs?: number; watchMs?: number } = {},
  ) {
    this.cfg = cfg;
    this.log = log;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.wait = opts.wait ?? sleep;
    this.beatMs = opts.beatMs ?? BEAT_MS;
    this.watchMs = opts.watchMs ?? WATCH_MS;
  }

  private name(kind: 'lease' | 'handoff') {
    return `${this.cfg.object}.${kind}.json`;
  }

  private async read<T>(kind: 'lease' | 'handoff'): Promise<T | null> {
    const res = await this.fetchFn(objectUrl(this.cfg, this.name(kind), true), { headers: headers(this.cfg), signal: AbortSignal.timeout(15_000) });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`reading the ${kind} failed: HTTP ${res.status}`);
    try {
      return JSON.parse(await res.text()) as T;
    } catch {
      return null;
    }
  }

  private async write(kind: 'lease' | 'handoff', value: unknown) {
    const res = await this.fetchFn(objectUrl(this.cfg, this.name(kind)), {
      method: 'POST',
      headers: { ...headers(this.cfg), 'content-type': 'application/json', 'x-upsert': 'true' },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`writing the ${kind} failed: HTTP ${res.status}`);
  }

  private live(l: Lease | null) {
    return Boolean(l && !l.released && this.now() - l.beat < LEASE_STALE_MS);
  }

  /**
   * Before restoring the backup: if another server is still running, asks it to hand over and waits
   * until it has taken its last copy. Never throws: at worst it starts from the latest copy, as before.
   */
  async claim(): Promise<'free' | 'handed-over' | 'timeout'> {
    try {
      const lease = await this.read<Lease>('lease');
      if (!this.live(lease) || lease!.id === this.id) return 'free';
      await this.write('handoff', { to: this.id, at: this.now() });
      this.log('deploy: a running server was found; asking it to save and hand over');
      const deadline = this.now() + CLAIM_WAIT_MS;
      while (this.now() < deadline) {
        await this.wait(CLAIM_POLL_MS);
        const l = await this.read<Lease>('lease').catch(() => lease);
        if (!l || l.id !== lease!.id || !this.live(l)) {
          this.log('deploy: the previous server handed over');
          return 'handed-over';
        }
      }
      this.log('deploy: the previous server did not hand over in time; starting from the latest copy');
      return 'timeout';
    } catch (err) {
      this.log(`deploy: hand-over check failed (${(err as Error).message}); starting from the latest copy`);
      return 'free';
    }
  }

  /**
   * Once serving: keeps the lease alive and watches for a newer server asking to take over. Then
   * `onHandover` runs once (stop changes, take the last copy); its result releases the lease.
   */
  start(onHandover: () => Promise<void>) {
    this.startedAt = this.now();
    const beat = () => this.beat();
    void beat();
    this.beatTimer = setInterval(() => void beat(), this.beatMs);
    this.beatTimer.unref();
    let busy = false;
    this.watchTimer = setInterval(async () => {
      if (busy || this.handedOver) return;
      busy = true;
      try {
        const h = await this.read<{ to: string; at: number }>('handoff');
        if (h && h.to !== this.id && h.at >= this.startedAt) await this.handOver(h.to, onHandover);
        this.watchFails = 0;
      } catch (err) {
        // Checked every few seconds, so one slow answer from storage is simply retried; only a run of them is a problem.
        if (++this.watchFails === FAILS_BEFORE_LOG) this.log(`deploy: hand-over check failed ${FAILS_BEFORE_LOG} times in a row: ${(err as Error).message}`);
      } finally {
        busy = false;
      }
    }, this.watchMs);
    this.watchTimer.unref();
  }

  private async handOver(to: string, onHandover: () => Promise<void>) {
    this.handedOver = true;
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = null;
    this.log('deploy: a new server is starting; saving and handing over');
    await onHandover();
    await this.write('lease', { id: this.id, beat: this.now(), released: true } satisfies Lease);
    this.log('deploy: handed over');
    // The new server writes its own lease once it serves. If it never does (its deploy failed), take
    // back over so players aren't left unable to play.
    const deadline = this.now() + TAKEOVER_WAIT_MS;
    while (this.now() < deadline) {
      await this.wait(10_000);
      const l = await this.read<Lease>('lease').catch(() => null);
      if (l && l.id === to) return;
    }
    this.log('deploy: the new server never took over; carrying on here');
    this.handedOver = false;
    this.onResume?.();
    this.startedAt = this.now();
    void this.write('lease', { id: this.id, beat: this.now() } satisfies Lease).catch(() => {});
    this.beatTimer = setInterval(() => void this.beat(), this.beatMs);
    this.beatTimer.unref();
  }

  /**
   * Keeps the lease fresh. The lease only goes stale after several missed beats, so a single
   * failed update (a slow answer from storage) is retried quietly; a run of them is reported.
   */
  private async beat() {
    try {
      await this.write('lease', { id: this.id, beat: this.now() } satisfies Lease);
      this.beatFails = 0;
    } catch (err) {
      if (++this.beatFails === FAILS_BEFORE_LOG) this.log(`deploy: lease update failed ${FAILS_BEFORE_LOG} times in a row: ${(err as Error).message}`);
    }
  }
  private beatFails = 0;
  private watchFails = 0;

  /** Called when an abandoned hand-over is undone (re-enable changes and backups). */
  onResume: (() => void) | null = null;

  stop() {
    if (this.beatTimer) clearInterval(this.beatTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.beatTimer = this.watchTimer = null;
  }
}
