/** Creates .env from .env.example with a random admin key. Run once: npm run setup */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const root = new URL('../', import.meta.url);
const envPath = new URL('.env', root);
if (existsSync(envPath)) {
  const current = readFileSync(envPath, 'utf8').match(/^ADMIN_KEY=(.*)$/m)?.[1];
  console.log('.env already exists, leaving it unchanged.');
  if (current) console.log(`Admin key: ${current}`);
  process.exit(0);
}
const key = randomBytes(24).toString('base64url');
const env = readFileSync(new URL('.env.example', root), 'utf8').replace(/^ADMIN_KEY=.*$/m, `ADMIN_KEY=${key}`);
writeFileSync(envPath, env);
console.log('Created .env');
console.log(`Admin key: ${key}`);
console.log('Keep this key private. You need it to open http://localhost:8787/#/admin');
