import test from 'node:test';
import assert from 'node:assert/strict';
import { MexcFocusWorker } from '../src/workers/mexcFocus.ts';

test('MEXC focus worker syncs USDT pairs and settles due markets without exposing its key', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const worker = new MexcFocusWorker({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'server-secret',
    now: () => Date.parse('2026-09-20T12:00:00Z'),
    fetch: (async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/exchangeInfo')) return Response.json({ symbols: [
        { symbol: 'NEWUSDT', baseAsset: 'NEW', quoteAsset: 'USDT' },
        { symbol: 'NEWBTC', baseAsset: 'NEW', quoteAsset: 'BTC' },
      ] });
      if (url.endsWith('/ticker/price')) return Response.json([{ symbol: 'NEWUSDT', price: '1.25' }]);
      if (url.includes('/rpc/fp_admin_sync_mexc_pairs')) return Response.json({ baseline: false, created: 1 });
      if (url.includes('/fp_markets?')) return Response.json([{ id: 'market-1', pair: 'NEWUSDT' }]);
      if (url.includes('/rpc/fp_admin_settle_mexc_market')) return Response.json(null);
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  });

  assert.deepEqual(await worker.run(true), {
    configured: true, pairsSeen: 1, marketsCreated: 1, marketsSettled: 1, baseline: false,
  });
  const syncBody = JSON.parse(String(calls.find((call) => call.url.includes('sync_mexc'))?.init?.body));
  assert.deepEqual(syncBody.p_pairs, [{ pair: 'NEWUSDT', base: 'NEW', price: 1.25 }]);
  assert.ok(calls.filter((call) => call.url.includes('project.supabase.co')).every((call) =>
    (call.init?.headers as Record<string, string>).authorization === 'Bearer server-secret'));
  assert.ok(!JSON.stringify(await worker.run()).includes('server-secret'));
});

test('MEXC focus worker is inert without the server-only Supabase credential', async () => {
  const worker = new MexcFocusWorker({ supabaseUrl: 'https://project.supabase.co' });
  assert.deepEqual(await worker.run(true), { configured: false });
});
