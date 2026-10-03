import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { linkSiteToApp } from '../src/site/links.ts';
const root = new URL('../', import.meta.url);
const out = new URL('../.deploy/', import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL('site/', root), out, { recursive: true });
cpSync(new URL('web/', root), new URL('play/', out), { recursive: true });
// The public /play/ build is practice-only. The flag lives in its own file rather than an inline
// script, so the Content-Security-Policy can forbid inline scripts.
writeFileSync(new URL('play/force-demo.js', out), 'window.FP_FORCE_DEMO = true;\n');
const playIndex = new URL('play/index.html', out);
const appTag = '<script type="module" src="./app.js"></script>';
const index = readFileSync(playIndex, 'utf8');
if (!index.includes(appTag)) throw new Error('web/index.html no longer loads ./app.js the expected way; update build-deploy.ts.');
writeFileSync(playIndex, index.replace(appTag, `<script src="./force-demo.js"></script>\n    ${appTag}`));
console.log('Built public site and prediction app into .deploy/');

// APP_URL points the marketing site's "launch" links at the hosted full app (accounts, real markets)
// instead of the browser-only practice build. Leave it unset to keep linking to /play/.
const appUrl = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
if (appUrl) {
  if (!/^https:\/\/[^\s"'<>]+$/.test(appUrl)) throw new Error('APP_URL must be an https:// address.');
  for (const file of ['index.html', 'assets/site.js']) {
    const url = new URL(file, out);
    writeFileSync(url, linkSiteToApp(readFileSync(url, 'utf8'), appUrl, file));
  }
  console.log(`Site links to the full app at ${appUrl}`);
}
