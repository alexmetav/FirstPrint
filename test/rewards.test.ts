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
  assert.throws(() => rewards.verifyTask(a.id, follow), failsWith('x_required'));
  assert.throws(() => rewards.connectX(a.id, 'not a name!'), failsWith('bad_x_username'));
  assert.equal(rewards.connectX(a.id, '@Ana_X').rewarded, X_CONNECT_POINTS);
  assert.equal(rewards.connectX(a.id, 'ana_x').rewarded, 0, 'linking again gives nothing more');
  assert.throws(() => rewards.connectX(b.id, 'ANA_X'), failsWith('x_taken'));
  rewards.connectX(b.id, 'bea');

  assert.throws(() => rewards.verifyTask(a.id, follow), failsWith('task_not_started'));
  rewards.startTask(a.id, follow);
  assert.throws(() => rewards.verifyTask(a.id, follow), failsWith('task_too_fast'));
  clock.advance(TASK_MIN_WAIT_MS);
  assert.equal(rewards.verifyTask(a.id, follow).points, 50);
  assert.throws(() => rewards.verifyTask(a.id, follow), failsWith('task_done'));

  rewards.startTask(b.id, follow);
  clock.advance(TASK_MIN_WAIT_MS);
  assert.throws(() => rewards.verifyTask(b.id, follow), failsWith('task_full'), 'limit of 1 reached');
  assert.equal(rewards.summary(b.id).tasks.find((t) => t.id === follow)?.remaining, 0);

  // TestFPT is on: task points wait to be claimed rather than landing in the balance.
  assert.equal(service.getUser(a.id).points, 0);
  assert.equal(rewards.summary(a.id).claimable, START_POINTS + X_CONNECT_POINTS + 50);

  rewards.updateTask(repost, { active: false });
  assert.equal(rewards.summary(a.id).tasks.some((t) => t.id === repost), false);
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

  const id = service.createManualMarket({ symbol: 'ABC', exchanges: ['exa'], basePrice: 1, closeAt: T0 + 3_600_000, publish: true });
  service.placePrediction(id, friend.id, 'up', 100);
  assert.equal(service.getUser(host.id).points, START_POINTS + REFERRAL_POINTS);
  service.placePrediction(id, friend.id, 'down', 100);
  assert.equal(service.getUser(host.id).points, START_POINTS + REFERRAL_POINTS, 'only the first prediction counts');

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
  assert.equal(rewards.summary(p2.id).claimable, START_POINTS, 'their welcome bonus still waits for them to claim (they pay that fee)');

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
