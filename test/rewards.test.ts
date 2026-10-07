import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { generateKeyPairSigner, getBase64Encoder, getBase64EncodedWireTransaction, getTransactionDecoder, lamports, partiallySignTransaction, type Address, type KeyPairSigner } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, decodeMint, decodeToken, findAssociatedTokenPda } from '@solana-program/token-2022';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { AppError, FirstprintService, START_POINTS } from '../src/services/firstprint.ts';
import { REFERRAL_POINTS, RewardsService, TASK_MIN_WAIT_MS, X_CONNECT_POINTS } from '../src/services/rewards.ts';
import { transactionId, type Chain } from '../src/solana/testfpt.ts';

const T0 = Date.UTC(2026, 9, 3, 12);
const failsWith = (code: string) => (e: unknown) => e instanceof AppError && e.code === code;

/** Solana in-process: the real Token-2022 and associated-token programs, no network. */
function liteChain() {
  const svm = new LiteSVM();
  const statuses = new Map<string, 'confirmed' | 'failed'>();
  const chain: Chain = {
    latestBlockhash: async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000n }),
    blockHeight: async () => 0n,
    minimumBalance: async (space) => svm.minimumBalanceForRentExemption(BigInt(space)),
    balance: async (a) => svm.getBalance(a) ?? 0n,
    async send(wire) {
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      const res = svm.sendTransaction(tx);
      const sig = transactionId(wire);
      if (res instanceof FailedTransactionMetadata) {
        statuses.set(sig, 'failed');
        throw new Error(`simulation failed: ${res.err()} ${res.meta().logs().join(' ')}`);
      }
      statuses.set(sig, 'confirmed');
      return sig as never;
    },
    status: async (sig) => statuses.get(sig) ?? 'unknown',
    airdrop: async (a, amount) => {
      svm.airdrop(a, lamports(amount));
      return 'airdrop' as never;
    },
    async tokenBalance(owner, mint) {
      const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
      const acct = svm.getAccount(ata);
      return acct.exists ? decodeToken(acct).data.amount : 0n;
    },
  };
  return { svm, chain };
}

const venue = { id: 'exa', name: 'Exchange A', pair: (b: string) => `${b}USDT`, fetchTicker: async () => { throw new Error('unused'); }, fetchCandles: async () => { throw new Error('unused'); }, listPairs: async () => { throw new Error('unused'); } };

async function setup(withToken = true) {
  const clock = new ManualClock(T0);
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const { svm, chain } = liteChain();
  const rewards = new RewardsService(service, withToken ? { cluster: 'testnet', chain } : null, 'https://firstprint.test');
  rewards.confirmWaitMs = 0;
  await rewards.init();
  return { clock, service, rewards, svm, chain };
}

/** An email sign-up, then a wallet linked straight in the database (the SIWS flow has its own tests). */
async function player(service: FirstprintService, email: string, ref?: string) {
  const code = service.startEmailLogin(email).code;
  const { user } = service.verifyEmailCode(email, code, ref);
  const wallet = await generateKeyPairSigner();
  service.db.prepare('INSERT INTO wallets (address, user_id, verified_at) VALUES (?, ?, 1)').run(wallet.address, user.id);
  return { user, wallet };
}

async function signAsWallet(base64: string, wallet: KeyPairSigner) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  return getBase64EncodedWireTransaction(await partiallySignTransaction([wallet.keyPair], tx));
}

async function tokenBalance(svm: LiteSVM, owner: Address, mint: Address) {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const acct = svm.getAccount(ata);
  return acct.exists ? decodeToken(acct).data.amount : 0n;
}

test('TestFPT: admin sets up the token; with the server out of SOL a player claims by signing and paying the fee', async () => {
  const { service, rewards, svm } = await setup();
  rewards.serverPaysClaims = false;
  assert.equal(rewards.ready(), false);
  let status = await rewards.setupAuthority();
  assert.ok(status.enabled && status.authority);
  // The admin can copy the key into the host's settings, so a wiped database can't lose it.
  assert.ok(status.enabled && /^[0-9a-f]{64}$/.test(status.authorityKey ?? ''));
  assert.deepEqual(status.enabled && status.savedInEnv, { authority: false, mint: false });
  await assert.rejects(rewards.createMint(), failsWith('mint_failed'), 'no SOL yet, so the token cannot be created');
  status = await rewards.airdropAuthority();
  status = await rewards.createMint();
  assert.ok(status.enabled && status.ready && status.mint);
  const mint = status.mint as Address;
  const mintAccount = svm.getAccount(mint);
  assert.ok(mintAccount.exists);
  const onChain = decodeMint(mintAccount);
  assert.equal(onChain.data.decimals, 0);
  assert.match(JSON.stringify(onChain.data.extensions, (_k, v) => (typeof v === 'bigint' ? String(v) : v)), /"name":"TestFPT"/);

  // With TestFPT on, a new account starts with 0 points and 1,000 to claim.
  const { user, wallet } = await player(service, 'ana@example.com');
  assert.equal(service.getUser(user.id).points, 0);
  let s = rewards.summary(user.id);
  assert.equal(s.claimable, START_POINTS);
  assert.equal(s.welcomeClaimed, false);

  // No test SOL: the claim is refused and the rewards stay claimable.
  let claim = await rewards.startClaim(user.id, wallet.address);
  await assert.rejects(rewards.submitClaim(user.id, claim.claimId, await signAsWallet(claim.transaction!, wallet)), failsWith('claim_rejected'));
  assert.equal(rewards.summary(user.id).claimable, START_POINTS);

  // With test SOL from the faucet it goes through.
  svm.airdrop(wallet.address, lamports(1_000_000_000n));
  const solBefore = svm.getBalance(wallet.address)!;
  claim = await rewards.startClaim(user.id, wallet.address);
  assert.equal(claim.amount, START_POINTS);
  // The transaction handed to the wallet carries no mint-authority signature, so it can't be
  // broadcast without going through submitClaim.
  const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(claim.transaction!));
  assert.ok(Object.values(unsigned.signatures).every((sig) => sig === null), 'no signatures before the wallet signs');
  const done = await rewards.submitClaim(user.id, claim.claimId, await signAsWallet(claim.transaction!, wallet));
  assert.equal(done.status, 'confirmed');
  assert.match(done.explorerUrl ?? '', /explorer\.solana\.com\/tx\/.+\?cluster=testnet/);
  assert.equal(await tokenBalance(svm, wallet.address, mint), 1000n, 'TestFPT is in the wallet');
  assert.ok(svm.getBalance(wallet.address)! < solBefore, 'the player paid the network fee');
  assert.equal(service.getUser(user.id).points, START_POINTS, 'and the points are in the balance');
  s = rewards.summary(user.id);
  assert.equal(s.claimable, 0);
  assert.equal(s.welcomeClaimed, true);
  await assert.rejects(rewards.startClaim(user.id, wallet.address), failsWith('nothing_to_claim'));
  await assert.rejects(rewards.submitClaim(user.id, claim.claimId, 'x'), failsWith('claim_closed'), 'a claim pays once');
});

