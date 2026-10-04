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
      const body = JSON.parse(String(init?.body ?? '{}'));
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
