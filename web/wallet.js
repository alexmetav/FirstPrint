// Solana wallet connection without SDKs: Wallet Standard discovery (Phantom,
// Solflare, Backpack, and others) with a fallback to legacy injected providers.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

export const shortAddress = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');

const standardWallets = new Map();
const walletListeners = new Set();

function isSolanaStandard(w) {
  return Boolean(
    w?.features?.['standard:connect'] &&
      w?.features?.['solana:signMessage'] &&
      (w.chains ?? []).some((c) => String(c).startsWith('solana:')),
  );
}

(function discover() {
  const api = {
    register(...wallets) {
      for (const w of wallets) if (isSolanaStandard(w)) standardWallets.set(w.name, w);
      walletListeners.forEach((fn) => fn());
      return () => wallets.forEach((w) => standardWallets.delete(w.name));
    },
  };
  window.addEventListener('wallet-standard:register-wallet', (e) => {
    try {
      e.detail(api);
    } catch {
      /* ignore misbehaving wallets */
    }
  });
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch {
    /* old browsers */
  }
})();

export function onWalletsChanged(fn) {
  walletListeners.add(fn);
  return () => walletListeners.delete(fn);
}

/** Wallets available in this browser. */
export function listWallets() {
  const out = [...standardWallets.values()].map((w) => ({
    kind: 'standard',
    name: w.name,
    icon: typeof w.icon === 'string' && w.icon.startsWith('data:image/') ? w.icon : null,
    wallet: w,
  }));
  const legacy = [
    ['Phantom', window.phantom?.solana?.isPhantom ? window.phantom.solana : null],
    ['Solflare', window.solflare?.isSolflare ? window.solflare : null],
    ['Backpack', window.backpack?.isBackpack ? window.backpack : null],
  ];
  for (const [name, provider] of legacy) {
    if (provider && !out.some((w) => w.name.toLowerCase().includes(name.toLowerCase()))) {
      out.push({ kind: 'legacy', name, icon: null, provider });
    }
  }
  return out;
}

/** Wallet app icons (64×64, from each wallet's own site), bundled so they load instantly and offline. */
export const WALLET_LOGOS = {
  Phantom: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAABzlBMVEX///+nmvGqnvKsofKmmfH+/f+lmPGrn/L+/v+soPKnm/GmmvH///6om/GpnfKlmfGtofKqnfKonPGroPL9/f///v+kl/H+//+rnvKtovLHv/bCufX8+/6+tfXTzfj8/P749/7Duvbz8f3i3vrVz/jNxve6sPTb1vmpnfGyp/Pq6Pyqn/K3rfSxpvPGvvavpPLx7/3m4/vEvPbAtvXy8P2qnvHt6/zn4/vd2Pnc1/rX0vnr6PzCuvXw7vz08v3t6vzFvfawpfPk4Pu2rPTDu/b19P318/2onPK9s/T9/P/Z1Pn+/v69tPS3rvTY0vnOxvfNxffIwPbQyfjTzfm+tfS+tPTEvfbEu/a/tvXw7/y5r/S4r/S9s/WwpfLy8f2uo/Lx8P22q/Tq5/ypnPLi3vvd2PrVz/nEu/XKw/fKwvfBuPXAuPW6sfTz8v3h3vrq5vzg3PqmmPGkmPHj4Pvg2/rPyfjFvPa4rvP7+v67sfTv7fy7svWuovKtoPLh3fqtovPh3Pqom/LX0fnLw/fBufW8svT8+/+1q/Tw7v2pnPGuo/OhlPDRy/i9tPX08/329f3u7Py4rvSsn/LPyPfJwfbQyvi2rPP6+f739v7l4vtagnyQAAAACXBIWXMAAAsTAAALEwEAmpwYAAAC8UlEQVR42uVX1XbbQBAdyasFyWzHjinMDA0nTcNQZmZmZmZm/tuu5CSWHa0s5/QhTedlz9q6d+/AakYAf92K4F80N6wIc9v+5/7vI0gVSilfaJguCZ1e16Z3hVIYJ7cd35RYt37vttN95/muUPjuqhriw5KkqtJl7Dq1uhAG/mj3Dhl7CJszVzFiVx0z8OMPlXsRR5OMsUDwkkMGBZJVRCNmtMHQ1TXgiIHCqj24OBeuM6g1yfwMXH4v87iIlblwLyj58EW0GsmsMXMsyyxM6syngEJpS8SsXkbqF33VNGMXm7Rn4Pgz2Czf62+ZDnKgPJggMpegjQJ12+GTZ7E/y+3fACWSX6oF6HvMCMNVi4IQzQrg4BUznqFxmIGJVvXzDIUXL18zhp7OE0QtBcSz9BPm+wph+PkjktCT80zjBGts0hCGkkh2+pjvGyThVzNKQVihtz32BBQueEI5iQ+MTALMIsYaAHr0IKIbQgIKFfvrcssvNNU0+90vM++bJ/3NXp2g2kbBPm1x+YamsI+fHJKRL2D4dEJEQKEWW9avuRK5gkoBAYUDMZnktWLWJqhECuMWDixSEzwcFjnQo+bHcw82CwV0ak4IpGPWBBTanQgggfoyEcFO5MiDuAhfcdBBCgipa7AmUGADdiTgpDCEuyQnIQg2iDwoGwnYVU968ePrQgFHjuZgvGbH0+Jc0s1bgolC4dcgy4NA7L030wvK6/XN/eDDbtH7VIGSrCQyXBKf/4FpNcMsxHujdm9AeJEV2GgmYGgaUnNB9avNFfD8rQfhu3fE73MFqk0ELmnsI7Qgl3GFUf0QwKt4quNR2KYfKNCfiQFTWz8BjEYaGWtUcWphJrCbTyhc9MwRhJhv7IOOeUcwIueuUTAGpLzjDW1CMWOMCKKEcV14g35QOaQ4movc+uPDrRFJkrCnqTKNSQOLrMIetaaZ2NqxvXxLe+nCmVRRCpmpKMDSRjlTV9RNWTJ+udgy+WqL5pWzQj7UVoj9AV5UXCb4Vgx/AAAAAElFTkSuQmCC',
  Solflare: 'data:image/png;base64,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',
  Backpack: 'data:image/png;base64,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',
};

