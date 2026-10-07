import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { AppError, EMAIL_CODE_DAILY_FAILURES, FirstprintService, START_POINTS } from '../src/services/firstprint.ts';
import { createApiServer } from '../src/api/server.ts';
import { verifyGoogleIdToken } from '../src/auth/google.ts';
import type { Mailer } from '../src/auth/mailer.ts';

const T0 = Date.UTC(2026, 8, 14, 12);
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

function setup() {
  const clock = new ManualClock(T0);
  const service = new FirstprintService(openDb(':memory:'), clock, []);
  return { clock, service };
}

const codeOf = (service: FirstprintService, email: string) => service.startEmailLogin(email).code;
const failsWith = (code: string) => (e: unknown) => e instanceof AppError && e.code === code;

test('email code: sign up, then the same email signs back into the same account', () => {
  const { clock, service } = setup();
  const first = service.verifyEmailCode('Alex@Example.com', codeOf(service, 'alex@example.com'));
  assert.equal(first.created, true);
  assert.equal(first.user.email, 'alex@example.com');
  assert.match(first.user.username, /^player_[0-9a-f]{6}$/, 'a random name, never part of the email');
  assert.equal(first.user.needs_username, 1);
  assert.equal(first.user.points, START_POINTS);

  clock.advance(60_000);
  const again = service.verifyEmailCode('alex@example.com', codeOf(service, 'alex@example.com'));
  assert.equal(again.created, false);
  assert.equal(again.user.id, first.user.id);
  assert.equal(again.user.points, START_POINTS); // no second signup bonus
});

test('email code: single use, expires, wrong codes lock it, resend has a cooldown', () => {
  const { clock, service } = setup();
  let code = codeOf(service, 'a@example.com');
  service.verifyEmailCode('a@example.com', code);
  assert.throws(() => service.verifyEmailCode('a@example.com', code), failsWith('bad_code')); // used

  clock.advance(60_000);
  code = codeOf(service, 'a@example.com');
  assert.throws(() => service.startEmailLogin('a@example.com'), failsWith('code_recently_sent'));
  clock.advance(11 * 60_000);
  assert.throws(() => service.verifyEmailCode('a@example.com', code), failsWith('bad_code')); // expired

  clock.advance(60_000);
  code = codeOf(service, 'a@example.com');
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.throws(() => service.verifyEmailCode('a@example.com', wrong), failsWith('bad_code'));
  assert.throws(() => service.verifyEmailCode('a@example.com', code), failsWith('bad_code')); // locked after 5 misses

  assert.throws(() => service.startEmailLogin('not-an-email'), failsWith('bad_email'));
  assert.throws(() => service.verifyEmailCode('a@example.com', 'abcdef'), failsWith('bad_code'));
});

test('email code: a new code replaces the old one; usernames never collide; password accounts match by email', async () => {
  const { clock, service } = setup();
  const old = codeOf(service, 'pat@example.com');
  clock.advance(31_000);
  const fresh = codeOf(service, 'pat@example.com');
  if (old !== fresh) assert.throws(() => service.verifyEmailCode('pat@example.com', old), failsWith('bad_code'));
  const pat = service.verifyEmailCode('pat@example.com', fresh).user;

  const other = service.verifyEmailCode('pat@other.com', codeOf(service, 'pat@other.com')).user;
  assert.notEqual(other.username.toLowerCase(), pat.username.toLowerCase());

  const legacy = await service.createUser({ email: 'old@example.com', username: 'oldtimer', password: 'a-long-password' });
  const back = service.verifyEmailCode('old@example.com', codeOf(service, 'old@example.com'));
  assert.equal(back.created, false);
  assert.equal(back.user.id, legacy.id);
});

test('email code: wrong guesses are capped per email per day, even across fresh codes', () => {
  const { clock, service } = setup();
  const email = 'target@example.com';
  let misses = 0;
  while (misses < EMAIL_CODE_DAILY_FAILURES) {
    const code = codeOf(service, email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5 && misses < EMAIL_CODE_DAILY_FAILURES; i++, misses++) {
      assert.throws(() => service.verifyEmailCode(email, wrong), failsWith('bad_code'));
    }
    clock.advance(31_000);
  }
  // Even the right code is refused now, so asking for new codes doesn't buy more guesses.
  const code = codeOf(service, email);
  assert.throws(() => service.verifyEmailCode(email, code), failsWith('too_many_attempts'));

  clock.advance(24 * 60 * 60_000);
  assert.equal(service.verifyEmailCode(email, codeOf(service, email)).created, true); // a day later it works again
});

