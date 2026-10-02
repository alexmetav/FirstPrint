import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { createApiServer } from '../src/api/server.ts';

async function serve(trustProxyHops?: number) {
  const service = new FirstprintService(openDb(':memory:'), new ManualClock(Date.UTC(2026, 8, 14, 12)), []);
  const server = createApiServer({ service, adminKey: null, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname, trustProxyHops });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  /** Signup is limited to 5 per minute per visitor. Returns the HTTP status. */
  const signup = async (forwardedFor?: string) => {
    n++;
    const r = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
      body: JSON.stringify({ email: `u${n}@example.com`, username: `user_${n}`, password: 'a-long-password' }),
    });
    return r.status;
  };
  const burst = async (forwardedFor?: string) => {
    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push(await signup(forwardedFor));
    return out;
  };
  /** Six signups in a row, each with its own forwarded-for header. */
  const sixWith = async (header: (i: number) => string) => {
    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push(await signup(header(i)));
    return out;
  };
  return { burst, sixWith, close: () => server.close() };
}

test('behind one proxy, each visitor gets their own rate limit', async () => {
  const s = await serve(1);
  try {
    assert.deepEqual(await s.burst('203.0.113.1'), [200, 200, 200, 200, 200, 429]); // visitor A hits the limit
    assert.deepEqual(await s.burst('203.0.113.2'), [200, 200, 200, 200, 200, 429]); // visitor B is unaffected
  } finally {
    s.close();
  }
});

test('forged entries on the left cannot dodge the limit', async () => {
  const s = await serve(1);
  try {
    // The visitor changes the forged left entry every time; the entry the proxy added (right) never changes.
    assert.deepEqual(await s.sixWith((i) => `10.0.0.${i}, 198.51.100.7`), [200, 200, 200, 200, 200, 429]);
  } finally {
    s.close();
  }
});

test('with two proxies the visitor is the second entry from the right', async () => {
  const s = await serve(2);
  try {
    // Same visitor, a different outer proxy address each time: still one visitor.
    assert.deepEqual(await s.sixWith((i) => `192.0.2.9, 76.76.0.${i}`), [200, 200, 200, 200, 200, 429]);
    // A different visitor behind the same proxies is not affected.
    assert.equal(await s.burst('192.0.2.10, 76.76.0.1').then((r) => r[0]), 200);
  } finally {
    s.close();
  }
});

test('a header with fewer entries than proxies falls back to the connection address (not trusted)', async () => {
  const s = await serve(2);
  try {
    // One entry but two proxies expected: everyone shares the connection address, whatever they put in the header.
    assert.deepEqual(await s.sixWith((i) => `198.51.100.${i}`), [200, 200, 200, 200, 200, 429]);
  } finally {
    s.close();
  }
});

test('with no proxy configured the header is ignored, so it cannot be used to dodge limits', async () => {
  const s = await serve(0);
  try {
    assert.deepEqual(await s.sixWith((i) => `198.51.100.${i}`), [200, 200, 200, 200, 200, 429]);
  } finally {
    s.close();
  }
});
