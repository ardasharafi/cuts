// The iPhone web app end to end: pair with the link from a computer, add an invoice,
// type a share, sync both ways, make the PDF, lock and unlock.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createEngine } from '../docs/assets/js/engine.js';
import { fakeGitHub, memoryStorage } from './fake-github.mjs';
import { serveStatic } from './static-server.mjs';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SP = process.argv[2];   // a scratch folder: screenshots go to shots/, other output to out/
for (const d of ['/shots', '/out']) mkdirSync(SP + d, { recursive: true });
const INVOICE = new URL('./sample/HaloNine_HaloNine_202607_2026-07_100231.pdf', import.meta.url).pathname;   // made up, see make-sample-invoice.mjs
const PORT = 8771;
const server = await serveStatic(new URL('../docs/', import.meta.url).pathname, PORT);
const gh = fakeGitHub();
const TOKEN = 'github_pat_' + 'A1b2C3d4E5'.repeat(8);
gh.add('ardasharafi/cuts-ledger', { [TOKEN]: 'rw' });

// the computer: a new ledger, connected to GitHub
const pc = createEngine({ storage: memoryStorage(), platform: 'windows', fetch: gh.fetch, version: 'test' });
await pc.call('POST', '/api/setup', { password: 'open sesame' });
await pc.call('POST', '/api/mutate', { ops: [{ op: 'put', c: 'settings', id: 'manager', b: { value: 'Morrow' } }, { op: 'put', c: 'rows', id: 'r-aster', b: { name: 'Aster', total: 20038, cur: 'EUR', period: '2026-07', invoiceNo: '100232', customerId: '', file: '', pct: '5' } }] });
await pc.call('POST', '/api/sync/connect', { key: 'ardasharafi/cuts-ledger#' + TOKEN });
const link = (await pc.call('GET', '/api/phone')).url.replace('https://ardasharafi.github.io/cuts/', 'http://127.0.0.1:' + PORT + '/');

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 14'], acceptDownloads: true });
await context.route('https://api.github.com/**', (route) => gh.route(route));
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));
const shot = (name) => page.screenshot({ path: SP + '/shots/phone-' + name + '.png' });
const text = async (sel) => (await page.innerText(sel)).replace(/\s+/g, ' ').trim();
let n = 0; const ok = (c, m) => { assert.ok(c, m); n += 1; }; const eq = (a, b, m) => { assert.deepEqual(a, b, m); n += 1; };

// 1. a visitor without a link sees only the connect screen
await page.goto('http://127.0.0.1:' + PORT + '/');
await page.waitForSelector('.lock-card h1');
eq(await text('.lock-card h1'), 'Connect this iPhone');
ok(await page.evaluate(() => document.body.classList.contains('is-phone')), 'phone layout');
await shot('01-connect');

// 2. the link from the computer
await page.goto(link);
await page.reload();
await page.waitForSelector('.lock-card h1');
eq(await text('.lock-card h1'), 'Add Cuts to your Home Screen');
await shot('02-home-screen');
await page.click('text=Use it here in Safari');
eq(await text('.lock-card h1'), 'Connect this iPhone');
await page.fill('#pr-pw', 'wrong');
await page.click('[data-act="pair"]');
await page.waitForSelector('#form-error:not([hidden])');
ok(/password isn.t right/.test(await text('#form-error')), 'wrong password is refused');
await page.fill('#pr-pw', 'open sesame');
await shot('03-password');
await page.click('[data-act="pair"]');
await page.waitForSelector('.phone-tabs');
await page.waitForSelector('tbody tr');
ok((await text('tbody tr')).includes('Aster'), 'the row from the computer is on the phone');
ok((await text('.hero-label')).includes('Morrow'), 'the manager name came along');
await page.waitForTimeout(1200);
await shot('04-shares');

// 3. add the sample invoice on the phone, type the share
await page.setInputFiles('#file-input', INVOICE);
await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2, null, { timeout: 30000 });
const row = page.locator('tbody tr', { hasText: 'HaloNine' });
ok((await row.innerText()).includes('€822.19'), 'total earnings read from the PDF');
await row.locator('input[data-input="pct"]').fill('10');
await page.waitForTimeout(300);
ok((await row.innerText()).includes('€82.22'), 'manager amount ' + (await row.innerText()).replace(/\s+/g, ' '));
eq(await text('.hero-figure'), '€92.24');     // 82.22 + 5% of 200.38 = 10.02
await page.locator('input[data-input="pct"]').first().blur();
await shot('05-two-rows');

// 4. the phone's change reaches the computer
await page.waitForTimeout(3500);
await pc.call('POST', '/api/sync/now');
let rows = (await pc.call('GET', '/api/data')).colls.rows.map((r) => r.b);
eq(rows.map((r) => r.name + ':' + r.pct).sort(), ['Aster:5', 'HaloNine:10']);
eq(rows.find((r) => r.name === 'HaloNine').total, 82219);

// 5. the computer's change reaches the phone
await pc.call('POST', '/api/mutate', { ops: [{ op: 'put', c: 'rows', id: 'r-teal', b: { name: 'Teal', total: 266284, cur: 'EUR', period: '2026-07', invoiceNo: '100233', customerId: '', file: '', pct: '12.5' } }] });
await pc.call('POST', '/api/sync/now');
await page.click('.phone-tabs .tab:nth-child(3)');
await page.waitForSelector('[data-act="sync-now"]');
await shot('06-settings');
await page.click('[data-act="sync-now"]');
await page.waitForTimeout(1500);
await page.click('.phone-tabs .tab:nth-child(1)');
await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 3);
eq(await text('.hero-figure'), '€425.10');    // 10.02 + 82.22 + 332.86
ok((await text('tfoot')).includes('€3,685.41'), 'total earnings ' + await text('tfoot'));

// 6. the statement and its PDF
await page.click('.phone-tabs .tab:nth-child(2)');
await page.waitForSelector('#sheet-scale .st-sheet');
ok((await text('.st-name')) === 'Morrow', 'statement name');
await page.waitForTimeout(500);
await shot('07-statement');
await page.click('[data-act="save-pdf"]');
await page.waitForSelector('.modal .modal-title', { timeout: 60000 });
ok((await text('.modal .modal-title')) === 'Manager Morrow - July 2026.pdf', 'pdf name: ' + await text('.modal .modal-title'));
await shot('08-pdf-ready');
const [download] = await Promise.all([page.waitForEvent('download'), page.click('.modal .btn-primary')]);
await download.saveAs(SP + '/out/phone-statement.pdf');
ok(true, 'the PDF was handed over');

// 7. lock and unlock
await page.keyboard.press('Escape');
await page.click('.phone-lock');
await page.waitForSelector('#unlock-pw');
await shot('09-locked');
ok(!(await page.content()).includes('HaloNine'), 'nothing is shown while locked');
await page.fill('#unlock-pw', 'open sesame');
await page.click('[data-act="unlock"]');
await page.waitForSelector('tbody tr');

// 8. what the phone keeps is locked
const stored = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
ok(!stored.includes('HaloNine') && !stored.includes('github_pat_'), 'the phone stores only locked data');
ok(Object.keys(JSON.parse(stored)).every((k) => k.startsWith('cuts.')), 'storage keys: ' + Object.keys(JSON.parse(stored)).join(', '));

writeFileSync(SP + '/out/phone-log.txt', logs.join('\n'));
console.log('phone: all', n, 'checks passed' + (logs.length ? '; console: ' + logs.slice(0, 6).join(' | ') : '; clean console'));
await browser.close();
pc.stop();
server.close();
