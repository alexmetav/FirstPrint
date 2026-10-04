import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchImage, isPrivateAddress } from '../src/api/fetchImage.ts';
import { AppError } from '../src/services/firstprint.ts';

test('private and internal addresses are never fetched', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  const refused = (e: unknown) => e instanceof AppError && e.code === 'bad_url';
  await assert.rejects(fetchImage('http://example.com/a.png'), refused);
  await assert.rejects(fetchImage('https://127.0.0.1/a.png'), refused);
  await assert.rejects(fetchImage('https://[::1]/a.png'), refused);
  await assert.rejects(fetchImage('https://169.254.169.254/latest/meta-data'), refused);
});

test('images come back as base64; redirects to private addresses and non-images are refused', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const ok = await fetchImage('https://8.8.8.8/logo.png', async () => new Response(png, { headers: { 'content-type': 'image/png' } }));
  assert.deepEqual(ok, { contentType: 'image/png', data: png.toString('base64') });
  await assert.rejects(
    fetchImage('https://8.8.8.8/logo.png', async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } })),
    (e) => e instanceof AppError && e.code === 'bad_url',
  );
  await assert.rejects(
    fetchImage('https://8.8.8.8/page', async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })),
    (e) => e instanceof AppError && e.code === 'not_image',
  );
});
