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
  const server = createApiServer({ service, adminKey: 'secret', secureCookies: false,
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