test('TestFPT: a tampered or wrongly signed transaction is refused; claims only go to your own wallet', async () => {
  const { service, rewards, svm } = await setup();
  rewards.serverPaysClaims = false;
  await rewards.setupAuthority();
  await rewards.airdropAuthority();
  await rewards.createMint();
  const { user, wallet } = await player(service, 'ben@example.com');
  svm.airdrop(wallet.address, lamports(1_000_000_000n));
  const stranger = await generateKeyPairSigner();
  await assert.rejects(rewards.startClaim(user.id, stranger.address), failsWith('wallet_not_linked'));

  const claim = await rewards.startClaim(user.id, wallet.address);
  // A forged signature: sign properly, then corrupt the player's signature bytes.
  const forged = Buffer.from(await signAsWallet(claim.transaction!, wallet), 'base64');
  forged[1] ^= 0xff;
  await assert.rejects(rewards.submitClaim(user.id, claim.claimId, forged.toString('base64')), failsWith('bad_signed_claim'));
  // A different transaction (here, an unsigned copy of a new claim) is not the one prepared.
  assert.equal(typeof stranger.address, 'string');
  const other = await rewards.startClaim(user.id, wallet.address); // the first prepared claim is replaced
  await assert.rejects(rewards.submitClaim(user.id, claim.claimId, await signAsWallet(other.transaction!, wallet)), failsWith('claim_closed'));
  const ok = await rewards.submitClaim(user.id, other.claimId, await signAsWallet(other.transaction!, wallet));
  assert.equal(ok.status, 'confirmed');
  assert.equal(service.getUser(user.id).points, START_POINTS);
});

test('TestFPT: a claim to your own wallet is signed and paid by Firstprint: no pop-up, no SOL needed', async () => {
  const { service, rewards, svm } = await setup();
  await rewards.setupAuthority();
  await rewards.airdropAuthority();
  const status = await rewards.createMint();
  const mint = (status.enabled && status.mint) as Address;
  const { user, wallet } = await player(service, 'cy@example.com');
  assert.equal(svm.getBalance(wallet.address) ?? 0n, 0n, 'the wallet has no SOL at all');
  const stranger = await generateKeyPairSigner();
  await assert.rejects(rewards.startClaim(user.id, stranger.address), failsWith('wallet_not_linked'));

  const done = await rewards.startClaim(user.id, wallet.address);
  assert.ok('serverPaid' in done && done.serverPaid, 'nothing for the wallet to sign');
  assert.ok(!('transaction' in done));
  assert.equal(done.status, 'confirmed');
  assert.equal(done.amount, START_POINTS);
  assert.equal(await tokenBalance(svm, wallet.address, mint), 1000n, 'TestFPT is in the wallet');
  assert.equal(svm.getBalance(wallet.address) ?? 0n, 0n, 'the player paid nothing');
  assert.equal(service.getUser(user.id).points, START_POINTS);
  assert.equal(rewards.summary(user.id).claimable, 0);
  await assert.rejects(rewards.startClaim(user.id, wallet.address), failsWith('nothing_to_claim'));
});

