import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { createApiServer, ipBucket } from '../src/api/server.ts';

const LIMIT = 10;
const LIMITED = [...Array(LIMIT).fill(401), 429];

async function serve(trustProxyHops?: number) {
  const service = new FirstprintService(openDb(':memory:'), new ManualClock(Date.UTC(2026, 8, 14, 12)), []);
  const server = createApiServer({ service, adminKey: null, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname, trustProxyHops });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  /** Log-in attempts are limited to 10 per minute per visitor. Returns the HTTP status (401 = wrong password, 429 = limited). */
  const attempt = async (forwardedFor?: string) => {
    n++;
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
      body: JSON.stringify({ email: `u${n}@example.com`, password: 'a-long-password' }),
    });
    return r.status;
  };
  const burst = async (forwardedFor?: string) => {
    const out: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) out.push(await attempt(forwardedFor));
    return out;
  };
  /** One attempt over the limit, each with its own forwarded-for header. */
  const overLimitWith = async (header: (i: number) => string) => {
    const out: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) out.push(await attempt(header(i)));
    return out;
  };
  return { burst, overLimitWith, close: () => server.close() };
}

test('behind one proxy, each visitor gets their own rate limit', async () => {
  const s = await serve(1);
  try {
    assert.deepEqual(await s.burst('203.0.113.1'), LIMITED); // visitor A hits the limit
    assert.deepEqual(await s.burst('203.0.113.2'), LIMITED); // visitor B is unaffected
  } finally {
    s.close();
  }
});

test('forged entries on the left cannot dodge the limit', async () => {
  const s = await serve(1);
  try {
    // The visitor changes the forged left entry every time; the entry the proxy added (right) never changes.
    assert.deepEqual(await s.overLimitWith((i) => `10.0.0.${i}, 198.51.100.7`), LIMITED);
  } finally {
    s.close();
  }
});

test('with two proxies the visitor is the second entry from the right', async () => {
  const s = await serve(2);
  try {
    // Same visitor, a different outer proxy address each time: still one visitor.
    assert.deepEqual(await s.overLimitWith((i) => `192.0.2.9, 76.76.0.${i}`), LIMITED);
    // A different visitor behind the same proxies is not affected.
    assert.equal(await s.burst('192.0.2.10, 76.76.0.1').then((r) => r[0]), 401);
  } finally {
    s.close();
  }
});

test('a header with fewer entries than proxies falls back to the connection address (not trusted)', async () => {
  const s = await serve(2);
  try {
    // One entry but two proxies expected: everyone shares the connection address, whatever they put in the header.
    assert.deepEqual(await s.overLimitWith((i) => `198.51.100.${i}`), LIMITED);
  } finally {
    s.close();
  }
});

test('with no proxy configured the header is ignored, so it cannot be used to dodge limits', async () => {
  const s = await serve(0);
  try {
    assert.deepEqual(await s.overLimitWith((i) => `198.51.100.${i}`), LIMITED);
  } finally {
    s.close();
  }
});

test('IPv6 visitors are grouped by /64, so rotating addresses inside one network cannot dodge limits', async () => {
  const s = await serve(1);
  try {
    assert.deepEqual(await s.overLimitWith((i) => `2001:db8:1:2::${i + 1}`), LIMITED);
    assert.equal(await s.burst('2001:db8:1:3::1').then((r) => r[0]), 401); // another /64 is someone else
  } finally {
    s.close();
  }
});

test('ipBucket', () => {
  assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
  assert.equal(ipBucket('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(ipBucket('2001:DB8:0001:0002::1'), '2001:db8:1:2::/64');
  assert.equal(ipBucket('::1'), '0:0:0:0::/64');
  assert.equal(ipBucket('not an ip'), 'not an ip');
});

test('an empty TRUST_PROXY_HOPS (as in .env.example) means the default, not zero', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const prod = { NODE_ENV: 'production', ADMIN_KEY: 'x'.repeat(24), PUBLIC_URL: 'https://example.test' };
  assert.equal(loadConfig({ ...prod, TRUST_PROXY_HOPS: '' }).trustProxyHops, 1);
  assert.equal(loadConfig({ ...prod, TRUST_PROXY_HOPS: '2' }).trustProxyHops, 2);
  assert.equal(loadConfig({ TRUST_PROXY_HOPS: '' }).trustProxyHops, 0);
});
