// Renders the X profile header (1500×500, saved at 2× as 3000×1000).
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 500 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`file://${here}/${process.argv[3] || 'header.html'}`);
await page.waitForFunction(() => window.READY === true, null, { timeout: 30000 });
const out = process.argv[2] || join(here, 'x-header.png');
await page.screenshot({ path: out });
await browser.close();
console.log('saved', out);
