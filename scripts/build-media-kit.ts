// Builds the partner media kit served at /media-kit: PNG copies of the logo SVGs, the banners, a short
// guide, and one zip with all of it. Run `npm run build:media-kit` after changing anything in
// site/media-kit/logo/ or brand/, then commit the results (the page links to the files directly).
//
// The logo SVGs have the wordmark as outlines (Bricolage Grotesque 700), so they look the same on every
// computer with no font installed.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

const root = new URL('../', import.meta.url);
const kit = new URL('site/media-kit/', root);
const at = (rel: string) => new URL(rel, kit);

mkdirSync(at('logo/'), { recursive: true });
mkdirSync(at('banners/'), { recursive: true });

/** PNG renders of each logo SVG: [svg name, output width]. */
const renders: [string, number][] = [
  ['firstprint-logo-for-dark', 3040],
  ['firstprint-logo-for-light', 3040],
  ['firstprint-logo-on-ink', 3040],
  ['firstprint-mark', 1200],
  ['firstprint-icon', 1024],
];
for (const [name, width] of renders) {
  const svg = readFileSync(at(`logo/${name}.svg`), 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
  writeFileSync(at(`logo/${name}.png`), png);
}

copyFileSync(new URL('site/og.png', root), at('banners/firstprint-link-preview-1200x630.png'));
copyFileSync(new URL('brand/x-banner-4k.png', root), at('banners/firstprint-x-header-3840x1280.png'));
copyFileSync(new URL('brand/screens/markets.png', root), at('banners/firstprint-app-screenshot.png'));

const guide = `FIRSTPRINT MEDIA KIT
https://firstprint.fun/media-kit

ABOUT
Firstprint is a free prediction game for crypto prices. Players pick where a token lands
(Crash, Down, Flat, Up or Moon) with free points, climb the leaderboard and claim rewards
as TestFPT on Solana.

Short: Firstprint: call where crypto prices land.

LOGO FILES (logo/)
  firstprint-logo-for-dark   Logo with light text, for dark backgrounds
  firstprint-logo-for-light  Logo with dark text, for light backgrounds
  firstprint-logo-on-ink     Logo on the Firstprint dark badge, works anywhere
  firstprint-mark            The five-bar mark alone
  firstprint-icon            Square app icon / avatar (circle-safe)
SVG files scale to any size. PNG files have transparent backgrounds (except the badge and icon).

COLOURS
  Moon   #7DFF3A
  Up     #35E0A1
  Flat   #A6B0C4
  Down   #FF8A5C
  Crash  #FF4D6A
  Ink    #07090F  (background)
  Paper  #F2F5FA  (text on dark)

TYPE
  Wordmark: Bricolage Grotesque Bold   https://fonts.google.com/specimen/Bricolage+Grotesque
  Product:  Geist                      https://fonts.google.com/specimen/Geist

USING THE LOGO
  - Leave clear space around the logo equal to the height of one bar.
  - Don't recolour, reorder, stretch or rotate the bars. The colour order carries the meaning.
  - Use the badge (on-ink) or icon on busy photos.
  - Smallest size: about 24 px tall for the mark.
  - Write the name as "Firstprint" (one word, capital F).

CONTACT
  X: https://x.com/firstprintapp
  Telegram: https://t.me/firstprintfun
`;
writeFileSync(at('README.txt'), guide);

// ---- Zip (deflate, no external tools) --------------------------------------------------------------

function filesUnder(dir: URL, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix + name;
    return statSync(new URL(name, dir)).isDirectory() ? filesUnder(new URL(`${name}/`, dir), `${rel}/`) : [rel];
  });
}

const entries = ['README.txt', ...['logo/', 'banners/'].flatMap((d) => filesUnder(at(d), d))];
const local: Buffer[] = [];
const central: Buffer[] = [];
let offset = 0;
// A fixed timestamp (2026-01-01) so rebuilding unchanged files gives the same zip.
const dosTime = 0;
const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
for (const rel of entries) {
  const data = readFileSync(at(rel));
  const packed = deflateRawSync(data, { level: 9 });
  const useDeflate = packed.length < data.length;
  const body = useDeflate ? packed : data;
  const name = Buffer.from(`firstprint-media-kit/${rel}`);
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(useDeflate ? 8 : 0, 8);
  head.writeUInt16LE(dosTime, 10);
  head.writeUInt16LE(dosDate, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  local.push(head, name, body);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0x0800, 8);
  dir.writeUInt16LE(useDeflate ? 8 : 0, 10);
  dir.writeUInt16LE(dosTime, 12);
  dir.writeUInt16LE(dosDate, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(body.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(name.length, 28);
  dir.writeUInt32LE(offset, 42);
  central.push(dir, name);
  offset += head.length + name.length + body.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, centralBuf, end]);
writeFileSync(at('firstprint-media-kit.zip'), zip);
console.log(`Media kit: ${entries.length} files, firstprint-media-kit.zip ${(zip.length / 1024).toFixed(0)} KB`);
