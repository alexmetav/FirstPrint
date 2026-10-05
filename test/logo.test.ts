// Token logos on admin-run markets: an https link or a small uploaded image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.ts';
import { ManualClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import type { Venue } from '../src/exchanges/types.ts';

const HOUR = 3_600_000;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function venue(id: string, name: string): Venue {
  const boom = async () => {
    throw new Error('manual markets must not fetch prices');
  };
  return { id, name, pair: (b) => `${b}USDT`, fetchTicker: boom, fetchCandles: boom, listPairs: boom };
}

function setup() {
  const clock = new ManualClock(Date.UTC(2026, 9, 4, 12));
  const service = new FirstprintService(openDb(':memory:'), clock, [venue('mexc', 'MEXC')]);
  const create = (logoUrl?: string) =>
    service.createManualMarket({ symbol: 'xdp', exchanges: ['mexc'], basePrice: 0.02, closeAt: clock.now() + HOUR, resultAt: clock.now() + 2 * HOUR, publish: true, logoUrl });
  return { service, create };
}

test('a market keeps an https logo link or an uploaded image, and shows it', () => {
  const { service, create } = setup();
  const linked = create('https://assets.coingecko.com/coins/images/1/large/xdp.png');
  assert.equal(service.getMarket(linked).logoUrl, 'https://assets.coingecko.com/coins/images/1/large/xdp.png');
  const uploaded = create(PNG);
  // Players get a cacheable link to the image; the admin (and banners) get the stored copy.
  assert.match(service.getMarket(uploaded).logoUrl!, new RegExp(`^/api/logo/${uploaded}\\?v=\\w+$`));
  assert.equal(service.getMarket(uploaded, undefined, true).logoUrl, PNG);
  assert.deepEqual(service.logoImage(uploaded)?.bytes, Buffer.from(PNG.split(',')[1], 'base64'));
  assert.equal(service.logoImage(uploaded)?.type, 'image/png');
  assert.equal(service.getMarket(create()).logoUrl, null);
});

test('editing can change or remove the logo, and leaves it alone otherwise', () => {
  const { service, create } = setup();
  const id = create(PNG);
  service.updateManualMarket(id, { note: 'Result on MEXC' });
  assert.equal(service.getMarket(id, undefined, true).logoUrl, PNG);
  service.updateManualMarket(id, { logoUrl: 'https://example.com/x.webp' });
  assert.equal(service.getMarket(id).logoUrl, 'https://example.com/x.webp');
  service.updateManualMarket(id, { logoUrl: '' });
  assert.equal(service.getMarket(id).logoUrl, null);
});

test('unsafe or oversized logos are refused', () => {
  const { create } = setup();
  for (const bad of ['http://example.com/x.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'not a link', `data:image/png;base64,${'A'.repeat(50_000)}`]) {
    assert.throws(() => create(bad), /logo/i, bad);
  }
});

test('HTTP: lists link to the logo, unchanged lists answer 304, big answers are gzipped', async () => {
  const { createApiServer } = await import('../src/api/server.ts');
  const { request } = await import('node:http');
  const { gunzipSync } = await import('node:zlib');
  const { service, create } = setup();
  const id = create(PNG);
  for (let i = 0; i < 12; i++) create();
  const server = createApiServer({ service, secureCookies: false, webDir: new URL('../web', import.meta.url).pathname });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  // node:http, so the gzip body and 304s come through untouched.
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      request({ port, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject).end();
    });
  try {
    const first = await get('/api/markets?filter=open', { 'accept-encoding': 'gzip' });
    assert.equal(first.headers['content-encoding'], 'gzip');
    const list = JSON.parse(gunzipSync(first.body).toString());
    const logo = list.markets.find((m: { id: string }) => m.id === id).logoUrl as string;
    assert.match(logo, /^\/api\/logo\//);
    const again = await get('/api/markets?filter=open', { 'if-none-match': String(first.headers.etag) });
    assert.equal(again.status, 304, 'nothing changed: 304 even though serverTime moved on');
    const img = await get(logo);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.match(String(img.headers['cache-control']), /immutable/);
    assert.equal((await get('/api/logo/nope')).status, 404);
  } finally {
    server.close();
  }
});
