// Renders a video frame by frame (exact timing, no dropped frames) and encodes it with ffmpeg.
// node record.mjs v1 [fps] [--stills 1,4.5,9]
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const v = process.argv[2] ?? 'v1';
const fps = Number(process.argv[3] ?? 60);
const stillsArg = process.argv.indexOf('--stills');
const stills = stillsArg > 0 ? process.argv[stillsArg + 1].split(',').map(Number) : null;
const native = v.startsWith('x'); // natively square videos (x1, x2, ...)
const mode = process.argv.includes('--x') || native ? 'x' : 'v';
const out = join(here, mode === 'x' ? 'out-x' : 'out');
const VH = mode === 'x' ? 1080 : 1920;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 1080, height: VH }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`file://${here}/${native ? 'stage-sq' : mode === 'x' ? 'stage-x' : 'stage'}.html?v=${v}${process.env.Q ? `&${process.env.Q}` : ''}`); // Q: extra params, e.g. name=X&logo=partners/x.png
await page.waitForFunction(() => window.READY === true, null, { timeout: 30000 });
const duration = await page.evaluate(() => window.DURATION);
if (mode === 'x') {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(out, `${v}.sfx.json`), JSON.stringify({ duration, sfx: await page.evaluate(() => window.SFX_FINAL) }));
}

if (stills) {
  for (const t of stills) {
    await page.evaluate((x) => window.render(x), t);
    await page.screenshot({ path: join(out, `${v}-${String(t).replace('.', '_')}.png`) });
  }
  console.log('stills done');
  await browser.close();
  process.exit(0);
}

const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', String(fps), join(out, `firstprint-${v}${mode === 'x' ? '-silent' : ''}.mp4`)], { stdio: ['pipe', 'inherit', 'inherit'] });
const frames = Math.round(duration * fps);
const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  await page.evaluate((x) => window.render(x), i / fps);
  const buf = await page.screenshot({ type: 'jpeg', quality: 96 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 120 === 0) console.log(`${v}: frame ${i}/${frames} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
await browser.close();
console.log(`${v}: done, ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
