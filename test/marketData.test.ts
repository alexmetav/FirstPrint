import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketData } from '../src/services/marketData.ts';

test('market data combines concurrent requests and retains original timestamp during outages', async () => {
  let time = 1_000;
  let requests = 0;
  let fail = false;
  const upstream = (async () => {
    requests++;
    if (fail) throw new Error('offline');
    return Response.json([{ id: 'binance' }]);
  }) as typeof fetch;
  const cache = new MarketData(upstream, () => time);
  const path = '/exchanges?per_page=100&page=1';
  const first = await Promise.all([cache.get(path), cache.get(path), cache.get(path)]);
  assert.equal(requests, 1);
  assert.deepEqual(first[0], { data: [{ id: 'binance' }], updatedAt: 1000, stale: false });
  time += 61_000;
  fail = true;
  assert.deepEqual(await cache.get(path), { data: [{ id: 'binance' }], updatedAt: 1000, stale: true });
  await cache.get(path);
  assert.equal(requests, 2, 'failed upstream requests have a cooldown');
  time += 3_600_000;
  await assert.rejects(cache.get(path), /unavailable/);
});

test('market data refuses arbitrary URLs and unsupported queries before any network request', async () => {
  const cache = new MarketData((async () => { throw new Error('Must not fetch'); }) as typeof fetch);
  for (const path of ['https://example.com', '/exchanges/../../admin', '/exchanges?per_page=9999', '/exchanges/unknown']) {
    await assert.rejects(cache.get(path), /Unsupported/);
  }
});
