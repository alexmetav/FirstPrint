/**
 * Downloads a token logo for the admin, so a market can keep its own copy instead of linking to
 * someone else's site (links break when a project changes its avatar or a site blocks hotlinking).
 *
 * Only public https addresses are fetched: hostnames that resolve to private, loopback or link-local
 * addresses are refused, every redirect is checked the same way, and the download is capped in size
 * and time.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '../services/firstprint.ts';

const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);

/** True for addresses that must never be fetched from the server (internal networks, metadata services). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (v === 6) {
    const h = ipv6Hextets(ip);
    if (!h) return true;
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const zero = (n: number) => h.slice(0, n).every((x) => x === 0);
    if (h.every((x) => x === 0) || (zero(7) && h[7] === 1)) return true; // :: and ::1
    // IPv4 inside IPv6 (mapped ::ffff:a.b.c.d, the old ::a.b.c.d form, NAT64 64:ff9b::, 6to4 2002::): check the IPv4.
    if (zero(5) && (h[5] === 0xffff || h[5] === 0)) return isPrivateAddress(v4(h[6], h[7]));
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isPrivateAddress(v4(h[6], h[7]));
    if (h[0] === 0x2002) return isPrivateAddress(v4(h[1], h[2]));
    return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xff00) === 0xff00;
  }
  return true;
}

/** The eight 16-bit groups of an IPv6 address (handles :: and a trailing dotted IPv4), or null. */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = s.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const part = (x: string | undefined) => (x ? x.split(':').map((g) => parseInt(g, 16)) : []);
  const a = part(head);
  const b = part(tail);
  const fill = s.includes('::') ? 8 - a.length - b.length : 0;
  const out = [...a, ...Array(Math.max(0, fill)).fill(0), ...b];
  return out.length === 8 && out.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? out : null;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, 'bad_url', 'That isn’t a valid link.');
  }
  if (url.protocol !== 'https:') throw new AppError(400, 'bad_url', 'Only https:// links can be copied.');
  if (url.username || url.password) throw new AppError(400, 'bad_url', 'Links with a username or password aren’t allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new AppError(400, 'bad_url', 'That website couldn’t be found.');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new AppError(400, 'bad_url', 'That address isn’t allowed.');
  return url;
}

/** Fetches an image and returns its type and bytes (base64). */
export async function fetchImage(raw: string, fetchImpl: typeof fetch = fetch): Promise<{ contentType: string; data: string }> {
  let url = await assertPublicUrl(String(raw ?? '').trim());
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url, { redirect: 'manual', signal, headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (Firstprint logo fetch)' } }).catch((err: Error) => {
      throw new AppError(502, 'fetch_failed', err.name === 'TimeoutError' ? 'The image took too long to download.' : 'Couldn’t download that image.');
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new AppError(502, 'fetch_failed', 'Too many redirects.');
      url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    if (!res.ok) throw new AppError(502, 'fetch_failed', `The image link answered with an error (${res.status}).`);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) throw new AppError(400, 'not_image', 'That link isn’t a PNG, JPG, WebP, GIF or SVG image.');
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) throw new AppError(400, 'too_large', 'That image is over 3 MB.');
    const reader = res.body?.getReader();
    if (!reader) throw new AppError(502, 'fetch_failed', 'Couldn’t download that image.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new AppError(400, 'too_large', 'That image is over 3 MB.');
      }
      chunks.push(value);
    }
    return { contentType, data: Buffer.concat(chunks).toString('base64') };
  }
}
