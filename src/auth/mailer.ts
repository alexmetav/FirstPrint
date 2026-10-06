export interface Mailer {
  /** `html` is the styled version; `text` is always sent too, for inboxes that show text only. */
  send(to: string, subject: string, text: string, html?: string): Promise<void>;
}

/** Sends through Resend's HTTP API (https://resend.com). Needs an API key and a verified sender. */
export class ResendMailer implements Mailer {
  private apiKey: string;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(to: string, subject: string, text: string, html?: string) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [to], subject, text, ...(html ? { html } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Email provider rejected the message (${res.status})`);
  }
}

/** Development mailer: prints the message instead of sending it. */
export class ConsoleMailer implements Mailer {
  log: (msg: string) => void;
  constructor(log: (msg: string) => void) {
    this.log = log;
  }
  async send(to: string, subject: string, text: string) {
    this.log(`email to ${to}: ${subject}\n${text}`);
  }
}
