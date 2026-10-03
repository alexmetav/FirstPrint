import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/db.ts';
import { systemClock } from '../src/clock.ts';
import { FirstprintService } from '../src/services/firstprint.ts';
import { createApiServer } from '../src/api/server.ts';
import { linkSiteToApp } from '../src/site/links.ts';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

async function serve(siteDir: string | null) {
  const service = new FirstprintService(openDb(':memory:'), systemClock, []);
  const server = createApiServer({ service, adminKey: null, secureCookies: false, webDir: dir('../web/'), siteDir });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => server.close() };
}

test('with the website: landing page at /, its Launch app buttons open /app/, which is the app', async () => {
  const s = await serve(dir('../site/'));
  try {
    const home = await (await fetch(`${s.base}/`)).text();
    assert.match(home, /Predict the/);
    assert.match(home, /href="\/app\/">Launch app</);
    assert.doesNotMatch(home, /href="\/play\//, 'no link to the practice build');

    const siteJs = await (await fetch(`${s.base}/assets/site.js`)).text();
    assert.doesNotMatch(siteJs, /href="\/play\//);

    const app = await fetch(`${s.base}/app/`);
    assert.equal(app.status, 200);
    assert.match(await app.text(), /<script type="module" src="\.\/app\.js">/);
    assert.match(await (await fetch(`${s.base}/app/app.js`)).text(), /Firstprint website\. Vanilla ES modules/);

    for (const path of ['/app', '/play/', '/play']) {
      const r = await fetch(`${s.base}${path}?ref=x`, { redirect: 'manual' });
      assert.equal(r.status, 301, path);
      assert.equal(r.headers.get('location'), '/app/?ref=x');
    }

    assert.match(await (await fetch(`${s.base}/privacy.html`)).text(), /Privacy policy/);
    assert.equal((await fetch(`${s.base}/api/health`)).status, 200, 'the API is unchanged');
  } finally {
    s.close();
  }
});

test('without the website, the app is served at / as before', async () => {
  const s = await serve(null);
  try {
    assert.match(await (await fetch(`${s.base}/`)).text(), /<script type="module" src="\.\/app\.js">/);
  } finally {
    s.close();
  }
});

test('every practice link on the website has a known label to rewrite', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['../site/index.html', '../site/assets/site.js']) {
    const text = readFileSync(dir(file), 'utf8');
    assert.doesNotThrow(() => linkSiteToApp(text, '/app', file));
  }
  assert.throws(() => linkSiteToApp('<a href="/play/">Something new</a>', '/app'), /unexpected label/);
});
