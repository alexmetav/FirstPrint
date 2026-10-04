import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
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
