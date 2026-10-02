import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // The full app has real accounts, so its links shouldn't call it "practice".
  const labels: [string, string][] = [
    ['>Try practice beta<', '>Open the app<'],
    ['>Try practice predictions<', '>Start predicting<'],
    ['>Open practice beta<', '>Open the app<'],
    ['>Practice beta<', '>Play<'],
    ['>Practice predictions<', '>Predictions<'],
    ['>Predictions <span class="soon">Practice</span><', '>Predictions<'],
  ];
  for (const file of ['index.html', 'assets/site.js']) {
    const url = new URL(file, out);
    let text = readFileSync(url, 'utf8');
    for (const [from, to] of labels) text = text.replaceAll(`href="/play/"${from}`, `href="${appUrl}/"${to}`);
    if (text.includes('href="/play/"')) throw new Error(`${file} has a /play/ link with an unexpected label; add it to build-deploy.ts.`);
    writeFileSync(url, text);
  }
  console.log(`Site links to the full app at ${appUrl}`);
}
