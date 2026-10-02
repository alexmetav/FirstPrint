import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const out = new URL('../.deploy/', import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL('site/', root), out, { recursive: true });
cpSync(new URL('web/', root), new URL('play/', out), { recursive: true });
const playIndex = new URL('play/index.html', out);
const html = readFileSync(playIndex, 'utf8').replace(
  '<script type="module" src="./app.js"></script>',
  '<script>window.FP_FORCE_DEMO = true;</script>\n    <script type="module" src="./app.js"></script>',
);
writeFileSync(playIndex, html);
console.log('Built public site and prediction app into .deploy/');

// APP_URL points the marketing site's "launch" links at the hosted full app (accounts, real markets)
// instead of the browser-only practice build. Leave it unset to keep linking to /play/.
const appUrl = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
if (appUrl) {
  if (!/^https:\/\/[^\s"'<>]+$/.test(appUrl)) throw new Error('APP_URL must be an https:// address.');
  for (const file of ['index.html', 'assets/site.js']) {
    const url = new URL(file, out);
    writeFileSync(url, readFileSync(url, 'utf8').replaceAll('href="/play/"', `href="${appUrl}/"`));
  }
  console.log(`Site links to the full app at ${appUrl}`);
}
