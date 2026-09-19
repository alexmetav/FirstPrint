import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createDemoServer } from '../src/demoServer.ts';
import { MarketData } from '../src/services/marketData.ts';

test('read-only demo server exposes only health and allowlisted market data', async (t) => {
  let requests = 0;
  const marketData = new MarketData((async () => {
    requests++;
    return Response.json([{ id: 'binance' }]);
  }) as typeof fetch, () => 1_000);
  const server = createDemoServer({ marketData, now: () => 2_000 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, mode: 'read-only-demo', time: 2_000 });

  const path = encodeURIComponent('/exchanges?per_page=100&page=1');
  const data = await fetch(`${base}/api/market-data?path=${path}`);
  assert.equal(data.status, 200);
  assert.deepEqual(await data.json(), { data: [{ id: 'binance' }], updatedAt: 1_000, stale: false });
  assert.equal(requests, 1);

  assert.equal((await fetch(`${base}/api/market-data?path=${encodeURIComponent('https://example.com')}`)).status, 400);
  assert.equal((await fetch(`${base}/api/auth/wallet/challenge`)).status, 404);
  assert.equal((await fetch(`${base}/api/markets`)).status, 404);
  assert.equal((await fetch(`${base}/api/admin/ping`)).status, 404);
  assert.equal((await fetch(`${base}/api/market-data`, { method: 'POST' })).status, 405);
});