test('tasks: link X, open the task, wait, confirm once; limits; rewards wait for the claim when TestFPT is on', async () => {
  const { clock, service, rewards } = await setup();
  await rewards.setupAuthority();
  await rewards.airdropAuthority();
  await rewards.createMint();
  const follow = rewards.createTask({ kind: 'follow', target: 'https://x.com/firstprint', points: 50, maxCompletions: 1 });
  const repost = rewards.createTask({ kind: 'repost', target: 'https://x.com/firstprint/status/1975000000000000001', points: 30 });
  assert.throws(() => rewards.createTask({ kind: 'link', target: 'http://insecure.example', points: 10 }), failsWith('bad_target'));
  const admin = rewards.listTasksAdmin();
  assert.equal(admin.find((t) => t.id === follow)?.title, 'Follow @firstprint on X');
  assert.equal(admin.find((t) => t.id === repost)?.url, 'https://x.com/intent/retweet?tweet_id=1975000000000000001');

  const { user: a } = await player(service, 'a@example.com');
  const { user: b } = await player(service, 'b@example.com');
  await assert.rejects(rewards.verifyTask(a.id, follow), failsWith('x_required'));
  assert.throws(() => rewards.connectX(a.id, 'not a name!'), failsWith('bad_x_username'));
  assert.equal(rewards.connectX(a.id, '@Ana_X').rewarded, X_CONNECT_POINTS);
  assert.equal(rewards.connectX(a.id, 'ana_x').rewarded, 0, 'linking again gives nothing more');
  assert.throws(() => rewards.connectX(b.id, 'ANA_X'), failsWith('x_taken'));
  rewards.connectX(b.id, 'bea');

  await assert.rejects(rewards.verifyTask(a.id, follow), failsWith('task_not_started'));
  rewards.startTask(a.id, follow);
  await assert.rejects(rewards.verifyTask(a.id, follow), failsWith('task_too_fast'));
  clock.advance(TASK_MIN_WAIT_MS);
  assert.equal((await rewards.verifyTask(a.id, follow)).points, 50);
  await assert.rejects(rewards.verifyTask(a.id, follow), failsWith('task_done'));

  rewards.startTask(b.id, follow);
  clock.advance(TASK_MIN_WAIT_MS);
  await assert.rejects(rewards.verifyTask(b.id, follow), failsWith('task_full'), 'limit of 1 reached');
  assert.equal(rewards.summary(b.id).tasks.find((t) => t.id === follow)?.remaining, 0);

  // TestFPT is on and the player has a wallet: the task sends everything owed straight to it
  // (signed and paid by the server), so it lands in the balance with nothing left to claim.
  assert.equal(service.getUser(a.id).points, START_POINTS + X_CONNECT_POINTS + 50);
  assert.equal(rewards.summary(a.id).claimable, 0);
  assert.equal(rewards.summary(a.id).autoSend, true);

  rewards.updateTask(repost, { active: false });
  assert.equal(rewards.summary(a.id).tasks.some((t) => t.id === repost), false);
});

test('resetting a task opens it to everyone again, with no limit, and pays once more', async () => {
  const { clock, service, rewards } = await setup();
  const { user: a } = await player(service, 'a@example.com');
  const { user: b } = await player(service, 'b@example.com');
  const link = rewards.createTask({ kind: 'link', target: 'https://firstprint.fun/x', points: 500, maxCompletions: 1 });
  rewards.startTask(a.id, link);
  clock.advance(TASK_MIN_WAIT_MS);
  await rewards.verifyTask(a.id, link);
  assert.equal(rewards.summary(b.id).tasks.find((t) => t.id === link)?.remaining, 0, 'full before the reset');

  const fresh = rewards.resetTask(link).id;
  assert.notEqual(fresh, link);
  const tasks = rewards.summary(a.id).tasks;
  assert.deepEqual(tasks.map((t) => [t.id, t.done, t.remaining, t.points]), [[fresh, false, null, 500]], 'only the fresh copy shows');
  for (const u of [a, b]) {
    rewards.startTask(u.id, fresh);
    clock.advance(TASK_MIN_WAIT_MS);
    assert.equal((await rewards.verifyTask(u.id, fresh)).points, 500);
  }
  assert.equal(rewards.listTasksAdmin().find((t) => t.id === link)?.active, false, 'the old one is switched off');
});

test('only a switched-off task can be deleted; points it paid stay', async () => {
  const { clock, service, rewards } = await setup();
  const { user: a } = await player(service, 'a@example.com');
  const link = rewards.createTask({ kind: 'link', target: 'https://firstprint.fun/x', points: 40 });
  rewards.startTask(a.id, link);
  clock.advance(TASK_MIN_WAIT_MS);
  await rewards.verifyTask(a.id, link);
  assert.throws(() => rewards.deleteTask(link), failsWith('task_active'));
  rewards.updateTask(link, { active: false });
  rewards.deleteTask(link);
  assert.equal(rewards.listTasksAdmin().some((t) => t.id === link), false);
  assert.equal(service.db.prepare("SELECT COUNT(*) AS n FROM rewards WHERE user_id = ? AND kind = 'task'").get(a.id)?.n, 1);
  assert.throws(() => rewards.deleteTask(link), failsWith('task_not_found'));
});

test('an admin reset of Connect X lets everyone link X and earn it again, at the new points', async () => {
  const { service, rewards } = await setup();
  const { user: a } = await player(service, 'a@example.com');
  const { user: b } = await player(service, 'b@example.com');
  assert.equal(rewards.connectX(a.id, 'ana').rewarded, X_CONNECT_POINTS);
  assert.equal(rewards.xConnectAdmin().players, 1);
  assert.throws(() => rewards.resetXConnect(0), failsWith('bad_points'));

  const out = rewards.resetXConnect(500);
  assert.deepEqual([out.round, out.points, out.cleared, out.players], [1, 500, 1, 0]);
  const s = rewards.summary(a.id);
  assert.deepEqual([s.xUsername, s.xVerified, s.xConnectPoints], [null, false, 500]);

  assert.equal(rewards.connectX(a.id, 'ana').rewarded, 500, 'paid again after the reset');
  assert.equal(rewards.connectX(a.id, 'ana').rewarded, 0, 'still once per round');
  assert.equal(rewards.connectX(b.id, 'bea').rewarded, 500);
  const given = service.db.prepare("SELECT amount FROM rewards WHERE user_id = ? AND kind = 'x_connect' ORDER BY id").all(a.id) as { amount: number }[];
  assert.deepEqual(given.map((r) => r.amount), [X_CONNECT_POINTS, 500], 'earlier points are kept');
  assert.equal(rewards.xConnectAdmin().players, 2);
});

