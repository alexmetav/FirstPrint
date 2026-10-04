import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The browser code isn't type-checked, so a stray character would only show up as a blank page.
test('every browser script parses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-web-'));
  const files = [...readdirSync(new URL('../web/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `web/${f}`), 'site/assets/site.js'];
  for (const f of files) {
    const copy = join(dir, f.replace(/\//g, '_').replace(/\.js$/, '.mjs'));
    copyFileSync(new URL(`../${f}`, import.meta.url), copy);
    const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f} has a syntax error:\n${r.stderr}`);
  }
});

// Clicks reach the admin handler only for actions named admin-…; any other name there is a dead button.
test('every admin panel action is routed to the admin handler', () => {
  const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function onAdminAction(');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const cases = [...body.matchAll(/case '([^']+)'/g)].map((m) => m[1]);
  assert.ok(cases.length > 10);
  assert.deepEqual(cases.filter((c) => !c.startsWith('admin-')), []);
  assert.match(src, /if \(action\?\.startsWith\('admin-'\)\) return onAdminAction\(/);
});
