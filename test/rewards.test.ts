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

test('TestFPT: admin sets up the token, a new player claims 1,000 to their wallet and pays the fee', async () => {
  const { service, rewards, svm } = await setup();
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
  await assert.rejects(rewards.submitClaim(user.id, claim.claimId, await signAsWallet(claim.transaction, wallet)), failsWith('claim_rejected'));
  assert.equal(rewards.summary(user.id).claimable, START_POINTS);

  // With test SOL from the faucet it goes through.
  svm.airdrop(wallet.address, lamports(1_000_000_000n));
  const solBefore = svm.getBalance(wallet.address)!;
  claim = await rewards.startClaim(user.id, wallet.address);
  assert.equal(claim.amount, START_POINTS);
  // The transaction handed to the wallet carries no mint-authority signature, so it can't be
  // broadcast without going through submitClaim.
  const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(claim.transaction));
  assert.ok(Object.values(unsigned.signatures).every((sig) => sig === null), 'no signatures before the wallet signs');
  const done = await rewards.submitClaim(user.id, claim.claimId, await signAsWallet(claim.transaction, wallet));
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
  await rewards.setupAuthority();
  await rewards.airdropAuthority();
  await rewards.createMint();
  const { user, wallet } = await player(service, 'ben@example.com');
  svm.airdrop(wallet.address, lamports(1_000_000_000n));
  const stranger = await generateKeyPairSigner();
  await assert.rejects(rewards.startClaim(user.id, stranger.address), failsWith('wallet_not_linked'));

  const claim = await rewards.startClaim(user.id, wallet.address);
  // A forged signature: sign properly, then corrupt the player's signature bytes.
  const forged = Buffer.from(await signAsWallet(claim.transaction, wallet), 'base64');
  forged[1] ^= 0xff;
  await assert.rejects(rewards.submitClaim(user.id, claim.claimId, forged.toString('base64')), failsWith('bad_signed_claim'));
  // A different transaction (here, an unsigned copy of a new claim) is not the one prepared.
  assert.equal(typeof stranger.address, 'string');
  const other = await rewards.startClaim(user.id, wallet.address); // the first prepared claim is replaced
  await assert.rejects(rewards.submitClaim(user.id, claim.claimId, await signAsWallet(other.transaction, wallet)), failsWith('claim_closed'));
  const ok = await rewards.submitClaim(user.id, other.claimId, await signAsWallet(other.transaction, wallet));
  assert.equal(ok.status, 'confirmed');
  assert.equal(service.getUser(user.id).points, START_POINTS);
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
