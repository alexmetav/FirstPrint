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
  const link = 'https://firstprint.fun/app/#/market/agency-m-abc123';
  const live = marketLiveText(base, link);
  assert.ok(live.startsWith('<b>$AGENCY</b> · Agency\n🟢 <b>New market listed</b>'), 'the ticker comes first');
  assert.match(live, /Start price: \$0\.0421/);
  assert.match(live, /Predictions close: 5 Oct, 12:00 UTC/);
  assert.ok(live.endsWith(`👉 <b>Predict now:</b> <a href="${link}">${link}</a>`), 'ends with the link to the market');
  assert.match(marketLiveText({ ...base, basePrice: null }), /Upcoming[\s\S]*Start price: the opening price at listing/);
  assert.match(marketLiveText({ ...base, outcomes: 'binary' }), /Will \$AGENCY be at or above \$0\.0421 on MEXC\?/);
  assert.match(marketLiveText({ ...base, exchange: 'Binance, MEXC, Bybit, OKX, Gate, Bitget, and KuCoin' }), /on Binance \+6 more\?/);
  assert.doesNotMatch(marketLiveText(base), /href/, 'no link given: no link line');

  const res = marketResultText({ ...base, predictors: 23, result: { winningBucket: 'up', returnPct: 0.234, basePrice: 0.0421, finalPrice: 0.052, pool: 1500 } }, link);
  assert.match(res!, /^<b>\$AGENCY<\/b> · Agency\n🏁 <b>Result: Up wins · \+23\.4%<\/b>/);
  assert.match(res!, /\$0\.0421 → \$0\.052/);
  assert.match(res!, /23 predictors · 1,500 pts paid to the winners/);
  assert.match(res!, /See the result:/);
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
  const lines = (html: string) => html.split('\n').slice(0, 2).join(' | ');
  t.sendTo = async (chat: string, html: string) => void posts.push(`${chat} ${lines(html)}`);
  t.sendPhotoTo = async (chat: string, png: Uint8Array, html: string) => void posts.push(`${chat} [banner ${png.length > 1000 ? 'ok' : 'empty'}] ${lines(html)}`);
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
  assert.deepEqual(posts, ['@firstprintfun [banner ok] <b>$SHORT</b> | 🟢 <b>New market listed</b>', '@firstprintfun [banner ok] <b>$LONG</b> | 🟢 <b>New market listed</b>'], 'soonest to close first, with the banner');
  assert.equal(channel.postAllOpen(), 0, 'already posted');
  assert.equal(channel.postAllOpen(true), 2, 'posting again includes posted ones');
  await channel.later(async () => {});
  posts.splice(2);

  clock.advance(4 * HOUR + 10 * 60_000); // LONG closes in 50 minutes
  channel.remindClosing();
  channel.remindClosing();
  await channel.later(async () => {});
  assert.deepEqual(posts.slice(2), ['@firstprintfun [banner ok] <b>$LONG</b> | ⏳ <b>Last hour to predict</b>'], 'token banners are on by default');

  // A ticker the banner font can't draw: the fixed banner, never a broken image.
  const cn = service.createManualMarket({ symbol: '币安人生', exchanges: ['mexc'], basePrice: 1, closeAt: T0 + 30 * HOUR, resultAt: T0 + 80 * HOUR, publish: true });
  let photo: Uint8Array | null = null;
  const send = t.sendPhotoTo;
  t.sendPhotoTo = async (chat: string, png: Uint8Array, html: string) => {
    photo = png;
    return send(chat, png, html);
  };
  await channel.postLive(cn);
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(Buffer.from(photo!), readFileSync(new URL('../assets/telegram/new-market.png', import.meta.url)), 'fixed banner');

  // Switched off in Settings: new markets get the fixed banner again.
  service.setTokenBanners(false);
  assert.equal(service.tokenBannersEnabled(), false);
  await channel.postLive(long);
  assert.deepEqual(Buffer.from(photo!), readFileSync(new URL('../assets/telegram/new-market.png', import.meta.url)));
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