export const INSTALL_LINKS = [
  { name: 'Phantom', url: 'https://phantom.com/download', logo: WALLET_LOGOS.Phantom },
  { name: 'Solflare', url: 'https://solflare.com/download', logo: WALLET_LOGOS.Solflare },
  { name: 'Backpack', url: 'https://backpack.app/download', logo: WALLET_LOGOS.Backpack },
];

/** Opens this page inside a mobile wallet's built-in browser. */
export function mobileWalletLinks() {
  const url = encodeURIComponent(location.href);
  const ref = encodeURIComponent(location.origin);
  return [
    { name: 'Phantom', url: `https://phantom.app/ul/browse/${url}?ref=${ref}`, logo: WALLET_LOGOS.Phantom },
    { name: 'Solflare', url: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}`, logo: WALLET_LOGOS.Solflare },
  ];
}

export const isMobileDevice = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * Connects a wallet and signs the server's sign-in message.
 * getMessage(address) must return the exact text to sign.
 */
export async function connectAndSign(entry, getMessage) {
  const encoder = new TextEncoder();
  if (entry.kind === 'standard') {
    const { accounts } = await entry.wallet.features['standard:connect'].connect();
    const account = accounts?.[0];
    if (!account) throw new Error('No account was shared by the wallet.');
    const message = await getMessage(account.address);
    const [signed] = await entry.wallet.features['solana:signMessage'].signMessage({ account, message: encoder.encode(message) });
    return { address: account.address, message, signature: b58encode(signed.signature), walletName: entry.name };
  }
  const provider = entry.provider;
  const res = await provider.connect();
  const address = (res?.publicKey ?? provider.publicKey).toString();
  const message = await getMessage(address);
  const signed = await provider.signMessage(encoder.encode(message), 'utf8');
  return { address, message, signature: b58encode(signed.signature ?? signed), walletName: entry.name };
}

const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/**
 * Has the wallet holding `address` sign a transaction Firstprint prepared (base64), and returns
 * it signed (base64). Firstprint checks and sends it. Tries the wallet the player linked first.
 */
export async function signTransactionWith(address, transactionBase64, cluster, walletName) {
  const transaction = fromBase64(transactionBase64);
  const chain = `solana:${cluster}`;
  const wallets = [...standardWallets.values()].filter((w) => w.features['solana:signTransaction']);
  if (!wallets.length) throw new Error('Open this page in a browser with Phantom, Solflare or Backpack installed.');
  wallets.sort((a, b) => Number(b.name === walletName) - Number(a.name === walletName));
  for (const [i, w] of wallets.entries()) {
    let account = (w.accounts ?? []).find((a) => a.address === address);
    if (!account) {
      try {
        // Ask quietly first; only the preferred wallet may show a connect prompt.
        const { accounts } = await w.features['standard:connect'].connect(i === 0 ? undefined : { silent: true });
        account = (accounts ?? []).find((a) => a.address === address);
      } catch (err) {
        if (i === 0 && (err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? ''))) throw err;
      }
    }
    if (!account) continue;
    const [out] = await w.features['solana:signTransaction'].signTransaction({ account, transaction, chain });
    return toBase64(out.signedTransaction);
  }
  throw new Error(`Switch your wallet to the account ${shortAddress(address)} (the one linked to Firstprint), then try again.`);
}

export async function disconnectWallets() {
  for (const w of standardWallets.values()) {
    try {
      await w.features['standard:disconnect']?.disconnect();
    } catch {
      /* ignore */
    }
  }
  for (const p of [window.phantom?.solana, window.solflare, window.backpack]) {
    try {
      await p?.disconnect?.();
    } catch {
      /* ignore */
    }
  }
}
