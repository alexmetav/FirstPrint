import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/db.ts';
import { systemClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { createApiServer } from '../src/api/server.ts';

test('API rejects bad inputs and cross-origin writes without crashing', async (t) => {
  const db = openDb(':memory:');
  const service = new FirstprintService(db, systemClock, []);
  const server = createApiServer({ service, adminKey: 'secret', secureCookies: false, trustProxy: 0,
    publicUrl: 'https://firstprint.example', webDir: fileURLToPath(new URL('../web/', import.meta.url)) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); db.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const path of ['/api/markets/%ZZ', '/%ZZ']) {
    assert.equal((await fetch(base + path)).status, 400);
  }
  assert.equal((await fetch(base + '/api/me', { headers: { cookie: 'fp_session=%ZZ' } })).status, 401);
  assert.equal((await fetch(base + '/api/admin/ping', { headers: { 'x-admin-key': 'éééééé' } })).status, 403);
  assert.equal((await fetch(base + '/api/auth/logout', {
    method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: '{}',
  })).status, 403);
  assert.equal((await fetch(base + '/api/market-data?path=https://example.com')).status, 400);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/api/listings/detected')).status, 200);
});

test('behind a proxy, rate limits follow the forwarded client and resist forged hops', async (t) => {
  const db = openDb(':memory:');
  const service = new FirstprintService(db, systemClock, []);
  // One trusted proxy, as on Render / Vercel / behind Cloudflare.
  const server = createApiServer({ service, adminKey: 'secret', secureCookies: false, trustProxy: 1,
    publicUrl: 'https://firstprint.example', webDir: fileURLToPath(new URL('../web/', import.meta.url)) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); db.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The signup limiter allows 5 per minute per client.
  const signup = (xff: string, n: number) =>
    fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify({ email: `u${n}@example.com`, username: `user${n}`, password: 'password123' }),
    });

  // Burn one client's budget. Later attempts are throttled.
  const first = [];
  for (let n = 0; n < 6; n++) first.push((await signup('203.0.113.9', n)).status);
  assert.equal(first.filter((s) => s === 429).length, 1, 'sixth signup from one IP is throttled');

  // A different visitor behind the same proxy is unaffected. This is the
  // regression: keying on the socket address made every user share one bucket.
  assert.notEqual((await signup('198.51.100.4', 100)).status, 429);

  // A client prepending its own X-Forwarded-For entry cannot escape its bucket:
  // counting from the right ignores anything the caller forged on the left.
  assert.equal((await signup('198.51.100.7, 203.0.113.9', 101)).status, 429);
  db.prepare('SELECT 1').get();
});
