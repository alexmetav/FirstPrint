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