test('without TestFPT: rewards go straight to the balance; referrals pay when the friend first predicts', async () => {
  const { clock, service, rewards } = await setup(false);
  const { user: host } = await player(service, 'host@example.com');
  assert.equal(service.getUser(host.id).points, START_POINTS, 'welcome points as before');
  const s = rewards.summary(host.id);
  assert.match(s.referral.link, /^https:\/\/firstprint\.test\/\?ref=[A-Z0-9]{8}$/);
  assert.equal(rewards.summary(host.id).referral.code, s.referral.code, 'the code is stable');

  const { user: friend } = await player(service, 'friend@example.com', s.referral.code.toLowerCase());
  assert.equal(service.getUser(friend.id).referred_by, host.id);
  assert.equal(rewards.summary(host.id).referral.invited, 1);

  // Paid once the friend has predicted on three different markets (one prediction alone isn't enough).
  const ids = ['ABC', 'DEF', 'GHI'].map((symbol) => service.createManualMarket({ symbol, exchanges: ['exa'], basePrice: 1, closeAt: T0 + 3_600_000, publish: true }));
  service.placePrediction(ids[0], friend.id, 'up', 100);
  service.placePrediction(ids[0], friend.id, 'down', 100);
  service.placePrediction(ids[1], friend.id, 'up', 100);
  assert.equal(service.getUser(host.id).points, START_POINTS, 'not yet: two markets so far');
  service.placePrediction(ids[2], friend.id, 'up', 100);
  assert.equal(service.getUser(host.id).points, START_POINTS + REFERRAL_POINTS);
  service.placePrediction(ids[2], friend.id, 'down', 100);
  assert.equal(service.getUser(host.id).points, START_POINTS + REFERRAL_POINTS, 'paid only once');

  const { user: self } = await player(service, 'self@example.com', rewards.summary(friend.id).referral.code);
  assert.equal(service.getUser(self.id).referred_by, friend.id);
  clock.advance(1);
  await assert.rejects(rewards.startClaim(host.id, 'x'), failsWith('token_off'));
});

