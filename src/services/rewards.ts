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
    if (!['stake', 'payout', 'refund'].includes(reason) || !ref) return;
    if (reason === 'stake' ? delta >= 0 : delta <= 0) return;
    const wallet = this.embeddedAddress(userId);
    if (!wallet) return;
    this.queueMint(userId, reason, `L${ledgerId}`, Math.abs(delta), wallet, ref);
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
      const owed = as<{ user_id: string }[]>(
        this.db
          .prepare(
            `SELECT DISTINCT r.user_id FROM rewards r JOIN embedded_wallets e ON e.user_id = r.user_id
             WHERE r.claim_id IS NULL AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.user_id = r.user_id AND c.status IN ('pending', 'submitted')) LIMIT 20`,
          )
          .all(),
      );
      for (const { user_id } of owed) {
        if (this.paused()) return;
        try {
          await this.serverClaim(user_id);
        } catch (err) {
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
      ? as<{ market_id: string; bucket: string } | undefined>(this.db.prepare('SELECT market_id, bucket FROM predictions WHERE id = ?').get(m.subject))
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
  chainActivity(userId: string) {
    const cluster = this.token?.cluster ?? null;
    const url = (sig: string | null) => (sig && cluster ? explorerTx(sig, cluster) : null);
    const wallet = this.embeddedAddress(userId);
    const symbolOf = (predictionId: string | null) =>
      predictionId
        ? (as<{ symbol: string; market_id: string } | undefined>(
            this.db.prepare('SELECT m.symbol, p.market_id FROM predictions p JOIN markets m ON m.id = p.market_id WHERE p.id = ?').get(predictionId),
          ) ?? null)
        : null;
    const mints = as<MintRow[]>(this.db.prepare('SELECT * FROM chain_mints WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(userId)).map((m) => ({
      kind: m.kind,
      // A stake leaves the wallet; everything else arrives in it.
      amount: m.kind === 'stake' ? -m.amount : m.amount,
      symbol: symbolOf(m.subject)?.symbol ?? null,
      marketId: symbolOf(m.subject)?.market_id ?? null,
      wallet: m.wallet,
      status: m.status,
      at: m.created_at,
      explorerUrl: m.status === 'confirmed' ? url(m.signature) : null,
    }));
    const claims = as<ClaimRow[]>(this.db.prepare('SELECT * FROM claims WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(userId)).map((c) => ({
      kind: 'claim',
      amount: c.amount,
      symbol: null,
      marketId: null,
      wallet: c.wallet,
      status: c.status,
      at: c.created_at,
      explorerUrl: c.status === 'confirmed' ? url(c.signature) : null,
    }));
    return {
      onChain: this.ready(),
      cluster,
      wallet,
      walletUrl: wallet && cluster ? explorerAddress(wallet, cluster) : null,
      mint: this.mint,
      activity: [...mints, ...claims].sort((a, b) => b.at - a.at).slice(0, 30),
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
      // A Firstprint wallet: rewards are sent to it by the server, no claim or fee needed.
      firstprintWallet: this.embeddedAddress(userId),
      // The server is out of test SOL: sends wait, and claims would need the wallet to pay.
      chainPaused: this.ready() && !this.funded,
      welcomeClaimed: welcome ? welcome.claim_id !== null && this.isClaimed(welcome.claim_id) : true,
      xUsername: user.x_username,
      xConnectPoints: X_CONNECT_POINTS,
      referral: { code, link, invited, rewarded: referrals.n, points: referrals.pts ?? 0, limit: REFERRAL_LIMIT, perReferral: REFERRAL_POINTS, markets: REFERRAL_MARKETS },
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
