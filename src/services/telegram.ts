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

  private async call(method: string, body: Record<string, unknown> | FormData) {
    const form = body instanceof FormData;
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      ...(form ? {} : { headers: { 'content-type': 'application/json' } }),
      body: form ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(form ? 30_000 : 10_000),
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

  /** Posts an image with the text as its caption (at most 1,024 characters). */
  async sendPhotoTo(chat: string, png: Uint8Array, html: string, button?: { text: string; url: string }) {
    const form = new FormData();
    form.set('chat_id', chat);
    form.set('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'banner.png');
    form.set('caption', html);
    form.set('parse_mode', 'HTML');
    if (button) form.set('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: button.text, url: button.url }]] }));
    await this.call('sendPhoto', form);
  }

  private botName: string | null = null;

  /** The bot's username (asked once), for t.me links. */
  async me() {
    if (!this.botName) this.botName = String(((await this.call('getMe', {})) as { username?: string }).username ?? '');
    return this.botName;
  }

  // Codes players sent with Start (/start CODE), remembered so a later check still finds them after
  // newer messages push them out of what getUpdates returns.
  private starts = new Map<string, string>();

  /** The Telegram user ID that pressed Start in the bot with this code, or null if none has yet. */
  async startedBy(code: string): Promise<string | null> {
    const want = code.toUpperCase();
    if (!this.starts.has(want)) {
      const updates = (await this.call('getUpdates', { offset: -100, limit: 100, allowed_updates: ['message'] })) as {
        message?: { text?: string; from?: { id: number | string; is_bot?: boolean } };
      }[];
      for (const u of updates ?? []) {
        const m = /^\/start\s+(FP-[A-Z0-9]{6,})\s*$/i.exec(u.message?.text?.trim() ?? '');
        if (m && u.message!.from && !u.message!.from.is_bot) this.starts.set(m[1].toUpperCase(), String(u.message!.from.id));
      }
      if (this.starts.size > 5_000) this.starts.clear();
    }
    return this.starts.get(want) ?? null;
  }

  /** True when the user is in the channel (@name). The bot must be an admin of the channel. */
  async isMember(channel: string, userId: string) {
    const m = (await this.call('getChatMember', { chat_id: `@${channel}`, user_id: Number(userId) })) as { status?: string; is_member?: boolean };
    return ['creator', 'administrator', 'member'].includes(String(m?.status)) || (m?.status === 'restricted' && m.is_member === true);
  }

  /** Links the chat that most recently sent the bot this code. */
  async connect(code: string) {
    // offset -100: the latest 100 messages (without it Telegram returns the oldest ones still waiting).
    const updates = (await this.call('getUpdates', { offset: -100, limit: 100, allowed_updates: ['message'] })) as {
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
  const what = m.basePrice === null ? 'Predictions closed and it has no start price yet. Add its opening price, then the result.' : 'Its result is due. Post the final price to pay the winners.';
  return `⏰ <b>${esc(m.symbol)} needs you</b>\n${what}\nPool: ${m.pool.toLocaleString('en-US')} pts from ${m.predictors} participant${m.predictors === 1 ? '' : 's'}.\n\n${esc(adminUrl)}`;
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

/** The opening line of every channel post: the $TICKER first, like an exchange listing notice. */
function head(m: ChannelMarket, tag: string) {
  return `<b>$${esc(m.symbol)}</b>${m.name ? ` · ${esc(m.name)}` : ''}\n${tag}`;
}

/** The last line: the market link, so a tap from Telegram goes straight to predicting. */
function cta(label: string, link?: string) {
  // A link tag, so the whole address (with its #/market/… part) is always the tap target.
  return link ? `\n\n👉 <b>${label}:</b> <a href="${esc(link).replace(/"/g, '&quot;')}">${esc(link)}</a>` : '';
}

/** "New market live" post for the public channel. */
export function marketLiveText(m: ChannelMarket, link?: string) {
  // Exchanges are named on the market page only, not in posts.
  const question =
    m.outcomes === 'binary' && m.basePrice !== null
      ? `Will $${esc(m.symbol)} be at or above ${price(m.basePrice)}?\nYes · No`
      : `Where will $${esc(m.symbol)} go from here?\nCrash · Down · Flat · Up · Moon`;
  const start = m.basePrice === null ? 'Start price: the opening price at listing' : `Start price: ${price(m.basePrice)}`;
  return `${head(m, `🟢 <b>New market listed</b>${m.basePrice === null ? ' · Upcoming' : ''}`)}

${question}

💲 ${start}
⏰ Predictions close: ${utc(m.closeAt)}
🏁 Result: ${utc(m.settleAt)}

Free to play with points. Early picks earn more.${cta('Predict now', link)}`;
}

/** "Result is in" post for the public channel: the move and the players first. */
export function marketResultText(
  m: ChannelMarket & { predictors?: number; result: { winningBucket: string | null; returnPct: number | null; basePrice: number | null; finalPrice: number | null; pool: number } | null },
  link?: string,
) {
  const r = m.result;
  if (!r || !r.winningBucket) return null;
  const won = m.outcomes === 'binary' ? (r.winningBucket === 'up' ? 'Yes' : 'No') : OUTCOME[r.winningBucket] ?? r.winningBucket;
  const pct = r.returnPct !== null ? ` · ${r.returnPct >= 0 ? '+' : ''}${(r.returnPct * 100).toFixed(1)}%` : '';
  const move = r.basePrice !== null && r.finalPrice !== null ? `\n📈 ${price(r.basePrice)} → ${price(r.finalPrice)}` : '';
  const players = m.predictors ? `👥 ${m.predictors.toLocaleString('en-US')} participant${m.predictors === 1 ? '' : 's'} · ` : '👥 ';
  return `${head(m, `🏁 <b>Result: ${won} wins${pct}</b>`)}
${move}
${players}${r.pool.toLocaleString('en-US')} pts paid to the winners${cta('See the result', link)}`;
}

/** "Closing in an hour" reminder for the public channel. */
export function closingSoonText(m: ChannelMarket & { pool: number; predictors: number }, link?: string) {
  const what = m.basePrice === null ? 'Starts trading in about an hour; predictions close when it does.' : 'Predictions close in about an hour.';
  const crowd = m.predictors ? `👥 ${m.predictors} participant${m.predictors === 1 ? '' : 's'} · ${m.pool.toLocaleString('en-US')} pts in the pool` : '👥 No picks yet. Early picks earn more.';
  return `${head(m, '⏳ <b>Last hour to predict</b>')}

${what}
⏰ Closes: ${utc(m.closeAt)}
${crowd}${cta('Predict now', link)}`;
}

/** "in 3h 20m" or "in 2d 4h": how long until a market closes, for the summary post. */
function closesIn(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60 ? ` ${min % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

/**
 * "12 markets live" post for the public channel: how many are open, the ones closing soonest
 * with the time left, and the link. Real numbers only, straight from the open markets.
 */
export function liveSummaryText(markets: { symbol: string; closeAt: number; participants: number }[], link: string, now = Date.now()) {
  const n = markets.length;
  if (!n) return null;
  const soonest = [...markets].sort((a, b) => a.closeAt - b.closeAt);
  const shown = soonest.slice(0, 10);
  const people = markets.reduce((s, m) => s + m.participants, 0);
  const lines = shown.map((m) => `• <b>$${esc(m.symbol)}</b> · closes in ${closesIn(m.closeAt - now)}`).join('\n');
  const more = n > shown.length ? `\n…and ${n - shown.length} more` : '';
  const crowd = people ? `👥 ${people.toLocaleString('en-US')} participant${people === 1 ? '' : 's'} so far. ` : '';
  return `🟢 <b>${n} market${n === 1 ? '' : 's'} live on Firstprint</b>

Pick where each token goes: Crash, Down, Flat, Up or Moon. Free to play with points.

${lines}${more}

${crowd}Early picks earn more.${cta('Predict now', link)}`;
}
