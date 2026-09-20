import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { base58Decode, base58Encode, isSolanaAddress } from '../src/solana/base58.ts';
import { verifyEd25519 } from '../src/solana/siws.ts';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService, START_POINTS } from '../src/services/firstprint.ts';
import { createApiServer } from '../src/api/server.ts';

const SITE = { domain: 'firstprint.test', uri: 'https://firstprint.test', chainId: 'mainnet' as const };

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const address = base58Encode(raw);
  return { address, signMessage: (msg: string) => base58Encode(sign(null, Buffer.from(msg, 'utf8'), privateKey)) };
}

function setup() {
  const clock = new ManualClock(Date.UTC(2026, 8, 14, 12));
  const service = new FirstprintService(openDb(':memory:'), clock, []);
  return { clock, service };
}

test('base58 matches known vectors', () => {
  assert.equal(base58Encode(new Uint8Array(32)), '11111111111111111111111111111111'); // System Program
  assert.equal(base58Encode(Buffer.from('hello world')), 'StV1DL6CwTryKyV');
  assert.deepEqual(Buffer.from(base58Decode('StV1DL6CwTryKyV')).toString(), 'hello world');
  assert.ok(isSolanaAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
  assert.ok(!isSolanaAddress('0xabc'));
  assert.ok(!isSolanaAddress('StV1DL6CwTryKyV'), 'must decode to 32 bytes');
});

test('ed25519 verification against a Solana-style address', () => {
  const w = wallet();
  const sig = base58Decode(w.signMessage('gm'));
  assert.ok(verifyEd25519(w.address, new TextEncoder().encode('gm'), sig));
  assert.ok(!verifyEd25519(w.address, new TextEncoder().encode('gn'), sig));
  assert.ok(!verifyEd25519(wallet().address, new TextEncoder().encode('gm'), sig));
});

test('wallet sign-in creates an account once and rejects replays and tampering', () => {
  const { service, clock } = setup();
  const w = wallet();

  const c1 = service.walletChallenge(w.address, SITE);
  assert.match(c1.message, /^firstprint\.test wants you to sign in with your Solana account:\n/);
  assert.ok(c1.message.includes(`\nChain ID: mainnet\n`));

  const first = service.walletSignIn({ address: w.address, message: c1.message, signature: w.signMessage(c1.message), walletName: 'Phantom' });
  assert.equal(first.created, true);
  assert.equal(first.user.points, START_POINTS);
  assert.equal(first.user.needs_username, 1);
  assert.match(first.user.username, /^sol_/);

  assert.throws(() => service.walletSignIn({ address: w.address, message: c1.message, signature: w.signMessage(c1.message) }), /failed/, 'replay');

  const c2 = service.walletChallenge(w.address, SITE);
  const again = service.walletSignIn({ address: w.address, message: c2.message, signature: w.signMessage(c2.message) });
  assert.equal(again.created, false);
  assert.equal(again.user.id, first.user.id);

  const c3 = service.walletChallenge(w.address, SITE);
  const tampered = c3.message.replace('firstprint.test', 'evil.test');
  assert.throws(() => service.walletSignIn({ address: w.address, message: tampered, signature: w.signMessage(tampered) }), /failed/);

  const other = wallet();
  const c4 = service.walletChallenge(w.address, SITE);
  assert.throws(() => service.walletSignIn({ address: w.address, message: c4.message, signature: other.signMessage(c4.message) }), /failed/, 'wrong key');

  const c5 = service.walletChallenge(w.address, SITE);
  clock.advance(6 * 60_000);
  assert.throws(() => service.walletSignIn({ address: w.address, message: c5.message, signature: w.signMessage(c5.message) }), /expired/);

  const named = service.setUsername(first.user.id, 'solana_sam');
  assert.equal(named.needs_username, 0);
  assert.throws(() => service.walletChallenge('not-an-address', SITE), /valid Solana address/);
});

test('linking wallets to accounts', async () => {
  const { service } = setup();
  const alice = await service.createUser({ email: 'a@example.com', username: 'alice', password: 'password123' });
  const bob = await service.createUser({ email: 'b@example.com', username: 'bob', password: 'password123' });
  const w = wallet();

  const c = service.walletChallenge(w.address, SITE);
  const wallets = service.linkWallet(alice.id, { address: w.address, message: c.message, signature: w.signMessage(c.message), walletName: 'Solflare' });
  assert.deepEqual(wallets.map((x) => x.address), [w.address]);

  const c2 = service.walletChallenge(w.address, SITE);
  assert.throws(() => service.linkWallet(bob.id, { address: w.address, message: c2.message, signature: w.signMessage(c2.message) }), /another account/);

  const c3 = service.walletChallenge(w.address, SITE);
  assert.equal(service.walletSignIn({ address: w.address, message: c3.message, signature: w.signMessage(c3.message) }).user.id, alice.id);
});

test('HTTP: wallet challenge → verify → session → profile', async () => {
  const { service } = setup();
  const server = createApiServer({ service, adminKey: null, secureCookies: false, trustProxy: 0, publicUrl: 'https://firstprint.test', solanaChain: 'devnet', webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { 'content-type': 'application/json', cookie } });
  try {
    const w = wallet();
    const challenge = await (await call(`/api/auth/wallet/challenge?address=${w.address}`)).json();
    assert.ok(challenge.message.includes('Chain ID: devnet'));
    const verify = await call('/api/auth/wallet/verify', {
      method: 'POST',
      body: JSON.stringify({ address: w.address, message: challenge.message, signature: w.signMessage(challenge.message), walletName: 'Backpack' }),
    });
    assert.equal(verify.status, 200);
    const out = await verify.json();
    assert.equal(out.created, true);
    assert.equal(out.user.needsUsername, true);
    assert.equal(out.user.wallets[0].walletName, 'Backpack');
    cookie = (verify.headers.get('set-cookie') ?? '').split(';')[0];

    const profile = await call('/api/me/profile', { method: 'POST', body: JSON.stringify({ username: 'printer' }) });
    assert.equal((await profile.json()).username, 'printer');

    const me = await (await call('/api/me')).json();
    assert.equal(me.needsUsername, false);
    assert.equal(me.wallets.length, 1);

    const bad = await call('/api/auth/wallet/verify', { method: 'POST', body: JSON.stringify({ address: w.address, message: challenge.message, signature: 'x' }) });
    assert.equal(bad.status, 401);
  } finally {
    server.close();
  }
});
