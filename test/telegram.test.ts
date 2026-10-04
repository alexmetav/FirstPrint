import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram, newListingText, resultDueText } from '../src/services/telegram.ts';

function fakeTelegram(updates: unknown[], ok = true) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let chat: string | null = null;
  const t = new Telegram(
    'SECRET-TOKEN',
    { get: () => chat, set: (id) => (chat = id) },
    async (url, init) => {
      const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      if (!ok) return new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 });
      return new Response(JSON.stringify({ ok: true, result: url.endsWith('/getUpdates') ? updates : {} }));
    },
  );
  return { t, calls, chat: () => chat };
}

test('telegram: links the chat that sent the code, then sends to it', async () => {
  const { t, calls, chat } = fakeTelegram([
    { message: { text: '/start', chat: { id: 111 } } },
    { message: { text: 'FP-123456', chat: { id: 222 } } },
  ]);
  assert.equal(await t.send('hi'), false, 'nothing is sent before a chat is linked');
  assert.equal(await t.connect('FP-999999'), false);
  assert.equal(await t.connect('FP-123456'), true);
  assert.equal(chat(), '222');
  assert.equal(await t.send('<b>hi</b>'), true);
  const last = calls[calls.length - 1];
  assert.match(last.url, /\/sendMessage$/);
  assert.deepEqual([last.body.chat_id, last.body.parse_mode], ['222', 'HTML']);
});

test('telegram: errors never include the bot token', async () => {
  const { t } = fakeTelegram([], false);
  await assert.rejects(t.connect('FP-123456'), (err: Error) => err.message === 'Telegram: Unauthorized' && !err.message.includes('SECRET'));
});

test('telegram: alert texts', () => {
  const now = Date.UTC(2026, 9, 5, 10, 0);
  const text = newListingText({ symbol: 'AGENCY', name: 'Agency <AI>', exchangeName: 'MEXC', listingAt: now + 90 * 60_000 }, 'https://firstprint.fun/app/#/admin', now);
  assert.match(text, /New MEXC listing: AGENCY \(Agency &lt;AI&gt;\)/);
  assert.match(text, /Trading starts 2026-10-05 11:30 UTC \(in 1h 30m\)/);
  assert.match(newListingText({ symbol: 'X', name: null, exchangeName: 'MEXC', listingAt: now - 20 * 60_000 }, 'u', now), /Trading started .* \(20m ago\)/);
  assert.match(resultDueText({ symbol: 'PNT', basePrice: null, pool: 1500, predictors: 3 }, 'u'), /no start price yet[\s\S]*1,500 pts from 3 predictors/);
});

test('telegram: channel names and channel posts', async () => {
  const { channelName, marketLiveText, marketResultText } = await import('../src/services/telegram.ts');
  assert.equal(channelName('@firstprint_markets'), 'firstprint_markets');
  assert.equal(channelName('https://t.me/firstprint_markets'), 'firstprint_markets');
  assert.equal(channelName('fp'), null);
  assert.equal(channelName('@bad name'), null);

  const base = { symbol: 'AGENCY', name: 'Agency', exchange: 'MEXC', outcomes: 'ladder', basePrice: 0.0421, closeAt: Date.UTC(2026, 9, 5, 12), settleAt: Date.UTC(2026, 9, 8, 12) };
  const live = marketLiveText(base);
  assert.match(live, /New market: AGENCY \(Agency\)/);
  assert.match(live, /Start price: \$0\.0421/);
  assert.match(live, /Predictions close: 5 Oct, 12:00 UTC/);
  assert.match(marketLiveText({ ...base, basePrice: null }), /Lists on MEXC around 5 Oct, 12:00 UTC/);
  assert.match(marketLiveText({ ...base, outcomes: 'binary' }), /Will AGENCY be at or above \$0\.0421 on MEXC\?/);

  const res = marketResultText({ ...base, result: { winningBucket: 'up', returnPct: 0.234, basePrice: 0.0421, finalPrice: 0.052, pool: 1500 } });
  assert.match(res!, /AGENCY result: Up/);
  assert.match(res!, /\$0\.0421 → \$0\.052 \(\+23\.4%\)/);
  assert.equal(marketResultText({ ...base, result: null }), null);
});

