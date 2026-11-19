import { writeFileSync } from 'node:fs';
import { encode, svg } from '../docs/assets/js/qr.js';
const out = [];
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
for (const level of ['L', 'M']) {
  for (const len of [3, 17, 40, 78, 130, 200, 271, 330, 362, 420, 520, 700, 900, 1200, 1700]) {
    let text = 'https://ardasharafi.github.io/cuts/#p=';
    while (text.length < len) text += alphabet[rnd() % alphabet.length];
    text = text.slice(0, len);
    const q = encode(text, level);
    out.push({ level, text, size: q.size, version: q.version, mask: q.mask, rows: q.modules.map((r) => r.map((d) => (d ? 1 : 0)).join('')) });
  }
}
out.push((() => { const text = 'سلام Cuts €'; const q = encode(text, 'L'); return { level: 'L', text, size: q.size, version: q.version, mask: q.mask, rows: q.modules.map((r) => r.map((d) => (d ? 1 : 0)).join('')) }; })());
writeFileSync(process.argv[2], JSON.stringify(out));
writeFileSync(process.argv[3], svg(out[8].text));
console.log('wrote', out.length, 'codes; versions:', out.map((o) => o.level + o.version).join(' '));
