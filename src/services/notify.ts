import type { Notification } from './firstprint.ts';
import { emailHtml } from '../auth/emailHtml.ts';

const NAMES: Record<string, string> = { crash: 'Crash', down: 'Down', flat: 'Flat', up: 'Up', moon: 'Moon' };

/** The short email a player gets when a market they predicted on settles or is cancelled (text and HTML). */
export function resultEmail(n: Notification, appUrl: string): { subject: string; text: string; html: string } {
  const link = `${appUrl}#/market/${encodeURIComponent(n.marketId)}`;
  const siteUrl = appUrl.replace(/\/app\/?$/, '');
  const pts = (x: number) => `${x.toLocaleString('en-US')} points`;
  const why = 'You get this email because you made a prediction on Firstprint.';
  const footer = `\n\nSee the result: ${link}\n\n${why} Points have no cash value.`;
  const build = (subject: string, heading: string, line: string) => ({
    subject,
    text: `${line}${footer}`,
    html: emailHtml({ siteUrl, preview: line, heading, lines: [line], button: { label: 'See the result', url: link }, footer: why }),
  });
  if (n.status === 'void') {
    return build(
      `${n.symbol} was cancelled: ${pts(n.refund)} refunded`,
      `${n.symbol} was cancelled`,
      `The ${n.symbol} market was cancelled, so every prediction was refunded. ${pts(n.refund)} are back in your balance.`,
    );
  }
  const yesNo = n.outcomes === 'binary';
  const winner = !n.winningBucket ? 'the result' : yesNo ? (n.winningBucket === 'up' ? 'Yes' : 'No') : NAMES[n.winningBucket] ?? n.winningBucket;
  if (n.payout > 0) {
    return build(
      `You won ${pts(n.payout)} on ${n.symbol}`,
      `You won ${pts(n.payout)}`,
      `${n.symbol} settled ${yesNo ? 'as' : 'in'} ${winner} and you called it. ${pts(n.payout)} have been added to your balance (you staked ${pts(n.staked)}).`,
    );
  }
  return build(
    `${n.symbol} settled ${yesNo ? 'as' : 'in'} ${winner}`,
    `${n.symbol} settled ${yesNo ? 'as' : 'in'} ${winner}`,
    `${n.symbol} settled ${yesNo ? 'as' : 'in'} ${winner}. Your pick didn't win this time${n.refund ? `, and ${pts(n.refund)} were refunded by the pool limit` : ''}. New markets open all the time.`,
  );
}
