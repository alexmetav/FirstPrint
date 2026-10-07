import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { createApiServer } from '../src/api/server.ts';
import type { Venue } from '../src/exchanges/types.ts';

const T0 = Date.UTC(2026, 9, 6, 12);
const HOUR = 3_600_000;
const venue: Venue = {
  id: 'mexc',
  name: 'MEXC',
  pair: (b: string) => `${b}USDT`,
  fetchTicker: async () => null,
  fetchCandles: async () => [],
  listPairs: async () => [],
} as unknown as Venue;

test('public API (read-only): markets, upcoming tokens and the leaderboard, with public fields only', async () => {
  const clock = new ManualClock(T0);
  const service = new FirstprintService(openDb(':memory:'), clock, [venue]);
  const server = createApiServer({ service, adminKey: null, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname, publicUrl: 'https://firstprint.test' });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const r = await fetch(base + path);
    return { status: r.status, cors: r.headers.get('access-control-allow-origin'), cache: r.headers.get('cache-control'), json: (await r.json()) as Record<string, any> };
  };
  try {
    const priced = service.createManualMarket({ symbol: 'ABC', name: 'Alpha', exchanges: ['mexc'], basePrice: 2, closeAt: T0 + 2 * HOUR, resultAt: T0 + 48 * HOUR, publish: true } as never);
    const soon = service.createManualMarket({ symbol: 'NEW', exchanges: ['mexc'], basePrice: null, closeAt: T0 + 5 * HOUR, resultAt: T0 + 72 * HOUR, publish: true } as never);
    service.createManualMarket({ symbol: 'DRAFT', exchanges: ['mexc'], basePrice: 1, closeAt: T0 + 2 * HOUR, resultAt: T0 + 48 * HOUR } as never);
    const u = await service.createUser({ email: 'secret@example.com', username: 'alice' });
    service.placePrediction(priced, u.id, 'up', 100);

    // The app's scripts are never kept by Cloudflare (a deploy must show at once); images may be.
    const script = await fetch(`${base}/app.js`);
    assert.equal(script.headers.get('cloudflare-cdn-cache-control'), 'no-store');
    assert.equal(script.headers.get('cache-control'), 'no-cache');
    // Each module is named with a fingerprint of its content, so a deploy changes the addresses.
    const appJs = await script.text();
    assert.match(appJs, /from '\.\/api\.js\?v=[\w-]{10}'/);
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /<script type="module" src="\.\/app\.js\?v=[\w-]{10}"><\/script>/);
    assert.match(page, /href="\.\/styles\.css\?v=[\w-]{10}"/);
    const v = /app\.js\?v=([\w-]{10})/.exec(page)![1];
    assert.equal((await fetch(`${base}/app.js?v=${v}`)).status, 200);

    const index = await get('/api/v1');
    assert.equal(index.status, 200);
    assert.equal(index.cors, '*', 'any site may call it');
    assert.equal(index.json.docs, 'https://firstprint.test/api.html');
    assert.equal(index.cache, 'public, max-age=15', 'the same for everyone, so Cloudflare may keep it briefly');

    const open = await get('/api/v1/markets');
    assert.equal(open.status, 200);
    assert.deepEqual(open.json.markets.map((m: any) => m.token.symbol).sort(), ['ABC', 'NEW'], 'drafts are never public');
    const abc = open.json.markets.find((m: any) => m.token.symbol === 'ABC');
    assert.equal(abc.status, 'open');
    assert.equal(abc.pool, 100);
    assert.equal(abc.participants, 1);
    assert.equal(abc.url, `https://firstprint.test/app/#/market/${priced}`);
    assert.equal(abc.outcomes.length, 5);
    const up = abc.outcomes.find((o: any) => o.outcome === 'up');
    assert.deepEqual([up.pool, up.share, up.range], [100, 1, '+10% to +50%']);
    assert.equal(abc.predictionsClose, new Date(T0 + 2 * HOUR).toISOString());
    const text = JSON.stringify(open.json);
    for (const leak of ['secret@example.com', u.id, 'mine', 'alice']) assert.ok(!text.includes(leak), `no ${leak} in market data`);

    const upcoming = await get('/api/v1/upcoming');
    assert.deepEqual(upcoming.json.markets.map((m: any) => [m.token.symbol, m.upcoming, m.startPriceFrom]), [['NEW', true, 'opening_price']]);

    const one = await get(`/api/v1/markets/${priced}`);
    assert.equal(one.json.token.name, 'Alpha');
    const missing = await get('/api/v1/markets/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.cache, 'no-store', 'errors are never cached');
    assert.equal((await get('/api/v1/markets?status=bogus')).status, 400);
    assert.equal((await get('/api/v1/markets?status=settled')).json.count, 0);

    const board = await get('/api/v1/leaderboard?period=all');
    assert.equal(board.status, 200);
    assert.deepEqual(board.json.entries, []);
    assert.equal(board.json.seasonStart, null);
    assert.equal((await get('/api/v1/leaderboard?period=year')).status, 400);
    void soon;
  } finally {
    server.close();
  }
});

test('public API: a total cap per minute, so callers on many addresses cannot load the server', async () => {
  const service = new FirstprintService(openDb(':memory:'), new ManualClock(T0), [venue]);
  const server = createApiServer({ service, adminKey: null, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname, publicApiPerMinute: 3 });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${base}/api/v1`)).status);
    assert.deepEqual(codes, [200, 200, 200, 429]);
    const app = await fetch(`${base}/api/markets`);
    assert.equal(app.status, 200, "the app's own routes don't count");
  } finally {
    server.close();
  }
});
