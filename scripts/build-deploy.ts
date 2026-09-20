/**
 * Builds the public tree into .deploy/: the marketing site at the root and the
 * prediction app under /play.
 *
 * Two modes, because they are deployed very differently:
 *
 *   (default)  practice — injects window.FP_FORCE_DEMO so /play runs entirely in
 *              the browser against DemoBackend. Safe on static hosting with no
 *              backend; points and prices are simulated. CI asserts the lock.
 *
 *   --live     real — no injection, so /play uses createApi() and talks to the
 *              backend. api.js sends credentials: 'same-origin' and the session
 *              cookie is SameSite=Lax, so this tree MUST be served from the same
 *              origin as the API (WEB_DIR=.deploy on the Node service). Serving
 *              it from static hosting with the API elsewhere logs everyone out.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const live = process.argv.includes('--live');
const root = new URL('../', import.meta.url);
const out = new URL('../.deploy/', import.meta.url);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL('site/', root), out, { recursive: true });
cpSync(new URL('web/', root), new URL('play/', out), { recursive: true });

const playIndex = new URL('play/index.html', out);
const tag = '<script type="module" src="./app.js"></script>';
const html = readFileSync(playIndex, 'utf8');
if (!html.includes(tag)) throw new Error('web/index.html no longer loads ./app.js as a module; update build-deploy.');

if (!live) {
  writeFileSync(playIndex, html.replace(tag, `<script>window.FP_FORCE_DEMO = true;</script>\n    ${tag}`));
}

console.log(
  live
    ? 'Built public site and LIVE prediction app into .deploy/ (serve with WEB_DIR pointing here, same origin as the API)'
    : 'Built public site and practice-mode prediction app into .deploy/',
);
