// Writes the logo and icon files from the same geometry the app draws (lib.js → logoMark).
import { writeFile, mkdir } from 'node:fs/promises';
import { logoMark } from '../docs/assets/js/lib.js';
// sharp from the project if it is installed there, otherwise the copy this build machine keeps
const sharp = (await import('sharp').catch(() => import('/opt/npm-tools/node_modules/sharp/dist/index.mjs'))).default;

const inner = (kind) => logoMark(64, kind).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
const svg = (body, size = 64) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="' + size + '" height="' + size + '">' + body + '</svg>\n';
const scaled = (kind, k) => '<g transform="translate(32 32) scale(' + k + ') translate(-32 -32)">' + inner(kind) + '</g>';

const img = new URL('../docs/assets/img/', import.meta.url).pathname;
const out = new URL('../build/', import.meta.url).pathname;
await mkdir(img, { recursive: true });
await mkdir(out + 'png', { recursive: true });

const appIcon = svg('<rect width="64" height="64" rx="14" fill="#26173a"/>' + inner('dark'), 256);
const fullBleed = (k) => svg('<rect width="64" height="64" fill="#26173a"/>' + scaled('dark', k), 512);
await writeFile(img + 'app-icon.svg', appIcon);
await writeFile(img + 'logo-on-dark.svg', svg(inner('dark')));
await writeFile(img + 'logo-flat.svg', svg(inner('flat')));

// every source is redrawn at 64 px wide and rendered at twice the target size before scaling down
const png = (source, size, file) => sharp(Buffer.from(source.replace(/width="\d+" height="\d+"/, 'width="64" height="64"')), { density: Math.max(72, Math.ceil((72 * size * 2) / 64)) }).resize(size, size).png().toFile(file);
for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) await png(appIcon, size, out + 'png/icon-' + size + '.png');
await png(appIcon, 64, img + 'icon-64.png');
await png(appIcon, 192, img + 'icon-192.png');
await png(appIcon, 512, img + 'icon-512.png');
await png(fullBleed(0.84), 180, img + 'icon-180.png');           // iOS rounds the corners itself
await png(fullBleed(0.62), 512, img + 'icon-512-maskable.png');   // the mark stays inside the safe zone
console.log('logo and icon files written');
