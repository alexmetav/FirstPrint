/**
 * Rewards outside predictions: the welcome bonus, tasks (follow, repost, share on X...), referrals,
 * and claiming them to a wallet as TestFPT.
 *
 * With TestFPT set up, rewards wait until the player claims them: the claim mints that many TestFPT
 * to their wallet (they sign and pay the network fee in test SOL) and, once confirmed on chain, adds
 * the points to their balance. Without TestFPT, rewards go straight to the balance.
 *
 * X has no free API for checking follows or reposts, so tasks are honour-based: the player links
 * their X username (one account per username), opens the task, and confirms it after a short wait.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { address, type Address, type KeyPairSigner, type Signature } from '@solana/kit';
import { AppError, type FirstprintService } from './firstprint.ts';
import { tx } from '../db/db.ts';
import { isSolanaAddress } from '../solana/base58.ts';
import {
  buildClaimTransaction,
  checkSignedClaim,
  createTestFptMint,
  explorerAddress,
  explorerTx,
  newAuthoritySecret,
  signerFromSecret,
  transactionId,
  type Chain,
  type Cluster,
} from '../solana/testfpt.ts';

export const X_CONNECT_POINTS = 100;
export const REFERRAL_POINTS = 200;
/** Most referral rewards one player can earn. */
export const REFERRAL_LIMIT = 25;
/** How long a task must have been open before it can be confirmed. */
export const TASK_MIN_WAIT_MS = 8_000;
/** How long a prepared claim waits for the wallet before it lapses (a blockhash lives about a minute). */
export const CLAIM_PENDING_MS = 3 * 60_000;
export const FAUCET_URL = 'https://faucet.solana.com';

export type TaskKind = 'follow' | 'repost' | 'like' | 'share' | 'link';
export interface TaskInput {
  kind: TaskKind;
  title?: string;
  target: string;
  points: number;
  maxCompletions?: number | null;
  active?: boolean;
}

interface TaskRow {
  id: string;
  kind: TaskKind;
  title: string;
  target: string;
  points: number;
  max_completions: number | null;
  active: number;
  created_at: number;
}

interface ClaimRow {
  id: string;
  user_id: string;
  wallet: string;
  amount: number;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed' | 'expired';
  message: string;
  last_valid_height: number;
  signature: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface TokenOptions {
  cluster: Cluster;
  chain: Chain;
  /** Mint authority from the environment (overrides the stored one). */
  authoritySecret?: string | null;
  /** Mint address from the environment (overrides the stored one). */
  mint?: string | null;
}

const as = <T>(v: unknown) => v as T;
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RewardsService {
  private service: FirstprintService;
  private token: TokenOptions | null;
  private siteUrl: string;
  private authority: KeyPairSigner | null = null;
  private mint: Address | null = null;
  /** How long submitClaim waits for confirmation before answering "still confirming". */
  confirmWaitMs = 20_000;

  constructor(service: FirstprintService, token: TokenOptions | null, siteUrl = 'https://www.firstprint.fun') {
    this.service = service;
    this.token = token;
    this.siteUrl = siteUrl.replace(/\/+$/, '');
    service.rewardsOnChain = () => this.ready();
    service.onPredicted = (userId) => this.onPredicted(userId);
  }

  private get db() {
    return this.service.db;
  }
  private now() {
    return this.service.clock.now();
  }

  // --- TestFPT setup ------------------------------------------------------------

  /** Loads the mint authority and mint from the environment or the database. */
  async init() {
    if (!this.token) return;
    const secret = this.token.authoritySecret || this.setting('testfpt.authority');
    if (secret) this.authority = await signerFromSecret(secret);
    const mint = this.token.mint || this.setting('testfpt.mint');
    if (mint && isSolanaAddress(mint)) this.mint = address(mint);
  }

  cluster() {
    return this.token?.cluster ?? null;
  }

  /** True when claims mint TestFPT. */
  ready() {
    return Boolean(this.token && this.authority && this.mint);
  }

  private setting(key: string): string | null {
    return as<{ value: string } | undefined>(this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key))?.value ?? null;
  }
  private saveSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private requireToken() {
    if (!this.token) throw new AppError(503, 'token_off', 'TestFPT is not enabled on this server.');
    return this.token;
  }

