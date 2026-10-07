import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
for (const n of ['1', '2', '3']) {
  await p.goto(`file://${here}/banners.html?b=${n}`);
  await p.waitForFunction(() => window.READY === true);
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(here, '..', 'content', `teaser-${n}.png`) });
}
await b.close();
