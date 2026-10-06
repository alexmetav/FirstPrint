/**
 * The HTML version of Firstprint's emails: the logo on top, a heading, a few lines, an optional big
 * sign-in code or button, and a small footer. Built from tables with inline styles, the only layout
 * every inbox (Gmail, Outlook, Apple Mail) renders the same. The plain-text version is always sent
 * too, for inboxes that show text only. Every value put in is escaped.
 */

export interface EmailParts {
  /** The site's address (https://www.firstprint.fun): the logo and links come from here. */
  siteUrl: string;
  /** The line inboxes show next to the subject, before the email is opened. */
  preview: string;
  heading: string;
  /** Paragraphs of plain text. */
  lines: string[];
  /** A sign-in code, shown large. */
  code?: string;
  button?: { label: string; url: string };
  footer: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

export function emailHtml(p: EmailParts): string {
  const site = p.siteUrl.replace(/\/+$/, '');
  const lines = p.lines.map((l) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3a3a40;">${esc(l)}</p>`).join('');
  const code = p.code
    ? `<div style="margin:6px 0 20px;padding:18px 0;border-radius:12px;background:#f2f3f7;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#0b0f2a;">${esc(p.code)}</div>`
    : '';
  const button = p.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;"><tr><td style="border-radius:10px;background:#0b0f2a;"><a href="${esc(p.button.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${esc(p.button.label)}</a></td></tr></table>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(p.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f8;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(p.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;font-family:${FONT};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
<tr><td style="padding:0 4px 18px;">
<a href="${esc(site)}/" style="text-decoration:none;">
<img src="${esc(site)}/icon-192.png" width="36" height="36" alt="Firstprint" style="display:inline-block;vertical-align:middle;border:0;border-radius:9px;">
<span style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:18px;font-weight:700;color:#0b0f2a;">Firstprint</span>
</a>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e6e7ee;border-radius:16px;padding:28px 26px 14px;">
<h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;font-weight:700;color:#0b0f2a;">${esc(p.heading)}</h1>
${lines}${code}${button}
</td></tr>
<tr><td style="padding:16px 6px 0;font-size:12px;line-height:1.6;color:#8a8b95;">
${esc(p.footer)}<br>
<a href="${esc(site)}/" style="color:#8a8b95;">firstprint.fun</a> · Points have no cash value.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The sign-in code email. */
export function codeEmail(code: string, siteUrl: string) {
  return {
    subject: `${code} is your Firstprint code`,
    text: `Your Firstprint sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
    html: emailHtml({
      siteUrl,
      preview: `Your sign-in code is ${code}. It expires in 10 minutes.`,
      heading: 'Your sign-in code',
      lines: ['Enter this code in Firstprint to sign in. It expires in 10 minutes.'],
      code,
      footer: "If you didn't ask for this code, you can ignore this email. Someone may have typed your address by mistake.",
    }),
  };
}