  async tokenStatus() {
    const token = this.token;
    if (!token) return { enabled: false as const };
    let balance: number | null = null;
    let balanceError: string | null = null;
    if (this.authority) {
      try {
        balance = Number(await token.chain.balance(this.authority.address)) / 1e9;
      } catch (err) {
        balanceError = `Couldn't read the balance from Solana ${token.cluster}: ${(err as Error).message.slice(0, 160)}`;
      }
    }
    return {
      enabled: true as const,
      ready: this.ready(),
      cluster: token.cluster,
      authority: this.authority?.address ?? null,
      authoritySol: balance,
      // Without these in the environment, the key and mint live only in the database, which a host
      // without a disk or backups wipes on restart. The admin copies them into the host's settings.
      savedInEnv: { authority: Boolean(token.authoritySecret), mint: Boolean(token.mint) },
      authorityKey: this.authority && !token.authoritySecret ? this.setting('testfpt.authority') : null,
      balanceError,
      authorityUrl: this.authority ? explorerAddress(this.authority.address, token.cluster) : null,
      mint: this.mint,
      mintUrl: this.mint ? explorerAddress(this.mint, token.cluster) : null,
      faucetUrl: FAUCET_URL,
    };
  }

  /** Makes the server's mint authority key (once). It needs test SOL before it can create the token. */
  async setupAuthority() {
    this.requireToken();
    if (!this.authority) {
      const secret = await newAuthoritySecret();
      this.saveSetting('testfpt.authority', secret);
      this.authority = await signerFromSecret(secret);
    }
    return this.tokenStatus();
  }

  /** Asks the test network's faucet for 1 SOL for the mint authority. Often rate-limited; the web faucet is the fallback. */
  async airdropAuthority() {
    const token = this.requireToken();
    if (!this.authority) throw new AppError(409, 'no_authority', 'Create the mint authority first.');
    try {
      await token.chain.airdrop(this.authority.address, 1_000_000_000n);
    } catch (err) {
      throw new AppError(502, 'airdrop_failed', `The faucet refused (${(err as Error).message.slice(0, 120)}). Use ${FAUCET_URL} instead.`);
    }
    return this.tokenStatus();
  }

  /** Creates the TestFPT mint on chain, paid by the mint authority. */
  async createMint() {
    const token = this.requireToken();
    if (!this.authority) throw new AppError(409, 'no_authority', 'Create the mint authority first.');
    if (this.mint) throw new AppError(409, 'mint_exists', 'TestFPT already exists.');
    let mint: Address;
    try {
      mint = await createTestFptMint(token.chain, this.authority);
    } catch (err) {
      throw new AppError(
        502,
        'mint_failed',
        `Creating TestFPT failed: ${(err as Error).message.slice(0, 200)}. Check that the authority address has test SOL on ${token.cluster} (the faucet's network menu must say ${token.cluster === 'devnet' ? 'Devnet' : 'Testnet'}).`,
      );
    }
    this.saveSetting('testfpt.mint', mint);
    this.mint = mint;
    this.service.log(`TestFPT created: ${mint}`);
    return this.tokenStatus();
  }

  // --- Rewards ----------------------------------------------------------------------

