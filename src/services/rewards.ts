/**
 * Rewards outside predictions: the welcome bonus, tasks (follow, repost, share on X...), referrals,
 * and claiming them to a wallet as TestFPT.
 *
 * With TestFPT set up, rewards wait until the player claims them: the claim mints that many TestFPT
 * to their wallet (the server signs and pays the network fee) and, once confirmed on chain, adds
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
import { WalletVault } from '../solana/vault.ts';
import { XCheckUnavailable, type XChecker } from './xcheck.ts';
import { channelName } from './telegram.ts';
import {
  buildClaimTransaction,
  buildServerMint,
  buildServerTransfer,
  sendAndConfirm,
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
/** How many different markets a referred player predicts on before their referrer is rewarded. */
export const REFERRAL_MARKETS = 3;
/** Test points an admin can add to their own account: per top-up, and per day. */
export const ADMIN_TOPUP_MAX = 10_000;
const ADMIN_TOPUP_DAY = 50_000;
/** Checks on X a player may come back from empty-handed in a row before a wait (each one is a paid call). */
export const X_TRIES = 3;
/** The wait after X_TRIES checks that found nothing. */
export const X_COOLDOWN_MS = 5 * 60_000;
/** How long a task must have been open before it can be confirmed. */
export const TASK_MIN_WAIT_MS = 8_000;
/** How long a prepared claim waits for the wallet before it lapses (a blockhash lives about a minute). */
export const CLAIM_PENDING_MS = 3 * 60_000;
export const FAUCET_URL = 'https://faucet.solana.com';

export type TaskKind = 'follow' | 'repost' | 'like' | 'share' | 'link' | 'telegram';
/** Tasks done on X: they need the player's X account. */
const X_TASKS: readonly string[] = ['follow', 'repost', 'like', 'share'];

/** Checks on Telegram through our bot (the "join the channel" task). */
export interface TelegramChecker {
  /** The Telegram user ID that pressed Start in the bot with this code, or null. */
  startedBy(code: string): Promise<string | null>;
  /** True when the user is in the public channel (@name). */
  isMember(channel: string, userId: string): Promise<boolean>;
  /** Sends a private message (best effort). */
  sendTo(chat: string, html: string): Promise<void>;
}
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
  /** WALLET_ENCRYPTION_KEY: with it, players without a wallet get a Firstprint wallet. */
  walletKey?: string | null;
}

/** Below this the mint authority stops sending (it pays every fee and new token account). */
export const MIN_AUTHORITY_LAMPORTS = 10_000_000n;
/** A server mint is tried this many times before it is marked failed. */
const MAX_MINT_ATTEMPTS = 5;
export const EMBEDDED_WALLET_NAME = 'Firstprint wallet';

interface MintRow {
  id: string;
  user_id: string;
  wallet: string;
  kind: string;
  ref: string;
  amount: number;
  status: 'queued' | 'submitted' | 'confirmed' | 'failed';
  signature: string | null;
  last_valid_height: number | null;
  attempts: number;
  error: string | null;
  created_at: number;
  subject: string | null;
}

