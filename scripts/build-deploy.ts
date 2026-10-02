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

// The live app (accounts, real markets) is served at /app/. Its requests to /api go to the hosted backend
// through the rewrites in vercel.json. Unlike /play/ it is NOT locked to practice mode.
cpSync(new URL('web/', root), new URL('app/', out), { recursive: true });

// APP_URL points the marketing site's "launch" links at the live app instead of the browser-only practice
// build. It is an https:// address or a path on this site such as /app/. Unset keeps linking to /play/.
const appUrl = (process.env.APP_URL ?? '').trim();
if (appUrl) {
  if (!/^(https:\/\/[^\s"'<>]+|\/[A-Za-z0-9/_-]*)$/.test(appUrl)) throw new Error('APP_URL must be an https:// address or a path such as /app/.');
  const target = /^https:/.test(appUrl) ? `${appUrl.replace(/\/+$/, '')}/` : appUrl;
  // Buttons that said "practice" now open the live app, so their labels change with them.
  const labels: [string, string][] = [
    ['>Practice beta</a>', '>Launch app</a>'],
    ['>Try practice beta</a>', '>Launch app</a>'],
    ['>Try practice predictions</a>', '>Launch app</a>'],
    ['>Practice predictions</a>', '>Launch app</a>'],
    ['>Open practice beta</a>', '>Launch app</a>'],
    ['Predictions <span class="soon">Practice</span>', 'Predictions <span class="soon">Live</span>'],
  ];
  for (const file of ['index.html', 'assets/site.js']) {
    const url = new URL(file, out);
    let text = readFileSync(url, 'utf8').replaceAll('href="/play/"', `href="${target}"`);
    for (const [from, to] of labels) text = text.replaceAll(from, to);
    writeFileSync(url, text);
  }
  console.log(`Site links to the live app at ${target}`);
}
