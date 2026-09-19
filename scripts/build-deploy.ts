import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const out = new URL('../.deploy/', import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL('site/', root), out, { recursive: true });
cpSync(new URL('web/', root), new URL('play/', out), { recursive: true });
cpSync(new URL('beta/', root), new URL('beta/', out), { recursive: true });
const playIndex = new URL('play/index.html', out);
const html = readFileSync(playIndex, 'utf8').replace(
  '<script type="module" src="./app.js"></script>',
  '<script>window.FP_FORCE_DEMO = true;</script>\n    <script type="module" src="./app.js"></script>',
);
writeFileSync(playIndex, html);
const betaConfig = new URL('beta/config.js', out);
const supabaseUrl = process.env.SUPABASE_URL ?? 'https://ensaawthhctjmfyjbgsq.supabase.co';
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? '__SUPABASE_PUBLISHABLE_KEY__';
writeFileSync(
  betaConfig,
  readFileSync(betaConfig, 'utf8')
    .replace('__SUPABASE_URL__', supabaseUrl.replaceAll('\\', '\\\\').replaceAll("'", "\\'"))
    .replace('__SUPABASE_PUBLISHABLE_KEY__', supabasePublishableKey.replaceAll('\\', '\\\\').replaceAll("'", "\\'")),
);
console.log('Built public site, practice app and wallet beta into .deploy/');
