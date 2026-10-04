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
