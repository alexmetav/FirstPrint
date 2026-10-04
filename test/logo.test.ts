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
  assert.equal(service.getMarket(uploaded).logoUrl, PNG);
  assert.equal(service.getMarket(create()).logoUrl, null);
});

test('editing can change or remove the logo, and leaves it alone otherwise', () => {
  const { service, create } = setup();
  const id = create(PNG);
  service.updateManualMarket(id, { note: 'Result on MEXC' });
  assert.equal(service.getMarket(id).logoUrl, PNG);
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
