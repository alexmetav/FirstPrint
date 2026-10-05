/**
 * Firstprint wallets: players who sign up with email or Google get a Solana wallet the server
 * makes for them. Its key is sealed with AES-256-GCM under WALLET_ENCRYPTION_KEY, a secret that
 * lives only in the host's settings, so the database (and its backups) never hold a usable key.
 * Losing that secret loses the keys, which on a test network costs nothing but the test tokens.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class WalletVault {
  private key: Buffer;

  constructor(secret: string) {
    if (String(secret ?? '').trim().length < 16) throw new Error('WALLET_ENCRYPTION_KEY must be at least 16 characters.');
    this.key = createHash('sha256').update(`firstprint-wallets:${secret.trim()}`).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
  }

  open(sealed: string): string {
    const [v, iv, tag, enc] = String(sealed).split('.');
    if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Not a sealed wallet key.');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
  }
}
