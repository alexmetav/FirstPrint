import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

export interface GoogleIdentity {
  email: string;
  name: string | null;
  sub: string;
}

type Jwks = { keys: (JsonWebKey & { kid?: string })[] };
export type JwksFetcher = () => Promise<Jwks>;

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** Fetches Google's signing keys and keeps them for an hour. */
export function cachedGoogleJwks(): JwksFetcher {
  let cache: { at: number; jwks: Jwks } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < 3_600_000) return cache.jwks;
    const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`Google keys unavailable (${res.status})`);
    const jwks = (await res.json()) as Jwks;
    cache = { at: Date.now(), jwks };
    return jwks;
  };
}

const b64 = (s: string) => Buffer.from(s, 'base64url');

/**
 * Verifies a "Sign in with Google" ID token (RS256 JWT) and returns who it
 * belongs to, or null if anything is wrong: bad signature, wrong audience or
 * issuer, expired, or an email Google hasn't verified.
 */
export async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  getJwks: JwksFetcher,
  nowMs = Date.now(),
): Promise<GoogleIdentity | null> {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || !clientId) return null;
  try {
    const header = JSON.parse(b64(parts[0]).toString('utf8')) as { alg?: string; kid?: string };
    const claims = JSON.parse(b64(parts[1]).toString('utf8')) as Record<string, unknown>;
    if (header.alg !== 'RS256' || !header.kid) return null;

    const jwk = (await getJwks()).keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), b64(parts[2]));
    if (!ok) return null;

    const exp = Number(claims.exp);
    if (!ISSUERS.has(String(claims.iss)) || claims.aud !== clientId) return null;
    if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return null;
    if (claims.email_verified !== true && claims.email_verified !== 'true') return null;
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof claims.sub !== 'string') return null;
    return { email, name: typeof claims.name === 'string' ? claims.name : null, sub: claims.sub };
  } catch {
    return null;
  }
}