test('a verified sign-in takes over a password account: the password, sessions and wallets of whoever registered it are dropped', async () => {
  const { service } = setup();
  // Someone registers another person's email with a password (no proof they own it).
  const squatter = await service.createUser({ email: 'victim@example.com', username: 'squatter', password: 'a-long-password' });
  const squatterSession = service.createSession(squatter.id);
  service.db
    .prepare("INSERT INTO wallets (address, user_id, verified_at) VALUES ('SquatterWallet111111111111111111111111111111', ?, 1)")
    .run(squatter.id);

  // The real owner signs in with a code sent to that inbox.
  const owner = service.verifyEmailCode('victim@example.com', codeOf(service, 'victim@example.com'));
  assert.equal(owner.user.id, squatter.id);
  assert.equal(owner.user.password_hash, null);
  await assert.rejects(service.authenticate('victim@example.com', 'a-long-password'), /incorrect/);
  assert.equal(service.userForSession(squatterSession.token), null);
  assert.deepEqual(service.walletsFor(squatter.id), []);

  // Later verified sign-ins leave the account alone.
  const s = service.createSession(owner.user.id);
  service.signInWithVerifiedEmail('victim@example.com', null);
  assert.equal(service.userForSession(s.token)?.id, owner.user.id);
});

// --- Google -------------------------------------------------------------------------

function googleKit() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'k1' };
  const jwks = async () => ({ keys: [jwk] });
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => {
    const h = b64({ alg: 'RS256', kid: 'k1', ...header });
    const p = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '123', email: 'Sam@Gmail.com', email_verified: true, name: 'Sam Lee', exp: Math.floor(T0 / 1000) + 3600, ...claims });
    return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  };
  return { jwks, token };
}

test('google: accepts a valid token and rejects every kind of bad one', async () => {
  const { jwks, token } = googleKit();
  const check = (t: string) => verifyGoogleIdToken(t, CLIENT_ID, jwks, T0);
  assert.deepEqual(await check(token()), { email: 'sam@gmail.com', name: 'Sam Lee', sub: '123' });
  assert.deepEqual((await check(token({ iss: 'accounts.google.com' })))?.email, 'sam@gmail.com');

  assert.equal(await check(token({ aud: 'someone-else' })), null);
  assert.equal(await check(token({ iss: 'https://evil.example' })), null);
  assert.equal(await check(token({ exp: Math.floor(T0 / 1000) - 1 })), null);
  assert.equal(await check(token({ email_verified: false })), null);
  assert.equal(await check(token({ email: 'nope' })), null);
  assert.equal(await check(token({}, { kid: 'unknown' })), null);
  assert.equal(await check(token({}, { alg: 'none' })), null);
  assert.equal(await check(`${token().split('.').slice(0, 2).join('.')}.AAAA`), null); // bad signature
  assert.equal(await check('garbage'), null);

  const other = googleKit(); // signed by a different key than the one Google publishes
  assert.equal(await check(other.token()), null);
});

// --- HTTP ---------------------------------------------------------------------------

async function serve(extra: Record<string, unknown> = {}) {
  const { clock, service } = setup();
  const sent: { to: string; text: string; html?: string }[] = [];
  const mailer: Mailer = { send: async (to, _s, text, html) => void sent.push({ to, text, html }) };
  const { jwks, token } = googleKit();
  const server = createApiServer({ service, adminKey: null, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname, googleClientId: CLIENT_ID, googleJwks: jwks, mailer, ...extra });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, cookie = '') => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], json: (await r.json()) as Record<string, any> };
  };
  return { clock, service, sent, token, base, post, close: () => server.close() };
}

