/**
 * Cloudflare's own addresses (https://www.cloudflare.com/ips/), so the server only believes a
 * CF-Connecting-IP header that Cloudflare itself sent. Anyone can reach the host directly (for
 * example its *.onrender.com address) and put any value in that header, which would dodge every
 * per-visitor limit. Cloudflare changes this list rarely; update it from the page above if it does.
 */
import { BlockList, isIP } from 'node:net';

const V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

const ranges = new BlockList();
for (const r of V4) {
  const [net, bits] = r.split('/');
  ranges.addSubnet(net, Number(bits), 'ipv4');
}
for (const r of V6) {
  const [net, bits] = r.split('/');
  ranges.addSubnet(net, Number(bits), 'ipv6');
}

/** True when the address belongs to Cloudflare (IPv4-mapped IPv6 addresses count as their IPv4). */
export function isCloudflareAddress(ip: string): boolean {
  const plain = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  const v = isIP(plain);
  if (!v) return false;
  return ranges.check(plain, v === 4 ? 'ipv4' : 'ipv6');
}
