/**
 * Builds a single-file preview of the public website: dist/firstprint-site-preview.html
 * (The deployable site is the site/ folder as-is; no build needed.)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../site/', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const inline = (src: string) =>
  src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '').replace(/^export\s+(?=(async\s+)?(function|class|const|let))/gm, '');

const html = read('index.html')
  .replace(/<link rel="stylesheet" href="assets\/styles\.css"\s*\/?>/, () => `<style>\n${read('assets/styles.css')}\n</style>`)
  .replace(/<script src="assets\/config\.js"><\/script>/, () => `<script>\n${read('assets/config.js')}\n</script>`)
  .replace(/<script type="module" src="assets\/site\.js"><\/script>/, () => `<script type="module">\n${inline(read('assets/exchanges.js'))}\n;\n${inline(read('assets/site.js'))}\n</script>`)
  .replace(/href="favicon\.svg"/, `href="data:image/svg+xml,${encodeURIComponent(read('favicon.svg'))}"`);

mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/firstprint-site-preview.html', import.meta.url), html);
console.log(`dist/firstprint-site-preview.html ${html.length} bytes`);