test('HTTP: email code sign-in end to end, and the session works', async () => {
  const s = await serve();
  try {
    const cfg = await (await fetch(`${s.base}/api/config`)).json();
    assert.deepEqual(cfg.signIn, { google: CLIENT_ID, email: true });

    const start = await s.post('/api/auth/email/start', { email: 'kim@example.com' });
    assert.equal(start.status, 200);
    assert.equal(start.json.devCode, undefined); // never leaked outside dev mode
    const code = /code is (\d{6})/.exec(s.sent[0].text)![1];
    assert.equal(s.sent[0].to, 'kim@example.com');
    assert.ok(s.sent[0].html?.includes(`>${code}</div>`), 'the styled email shows the code large');
    assert.match(s.sent[0].html!, /src="http:\/\/127\.0\.0\.1:\d+\/icon-192\.png"/, 'with the logo from the site');

    assert.equal((await s.post('/api/auth/email/verify', { email: 'kim@example.com', code: '12345' })).status, 401);
    const ok = await s.post('/api/auth/email/verify', { email: 'kim@example.com', code });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.created, true);
    assert.equal(ok.json.user.needsUsername, true);
    assert.ok(ok.cookie.startsWith('fp_session='), ok.cookie);
    const me = await (await fetch(`${s.base}/api/me`, { headers: { cookie: ok.cookie } })).json();
    assert.match(me.username ?? me.user?.username, /^player_[0-9a-f]{6}$/);
  } finally {
    s.close();
  }
});

test('HTTP: dev mode returns the code; no mailer means email sign-in is off', async () => {
  const dev = await serve({ devEmailCodes: true });
  try {
    const start = await dev.post('/api/auth/email/start', { email: 'dev@example.com' });
    assert.match(start.json.devCode, /^\d{6}$/);
    assert.equal((await dev.post('/api/auth/email/verify', { email: 'dev@example.com', code: start.json.devCode })).status, 200);
  } finally {
    dev.close();
  }
  const off = await serve({ mailer: null, googleClientId: null });
  try {
    assert.deepEqual((await (await fetch(`${off.base}/api/config`)).json()).signIn, { google: null, email: false });
    assert.equal((await off.post('/api/auth/email/start', { email: 'x@example.com' })).status, 503);
    assert.equal((await off.post('/api/auth/google', { credential: 'x' })).status, 503);
  } finally {
    off.close();
  }
});

test('HTTP: Google sign-in creates the account once; email code and Google reach the same account', async () => {
  const s = await serve();
  try {
    const bad = await s.post('/api/auth/google', { credential: 'garbage' });
    assert.equal(bad.status, 401);

    // The test token expires an hour after T0, so sign in while the clock-independent check still passes.
    const real = s.token({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const g = await s.post('/api/auth/google', { credential: real });
    assert.equal(g.status, 200);
    assert.equal(g.json.created, true);
    assert.equal(g.json.user.points, START_POINTS);
    const again = await s.post('/api/auth/google', { credential: real });
    assert.equal(again.json.created, false);
    assert.equal(again.json.user.id, g.json.user.id);

    // Same email via a one-time code lands in the same account.
    await s.post('/api/auth/email/start', { email: 'sam@gmail.com' });
    const code = /code is (\d{6})/.exec(s.sent.at(-1)!.text)![1];
    const viaEmail = await s.post('/api/auth/email/verify', { email: 'sam@gmail.com', code });
    assert.equal(viaEmail.json.user.id, g.json.user.id);
    assert.equal(viaEmail.json.created, false);
  } finally {
    s.close();
  }
});

test('HTTP: a per-network cap on new accounts a day (NEW_ACCOUNTS_PER_DAY); existing accounts still sign in', async () => {
  const s = await serve({ newAccountsPerDay: 10 });
  try {
    const signIn = (email: string) => s.post('/api/auth/email/verify', { email, code: s.service.startEmailLogin(email).code });
    for (let i = 0; i < 10; i++) assert.equal((await signIn(`p${i}@example.com`)).status, 200);
    const eleventh = await signIn('p10@example.com');
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.json.error, 'too_many_accounts');
    assert.equal((await signIn('p3@example.com')).status, 200, 'signing back in is never limited');
    // Kept in the database (a restart doesn't reset it), as a hash, never the address itself.
    const rows = s.service.db.prepare('SELECT network FROM signups').all() as { network: string }[];
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => /^[0-9a-f]{32}$/.test(r.network) && !r.network.includes('127')));
    // A day later the network can make new accounts again.
    s.clock.advance(24 * 60 * 60_000 + 1);
    assert.equal((await signIn('p10@example.com')).status, 200);
  } finally {
    s.close();
  }
});