test('Firstprint wallets: email players get a wallet, their rewards and daily streak arrive on chain, paid by the server', async () => {
  const { WalletVault } = await import('../src/solana/vault.ts');
  const vault = new WalletVault('a-long-test-secret-for-wallets');
  assert.equal(vault.open(vault.seal('seed')), 'seed');
  assert.throws(() => new WalletVault('a-different-secret-1').open(vault.seal('seed')), 'another key can’t open it');

  const clock = new ManualClock(T0);
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const { svm, chain } = liteChain();
  const rewards = new RewardsService(service, { cluster: 'testnet', chain, walletKey: 'a-long-test-secret-for-wallets' }, 'https://firstprint.test');
  rewards.confirmWaitMs = 0;
  await rewards.init();
  await rewards.setupAuthority();
  await rewards.airdropAuthority();
  const status = await rewards.createMint();
  const mint = (status as { mint: Address }).mint;

  // An email sign-up: no wallet of their own, so one is made.
  const code = service.startEmailLogin('eva@example.com').code;
  const { user } = service.verifyEmailCode('eva@example.com', code);
  const addr = (await rewards.ensureWallet(user.id)) as Address;
  assert.ok(addr);
  assert.equal(await rewards.ensureWallet(user.id), null, 'only once');
  assert.deepEqual(service.walletsFor(user.id).map((w) => [w.address, w.walletName]), [[addr, 'Firstprint wallet']]);
  const sealed = (service.db.prepare('SELECT secret_sealed FROM embedded_wallets WHERE user_id = ?').get(user.id) as { secret_sealed: string }).secret_sealed;
  assert.match(sealed, /^v1\./, 'the key is stored sealed, never in plain text');

  // The welcome bonus is claimed by itself, signed and paid by the server.
  await rewards.runChain();
  assert.equal(await tokenBalance(svm, addr, mint), BigInt(START_POINTS));
  assert.equal(service.getUser(user.id).points, START_POINTS);
  assert.equal(svm.getBalance(addr) ?? 0n, 0n, 'the player never needed test SOL');

  // The daily streak is minted to the wallet too.
  service.claimDaily(user.id);
  const daily = service.getUser(user.id).points - START_POINTS;
  assert.ok(daily > 0);
  await rewards.runChain();
  assert.equal(await tokenBalance(svm, addr, mint), BigInt(START_POINTS + daily));
  const act = rewards.chainActivity(user.id);
  assert.equal(act.wallet, addr);
  assert.deepEqual(act.activity.map((a) => [a.kind, a.status]), [['daily', 'confirmed'], ['claim', 'confirmed']]);
  assert.ok(act.activity.every((a) => /explorer\.solana\.com\/tx\//.test(a.explorerUrl ?? '')));
  await rewards.runChain();
  assert.equal(await tokenBalance(svm, addr, mint), BigInt(START_POINTS + daily), 'nothing is minted twice');

  // A player who signed in with their own wallet gets the daily mint there, with no signature asked.
  const { user: p2, wallet } = await player(service, 'phil@example.com');
  assert.equal(await rewards.ensureWallet(p2.id), null, 'has a wallet already');
  service.claimDaily(p2.id);
  await rewards.runChain();
  assert.ok((await tokenBalance(svm, wallet.address, mint)) > 0n);
  assert.equal(rewards.summary(p2.id).claimable, 0, 'their welcome bonus is sent to their own wallet too, paid by the server');
  assert.equal(await tokenBalance(svm, wallet.address, mint), BigInt(service.getUser(p2.id).points));

  // Out of test SOL: nothing is sent; it goes out once the authority is topped up.
  const realBalance = chain.balance;
  chain.balance = async () => 1_000n;
  clock.advance(24 * 60 * 60_000);
  service.claimDaily(user.id);
  await rewards.runChain();
  assert.equal(rewards.chainCounts().mintsWaiting, 1);
  assert.equal((await rewards.tokenStatus() as { lowFunds: boolean }).lowFunds, true, 'the admin page warns');
  chain.balance = realBalance;
  await rewards.runChain();
  assert.equal(rewards.chainCounts().mintsWaiting, 0);
  assert.equal(rewards.chainCounts().wallets, 1);

  // Maintenance mode (before a deploy): nothing is sent, so the copy for the new server misses no send.
  clock.advance(24 * 60 * 60_000);
  service.claimDaily(user.id);
  service.setMaintenance(true, '');
  await rewards.runChain();
  await rewards.chainIdle();
  assert.equal(rewards.chainCounts().mintsWaiting, 1, 'held while maintenance is on');
  service.setMaintenance(false, '');
  await rewards.runChain();
  assert.equal(rewards.chainCounts().mintsWaiting, 0, 'sent once it is off');
});

test('predictions on chain: stakes move TestFPT from Firstprint wallets to the escrow, payouts and refunds move it back', async () => {
  const { Scheduler } = await import('../src/workers/scheduler.ts');
  const clock = new ManualClock(T0);
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const { svm, chain } = liteChain();
  const rewards = new RewardsService(service, { cluster: 'testnet', chain, walletKey: 'a-long-test-secret-for-wallets' }, 'https://firstprint.test');
  rewards.confirmWaitMs = 0;
  await rewards.init();
  await rewards.setupAuthority();
  await rewards.airdropAuthority();
  const status = (await rewards.createMint()) as { mint: Address; authority: Address };
  const mint = status.mint;

  const signUp = async (email: string) => {
    const { user } = service.verifyEmailCode(email, service.startEmailLogin(email).code);
    const addr = (await rewards.ensureWallet(user.id)) as Address;
    return { id: user.id, addr };
  };
  const ana = await signUp('ana@example.com');
  const ben = await signUp('ben@example.com');
  await rewards.runChain();
  assert.equal(await tokenBalance(svm, ana.addr, mint), 1000n);

  const id = service.createManualMarket({ symbol: 'XYZ', exchanges: ['exa'], basePrice: 2, closeAt: T0 + 60 * 60_000, publish: true });
  service.placePrediction(id, ana.id, 'up', 300);
  service.placePrediction(id, ben.id, 'down', 200);
  await rewards.runChain();
  assert.equal(await tokenBalance(svm, ana.addr, mint), 700n, 'the stake left Ana’s wallet');
  assert.equal(await tokenBalance(svm, ben.addr, mint), 800n);
  assert.equal(await chain.tokenBalance(status.authority, mint), 500n, 'and sits in the escrow');
  const stakes = rewards.chainActivity(ana.id).activity.filter((a) => a.kind === 'stake');
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].status, 'confirmed');
  assert.match(stakes[0].explorerUrl ?? '', /explorer\.solana\.com\/tx\//);

  clock.advance(2 * 60 * 60_000);
  await new Scheduler(service, async () => {}, { tickMs: 1000 }).tick();
  service.resolveManualMarket(id, { finalPrice: 2.5 }); // Up wins
  await rewards.runChain();
  const anaPoints = service.getUser(ana.id).points;
  assert.equal(await tokenBalance(svm, ana.addr, mint), BigInt(anaPoints), 'Ana’s wallet matches her points');
  assert.equal(await tokenBalance(svm, ben.addr, mint), BigInt(service.getUser(ben.id).points));
  assert.ok(anaPoints > 1000, 'she won');
  const kinds = rewards.chainActivity(ana.id).activity.map((a) => `${a.kind}:${a.status}`);
  assert.ok(kinds.includes('payout:confirmed'));
  await rewards.runChain();
  assert.equal(await tokenBalance(svm, ana.addr, mint), BigInt(anaPoints), 'nothing moves twice');

  // A cancelled market refunds on chain too.
  const id2 = service.createManualMarket({ symbol: 'ABC', exchanges: ['exa'], basePrice: 1, closeAt: clock.now() + 60 * 60_000, publish: true });
  service.placePrediction(id2, ben.id, 'up', 100);
  await rewards.runChain();
  assert.equal(await tokenBalance(svm, ben.addr, mint), BigInt(service.getUser(ben.id).points));
  service.cancelMarket(id2);
  await rewards.runChain();
  assert.equal(await tokenBalance(svm, ben.addr, mint), BigInt(service.getUser(ben.id).points), 'refund back in the wallet');
  assert.ok(rewards.chainActivity(ben.id).activity.some((a) => a.kind === 'refund' && a.status === 'confirmed'));
});

test('admin test points: straight to the balance without TestFPT, a claimable reward with it, capped per top-up and per day', async () => {
  const off = await setup(false);
  const { user } = await player(off.service, 'admin-off@example.com');
  const before = off.service.getUser(user.id).points;
  assert.deepEqual(off.rewards.adminTopUp(user.id, 500), { points: 500, onChain: false, pending: 0, autoClaim: false, addedToday: 500, dayLimit: 50_000 });
  assert.equal(off.service.getUser(user.id).points, before + 500);
  assert.throws(() => off.rewards.adminTopUp(user.id, 0), (e: unknown) => e instanceof AppError && e.code === 'bad_amount');
  assert.throws(() => off.rewards.adminTopUp(user.id, 10_001), (e: unknown) => e instanceof AppError && e.code === 'bad_amount');
  for (let i = 0; i < 4; i++) off.rewards.adminTopUp(user.id, 10_000);
  assert.throws(() => off.rewards.adminTopUp(user.id, 9_600), (e: unknown) => e instanceof AppError && e.code === 'topup_limit');
  off.clock.advance(24 * 3_600_000 + 1);
  off.rewards.adminTopUp(user.id, 10_000);

  const on = await setup(true);
  await on.rewards.setupAuthority();
  await on.rewards.airdropAuthority();
  await on.rewards.createMint();
  assert.equal(on.rewards.ready(), true);
  const { user: u2 } = await player(on.service, 'admin-on@example.com');
  const pts = on.service.getUser(u2.id).points;
  assert.equal(on.rewards.adminTopUp(u2.id, 1000).onChain, true);
  assert.equal(on.service.getUser(u2.id).points, pts, 'waits as a reward to claim, like a task');
  assert.ok(on.rewards.summary(u2.id).rewards.some((r) => r.kind === 'admin_topup' && r.amount === 1000));
  const status = on.rewards.adminTopUpStatus(u2.id);
  assert.equal(status.pending, 1000, 'shown as processing until claimed');
  assert.equal(status.autoClaim, false, 'no Firstprint wallet: claimed on Earn');
});

test('the mint authority key is stored sealed (WALLET_ENCRYPTION_KEY), and an old plain one is sealed when read', async () => {
  const KEY = 'a-long-test-secret-for-wallets';
  const service = new FirstprintService(openDb(':memory:'), new ManualClock(T0), [venue]);
  const { chain } = liteChain();
  const make = () => new RewardsService(service, { cluster: 'testnet', chain, walletKey: KEY }, 'https://firstprint.test');
  const stored = () => (service.db.prepare("SELECT value FROM app_settings WHERE key = 'testfpt.authority'").get() as { value: string }).value;

  const first = make();
  await first.init();
  const status = await first.setupAuthority();
  assert.match(stored(), /^v1\./, 'never in plain text in the database or its backups');
  assert.ok(status.enabled && /^[0-9a-f]{64}$/.test(status.authorityKey ?? ''), 'the owner still sees the key to save it in the host');

  const again = make();
  await again.init();
  assert.equal((await again.tokenStatus() as { authority: string }).authority, (status as { authority: string }).authority, 'the same key after a restart');

  // A key saved in plain text before this change is sealed the first time it's read.
  service.db.prepare("UPDATE app_settings SET value = ? WHERE key = 'testfpt.authority'").run(status.enabled ? status.authorityKey : '');
  const legacy = make();
  await legacy.init();
  assert.match(stored(), /^v1\./);
  assert.equal((await legacy.tokenStatus() as { authority: string }).authority, (status as { authority: string }).authority);
});

test('X checks (GetXAPI): prove the username with a code, then follow, repost and post tasks are checked on X', async () => {
  const { clock, service, rewards } = await setup(false);
  const { XCheckUnavailable } = await import('../src/services/xcheck.ts');
  // A pretend X: who exists, their bios and posts, who follows whom, who reposted what.
  const x = {
    bios: new Map<string, string>([['ana_x', 'hello'], ['bea', '']]),
    posts: new Map<string, string[]>(),
    follows: new Set<string>(),
    reposts: new Set<string>(),
    down: false,
    calls: 0,
  };
  const guard = () => {
    x.calls++;
    if (x.down) throw new XCheckUnavailable('down');
  };
  rewards.xcheck = {
    profile: async (u) => (guard(), x.bios.has(u.toLowerCase()) ? { userName: u.toLowerCase() === 'ana_x' ? 'Ana_X' : u, description: x.bios.get(u.toLowerCase())! } : null),
    follows: async (s, t) => (guard(), x.follows.has(`${s.toLowerCase()}>${t.toLowerCase()}`)),
    reposted: async (u, id) => (guard(), x.reposts.has(`${u.toLowerCase()}:${id}`)),
    recentPosts: async (u) => (guard(), (x.posts.get(u.toLowerCase()) ?? []).map((text) => ({ text, createdAt: clock.now() }))),
    credit: async () => 0.14,
  };
  const { user: a } = await player(service, 'a@example.com');
  const { user: b } = await player(service, 'b@example.com');

  // Someone else typed in Ana's username before (no proof): it's still hers to verify.
  service.db.prepare("UPDATE users SET x_username = 'ana_x' WHERE id = ?").run(b.id);
  const started = rewards.connectX(a.id, '@Ana_X');
  assert.equal(started.pending, true);
  assert.match(started.code!, /^FP-[A-Z2-9]{6}$/);
  assert.equal(rewards.connectX(a.id, 'ana_x').code, started.code, 'the same username keeps its code');
  assert.deepEqual(rewards.summary(a.id).xPending, { username: 'ana_x', code: started.code });
  await assert.rejects(rewards.verifyX(a.id), failsWith('x_code_missing'));
  x.down = true;
  await assert.rejects(rewards.verifyX(a.id), failsWith('x_check_unavailable'), 'X down is never "not done"');
  x.down = false;
  x.bios.set('ana_x', `crypto fan ${started.code!.toLowerCase()}`);
  const ok = await rewards.verifyX(a.id);
  assert.deepEqual([ok.verified, ok.rewarded], [true, X_CONNECT_POINTS]);
  assert.equal(rewards.summary(a.id).xVerified, true);
  assert.equal(service.getUser(b.id).x_username, null, 'the unproven claim is dropped');
  assert.throws(() => rewards.connectX(b.id, 'ANA_X'), failsWith('x_taken'));
  // A code in a post works as well as the bio.
  const bc = rewards.connectX(b.id, 'bea').code!;
  x.posts.set('bea', [`Verifying my Firstprint account: ${bc}`]);
  assert.equal((await rewards.verifyX(b.id)).verified, true);
  await assert.rejects((async () => { rewards.connectX(a.id, 'nobody_here'); return rewards.verifyX(a.id); })(), failsWith('x_not_found'));
  assert.equal(rewards.connectX(a.id, 'ANA_X').pending, false, 'her own verified username needs no new code');
  assert.equal(rewards.summary(a.id).xPending, null);
  assert.equal(rewards.summary(a.id).xUsername, 'Ana_X');

  const follow = rewards.createTask({ kind: 'follow', target: '@firstprint', points: 50 });
  const repost = rewards.createTask({ kind: 'repost', target: 'https://x.com/firstprint/status/1975000000000000001', points: 30 });
  const share = rewards.createTask({ kind: 'share', target: 'Calling listings on Firstprint', points: 20 });
  const like = rewards.createTask({ kind: 'like', target: 'https://x.com/firstprint/status/1975000000000000001', points: 5 });
  for (const t of [follow, repost, share, like]) rewards.startTask(b.id, t);
  clock.advance(TASK_MIN_WAIT_MS);
  await assert.rejects(rewards.verifyTask(b.id, follow), failsWith('task_not_done'));
  x.follows.add('bea>firstprint');
  assert.equal((await rewards.verifyTask(b.id, follow)).points, 50);
  await assert.rejects(rewards.verifyTask(b.id, repost), failsWith('task_not_done'));
  x.reposts.add('bea:1975000000000000001');
  assert.equal((await rewards.verifyTask(b.id, repost)).points, 30);
  await assert.rejects(rewards.verifyTask(b.id, share), failsWith('task_not_done'));
  x.posts.set('bea', [`Calling listings on Firstprint https://firstprint.test/?ref=${rewards.summary(b.id).referral.code}`]);
  assert.equal((await rewards.verifyTask(b.id, share)).points, 20);
  const before = x.calls;
  assert.equal((await rewards.verifyTask(b.id, like)).points, 5, 'likes can’t be checked: honour-based');
  assert.equal(x.calls, before, 'no X call for a like');

  // An X username that was only typed in (from before checks were on) must be verified first.
  const { user: c } = await player(service, 'c@example.com');
  service.db.prepare("UPDATE users SET x_username = 'cee' WHERE id = ?").run(c.id);
  rewards.startTask(c.id, follow);
  clock.advance(TASK_MIN_WAIT_MS);
  await assert.rejects(rewards.verifyTask(c.id, follow), failsWith('x_unverified'));
  assert.equal(await rewards.xCredit(), 0.14);
});

test('X checks: three checks in a row that find nothing mean a five-minute wait (each check is a paid call)', async () => {
  const { X_TRIES, X_COOLDOWN_MS } = await import('../src/services/rewards.ts');
  const { clock, service, rewards } = await setup(false);
  let calls = 0;
  const following = new Set<string>();
  rewards.xcheck = {
    profile: async (u) => (calls++, { userName: u, description: '' }),
    follows: async (s) => (calls++, following.has(s)),
    reposted: async () => (calls++, false),
    recentPosts: async () => (calls++, []),
    credit: async () => null,
  };
  const { user } = await player(service, 'd@example.com');
  service.db.prepare("UPDATE users SET x_username = 'dee', x_verified = 1 WHERE id = ?").run(user.id);
  const follow = rewards.createTask({ kind: 'follow', target: '@firstprint', points: 50 });
  rewards.startTask(user.id, follow);
  clock.advance(TASK_MIN_WAIT_MS);
  for (let i = 0; i < X_TRIES; i++) await assert.rejects(rewards.verifyTask(user.id, follow), failsWith('task_not_done'));
  const before = calls;
  await assert.rejects(rewards.verifyTask(user.id, follow), failsWith('x_cooldown'));
  assert.equal(calls, before, 'no call on X while waiting');
  assert.equal(rewards.summary(user.id).xCooldownUntil, clock.now() + X_COOLDOWN_MS);
  following.add('dee');
  clock.advance(X_COOLDOWN_MS);
  assert.equal(rewards.summary(user.id).xCooldownUntil, null);
  assert.equal((await rewards.verifyTask(user.id, follow)).points, 50, 'after the wait it checks again');
});

test('Telegram task: join the channel, press Start in our bot with your code, then Verify; checked through the bot', async () => {
  const { clock, service, rewards } = await setup(false);
  const task = rewards.createTask({ kind: 'telegram', target: 't.me/firstprint_alerts', points: 500 });
  assert.throws(() => rewards.createTask({ kind: 'telegram', target: 'not a channel!', points: 10 }), failsWith('bad_target'));
  const listed = rewards.listTasksAdmin().find((t) => t.id === task)!;
  assert.deepEqual([listed.title, listed.url], ['Join our Telegram channel', 'https://t.me/firstprint_alerts']);

  // The bot: who pressed Start with which code, who is in the channel, what it sent.
  const starts = new Map<string, string>();
  const members = new Set<string>();
  const sent: string[] = [];
  rewards.tg = {
    bot: 'firstprint_bot',
    checker: {
      startedBy: async (code) => starts.get(code) ?? null,
      isMember: async (channel, id) => channel === 'firstprint_alerts' && members.has(id),
      sendTo: async (chat) => void sent.push(chat),
    },
  };
  const { user: a } = await player(service, 'a@example.com');
  const { user: b } = await player(service, 'b@example.com');

  // No X account needed for this one; the bot link carries the player's own code.
  const tg = rewards.summary(a.id).telegram!;
  assert.equal(tg.linked, false);
  const code = /start=(FP-[A-Z0-9]+)$/.exec(tg.botUrl!)![1];
  assert.match(tg.botUrl!, /^https:\/\/t\.me\/firstprint_bot\?start=FP-/);
  assert.equal(rewards.summary(a.id).telegram!.botUrl, tg.botUrl, 'the code stays the same until used');

  rewards.startTask(a.id, task);
  clock.advance(TASK_MIN_WAIT_MS);
  await assert.rejects(rewards.verifyTask(a.id, task), failsWith('tg_not_linked'));
  starts.set(code, '111');
  await assert.rejects(rewards.verifyTask(a.id, task), failsWith('task_not_done'), 'linked, but not in the channel yet');
  assert.deepEqual(sent, ['111'], 'the bot confirms the link');
  assert.equal(rewards.summary(a.id).telegram!.linked, true);
  members.add('111');
  assert.equal((await rewards.verifyTask(a.id, task)).points, 500);
  assert.equal(service.getUser(a.id).points, START_POINTS + 500);

  // One Telegram account per Firstprint account.
  const codeB = /start=(FP-[A-Z0-9]+)$/.exec(rewards.summary(b.id).telegram!.botUrl!)![1];
  starts.set(codeB, '111');
  rewards.startTask(b.id, task);
  clock.advance(TASK_MIN_WAIT_MS);
  await assert.rejects(rewards.verifyTask(b.id, task), failsWith('tg_taken'));
});

test('tasks: a full task opens again for new players when the admin raises or clears the limit', async () => {
  const { clock, service, rewards } = await setup(false);
  const follow = rewards.createTask({ kind: 'follow', target: '@firstprint', points: 50, maxCompletions: 1 });
  const { user: a } = await player(service, 'a@example.com');
  const { user: b } = await player(service, 'b@example.com');
  for (const [u, x] of [[a, 'ana'], [b, 'bea']] as const) rewards.connectX(u.id, x);
  rewards.startTask(a.id, follow);
  clock.advance(TASK_MIN_WAIT_MS);
  await rewards.verifyTask(a.id, follow);
  assert.equal(rewards.summary(b.id).tasks[0].remaining, 0, 'a new player sees it full');
  assert.equal(rewards.summary(b.id).tasks[0].done, false, 'but never as done by them');

  rewards.updateTask(follow, { points: 500, maxCompletions: null });
  const t = rewards.summary(b.id).tasks[0];
  assert.deepEqual([t.points, t.remaining, t.done], [500, null, false]);
  rewards.startTask(b.id, follow);
  clock.advance(TASK_MIN_WAIT_MS);
  assert.equal((await rewards.verifyTask(b.id, follow)).points, 500);
});

test('on-chain activity comes a page at a time: sends and claims together, newest first', async () => {
  const { clock, service, rewards } = await setup(false);
  const { user } = await player(service, 'a@example.com');
  const mint = service.db.prepare("INSERT INTO chain_mints (id, user_id, wallet, kind, ref, amount, status, created_at, updated_at) VALUES (?, ?, 'W', 'daily', ?, 10, 'confirmed', ?, ?)");
  for (let i = 0; i < 15; i++) {
    clock.advance(60_000);
    mint.run(`m${i}`, user.id, `d${i}`, clock.now(), clock.now());
  }
  clock.advance(60_000);
  service.db
    .prepare("INSERT INTO claims (id, user_id, wallet, amount, status, message, last_valid_height, created_at, updated_at) VALUES ('c1', ?, 'W', 500, 'confirmed', 'm', 1, ?, ?)")
    .run(user.id, clock.now(), clock.now());
  const p1 = rewards.chainActivity(user.id, 1);
  assert.deepEqual([p1.page, p1.pages, p1.total, p1.activity.length], [1, 2, 16, 8]);
  assert.equal(p1.activity[0].kind, 'claim', 'the newest first');
  const p2 = rewards.chainActivity(user.id, 2);
  assert.equal(p2.activity.length, 8);
  assert.equal(p2.activity.at(-1)!.at, Math.min(...[...p1.activity, ...p2.activity].map((a) => a.at)));
  assert.equal(rewards.chainActivity(user.id, 50).page, 2);
});

test('rewards: paid GetXAPI calls are counted in total and per UTC day; the credit check is free', async () => {
  const { GetXApi } = await import('../src/services/xcheck.ts');
  const { clock, rewards } = await setup(false);
  const x = new GetXApi('key', (async () => new Response(JSON.stringify({ data: { sourceFollowsTarget: true }, balance_total: 1.5 }))) as typeof fetch);
  x.onCall = () => rewards.countXCall();
  await x.follows('a', 'b');
  await x.follows('a', 'c');
  assert.equal(await x.credit(), 1.5);
  assert.deepEqual(rewards.xUsage(), { total: 2, today: 2 });
  clock.advance(24 * 3_600_000);
  assert.deepEqual(rewards.xUsage(), { total: 2, today: 0 }, 'a new day starts from zero');
  await x.follows('a', 'd');
  assert.deepEqual(rewards.xUsage(), { total: 3, today: 1 });
});