const as = <T>(v: unknown) => v as T;
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RewardsService {
  private service: FirstprintService;
  private token: TokenOptions | null;
  private siteUrl: string;
  private authority: KeyPairSigner | null = null;
  private mint: Address | null = null;
  private vault: WalletVault | null = null;
  /** The chain work in progress, so overlapping calls don't race; a call during a run gets one more run after it. */
  private chainRun: Promise<void> | null = null;
  /** False once the background run finds the mint authority out of test SOL (mints and auto-claims wait). */
  private funded = true;
  private chainNext: Promise<void> | null = null;
  /** How long submitClaim waits for confirmation before answering "still confirming". */
  confirmWaitMs = 20_000;
  /** Claims to a player's own wallet are signed and paid by the server (no wallet pop-up, no fee) while it has test SOL. */
  serverPaysClaims = true;
  /**
   * Checks on X (GetXAPI, when GETXAPI_KEY is set): players prove the X username is theirs, and
   * follow, repost and post tasks are checked before they pay. Without it both stay honour-based.
   */
  xcheck: XChecker | null = null;
  /** Our Telegram bot and its username, for the join-the-channel task; null without TELEGRAM_BOT_TOKEN. */
  tg: { checker: TelegramChecker; bot: string } | null = null;
  /** Per player: checks on X in a row that found nothing, and the end of the wait once there were too many. */
  private xFails = new Map<string, { n: number; until: number }>();

  constructor(service: FirstprintService, token: TokenOptions | null, siteUrl = 'https://www.firstprint.fun') {
    this.service = service;
    this.token = token;
    this.siteUrl = siteUrl.replace(/\/+$/, '');
    service.rewardsOnChain = () => this.ready();
    service.onPredicted = (userId) => this.onPredicted(userId);
    service.onDailyClaimed = (userId, day, amount) => this.queueMint(userId, 'daily', day, amount);
    service.onLedger = (userId, delta, reason, ref, ledgerId) => this.onLedger(userId, delta, reason, ref, ledgerId);
    if (token?.walletKey) this.vault = new WalletVault(token.walletKey);
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
    const secret = this.token.authoritySecret || this.storedAuthority();
    if (secret) this.authority = await signerFromSecret(secret);
    const mint = this.token.mint || this.setting('testfpt.mint');
    if (mint && isSolanaAddress(mint)) this.mint = address(mint);
  }

  cluster() {
    return this.token?.cluster ?? null;
  }

  /** True when claims mint TestFPT. */
  /** The token's public details for the analytics page: network and mint (no keys). */
  chainInfo() {
    if (!this.token) return null;
    return { cluster: this.token.cluster, mint: this.mint, mintUrl: this.mint ? explorerAddress(this.mint, this.token.cluster) : null };
  }

  ready() {
    return Boolean(this.token && this.authority && this.mint);
  }

  /**
   * The mint authority key kept in the database (when it isn't in the host's settings). It is sealed
   * with WALLET_ENCRYPTION_KEY, like the Firstprint wallet keys, so the database and its backups never
   * hold a usable key; one saved in plain text before this is sealed the first time it's read.
   */
  private storedAuthority(): string | null {
    const stored = this.setting('testfpt.authority');
    if (!stored) return null;
    if (stored.startsWith('v1.')) {
      if (!this.vault) {
        this.service.log('TestFPT: the saved mint authority key is sealed, but WALLET_ENCRYPTION_KEY is not set, so it cannot be used');
        return null;
      }
      try {
        return this.vault.open(stored);
      } catch {
        this.service.log('TestFPT: the saved mint authority key could not be opened (WALLET_ENCRYPTION_KEY changed?)');
        return null;
      }
    }
    if (this.vault) this.saveSetting('testfpt.authority', this.vault.seal(stored));
    return stored;
  }

  private saveAuthority(secret: string) {
    this.saveSetting('testfpt.authority', this.vault ? this.vault.seal(secret) : secret);
  }

  // --- Connect X reward ------------------------------------------------------------------
  // Paid once per round; an admin reset starts a new round (everyone links X again and can earn it
  // again) and can change the points.

  /** Points for linking (verifying) an X account in the current round. */
  xConnectPoints() {
    const n = Number(this.setting('x.connect.points'));
    return Number.isInteger(n) && n > 0 ? n : X_CONNECT_POINTS;
  }
  private xConnectRef() {
    const round = Number(this.setting('x.connect.round')) || 0;
    return round ? `x#${round}` : 'x';
  }
  xConnectAdmin() {
    const players = as<{ n: number }>(this.db.prepare("SELECT COUNT(*) AS n FROM rewards WHERE kind = 'x_connect' AND ref = ?").get(this.xConnectRef())).n;
    return { points: this.xConnectPoints(), round: Number(this.setting('x.connect.round')) || 0, players };
  }
  /**
   * Starts a new Connect X round: every account's X link is cleared, so players link (and verify)
   * again and earn the reward again. Points already given are kept.
   */
  resetXConnect(points: number) {
    const pts = Math.floor(Number(points));
    if (!(pts >= 1 && pts <= 10_000)) throw new AppError(400, 'bad_points', 'Choose between 1 and 10,000 points.');
    return tx(this.db, () => {
      const round = (Number(this.setting('x.connect.round')) || 0) + 1;
      this.saveSetting('x.connect.round', String(round));
      this.saveSetting('x.connect.points', String(pts));
      const cleared = this.db.prepare('UPDATE users SET x_username = NULL, x_verified = 0, x_pending = NULL, x_code = NULL WHERE x_username IS NOT NULL OR x_pending IS NOT NULL').run().changes;
      this.xFails.clear();
      this.service.log(`Connect X reset: round ${round}, ${pts} points, ${cleared} accounts unlinked`);
      return { ...this.xConnectAdmin(), cleared };
    });
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
      authorityKey: this.authority && !token.authoritySecret ? this.storedAuthority() : null,
      balanceError,
      authorityUrl: this.authority ? explorerAddress(this.authority.address, token.cluster) : null,
      mint: this.mint,
      mintUrl: this.mint ? explorerAddress(this.mint, token.cluster) : null,
      faucetUrl: FAUCET_URL,
      walletsOn: this.walletsOn(),
      lowFunds: balance !== null && balance * 1e9 < Number(MIN_AUTHORITY_LAMPORTS),
      chain: this.chainCounts(),
    };
  }

  /** Makes the server's mint authority key (once). It needs test SOL before it can create the token. */
  async setupAuthority() {
    this.requireToken();
    if (!this.authority) {
      const secret = await newAuthoritySecret();
      this.saveAuthority(secret);
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

  // --- Firstprint wallets and server-paid mints ----------------------------------------------

  /** True when players without a wallet get one made for them. */
  walletsOn() {
    return Boolean(this.vault);
  }

  embeddedAddress(userId: string): string | null {
    return as<{ address: string } | undefined>(this.db.prepare('SELECT address FROM embedded_wallets WHERE user_id = ?').get(userId))?.address ?? null;
  }

  /**
   * Gives a player with no wallet a Firstprint wallet (email and Google sign-ups). Its key is sealed
   * in the database; the server signs for it only where Firstprint needs to (none yet: minting needs
   * no owner signature). Returns the address, or null when the player already has a wallet.
   */
  async ensureWallet(userId: string): Promise<string | null> {
    if (!this.vault) return null;
    if (this.service.walletsFor(userId).length) return null;
    const secret = await newAuthoritySecret();
    const signer = await signerFromSecret(secret);
    const now = this.now();
    tx(this.db, () => {
      if (this.service.walletsFor(userId).length) return;
      this.db.prepare('INSERT INTO embedded_wallets (user_id, address, secret_sealed, created_at) VALUES (?, ?, ?, ?)').run(userId, signer.address, this.vault!.seal(secret), now);
      this.db.prepare('INSERT INTO wallets (address, user_id, wallet_name, verified_at) VALUES (?, ?, ?, ?)').run(signer.address, userId, EMBEDDED_WALLET_NAME, now);
    });
    this.service.log(`firstprint wallet made for ${userId}: ${signer.address}`);
    // Their welcome bonus goes to the new wallet straight away.
    void this.runChain().catch(() => {});
    return this.embeddedAddress(userId);
  }

  /** Where server mints go: the Firstprint wallet, or else the first wallet the player linked. */
  private payoutWallet(userId: string): string | null {
    return this.embeddedAddress(userId) ?? this.service.walletsFor(userId)[0]?.address ?? null;
  }

  /**
   * Where rewards are sent by themselves (no Claim button): the player's Firstprint wallet or the
   * first wallet they linked, while the server signs and pays for claims. Null when they must claim.
   */
  private autoSendWallet(userId: string): string | null {
    if (!this.ready() || !this.serverPaysClaims) return null;
    return this.payoutWallet(userId);
  }

  /**
   * Sends the player's unclaimed rewards to their wallet now (after a task, so the points land at
   * once). True once confirmed; false when it can't go now, and the background run retries.
   */
  private async sendRewardsNow(userId: string): Promise<boolean> {
    const wallet = this.autoSendWallet(userId);
    if (!wallet || !this.funded || this.paused()) return false;
    if (this.db.prepare("SELECT 1 FROM claims WHERE user_id = ? AND status IN ('pending', 'submitted')").get(userId)) return false;
    try {
      const id = await this.serverClaim(userId, wallet);
      if (!id) return false;
      return (await this.refreshClaim(userId, id)).status === 'confirmed';
    } catch {
      return false;
    }
  }

  /** Queues a server-paid chain transaction (inside the caller's transaction). Nothing happens without TestFPT or a wallet. */
  private queueMint(userId: string, kind: string, ref: string, amount: number, wallet = this.payoutWallet(userId), subject: string | null = null) {
    if (!this.ready() || amount <= 0 || !wallet) return;
    this.db
      .prepare("INSERT OR IGNORE INTO chain_mints (id, user_id, wallet, kind, ref, amount, status, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)")
      .run(randomUUID(), userId, wallet, kind, ref, amount, subject, this.now(), this.now());
  }

  /**
   * Predictions on chain, for players with a Firstprint wallet: each stake moves TestFPT from their
   * wallet to the escrow, and each payout or refund moves it back, every one its own transaction.
   * (Players with their own wallet would have to sign each prediction, so theirs stay as points.)
   */
  private onLedger(userId: string, delta: number, reason: string, ref: string | null, ledgerId: number) {
    // A reverted stake comes back like a refund, and early rewards are paid like winnings: both from
    // the escrow, where the burned part of the revert fee stays.
    const kind = reason === 'revert' ? 'refund' : reason === 'early_reward' ? 'payout' : reason;
    if (!['stake', 'payout', 'refund'].includes(kind) || !ref) return;
    if (kind === 'stake' ? delta >= 0 : delta <= 0) return;
    const wallet = this.embeddedAddress(userId);
    if (!wallet) return;
    this.queueMint(userId, kind, `L${ledgerId}`, Math.abs(delta), wallet, ref);
  }

  /**
   * The background chain work, every few seconds: sends queued mints and checks sent ones; claims
   * the rewards of players with a Firstprint wallet by itself; and settles claims still confirming.
   */
  runChain(): Promise<void> {
    if (!this.ready() || !this.token || this.paused()) return Promise.resolve();
    if (this.chainRun) {
      this.chainNext ??= this.chainRun.then(() => {
        this.chainNext = null;
        return this.runChain();
      });
      return this.chainNext;
    }
    this.chainRun = this.chainWork().finally(() => (this.chainRun = null));
    return this.chainRun;
  }

  /** Maintenance mode is on: no new chain sends, so the copy taken for a deploy can't miss one. */
  private paused() {
    return this.service.maintenance().on;
  }

  /**
   * Resolves once the chain work in progress (if any) has stopped. Maintenance mode waits for this
   * before copying the database, so every send already made is recorded in the copy.
   */
  chainIdle(): Promise<void> {
    const running = this.chainNext ?? this.chainRun;
    if (!running) return Promise.resolve();
    return running.catch(() => {}).then(() => this.chainIdle());
  }

  private async chainWork() {
    const token = this.token!;
    let funded = true;
    try {
      funded = (await token.chain.balance(this.authority!.address)) >= MIN_AUTHORITY_LAMPORTS;
      this.funded = funded;
    } catch {
      return; // network down: try again next time
    }
    // Each loop stops as soon as maintenance mode is switched on, so a deploy waits seconds, not minutes.
    for (const m of as<MintRow[]>(this.db.prepare("SELECT * FROM chain_mints WHERE status = 'submitted' ORDER BY created_at LIMIT 50").all())) {
      if (this.paused()) return;
      await this.checkMint(m);
    }
    if (funded) {
      // Rewards first (the welcome bonus funds a new wallet), then stakes, payouts and mints in order.
      // Every player with a wallet: their Firstprint wallet, or the one they linked (the server pays).
      const owed = as<{ user_id: string }[]>(
        this.db
          .prepare(
            `SELECT DISTINCT r.user_id FROM rewards r
             WHERE r.claim_id IS NULL
               AND (EXISTS (SELECT 1 FROM embedded_wallets e WHERE e.user_id = r.user_id)
                    OR (? AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = r.user_id)))
               AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.user_id = r.user_id AND c.status IN ('pending', 'submitted')) LIMIT 20`,
          )
          .all(this.serverPaysClaims ? 1 : 0),
      );
      for (const { user_id } of owed) {
        if (this.paused()) return;
        try {
          await this.serverClaim(user_id, this.payoutWallet(user_id));
        } catch (err) {
          // A claim started at the same moment (the player's own, or the send right after a task)
          // already took these rewards: nothing went wrong, so it isn't reported as a failure.
          if (err instanceof AppError && err.code === 'claim_conflict') continue;
          this.service.log(`auto-claim for ${user_id} failed: ${(err as Error).message}`);
        }
      }
      for (const m of as<MintRow[]>(this.db.prepare("SELECT * FROM chain_mints WHERE status = 'queued' ORDER BY created_at LIMIT 20").all())) {
        if (this.paused()) return;
        await this.sendMint(m);
      }
    }
    for (const c of as<{ id: string; user_id: string }[]>(this.db.prepare("SELECT id, user_id FROM claims WHERE status = 'submitted' LIMIT 50").all())) {
      if (this.paused()) return;
      await this.refreshClaim(c.user_id, c.id).catch(() => {});
    }
  }

  /** The memo on a stake, payout or refund: which market, and for a stake which outcome. */
  private memoFor(m: MintRow) {
    const p = m.subject
      ? as<{ market_id: string; bucket: string } | undefined>(
          this.db.prepare('SELECT market_id, bucket FROM predictions WHERE id = ? UNION ALL SELECT market_id, bucket FROM prediction_reverts WHERE id = ?').get(m.subject, m.subject),
        )
      : undefined;
    return m.kind === 'stake' ? `firstprint:stake:${p?.market_id ?? '?'}:${p?.bucket ?? '?'}` : `firstprint:${m.kind}:${p?.market_id ?? '?'}`;
  }

  private async buildOp(m: MintRow) {
    const token = this.token!;
    const amount = BigInt(m.amount);
    if (m.kind === 'stake') {
      const sealed = as<{ secret_sealed: string } | undefined>(this.db.prepare('SELECT secret_sealed FROM embedded_wallets WHERE address = ?').get(m.wallet))?.secret_sealed;
      if (!sealed || !this.vault) throw new Error('the Firstprint wallet key is not available');
      const from = await signerFromSecret(this.vault.open(sealed));
      const held = await token.chain.tokenBalance(from.address, this.mint!);
      return buildServerTransfer(token.chain, this.authority!, this.mint!, { kind: 'stake', from, amount, topUp: held < amount ? amount - held : 0n }, this.memoFor(m));
    }
    if (m.kind === 'payout' || m.kind === 'refund') {
      const held = await token.chain.tokenBalance(this.authority!.address, this.mint!);
      return buildServerTransfer(token.chain, this.authority!, this.mint!, { kind: 'payout', to: address(m.wallet), amount, topUp: held < amount ? amount - held : 0n }, this.memoFor(m));
    }
    return buildServerMint(token.chain, this.authority!, this.mint!, address(m.wallet), amount);
  }

  private async sendMint(m: MintRow) {
    const token = this.token!;
    let built;
    try {
      built = await this.buildOp(m);
    } catch (err) {
      return this.mintFailed({ ...m, attempts: m.attempts + 1 }, `couldn’t prepare: ${(err as Error).message.slice(0, 120)}`);
    }
    // Recorded before sending, so a crash after sending can be reconciled instead of sending twice.
    this.db
      .prepare("UPDATE chain_mints SET status = 'submitted', signature = ?, last_valid_height = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(built.signature, Number(built.lastValidBlockHeight), this.now(), m.id);
    try {
      // Each waits for confirmation, so the next one reads balances that include it.
      await sendAndConfirm(token.chain, built.transaction, 30_000);
    } catch (err) {
      const msg = (err as Error).message;
      if (/simulation failed|insufficient|custom program error|invalid|blockhash not found|failed on chain/i.test(msg)) {
        return this.mintFailed({ ...m, attempts: m.attempts + 1 }, msg.slice(0, 160));
      }
      // A timeout may still land: the status check settles it.
    }
    await this.checkMint(as<MintRow>(this.db.prepare('SELECT * FROM chain_mints WHERE id = ?').get(m.id)));
  }

  private async checkMint(m: MintRow) {
    const token = this.token!;
    if (m.status !== 'submitted' || !m.signature) return;
    let status;
    try {
      status = await token.chain.status(m.signature as Signature);
    } catch {
      return;
    }
    if (status === 'confirmed') {
      this.db.prepare("UPDATE chain_mints SET status = 'confirmed', error = NULL, updated_at = ? WHERE id = ?").run(this.now(), m.id);
    } else if (status === 'failed') {
      this.mintFailed(m, 'failed on chain');
    } else {
      // Still unknown after its blockhash expired: it can never land, so it is safe to send again.
      try {
        if (m.last_valid_height !== null && (await token.chain.blockHeight()) > BigInt(m.last_valid_height)) this.mintFailed(m, 'not confirmed in time');
      } catch {
        /* keep waiting */
      }
    }
  }

  /** Back to the queue for another try, or failed for good after a few. */
  private mintFailed(m: MintRow, error: string) {
    const final = m.attempts >= MAX_MINT_ATTEMPTS;
    // The attempt count is saved too: one that can't even be built must still reach the limit, or
    // it would stay queued at the front and hold up every later mint.
    this.db.prepare('UPDATE chain_mints SET status = ?, error = ?, attempts = ?, updated_at = ? WHERE id = ?').run(final ? 'failed' : 'queued', error, m.attempts, this.now(), m.id);
    if (final) this.service.log(`mint ${m.id} (${m.kind} for ${m.user_id}) failed: ${error}`);
  }

  /**
   * Claims every unclaimed reward to one of the player's wallets (their Firstprint wallet by
   * default), signed and paid by the server: no wallet pop-up and no fee for the player. Points are
   * added once it is confirmed, as with any claim. Returns the claim id, or null with nothing to claim.
   */
  private async serverClaim(userId: string, wallet = this.embeddedAddress(userId)): Promise<string | null> {
    const token = this.token!;
    if (!wallet) return null;
    const rows = as<{ id: number; amount: number }[]>(this.db.prepare('SELECT id, amount FROM rewards WHERE user_id = ? AND claim_id IS NULL').all(userId));
    const amount = rows.reduce((sum, r) => sum + r.amount, 0);
    if (!amount) return null;
    const built = await buildServerMint(token.chain, this.authority!, this.mint!, address(wallet), BigInt(amount));
    const id = randomUUID();
    tx(this.db, () => {
      const reserve = this.db.prepare('UPDATE rewards SET claim_id = ? WHERE id = ? AND claim_id IS NULL');
      let reserved = 0;
      for (const r of rows) reserved += Number(reserve.run(id, r.id).changes);
      if (reserved !== rows.length) throw new AppError(409, 'claim_conflict', 'Your rewards changed while preparing the claim. Try again.');
      this.db
        .prepare(
          `INSERT INTO claims (id, user_id, wallet, amount, status, message, last_valid_height, signature, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'submitted', '', ?, ?, ?, ?)`,
        )
        .run(id, userId, wallet, amount, Number(built.lastValidBlockHeight), built.signature, this.now(), this.now());
    });
    try {
      await sendAndConfirm(token.chain, built.transaction, 30_000);
    } catch (err) {
      if (/simulation failed|insufficient|custom program error|invalid|blockhash not found|failed on chain/i.test((err as Error).message)) {
        this.closeClaim(id, 'failed', `The network rejected it: ${(err as Error).message.slice(0, 160)}`);
        return id;
      }
    }
    await this.refreshClaim(userId, id);
    return id;
  }

  /** True while the mint authority has enough test SOL to pay for players' transactions. */
  private async serverFunded() {
    try {
      return (await this.token!.chain.balance(this.authority!.address)) >= MIN_AUTHORITY_LAMPORTS;
    } catch {
      return false;
    }
  }

  /** The player's on-chain record: their Firstprint wallet and every TestFPT transaction for them. */
  /** One page (8 entries) of the player's TestFPT transactions, newest first: server sends and their own claims. */
  chainActivity(userId: string, page = 1, perPage = 8) {
    const cluster = this.token?.cluster ?? null;
    const url = (sig: string | null) => (sig && cluster ? explorerTx(sig, cluster) : null);
    const wallet = this.embeddedAddress(userId);
    const per = Math.min(50, Math.max(1, Math.floor(perPage) || 8));
    const total = as<{ n: number }>(
      this.db.prepare('SELECT (SELECT COUNT(*) FROM chain_mints WHERE user_id = ?) + (SELECT COUNT(*) FROM claims WHERE user_id = ?) AS n').get(userId, userId),
    ).n;
    const pages = Math.max(1, Math.ceil(total / per));
    const p = Math.min(pages, Math.max(1, Math.floor(page) || 1));
    const rows = as<{ kind: string; amount: number; subject: string | null; wallet: string; status: string; signature: string | null; created_at: number }[]>(
      this.db
        .prepare(
          // Same moment: server sends before claims, then the later row first, so pages never shuffle.
          `SELECT kind, amount, subject, wallet, status, signature, created_at, 0 AS src, rowid AS r FROM chain_mints WHERE user_id = ?
           UNION ALL SELECT 'claim', amount, NULL, wallet, status, signature, created_at, 1, rowid FROM claims WHERE user_id = ?
           ORDER BY created_at DESC, src, r DESC LIMIT ? OFFSET ?`,
        )
        .all(userId, userId, per, (p - 1) * per),
    );
    const market = this.db.prepare(
      `SELECT m.symbol, p.market_id FROM (SELECT market_id FROM predictions WHERE id = ? UNION ALL SELECT market_id FROM prediction_reverts WHERE id = ?) p
       JOIN markets m ON m.id = p.market_id`,
    );
    const activity = rows.map((r) => {
      const m = r.subject ? as<{ symbol: string; market_id: string } | undefined>(market.get(r.subject, r.subject)) : undefined;
      return {
        kind: r.kind,
        // A stake leaves the wallet; everything else arrives in it.
        amount: r.kind === 'stake' ? -r.amount : r.amount,
        symbol: m?.symbol ?? null,
        marketId: m?.market_id ?? null,
        wallet: r.wallet,
        status: r.status,
        at: r.created_at,
        explorerUrl: r.status === 'confirmed' ? url(r.signature) : null,
      };
    });
    return {
      onChain: this.ready(),
      cluster,
      wallet,
      walletUrl: wallet && cluster ? explorerAddress(wallet, cluster) : null,
      mint: this.mint,
      activity,
      page: p,
      pages,
      total,
    };
  }


  /** Counts for the admin page. */
  chainCounts() {
    const n = (sql: string) => as<{ n: number }>(this.db.prepare(sql).get()).n;
    return {
      wallets: n('SELECT COUNT(*) AS n FROM embedded_wallets'),
      mintsConfirmed: n("SELECT COUNT(*) AS n FROM chain_mints WHERE status = 'confirmed'"),
      mintsWaiting: n("SELECT COUNT(*) AS n FROM chain_mints WHERE status IN ('queued', 'submitted')"),
      mintsFailed: n("SELECT COUNT(*) AS n FROM chain_mints WHERE status = 'failed'"),
      claimsConfirmed: n("SELECT COUNT(*) AS n FROM claims WHERE status = 'confirmed'"),
    };
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

  /**
   * Extra points for the admin's own account while testing (tasks, predictions, payouts). They go
   * through the same path as a task reward, so with TestFPT on they arrive as TestFPT too and the
   * on-chain stakes still have tokens behind them. At most 10,000 a time and 50,000 a day.
   */
  adminTopUp(userId: string, amount: number) {
    const pts = Math.floor(Number(amount));
    if (!(pts >= 1 && pts <= ADMIN_TOPUP_MAX)) throw new AppError(400, 'bad_amount', `Choose between 1 and ${ADMIN_TOPUP_MAX.toLocaleString('en-US')} points.`);
    return tx(this.db, () => {
      const today = as<{ pts: number | null }>(
        this.db.prepare("SELECT SUM(amount) AS pts FROM rewards WHERE user_id = ? AND kind = 'admin_topup' AND created_at > ?").get(userId, this.now() - 86_400_000),
      ).pts ?? 0;
      if (today + pts > ADMIN_TOPUP_DAY) throw new AppError(429, 'topup_limit', `That passes the ${ADMIN_TOPUP_DAY.toLocaleString('en-US')} points a day test limit (${today.toLocaleString('en-US')} added today).`);
      this.award(userId, 'admin_topup', `${this.now()}-${randomInt(1e9)}`, pts);
      this.service.log(`admin top-up: ${pts} points to ${userId}`);
      return { points: pts, ...this.adminTopUpStatus(userId) };
    });
  }

  /**
   * Where the admin's test points are: with TestFPT on they wait as a reward until claimed. A
   * Firstprint wallet claims by itself within a minute or so; any other wallet claims on Earn.
   */
  adminTopUpStatus(userId: string) {
    const rows = as<{ amount: number; claim_id: string | null; created_at: number }[]>(
      this.db.prepare("SELECT amount, claim_id, created_at FROM rewards WHERE user_id = ? AND kind = 'admin_topup' AND created_at > ?").all(userId, this.now() - 7 * 86_400_000),
    );
    const pending = rows.filter((r) => r.claim_id === null || !this.isClaimed(r.claim_id)).reduce((n, r) => n + r.amount, 0);
    const addedToday = rows.filter((r) => r.created_at > this.now() - 86_400_000).reduce((n, r) => n + r.amount, 0);
    return { onChain: this.ready(), pending, autoClaim: this.ready() && this.embeddedAddress(userId) !== null, addedToday, dayLimit: ADMIN_TOPUP_DAY };
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

  /**
   * A referred player who has predicted on REFERRAL_MARKETS different markets earns their referrer a
   * reward, up to the limit. (Not on the first prediction: a script could make throwaway accounts that
   * each place one prediction just to pay the referrer.)
   */
  private onPredicted(userId: string) {
    const u = as<{ referred_by: string | null }>(this.db.prepare('SELECT referred_by FROM users WHERE id = ?').get(userId));
    if (!u?.referred_by) return;
    const markets = as<{ n: number }>(this.db.prepare('SELECT COUNT(DISTINCT market_id) AS n FROM predictions WHERE user_id = ?').get(userId)).n;
    if (markets < REFERRAL_MARKETS) return;
    if (this.db.prepare("SELECT 1 FROM rewards WHERE user_id = ? AND kind = 'referral' AND ref = ?").get(u.referred_by, userId)) return;
    const given = as<{ n: number }>(this.db.prepare("SELECT COUNT(*) AS n FROM rewards WHERE user_id = ? AND kind = 'referral'").get(u.referred_by)).n;
    if (given >= REFERRAL_LIMIT) return;
    this.award(u.referred_by, 'referral', userId, REFERRAL_POINTS);
  }

  /** Everything the Earn page shows. */
  summary(userId: string) {
    this.expireStaleClaims(userId);
    const user = as<{ x_username: string | null; referred_by: string | null; x_verified: number; x_pending: string | null; x_code: string | null }>(
      this.db.prepare('SELECT x_username, referred_by, x_verified, x_pending, x_code FROM users WHERE id = ?').get(userId),
    );
    const code = this.referralCode(userId);
    const rewards = as<{ kind: string; ref: string | null; amount: number; created_at: number; claim_id: string | null }[]>(
      this.db.prepare('SELECT kind, ref, amount, created_at, claim_id FROM rewards WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId),
    );
    const claimable = as<{ n: number | null }>(this.db.prepare('SELECT SUM(amount) AS n FROM rewards WHERE user_id = ? AND claim_id IS NULL').get(userId)).n ?? 0;
    const referrals = as<{ n: number; pts: number | null }>(
      this.db.prepare("SELECT COUNT(*) AS n, SUM(amount) AS pts FROM rewards WHERE user_id = ? AND kind = 'referral'").get(userId),
    );
    const invited = as<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by = ?').get(userId)).n;
    const claims = as<ClaimRow[]>(this.db.prepare('SELECT * FROM claims WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10').all(userId));
    const welcome = as<{ claim_id: string | null } | undefined>(this.db.prepare("SELECT claim_id FROM rewards WHERE user_id = ? AND kind = 'welcome'").get(userId));
    const link = `${this.siteUrl}/?ref=${code}`;
    return {
      onChain: this.ready(),
      cluster: this.token?.cluster ?? null,
      mint: this.mint,
      mintUrl: this.mint && this.token ? explorerAddress(this.mint, this.token.cluster) : null,
      faucetUrl: FAUCET_URL,
      claimable,
      // A Firstprint wallet: rewards are sent to it by the server, no claim or fee needed.
      firstprintWallet: this.embeddedAddress(userId),
      // Rewards are sent to a wallet by themselves (nothing to claim) while the server pays.
      autoSend: Boolean(this.autoSendWallet(userId)),
      // The server is out of test SOL: sends wait, and claims would need the wallet to pay.
      chainPaused: this.ready() && !this.funded,
      welcomeClaimed: welcome ? welcome.claim_id !== null && this.isClaimed(welcome.claim_id) : true,
      xUsername: user.x_username,
      xConnectPoints: this.xConnectPoints(),
      // With X checks on: whether the linked username is proven, and the code waiting to be found.
      xChecks: Boolean(this.xcheck),
      xVerified: user.x_verified === 1,
      // After too many checks on X that found nothing: when the player may check again.
      xCooldownUntil: this.xCooldownUntil(userId),
      xPending: this.xcheck && user.x_pending && user.x_code ? { username: user.x_pending, code: user.x_code } : null,
      // The join-the-channel task is checked through our bot: until the player's Telegram is linked,
      // the link that opens the bot with their code.
      telegram: this.tgStatus(userId),
      referral: { code, link, invited, rewarded: referrals.n, points: referrals.pts ?? 0, limit: REFERRAL_LIMIT, perReferral: REFERRAL_POINTS, markets: REFERRAL_MARKETS },
      rewards: rewards.map((r) => ({ kind: r.kind, ref: r.ref, amount: r.amount, at: r.created_at, claimed: r.claim_id !== null && this.isClaimed(r.claim_id) })),
      claims: claims.map((c) => this.publicClaim(c)),
      claimsTotal: as<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM claims WHERE user_id = ?').get(userId)).n,
      tasks: this.tasksFor(userId, code),
    };
  }

  /** One page (10) of the player's claims, newest first. */
  claimsPage(userId: string, page = 1, perPage = 10) {
    const per = Math.min(50, Math.max(1, Math.floor(perPage) || 10));
    const total = as<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM claims WHERE user_id = ?').get(userId)).n;
    const pages = Math.max(1, Math.ceil(total / per));
    const p = Math.min(pages, Math.max(1, Math.floor(page) || 1));
    const rows = as<ClaimRow[]>(this.db.prepare('SELECT * FROM claims WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?').all(userId, per, (p - 1) * per));
    return { claims: rows.map((c) => this.publicClaim(c)), page: p, pages, total };
  }

  private tgStatus(userId: string) {
    if (!this.tg) return null;
    const open = this.db.prepare("SELECT 1 FROM tasks WHERE kind = 'telegram' AND active = 1").get();
    if (!open) return null;
    const linked = Boolean(as<{ tg_id: string | null }>(this.db.prepare('SELECT tg_id FROM users WHERE id = ?').get(userId)).tg_id);
    return { linked, botUrl: linked ? null : `https://t.me/${this.tg.bot}?start=${this.tgCode(userId)}` };
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

  private cleanX(input: string) {
    const name = String(input ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/[/?#].*$/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) throw new AppError(400, 'bad_x_username', 'Enter your X username, like @firstprint (letters, numbers and _ only).');
    return name;
  }

  /**
   * Links an X username (one account per username) and rewards the first link. With X checks on,
   * this only starts the link: the player gets a code to put in their X bio (or post), and
   * verifyX makes it theirs once the code is found.
   */
  connectX(userId: string, input: string) {
    const name = this.cleanX(input);
    return tx(this.db, () => {
      if (this.xcheck) {
        const taken = as<{ id: string } | undefined>(this.db.prepare('SELECT id FROM users WHERE x_username = ? COLLATE NOCASE AND x_verified = 1 AND id != ?').get(name, userId));
        if (taken) throw new AppError(409, 'x_taken', 'That X account is already verified on another Firstprint account.');
        const cur = as<{ x_pending: string | null; x_code: string | null; x_username: string | null; x_verified: number }>(
          this.db.prepare('SELECT x_pending, x_code, x_username, x_verified FROM users WHERE id = ?').get(userId),
        );
        // Already verified as this username: nothing to prove again.
        if (cur.x_verified === 1 && cur.x_username?.toLowerCase() === name.toLowerCase()) {
          this.db.prepare('UPDATE users SET x_pending = NULL, x_code = NULL WHERE id = ?').run(userId);
          return { xUsername: cur.x_username, pending: false, code: null, rewarded: 0 };
        }
        // The same username keeps its code, so a code already in the bio still counts.
        const code = cur.x_code && cur.x_pending?.toLowerCase() === name.toLowerCase() ? cur.x_code : `FP-${Array.from({ length: 6 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('')}`;
        this.db.prepare('UPDATE users SET x_pending = ?, x_code = ? WHERE id = ?').run(name, code, userId);
        return { xUsername: name, pending: true, code, rewarded: 0 };
      }
      const taken = as<{ id: string } | undefined>(this.db.prepare('SELECT id FROM users WHERE x_username = ? COLLATE NOCASE AND id != ?').get(name, userId));
      if (taken) throw new AppError(409, 'x_taken', 'That X account is already linked to another Firstprint account.');
      this.db.prepare('UPDATE users SET x_username = ? WHERE id = ?').run(name, userId);
      const pts = this.xConnectPoints();
      const rewarded = this.award(userId, 'x_connect', this.xConnectRef(), pts);
      return { xUsername: name, pending: false, code: null, rewarded: rewarded ? pts : 0 };
    });
  }

  /**
   * Proves the pending X username belongs to the player: their code must be in the account's bio or
   * one of its latest posts. The username then becomes theirs (taken from any account that only
   * claimed it without proof) and the first link is rewarded.
   */
  async verifyX(userId: string) {
    const x = this.requireX();
    const cur = as<{ x_pending: string | null; x_code: string | null }>(this.db.prepare('SELECT x_pending, x_code FROM users WHERE id = ?').get(userId));
    if (!cur.x_pending || !cur.x_code) throw new AppError(409, 'x_not_started', 'Enter your X username first to get your code.');
    const name = cur.x_pending;
    const code = cur.x_code.toLowerCase();
    this.xGate(userId);
    let canonical = name;
    const found = await this.xCall(async () => {
      const profile = await x.profile(name);
      if (!profile) {
        this.xMissed(userId);
        throw new AppError(404, 'x_not_found', `There’s no X account @${name}. Check the spelling.`);
      }
      // Stored as X writes it (capitals and all), whatever the player typed.
      if (profile.userName.toLowerCase() === name.toLowerCase()) canonical = profile.userName;
      if (profile.description.toLowerCase().includes(code)) return true;
      return (await x.recentPosts(name)).some((p) => p.text.toLowerCase().includes(code));
    });
    if (!found) this.xMissed(userId);
    else this.xFails.delete(userId);
    if (!found) throw new AppError(409, 'x_code_missing', `We couldn’t find ${cur.x_code} on @${name} yet. Add it to your X bio (or post it), wait a few seconds, then press Verify.`);
    return tx(this.db, () => {
      const taken = as<{ id: string } | undefined>(this.db.prepare('SELECT id FROM users WHERE x_username = ? COLLATE NOCASE AND x_verified = 1 AND id != ?').get(name, userId));
      if (taken) throw new AppError(409, 'x_taken', 'That X account is already verified on another Firstprint account.');
      // Someone who only typed this username in (no proof) loses it to its real owner.
      this.db.prepare('UPDATE users SET x_username = NULL WHERE x_username = ? COLLATE NOCASE AND id != ?').run(name, userId);
      this.db.prepare('UPDATE users SET x_username = ?, x_verified = 1, x_pending = NULL, x_code = NULL WHERE id = ?').run(canonical, userId);
      const pts = this.xConnectPoints();
      const rewarded = this.award(userId, 'x_connect', this.xConnectRef(), pts);
      return { xUsername: canonical, verified: true, rewarded: rewarded ? pts : 0 };
    });
  }

  /** Throws while the player has to wait after too many checks that found nothing. */
  private xGate(userId: string) {
    const until = this.xCooldownUntil(userId);
    if (until) {
      const mins = Math.max(1, Math.ceil((until - this.now()) / 60_000));
      throw new AppError(429, 'x_cooldown', `Too many checks in a row. Finish it on X, then try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
  }

  /** A check found nothing: after X_TRIES in a row the player waits X_COOLDOWN_MS. */
  private xMissed(userId: string) {
    const f = this.xFails.get(userId) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= X_TRIES) {
      f.n = 0;
      f.until = this.now() + X_COOLDOWN_MS;
    }
    if (this.xFails.size > 10_000) this.xFails.clear();
    this.xFails.set(userId, f);
  }

  /** When the player's wait ends, or null when they may check now. */
  xCooldownUntil(userId: string): number | null {
    const f = this.xFails.get(userId);
    return f && f.until > this.now() ? f.until : null;
  }

  private requireX(): XChecker {
    if (!this.xcheck) throw new AppError(404, 'x_checks_off', 'X checks aren’t set up on this server.');
    return this.xcheck;
  }

  /** Runs a check on X; when X can't be reached it says so (never "not done"). */
  private async xCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof XCheckUnavailable) {
        this.service.log(`X check failed: ${err.message}`);
        throw new AppError(503, 'x_check_unavailable', 'We couldn’t check X just now. Try again in a minute.');
      }
      throw err;
    }
  }

  /** Credit left for X checks (GetXAPI, in dollars), for the admin page; null when off or unknown. */
  /**
   * The GetXAPI balance for the admin's Tasks box. Every admin tab loads it, and GetXAPI can take
   * seconds to answer, so it is read at most once a minute: a known balance comes back at once (and
   * is refreshed behind it); the first read waits up to 3 s, then the box says it couldn't read it.
   */
  async xCredit(): Promise<number | null> {
    if (!this.xcheck) return null;
    const c = this.creditCache;
    if (this.now() - c.at > 60_000 && !c.loading) {
      c.loading = this.xcheck
        .credit()
        .then((v) => {
          c.value = v;
          c.at = this.now();
        })
        .catch(() => {})
        .finally(() => (c.loading = null));
    }
    if (c.at || !c.loading) return c.value;
    await Promise.race([c.loading, new Promise((ok) => setTimeout(ok, 3_000))]);
    return c.value;
  }
  private creditCache: { value: number | null; at: number; loading: Promise<void> | null } = { value: null, at: 0, loading: null };

  /** Counts one paid GetXAPI call: in total, and today (UTC). */
  countXCall() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const u = this.xUsage();
    this.service.setSetting('xcheck_calls', String(u.total + 1));
    this.service.setSetting('xcheck_calls_day', `${day}:${u.today + 1}`);
  }

  /** Paid GetXAPI calls made so far, in total and today (UTC). */
  xUsage() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const [d, n] = (this.service.getSetting('xcheck_calls_day') ?? '').split(':');
    return { total: Number(this.service.getSetting('xcheck_calls')) || 0, today: d === day ? Number(n) || 0 : 0 };
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
      case 'telegram':
        return `https://t.me/${encodeURIComponent(t.target)}`;
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

  /**
   * Confirms a task. Needs a linked X username for X tasks, and the task open for a few seconds.
   * With X checks on, follow, repost and post tasks are checked on X first (likes can't be, so they
   * stay honour-based), using the player's verified X username.
   */
  async verifyTask(userId: string, taskId: string) {
    const { t, xUsername } = this.taskReady(userId, taskId);
    if (this.xcheck && (t.kind === 'follow' || t.kind === 'repost' || t.kind === 'share')) {
      const x = this.xcheck;
      const verified = as<{ x_verified: number }>(this.db.prepare('SELECT x_verified FROM users WHERE id = ?').get(userId)).x_verified === 1;
      if (!verified) throw new AppError(409, 'x_unverified', 'Verify your X account first (Earn → Your X account), so we can check the task.');
      this.xGate(userId);
      const name = xUsername!;
      const code = this.referralCode(userId).toLowerCase();
      const done = await this.xCall(async () =>
        t.kind === 'follow'
          ? x.follows(name, t.target)
          : t.kind === 'repost'
            ? x.reposted(name, t.target)
            : (await x.recentPosts(name)).some((p) => p.text.toLowerCase().includes(`ref=${code}`)),
      );
        if (done) this.xFails.delete(userId);
      if (!done) {
        this.xMissed(userId);
        const what = t.kind === 'follow' ? `following @${t.target}` : t.kind === 'repost' ? 'your repost' : 'your post with your invite link';
        throw new AppError(409, 'task_not_done', `We can’t see ${what} on @${name} yet. Finish it on X, wait a few seconds, then confirm again.`);
      }
    }
    if (this.tg && t.kind === 'telegram') await this.checkTelegram(userId, t.target);
    const out = tx(this.db, () => {
      const { t: task, xUsername: x } = this.taskReady(userId, taskId);
      this.db.prepare('UPDATE task_completions SET completed_at = ?, x_username = ? WHERE task_id = ? AND user_id = ?').run(this.now(), x, taskId, userId);
      this.award(userId, 'task', taskId, task.points);
      return { points: task.points, onChain: this.ready(), sent: false };
    });
    // On chain with a wallet: send it now, so the points reach the wallet and balance straight away.
    if (out.onChain && this.autoSendWallet(userId)) {
      out.sent = await Promise.race([this.sendRewardsNow(userId), new Promise<boolean>((r) => setTimeout(() => r(false), 25_000).unref?.())]);
    }
    return out;
  }

  /** Throws unless the task can be confirmed now; checked before asking X and again when paying. */
  private taskReady(userId: string, taskId: string) {
    const t = this.activeTask(taskId);
    const user = as<{ x_username: string | null }>(this.db.prepare('SELECT x_username FROM users WHERE id = ?').get(userId));
    if (X_TASKS.includes(t.kind) && !user.x_username) throw new AppError(409, 'x_required', 'Link your X username first, so we know which account did it.');
    const mine = as<{ started_at: number; completed_at: number | null } | undefined>(
      this.db.prepare('SELECT started_at, completed_at FROM task_completions WHERE task_id = ? AND user_id = ?').get(taskId, userId),
    );
    if (mine?.completed_at) throw new AppError(409, 'task_done', 'You already completed this task.');
    if (!mine) throw new AppError(409, 'task_not_started', 'Open the task first, then come back to confirm it.');
    if (this.now() - mine.started_at < TASK_MIN_WAIT_MS) throw new AppError(429, 'task_too_fast', 'Give it a few seconds: finish the task, then confirm.');
    if (t.max_completions !== null && this.completions(taskId) >= t.max_completions) throw new AppError(409, 'task_full', 'This task has reached its limit.');
    return { t, xUsername: user.x_username };
  }

  // --- Telegram -----------------------------------------------------------------------

  /** The player's code for linking Telegram (made once, kept until it's used). */
  private tgCode(userId: string) {
    const cur = as<{ tg_code: string | null }>(this.db.prepare('SELECT tg_code FROM users WHERE id = ?').get(userId));
    if (cur.tg_code) return cur.tg_code;
    const code = `FP-${Array.from({ length: 8 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('')}`;
    this.db.prepare('UPDATE users SET tg_code = ? WHERE id = ?').run(code, userId);
    return code;
  }

  /**
   * Checks the join-the-channel task on Telegram. The player's Telegram account is found first: they
   * press Start in our bot through a link carrying their code (one Telegram account per Firstprint
   * account). Then the channel must list them as a member.
   */
  private async checkTelegram(userId: string, channel: string) {
    const tg = this.tg!.checker;
    const cur = as<{ tg_id: string | null; tg_code: string | null }>(this.db.prepare('SELECT tg_id, tg_code FROM users WHERE id = ?').get(userId));
    let tgId = cur.tg_id;
    const call = async <T>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (err) {
        this.service.log(`Telegram check failed: ${(err as Error).message}`);
        throw new AppError(503, 'tg_check_unavailable', 'We couldn’t check Telegram just now. Try again in a minute.');
      }
    };
    if (!tgId) {
      const code = cur.tg_code ?? this.tgCode(userId);
      const found = await call(() => tg.startedBy(code));
      if (!found) throw new AppError(409, 'tg_not_linked', 'Open our bot and press Start first, then press Verify again.');
      const taken = as<{ id: string } | undefined>(this.db.prepare('SELECT id FROM users WHERE tg_id = ? AND id != ?').get(found, userId));
      if (taken) throw new AppError(409, 'tg_taken', 'That Telegram account is already linked to another Firstprint account.');
      this.db.prepare('UPDATE users SET tg_id = ?, tg_code = NULL WHERE id = ?').run(found, userId);
      tgId = found;
      void tg.sendTo(found, 'Your Telegram is now linked to Firstprint ✅').catch(() => {});
    }
    const member = await call(() => tg.isMember(channel, tgId!));
    if (!member) throw new AppError(409, 'task_not_done', `We can’t see you in @${channel} yet. Join the channel, then press Verify again.`);
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
      } else if (kind === 'telegram') {
        const name = channelName(target);
        if (!name) throw new AppError(400, 'bad_target', 'Enter the public channel, like @firstprint or t.me/firstprint.');
        target = name;
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
    return { follow: `Follow @${target} on X`, repost: 'Repost our post on X', like: 'Like our post on X', share: 'Share Firstprint on X', link: 'Visit the link', telegram: 'Join our Telegram channel' }[kind];
  }

  createTask(input: TaskInput) {
    const kind = input.kind;
    if (!['follow', 'repost', 'like', 'share', 'link', 'telegram'].includes(kind)) throw new AppError(400, 'bad_kind', 'Choose a task type.');
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

  /**
   * Opens a task to everyone again: a fresh copy (same type, target and points, no player limit)
   * replaces it, so every player can do it and earn it once more. The old one is switched off and
   * keeps its history; points already given are kept.
   */
  resetTask(id: string, points?: number) {
    const t = as<TaskRow | undefined>(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    if (!t) throw new AppError(404, 'task_not_found', 'Task not found.');
    const pts = points === undefined ? t.points : this.cleanTask({ points }, t.kind).points ?? t.points;
    return tx(this.db, () => {
      const fresh = `task-${randomUUID().slice(0, 8)}`;
      this.db
        .prepare('INSERT INTO tasks (id, kind, title, target, points, max_completions, active, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?)')
        .run(fresh, t.kind, t.title, t.target, pts, this.now());
      this.db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(id);
      this.service.log(`task reset: ${id} -> ${fresh} (${pts} points)`);
      return { id: fresh, points: pts };
    });
  }

  /**
   * Removes a switched-off task and who did it. Points it paid stay with the players (rewards don't
   * depend on the task row). Active tasks must be switched off first.
   */
  deleteTask(id: string) {
    const t = as<TaskRow | undefined>(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    if (!t) throw new AppError(404, 'task_not_found', 'Task not found.');
    if (t.active) throw new AppError(409, 'task_active', 'Switch the task off before deleting it.');
    tx(this.db, () => {
      this.db.prepare('DELETE FROM task_completions WHERE task_id = ?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    });
    this.service.log(`task deleted: ${id} (${t.title})`);
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

    // Firstprint signs and pays: nothing for the wallet to approve. Only if the server is out of
    // test SOL does the claim fall back to the wallet signing and paying the fee itself.
    if (this.serverPaysClaims && (await this.serverFunded())) {
      let id;
      try {
        id = await this.serverClaim(userId, wallet);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(502, 'chain_unavailable', `The Solana ${token.cluster} network did not answer. Try again in a moment. (${(err as Error).message.slice(0, 120)})`);
      }
      if (!id) throw new AppError(400, 'nothing_to_claim', 'Nothing to claim yet. Complete a task or invite a friend to earn more.');
      const until = Date.now() + this.confirmWaitMs;
      let current = await this.refreshClaim(userId, id);
      while (current.status === 'submitted' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1_500));
        current = await this.refreshClaim(userId, id);
      }
      return { ...current, claimId: id, cluster: token.cluster, serverPaid: true as const };
    }

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
      wire = await checkSignedClaim(String(signed ?? ''), c.message, c.wallet, this.authority);
    } catch (err) {
      throw new AppError(400, 'bad_signed_claim', (err as Error).message);
    }
    const signature = transactionId(wire);
    // Record the signature before sending, so a crash after sending can still be reconciled.
    // The claim may have been replaced by a new one while it was being signed: never send it then.
    const moved = this.db.prepare("UPDATE claims SET status = 'submitted', signature = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(signature, this.now(), id);
    if (Number(moved.changes) !== 1) throw new AppError(409, 'claim_closed', 'This claim was replaced by a newer one. Use the latest claim.');
    try {
      await token.chain.send(wire);
    } catch (err) {
      const msg = (err as Error).message;
      // Only a clear rejection closes the claim. A timeout or lost connection may still have landed:
      // the claim stays "submitted" and the status check below settles it either way.
      const rejected = /insufficient|no record of a prior credit|0x1\b|simulation failed|custom program error|blockhash not found|invalid/i.test(msg);
      if (rejected) {
        const reason = /insufficient|no record of a prior credit|0x1\b/i.test(msg)
          ? 'Your wallet needs a little test SOL to pay the network fee. Get some from the faucet, then claim again.'
          : `The network rejected the claim: ${msg.slice(0, 160)}`;
        this.closeClaim(id, 'failed', reason);
        throw new AppError(400, 'claim_rejected', reason);
      }
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
