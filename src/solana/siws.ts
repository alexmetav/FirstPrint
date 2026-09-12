import { createPublicKey, verify } from 'node:crypto';
import { base58Decode } from './base58.ts';

/**
 * Sign-In With Solana.
 *
 * The server issues a one-time nonce and an exact message. The wallet signs
 * the message bytes (UTF-8) with its ed25519 key; the server checks the
 * signature against the address and that the message matches what it issued.
 * Format follows the SIWS / EIP-4361 layout so wallets display it cleanly.
 */

export interface SiwsFields {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: 'mainnet' | 'devnet' | 'testnet';
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

export function buildSiwsMessage(f: SiwsFields): string {
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.address,
    '',
    f.statement,
    '',
    `URI: ${f.uri}`,
    'Version: 1',
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
  ].join('\n');
}

// DER prefix that wraps a raw 32-byte ed25519 public key as SPKI.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyEd25519(address: string, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const raw = base58Decode(address);
    if (raw.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** Accepts a signature as base58 (Solana convention) or base64. */
export function decodeSignature(sig: string): Uint8Array | null {
  if (typeof sig !== 'string' || !sig) return null;
  try {
    const b58 = base58Decode(sig);
    if (b58.length === 64) return b58;
  } catch {
    /* not base58 */
  }
  const b64 = Buffer.from(sig, 'base64');
  return b64.length === 64 ? new Uint8Array(b64) : null;
}