test('channel: posts open markets not posted yet, then a single last-hour reminder', async () => {
  const { openDb } = await import('../src/db/db.ts');
  const { ManualClock } = await import('../src/clock.ts');
  const { FirstprintService } = await import('../src/services/firstprint.ts');
  const { ChannelPoster } = await import('../src/services/channel.ts');
  const HOUR = 3_600_000;
  const T0 = Date.UTC(2026, 9, 5, 8);
  const clock = new ManualClock(T0);
  const boom = async () => {
    throw new Error('no exchange calls');
  };
  const service = new FirstprintService(openDb(':memory:'), clock, [{ id: 'mexc', name: 'MEXC', pair: (b: string) => `${b}USDT`, fetchTicker: boom, fetchCandles: boom, listPairs: boom }]);
  const posts: string[] = [];
  const { t } = fakeTelegram([]);
  t.sendTo = async (chat: string, html: string) => void posts.push(`${chat} ${html.split('\n')[0]}`);
  t.sendPhotoTo = async (chat: string, png: Uint8Array, html: string) => void posts.push(`${chat} [banner ${png.length > 1000 ? 'ok' : 'empty'}] ${html.split('\n')[0]}`);
  const channel = new ChannelPoster(service, t, 'https://x/app/', () => {}, 0);
  const make = (symbol: string, closeIn: number) =>
    service.createManualMarket({ symbol, exchanges: ['mexc'], basePrice: 1, closeAt: T0 + closeIn, resultAt: T0 + closeIn + 24 * HOUR, publish: true });

  const long = make('LONG', 5 * HOUR);
  make('SHORT', 90 * 60_000); // open for only 1.5 hours: no reminder
  service.createManualMarket({ symbol: 'DRAFT', exchanges: ['mexc'], basePrice: 1, closeAt: T0 + 5 * HOUR, resultAt: T0 + 30 * HOUR });

  assert.throws(() => channel.postAllOpen(), /No player channel/);
  service.setSetting('telegram_channel', 'firstprintfun');
  assert.equal(channel.postAllOpen(), 2);
  await channel.later(async () => {});
  assert.deepEqual(posts, ['@firstprintfun [banner ok] 🟢 <b>New market: SHORT</b>', '@firstprintfun [banner ok] 🟢 <b>New market: LONG</b>'], 'soonest to close first, with the banner');
  assert.equal(channel.postAllOpen(), 0, 'already posted');

  clock.advance(4 * HOUR + 10 * 60_000); // LONG closes in 50 minutes
  channel.remindClosing();
  channel.remindClosing();
  await channel.later(async () => {});
  assert.deepEqual(posts.slice(2), ['@firstprintfun ⏳ <b>Last hour: LONG</b>']);
  assert.equal(service.getMarket(long).symbol, 'LONG');
});

test('telegram: a banner post sends the image, caption and button as one photo', async () => {
  const { t, calls } = fakeTelegram([]);
  await t.sendPhotoTo('@chan', new Uint8Array([137, 80, 78, 71]), '<b>New</b>', { text: 'Predict now', url: 'https://x/m' });
  const c = calls[0];
  assert.match(c.url, /\/sendPhoto$/);
  assert.equal(c.body.chat_id, '@chan');
  assert.equal(c.body.caption, '<b>New</b>');
  assert.equal(c.body.parse_mode, 'HTML');
  assert.ok(c.body.photo instanceof Blob);
  assert.deepEqual(JSON.parse(String(c.body.reply_markup)), { inline_keyboard: [[{ text: 'Predict now', url: 'https://x/m' }]] });
});