test('channel: a failed last-hour reminder is tried again; re-publishing does not post twice', async () => {
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
  service.setSetting('telegram_channel', 'firstprintfun');
  const sent: string[] = [];
  let fail = false;
  const { t } = fakeTelegram([]);
  t.sendTo = async (_c: string, html: string) => {
    if (fail) throw new Error('Telegram: Too Many Requests');
    sent.push(html.split('\n').slice(0, 2).join(' '));
  };
  t.sendPhotoTo = async (_c: string, _p: Uint8Array, html: string) => {
    if (fail) throw new Error('Telegram: Too Many Requests');
    sent.push(html.split('\n').slice(0, 2).join(' '));
  };
  const channel = new ChannelPoster(service, t, 'https://x/app/', () => {}, 0);
  const announced: string[] = [];
  service.onAnnounce = (kind, id) => void announced.push(`${kind}:${id}`);

  const id = service.createManualMarket({ symbol: 'LONG', exchanges: ['mexc'], basePrice: 1, closeAt: T0 + 5 * HOUR, resultAt: T0 + 30 * HOUR, publish: true });
  await new Promise((r) => setTimeout(r, 0));
  await channel.postLive(id);
  service.unpublishMarket(id);
  service.publishMarket(id);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(announced.length, 1, 'published again: no second "new market" post');

  clock.advance(4 * HOUR + 10 * 60_000);
  fail = true;
  channel.remindClosing();
  await channel.later(async () => {});
  assert.deepEqual(sent.filter((s) => s.includes('Last hour')), [], 'first try failed');
  fail = false;
  channel.remindClosing();
  await channel.later(async () => {});
  channel.remindClosing();
  await channel.later(async () => {});
  assert.equal(sent.filter((s) => s.includes('Last hour')).length, 1, 'sent once on the retry');
});

test('banners: each market gets its own PNG for new market, last hour and result, with or without a logo', async () => {
  const { renderBanner, bannerSvg } = await import('../src/services/banner.ts');
  const m = { symbol: 'AGENCY', name: 'Agency <x>', exchange: 'MEXC', outcomes: 'ladder', basePrice: 0.0421, closeAt: Date.UTC(2026, 9, 5, 12), settleAt: Date.UTC(2026, 9, 8, 12), pool: 1450, predictors: 3 };
  const isPng = (b: Uint8Array) => b.length > 1000 && b[0] === 0x89 && b[1] === 0x50;
  // A 1×1 PNG as the logo.
  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.ok(isPng(renderBanner('live', m, logo)));
  assert.ok(isPng(renderBanner('closing', m, null)));
  assert.ok(isPng(renderBanner('result', { ...m, result: { winningBucket: 'up', returnPct: 0.2, basePrice: 1, finalPrice: 1.2, pool: 100 } })));
  const svg = bannerSvg('live', m, null);
  assert.match(svg, />AGENCY</);
  assert.match(svg, /New Market Listed/);
  assert.match(svg, />LIVE</);
  assert.match(bannerSvg('live', { ...m, basePrice: null }), />UPCOMING</, 'no start price yet: upcoming');
  assert.doesNotMatch(svg, /Moon or Crash/, 'no slogans');
  const res = bannerSvg('result', { ...m, predictors: 23, result: { winningBucket: 'up', returnPct: 0.234, basePrice: 1, finalPrice: 1.234, pool: 1450 } });
  assert.match(res, />\+23\.4%</, 'the move is the headline');
  assert.match(res, />23</, 'how many predicted');
  assert.doesNotMatch(res, /New Market Listed/);
  assert.match(svg, /Agency &lt;x&gt;/, 'names are escaped');
  assert.match(svg, /5 Oct, 12:00 UTC/);
  assert.ok(isPng(renderBanner('live', { ...m, logoUrl: 'x' } as typeof m, 'data:image/webp;base64,AAAA')), 'a non-PNG logo falls back to the letter');

  // Text the font can't draw never reaches the image.
  assert.throws(() => renderBanner('live', { ...m, symbol: '币安人生' }), /can't draw/);
  assert.doesNotMatch(bannerSvg('live', { ...m, name: '币安人生 Token' }), /币安/, 'a Chinese name is left off');
  // Many exchanges fit on one line.
  assert.match(bannerSvg('live', { ...m, exchange: 'Binance, MEXC, Bybit, OKX, Gate, Bitget, and KuCoin' }), /on Binance \+6 more/);
  assert.match(bannerSvg('live', { ...m, exchange: 'MEXC and Gate' }), /on MEXC and Gate/);
});
