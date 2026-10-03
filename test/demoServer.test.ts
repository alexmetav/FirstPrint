import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createDemoServer } from '../src/demoServer.ts';

test('read-only demo server exposes only its health check', async (t) => {
  const server = createDemoServer({ now: () => 2_000 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, mode: 'read-only-demo', time: 2_000 });

  assert.equal((await fetch(`${base}/api/market-data?path=${encodeURIComponent('/search/trending')}`)).status, 404);
  assert.equal((await fetch(`${base}/api/auth/wallet/challenge`)).status, 404);
  assert.equal((await fetch(`${base}/api/markets`)).status, 404);
  assert.equal((await fetch(`${base}/api/admin/ping`)).status, 404);
  assert.equal((await fetch(`${base}/api/health`, { method: 'POST' })).status, 405);
});
