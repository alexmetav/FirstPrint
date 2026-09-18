import { cpSync, mkdirSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const out = new URL('../.deploy/', import.meta.url);
mkdirSync(out, { recursive: true });
cpSync(new URL('site/', root), out, { recursive: true });
cpSync(new URL('web/', root), new URL('play/', out), { recursive: true });
console.log('Built public site and prediction app into .deploy/');
