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