  /**
   * Gives a reward once per (user, kind, ref). With TestFPT it waits to be claimed; without it the
   * points go straight to the balance. Call inside a transaction. Returns false if already given.
   */
  private award(userId: string, kind: string, ref: string, amount: number): boolean {
    const direct = !this.ready();
    const res = this.db
      .prepare('INSERT OR IGNORE INTO rewards (user_id, kind, ref, amount, created_at, claim_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, kind, ref, amount, this.now(), direct ? 'direct' : null);
    if (res.changes !== 1) return false;
    if (direct) this.service.addPoints(userId, amount, kind, ref);
    return true;
  }

  private referralCode(userId: string): string {
    const row = as<{ referral_code: string | null }>(this.db.prepare('SELECT referral_code FROM users WHERE id = ?').get(userId));
    if (row.referral_code) return row.referral_code;
    for (;;) {
      const code = Array.from({ length: 8 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('');
      const res = this.db.prepare('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE referral_code = ?)').run(code, userId, code);
      if (res.changes === 1) return code;
      const again = as<{ referral_code: string | null }>(this.db.prepare('SELECT referral_code FROM users WHERE id = ?').get(userId));
      if (again.referral_code) return again.referral_code;
    }
  }

  /** A referred player's first prediction earns their referrer a reward, up to the limit. */
  private onPredicted(userId: string) {
    const u = as<{ referred_by: string | null }>(this.db.prepare('SELECT referred_by FROM users WHERE id = ?').get(userId));
    if (!u?.referred_by) return;
    const count = as<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM predictions WHERE user_id = ?').get(userId)).n;
    if (count !== 1) return;
    const given = as<{ n: number }>(this.db.prepare("SELECT COUNT(*) AS n FROM rewards WHERE user_id = ? AND kind = 'referral'").get(u.referred_by)).n;
    if (given >= REFERRAL_LIMIT) return;
    this.award(u.referred_by, 'referral', userId, REFERRAL_POINTS);
  }

  /** Everything the Earn page shows. */
  summary(userId: string) {
    this.expireStaleClaims(userId);
    const user = as<{ x_username: string | null; referred_by: string | null }>(this.db.prepare('SELECT x_username, referred_by FROM users WHERE id = ?').get(userId));
    const code = this.referralCode(userId);
    const rewards = as<{ kind: string; ref: string | null; amount: number; created_at: number; claim_id: string | null }[]>(
      this.db.prepare('SELECT kind, ref, amount, created_at, claim_id FROM rewards WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId),
    );
    const claimable = as<{ n: number | null }>(this.db.prepare('SELECT SUM(amount) AS n FROM rewards WHERE user_id = ? AND claim_id IS NULL').get(userId)).n ?? 0;
    const referrals = as<{ n: number; pts: number | null }>(
      this.db.prepare("SELECT COUNT(*) AS n, SUM(amount) AS pts FROM rewards WHERE user_id = ? AND kind = 'referral'").get(userId),
    );
    const invited = as<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?').get(userId)).n;
    const claims = as<ClaimRow[]>(this.db.prepare('SELECT * FROM claims WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(userId));
    const welcome = as<{ claim_id: string | null } | undefined>(this.db.prepare("SELECT claim_id FROM rewards WHERE user_id = ? AND kind = 'welcome'").get(userId));
    const link = `${this.siteUrl}/?ref=${code}`;
    return {
      onChain: this.ready(),
      cluster: this.token?.cluster ?? null,
      mint: this.mint,
      mintUrl: this.mint && this.token ? explorerAddress(this.mint, this.token.cluster) : null,
      faucetUrl: FAUCET_URL,
      claimable,
      welcomeClaimed: welcome ? welcome.claim_id !== null && this.isClaimed(welcome.claim_id) : true,
      xUsername: user.x_username,
      xConnectPoints: X_CONNECT_POINTS,
      referral: { code, link, invited, rewarded: referrals.n, points: referrals.pts ?? 0, limit: REFERRAL_LIMIT, perReferral: REFERRAL_POINTS },
      rewards: rewards.map((r) => ({ kind: r.kind, ref: r.ref, amount: r.amount, at: r.created_at, claimed: r.claim_id !== null && this.isClaimed(r.claim_id) })),
      claims: claims.map((c) => this.publicClaim(c)),
      tasks: this.tasksFor(userId, code),
    };
  }

  private isClaimed(claimId: string) {
    if (claimId === 'direct') return true;
    const c = as<{ status: string } | undefined>(this.db.prepare('SELECT status FROM claims WHERE id = ?').get(claimId));
    return c?.status === 'confirmed';
  }

  private publicClaim(c: ClaimRow) {
    return {
      id: c.id,
      wallet: c.wallet,
      amount: c.amount,
      status: c.status,
      signature: c.signature,
      explorerUrl: c.signature && this.token ? explorerTx(c.signature, this.token.cluster) : null,
      error: c.error,
      at: c.created_at,
    };
  }

  // --- X username ----------------------------------------------------------------------

  /** Links an X username (one account per username) and rewards the first link. */
  connectX(userId: string, input: string) {
    const name = String(input ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/[/?#].*$/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) throw new AppError(400, 'bad_x_username', 'Enter your X username, like @firstprint (letters, numbers and _ only).');
    return tx(this.db, () => {
      const taken = as<{ id: string } | undefined>(this.db.prepare('SELECT id FROM users WHERE x_username = ? COLLATE NOCASE AND id != ?').get(name, userId));
      if (taken) throw new AppError(409, 'x_taken', 'That X account is already linked to another Firstprint account.');
      this.db.prepare('UPDATE users SET x_username = ? WHERE id = ?').run(name, userId);
      const rewarded = this.award(userId, 'x_connect', 'x', X_CONNECT_POINTS);
      return { xUsername: name, rewarded: rewarded ? X_CONNECT_POINTS : 0 };
    });
  }

  // --- Tasks ------------------------------------------------------------------------

  private taskUrl(t: TaskRow, code: string) {
    switch (t.kind) {
      case 'follow':
        return `https://x.com/intent/follow?screen_name=${encodeURIComponent(t.target)}`;
      case 'repost':
        return `https://x.com/intent/retweet?tweet_id=${encodeURIComponent(t.target)}`;
      case 'like':
        return `https://x.com/intent/like?tweet_id=${encodeURIComponent(t.target)}`;
      case 'share':
        return `https://x.com/intent/tweet?text=${encodeURIComponent(t.target)}&url=${encodeURIComponent(`${this.siteUrl}/?ref=${code}`)}`;
      default:
        return t.target;
    }
  }

  private completions(taskId: string) {
    return as<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ? AND completed_at IS NOT NULL').get(taskId)).n;
  }

  private tasksFor(userId: string, code: string) {
    const tasks = as<TaskRow[]>(this.db.prepare('SELECT * FROM tasks WHERE active = 1 ORDER BY created_at').all());
    return tasks.map((t) => {
      const mine = as<{ started_at: number; completed_at: number | null } | undefined>(
        this.db.prepare('SELECT started_at, completed_at FROM task_completions WHERE task_id = ? AND user_id = ?').get(t.id, userId),
      );
      const done = this.completions(t.id);
      return {
        id: t.id,
        kind: t.kind,
        title: t.title,
        points: t.points,
        url: this.taskUrl(t, code),
        done: Boolean(mine?.completed_at),
        startedAt: mine?.started_at ?? null,
        remaining: t.max_completions === null ? null : Math.max(0, t.max_completions - done),
      };
    });
  }

  private activeTask(taskId: string) {
    const t = as<TaskRow | undefined>(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
    if (!t || !t.active) throw new AppError(404, 'task_not_found', 'This task is no longer available.');
    return t;
  }

  /** Records that the player opened the task (the wait before confirming starts now). */
  startTask(userId: string, taskId: string) {
    this.activeTask(taskId);
    this.db
      .prepare('INSERT INTO task_completions (task_id, user_id, started_at) VALUES (?, ?, ?) ON CONFLICT(task_id, user_id) DO NOTHING')
      .run(taskId, userId, this.now());
    return { ok: true };
  }

  /** Confirms a task. Needs a linked X username for X tasks, and the task open for a few seconds. */
  verifyTask(userId: string, taskId: string) {
    return tx(this.db, () => {
      const t = this.activeTask(taskId);
      const user = as<{ x_username: string | null }>(this.db.prepare('SELECT x_username FROM users WHERE id = ?').get(userId));
      if (t.kind !== 'link' && !user.x_username) throw new AppError(409, 'x_required', 'Link your X username first, so we know which account did it.');
      const mine = as<{ started_at: number; completed_at: number | null } | undefined>(
        this.db.prepare('SELECT started_at, completed_at FROM task_completions WHERE task_id = ? AND user_id = ?').get(taskId, userId),
      );
      if (mine?.completed_at) throw new AppError(409, 'task_done', 'You already completed this task.');
      if (!mine) throw new AppError(409, 'task_not_started', 'Open the task first, then come back to confirm it.');
      if (this.now() - mine.started_at < TASK_MIN_WAIT_MS) throw new AppError(429, 'task_too_fast', 'Give it a few seconds: finish the task on X, then confirm.');
      if (t.max_completions !== null && this.completions(taskId) >= t.max_completions) throw new AppError(409, 'task_full', 'This task has reached its limit.');
      this.db.prepare('UPDATE task_completions SET completed_at = ?, x_username = ? WHERE task_id = ? AND user_id = ?').run(this.now(), user.x_username, taskId, userId);
      this.award(userId, 'task', taskId, t.points);
      return { points: t.points, onChain: this.ready() };
    });
  }

  // --- Admin: tasks --------------------------------------------------------------------

  private cleanTask(input: Partial<TaskInput>, kind: TaskKind) {
    const out: { title?: string; target?: string; points?: number; max?: number | null; active?: number } = {};
    if (input.target !== undefined) {
      let target = String(input.target).trim();
      if (kind === 'follow') {
        target = target.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/[/?#].*$/, '');
        if (!/^[A-Za-z0-9_]{1,15}$/.test(target)) throw new AppError(400, 'bad_target', 'Enter the X handle to follow, like @firstprint.');
      } else if (kind === 'repost' || kind === 'like') {
        const m = /(?:status(?:es)?\/)?(\d{5,25})(?:[/?#].*)?$/.exec(target);
        if (!m) throw new AppError(400, 'bad_target', 'Paste the link to the post on X.');
        target = m[1];
      } else if (kind === 'share') {
        if (target.length < 3 || target.length > 240) throw new AppError(400, 'bad_target', 'The post text must be 3–240 characters.');
      } else if (!/^https:\/\/[^\s"'<>]+$/.test(target)) {
        throw new AppError(400, 'bad_target', 'Enter a link starting with https://');
      }
      out.target = target;
    }
    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (title.length > 80) throw new AppError(400, 'bad_title', 'Keep the title under 80 characters.');
      out.title = title;
    }
    if (input.points !== undefined) {
      const p = Math.floor(Number(input.points));
      if (!(p >= 1 && p <= 10_000)) throw new AppError(400, 'bad_points', 'Points must be between 1 and 10,000.');
      out.points = p;
    }
    if (input.maxCompletions !== undefined) {
      const v = input.maxCompletions === null || String(input.maxCompletions) === '' ? null : Math.floor(Number(input.maxCompletions));
      if (v !== null && !(v >= 1)) throw new AppError(400, 'bad_limit', 'The limit must be at least 1, or empty for no limit.');
      out.max = v;
    }
    if (input.active !== undefined) out.active = input.active ? 1 : 0;
    return out;
  }

  private defaultTitle(kind: TaskKind, target: string) {
    return { follow: `Follow @${target} on X`, repost: 'Repost our post on X', like: 'Like our post on X', share: 'Share Firstprint on X', link: 'Visit the link' }[kind];
  }

  createTask(input: TaskInput) {
    const kind = input.kind;
    if (!['follow', 'repost', 'like', 'share', 'link'].includes(kind)) throw new AppError(400, 'bad_kind', 'Choose a task type.');
    const c = this.cleanTask({ ...input, maxCompletions: input.maxCompletions ?? null }, kind);
    if (!c.target) throw new AppError(400, 'bad_target', 'Fill in what the task points to.');
    if (c.points === undefined) throw new AppError(400, 'bad_points', 'Set how many points the task gives.');
    const id = `task-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare('INSERT INTO tasks (id, kind, title, target, points, max_completions, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, kind, c.title || this.defaultTitle(kind, c.target), c.target, c.points, c.max ?? null, c.active ?? 1, this.now());
    return id;
  }

  updateTask(id: string, patch: Partial<TaskInput>) {
    const t = as<TaskRow | undefined>(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    if (!t) throw new AppError(404, 'task_not_found', 'Task not found.');
    const c = this.cleanTask(patch, t.kind);
    this.db
      .prepare('UPDATE tasks SET title = ?, target = ?, points = ?, max_completions = ?, active = ? WHERE id = ?')
      .run(c.title || t.title, c.target ?? t.target, c.points ?? t.points, c.max === undefined ? t.max_completions : c.max, c.active ?? t.active, id);
  }

  listTasksAdmin() {
    const rows = as<TaskRow[]>(this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all());
    return rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      target: t.target,
      points: t.points,
      maxCompletions: t.max_completions,
      active: t.active === 1,
      completions: this.completions(t.id),
      url: this.taskUrl(t, 'ADMIN'),
    }));
  }

  // --- Claims -----------------------------------------------------------------------------

  private expireStaleClaims(userId: string) {
    const stale = as<{ id: string }[]>(
      this.db.prepare("SELECT id FROM claims WHERE user_id = ? AND status = 'pending' AND created_at < ?").all(userId, this.now() - CLAIM_PENDING_MS),
    );
    for (const c of stale) this.closeClaim(c.id, 'expired', 'The wallet did not sign in time.');
  }

  /** Ends a claim that did not happen and makes its rewards claimable again. */
  private closeClaim(id: string, status: 'failed' | 'expired', error: string) {
    tx(this.db, () => {
      const res = this.db
        .prepare("UPDATE claims SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'submitted')")
        .run(status, error, this.now(), id);
      if (res.changes === 1) this.db.prepare('UPDATE rewards SET claim_id = NULL WHERE claim_id = ?').run(id);
    });
  }

  private ownClaim(userId: string, id: string) {
    const c = as<ClaimRow | undefined>(this.db.prepare('SELECT * FROM claims WHERE id = ? AND user_id = ?').get(id, userId));
    if (!c) throw new AppError(404, 'claim_not_found', 'Claim not found.');
    return c;
  }

  /** Prepares a claim of every unclaimed reward to one of the player's wallets. */
  async startClaim(userId: string, walletInput: string) {
    const token = this.token;
    if (!token || !this.ready() || !this.authority || !this.mint) throw new AppError(409, 'token_off', 'TestFPT claims are not switched on yet.');
    const wallet = String(walletInput ?? '');
    if (!this.service.walletsFor(userId).some((w) => w.address === wallet)) {
      throw new AppError(400, 'wallet_not_linked', 'Claim to a wallet linked to your account. Link one on your dashboard first.');
    }
    this.expireStaleClaims(userId);
    const busy = as<ClaimRow | undefined>(this.db.prepare("SELECT * FROM claims WHERE user_id = ? AND status = 'submitted'").get(userId));
    if (busy) {
      const now = await this.refreshClaim(userId, busy.id);
      if (now.status === 'submitted') throw new AppError(409, 'claim_in_progress', 'Your last claim is still being confirmed. Try again in a minute.');
    }
    for (const p of as<{ id: string }[]>(this.db.prepare("SELECT id FROM claims WHERE user_id = ? AND status = 'pending'").all(userId))) {
      this.closeClaim(p.id, 'expired', 'Replaced by a new claim.');
    }
    const rows = as<{ id: number; amount: number }[]>(this.db.prepare('SELECT id, amount FROM rewards WHERE user_id = ? AND claim_id IS NULL').all(userId));
    const amount = rows.reduce((s, r) => s + r.amount, 0);
    if (!amount) throw new AppError(400, 'nothing_to_claim', 'Nothing to claim yet. Complete a task or invite a friend to earn more.');

    let built;
    try {
      built = await buildClaimTransaction(token.chain, this.authority, this.mint, address(wallet), BigInt(amount));
    } catch (err) {
      throw new AppError(502, 'chain_unavailable', `The Solana ${token.cluster} network did not answer. Try again in a moment. (${(err as Error).message.slice(0, 120)})`);
    }
    const id = randomUUID();
    tx(this.db, () => {
      const reserve = this.db.prepare('UPDATE rewards SET claim_id = ? WHERE id = ? AND claim_id IS NULL');
      let reserved = 0;
      for (const r of rows) reserved += Number(reserve.run(id, r.id).changes);
      if (reserved !== rows.length) throw new AppError(409, 'claim_conflict', 'Your rewards changed while preparing the claim. Try again.');
      this.db
        .prepare(
          `INSERT INTO claims (id, user_id, wallet, amount, status, message, last_valid_height, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(id, userId, wallet, amount, built.message, Number(built.lastValidBlockHeight), this.now(), this.now());
    });
    return { claimId: id, amount, wallet, cluster: token.cluster, transaction: built.transaction };
  }

  /** Takes the transaction the wallet signed, checks it, sends it and waits a little for confirmation. */
  async submitClaim(userId: string, id: string, signed: string) {
    const token = this.token;
    if (!token || !this.authority) throw new AppError(409, 'token_off', 'TestFPT claims are not switched on.');
    const c = this.ownClaim(userId, id);
    if (c.status !== 'pending') throw new AppError(409, 'claim_closed', `This claim is ${c.status}. Start a new one.`);
    let wire;
    try {
      wire = checkSignedClaim(String(signed ?? ''), c.message, c.wallet, this.authority.address);
    } catch (err) {
      throw new AppError(400, 'bad_signed_claim', (err as Error).message);
    }
    const signature = transactionId(wire);
    // Record the signature before sending, so a crash after sending can still be reconciled.
    this.db.prepare("UPDATE claims SET status = 'submitted', signature = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(signature, this.now(), id);
    try {
      await token.chain.send(wire);
    } catch (err) {
      const msg = (err as Error).message;
      const reason = /insufficient|no record of a prior credit|0x1\b/i.test(msg)
        ? 'Your wallet needs a little test SOL to pay the network fee. Get some from the faucet, then claim again.'
        : `The network rejected the claim: ${msg.slice(0, 160)}`;
      this.closeClaim(id, 'failed', reason);
      throw new AppError(400, 'claim_rejected', reason);
    }
    const until = Date.now() + this.confirmWaitMs;
    let current = await this.refreshClaim(userId, id);
    while (current.status === 'submitted' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1_500));
      current = await this.refreshClaim(userId, id);
    }
    return current;
  }

  /** Checks a sent claim on chain; credits the points once it is confirmed. */
  async refreshClaim(userId: string, id: string) {
    const token = this.token;
    const c = this.ownClaim(userId, id);
    if (c.status === 'pending') this.expireStaleClaims(userId);
    if (c.status !== 'submitted' || !token || !c.signature) return this.publicClaim(this.ownClaim(userId, id));
    let status;
    try {
      status = await token.chain.status(c.signature as Signature);
    } catch {
      return this.publicClaim(c); // network hiccup: still submitted
    }
    if (status === 'confirmed') {
      tx(this.db, () => {
        const res = this.db.prepare("UPDATE claims SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'submitted'").run(this.now(), id);
        if (res.changes === 1) this.service.addPoints(c.user_id, c.amount, 'claim', id);
      });
    } else if (status === 'failed') {
      this.closeClaim(id, 'failed', 'The claim failed on chain. Your rewards are claimable again.');
    } else {
      try {
        if ((await token.chain.blockHeight()) > BigInt(c.last_valid_height)) {
          this.closeClaim(id, 'expired', 'The claim was not confirmed in time. Your rewards are claimable again.');
        }
      } catch {
        /* keep waiting */
      }
    }
    return this.publicClaim(this.ownClaim(userId, id));
  }
}
