// Renders the in-between post banners in social.html to PNG.
//   node social.mjs [outDir] [id ...]   -> out-social/<id>.png by default
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const [outArg, ...only] = process.argv.slice(2);
const out = resolve(outArg ?? join(here, 'out-social'));
mkdirSync(out, { recursive: true });
const ids = only.length ? only : ['outcomes', 'early', 'streak', 'poll', 'record', 'signin'];

const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1350 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
for (const id of ids) {
  await page.goto(`file://${here}/social.html?id=${id}`);
  await page.waitForFunction(() => window.READY === true, null, { timeout: 30000 });
  const [width, height] = await page.evaluate(() => window.SIZE);
  await page.setViewportSize({ width, height });
  await page.screenshot({ path: join(out, `${id}.png`) });
  console.log('saved', id, `${width}x${height}`);
}
await browser.close();
