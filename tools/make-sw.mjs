// Writes docs/sw.js with the list of files the iPhone keeps for offline use.
import { readdir, writeFile } from 'node:fs/promises';
import { APP_VERSION } from '../docs/assets/js/lib.js';
const web = new URL('../docs/', import.meta.url).pathname;
async function walk(dir, base = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base + e.name;
    if (e.isDirectory()) out.push(...await walk(dir + e.name + '/', rel + '/'));
    else out.push(rel);
  }
  return out;
}
const skip = new Set(['sw.js', 'assets/img/app-icon.svg', 'assets/img/logo-flat.svg', 'assets/img/logo-on-dark.svg', 'assets/js/pdfjs/LICENSE']);
const hidden = (f) => f.split('/').some((part) => part.startsWith('.'));
const files = (await walk(web)).filter((f) => !skip.has(f) && !hidden(f)).sort();
const list = ['./'].concat(files);
const sw = `/* Cuts for iPhone: keep the app on the phone so it opens without internet.
   Each version is cached as one set; a new version replaces the old set. */
var CACHE = 'cuts-${APP_VERSION}';
var FILES = ${JSON.stringify(list)};
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('cuts-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).catch(function () {
        return req.mode === 'navigate' ? c.match('index.html') : Response.error();
      });
    });
  }));
});
`;
await writeFile(web + 'sw.js', sw);
console.log('sw.js written:', list.length, 'files, cache cuts-' + APP_VERSION);
