import type { Notification } from './firstprint.ts';

const NAMES: Record<string, string> = { crash: 'Crash', down: 'Down', flat: 'Flat', up: 'Up', moon: 'Moon' };

/** The short email a player gets when a market they predicted on settles or is cancelled. */
export function resultEmail(n: Notification, appUrl: string): { subject: string; text: string } {
  const link = `${appUrl}#/market/${encodeURIComponent(n.marketId)}`;
  const pts = (x: number) => `${x.toLocaleString('en-US')} points`;
  const footer = `\n\nSee the result: ${link}\n\nYou get this email because you made a prediction on Firstprint. Points have no cash value.`;
  if (n.status === 'void') {
    return {
      subject: `${n.symbol} was cancelled: ${pts(n.refund)} refunded`,
      text: `The ${n.symbol} market was cancelled, so every prediction was refunded. ${pts(n.refund)} are back in your balance.${footer}`,
    };
  }
  const yesNo = n.outcomes === 'binary';
  const winner = !n.winningBucket ? 'the result' : yesNo ? (n.winningBucket === 'up' ? 'Yes' : 'No') : NAMES[n.winningBucket] ?? n.winningBucket;
  if (n.payout > 0) {
    return {
      subject: `You won ${pts(n.payout)} on ${n.symbol}`,
      text: `${n.symbol} settled ${yesNo ? 'as' : 'in'} ${winner} and you called it. ${pts(n.payout)} have been added to your balance (you staked ${pts(n.staked)}).${footer}`,
    };
  }
  return {
    subject: `${n.symbol} settled ${yesNo ? 'as' : 'in'} ${winner}`,
    text: `${n.symbol} settled ${yesNo ? 'as' : 'in'} ${winner}. Your pick didn't win this time${n.refund ? `, and ${pts(n.refund)} were refunded by the pool limit` : ''}. New markets open all the time.${footer}`,
  };
}
