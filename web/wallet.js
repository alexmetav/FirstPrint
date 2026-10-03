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

export const INSTALL_LINKS = [
  { name: 'Phantom', url: 'https://phantom.com/download' },
  { name: 'Solflare', url: 'https://solflare.com/download' },
  { name: 'Backpack', url: 'https://backpack.app/download' },
];

/** Opens this page inside a mobile wallet's built-in browser. */
export function mobileWalletLinks() {
  const url = encodeURIComponent(location.href);
  const ref = encodeURIComponent(location.origin);
  return [
    { name: 'Phantom', url: `https://phantom.app/ul/browse/${url}?ref=${ref}` },
    { name: 'Solflare', url: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
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
