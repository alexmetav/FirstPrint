/**
 * Telegram alerts for the admin. The bot token comes from TELEGRAM_BOT_TOKEN on the server.
 * The chat to write to is found by asking the admin to send the bot a short code, so nobody
 * else who finds the bot can link themselves.
 */
export type TelegramFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class Telegram {
  private token: string;
  private fetchImpl: TelegramFetch;
  getChat: () => string | null;
  setChat: (id: string | null) => void;

  constructor(token: string, store: { get: () => string | null; set: (id: string | null) => void }, fetchImpl: TelegramFetch = fetch) {
    this.token = token;
    this.getChat = store.get;
    this.setChat = store.set;
    this.fetchImpl = fetchImpl;
  }

  get connected() {
    return Boolean(this.getChat());
  }

  private async call(method: string, body: Record<string, unknown>) {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
    // Never echo the URL: it contains the bot token.
    if (!data.ok) throw new Error(data.description ? `Telegram: ${data.description}` : `Telegram answered ${res.status}`);
    return data.result;
  }

  /** Sends to the linked chat. Does nothing until a chat is linked. */
  async send(html: string) {
    const chat = this.getChat();
    if (!chat) return false;
    await this.call('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  }

  /** Posts to any chat the bot can write to, e.g. the public channel (@name). Optional link button underneath. */
  async sendTo(chat: string, html: string, button?: { text: string; url: string }) {
    await this.call('sendMessage', {
      chat_id: chat,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(button ? { reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] } } : {}),
    });
  }

  /** Links the chat that most recently sent the bot this code. */
  async connect(code: string) {
    const updates = (await this.call('getUpdates', { limit: 100, allowed_updates: ['message'] })) as {
      message?: { text?: string; chat?: { id: number | string } };
    }[];
    const hit = [...(updates ?? [])].reverse().find((u) => u.message?.text?.includes(code) && u.message.chat?.id !== undefined);
    if (!hit) return false;
    this.setChat(String(hit.message!.chat!.id));
    return true;
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function when(ts: number, now: number) {
  const utc = new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  const mins = Math.round((ts - now) / 60_000);
  const span = (m: number) => (m >= 120 ? `${Math.round(m / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
  return `${utc} UTC (${mins >= 0 ? `in ${span(mins)}` : `${span(-mins)} ago`})`;
}

export function newListingText(d: { symbol: string | null; name: string | null; exchangeName: string; listingAt: number | null }, adminUrl: string, now = Date.now()) {
  const title = `${esc(d.symbol ?? '?')}${d.name ? ` (${esc(d.name)})` : ''}`;
  const start = d.listingAt ? (d.listingAt > now ? `Trading starts ${when(d.listingAt, now)}` : `Trading started ${when(d.listingAt, now)}`) : 'Start time not published';
  return `🆕 <b>New ${esc(d.exchangeName)} listing: ${title}</b>\n${start}\n\nReview it, add the logo and start price, then publish:\n${esc(adminUrl)}`;
}

export function resultDueText(m: { symbol: string; basePrice: number | null; pool: number; predictors: number }, adminUrl: string) {
  const what = m.basePrice === null ? 'Predictions closed and it has no start price yet. Add its opening price, then the result.' : 'Predictions closed. Post the final price to pay the winners.';
  return `⏰ <b>${esc(m.symbol)} needs you</b>\n${what}\nPool: ${m.pool.toLocaleString('en-US')} pts from ${m.predictors} predictor${m.predictors === 1 ? '' : 's'}.\n\n${esc(adminUrl)}`;
}

/** A public channel username: 5–32 letters, digits or underscores, given with or without @ or a t.me link. */
export function channelName(input: string): string | null {
  const m = input.trim().match(/^(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/)?@?([A-Za-z][A-Za-z0-9_]{4,31})\/?$/);
  return m ? m[1] : null;
}

const OUTCOME: Record<string, string> = { crash: 'Crash', down: 'Down', flat: 'Flat', up: 'Up', moon: 'Moon' };

function utc(ts: number) {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function price(n: number) {
  return `$${n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : Number(n.toPrecision(4))}`;
}

type ChannelMarket = {
  symbol: string;
  name: string | null;
  exchange: string;
  outcomes: string;
  basePrice: number | null;
  closeAt: number;
  settleAt: number;
};

/** "New market live" post for the public channel. */
export function marketLiveText(m: ChannelMarket) {
  const title = `${esc(m.symbol)}${m.name ? ` (${esc(m.name)})` : ''}`;
  const question =
    m.outcomes === 'binary' && m.basePrice !== null
      ? `Will ${esc(m.symbol)} be at or above ${price(m.basePrice)} on ${esc(m.exchange)}?`
      : `Where will ${esc(m.symbol)} trade on ${esc(m.exchange)}? Crash, Down, Flat, Up or Moon.`;
  const start = m.basePrice === null ? `Lists on ${esc(m.exchange)} around ${utc(m.closeAt)}. The opening price is the start price.` : `Start price: ${price(m.basePrice)}`;
  return `🟢 <b>New market: ${title}</b>\n${question}\n\n${start}\nPredictions close: ${utc(m.closeAt)}\nResult: ${utc(m.settleAt)}\n\nFree to play with points. Early picks earn more.`;
}

/** "Result is in" post for the public channel. */
export function marketResultText(m: ChannelMarket & { result: { winningBucket: string | null; returnPct: number | null; basePrice: number | null; finalPrice: number | null; pool: number } | null }) {
  const r = m.result;
  if (!r || !r.winningBucket) return null;
  const won = m.outcomes === 'binary' ? (r.winningBucket === 'up' ? 'Yes' : 'No') : OUTCOME[r.winningBucket] ?? r.winningBucket;
  const move = r.basePrice !== null && r.finalPrice !== null ? `${price(r.basePrice)} → ${price(r.finalPrice)}${r.returnPct !== null ? ` (${r.returnPct >= 0 ? '+' : ''}${(r.returnPct * 100).toFixed(1)}%)` : ''}` : '';
  return `🏁 <b>${esc(m.symbol)} result: ${won}</b>\n${move}\nPool of ${r.pool.toLocaleString('en-US')} pts paid to the winners.`;
}
