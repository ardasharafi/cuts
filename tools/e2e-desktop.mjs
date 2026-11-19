// The Windows app end to end (run here with the helper built for this machine):
// first run, recovery code, GitHub, invoices, shares, PDFs, the iPhone QR code,
// lock, restart, and the helper's own defences.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { rmSync, existsSync, readdirSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { createEngine } from '../docs/assets/js/engine.js';
import { fakeGitHub, memoryStorage } from './fake-github.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const SP = process.argv[2];   // a scratch folder: screenshots go to shots/, other output to out/
for (const d of ['/shots', '/out']) mkdirSync(SP + d, { recursive: true });
const BIN = SP + '/out/cuts-linux';   // the helper built for this machine: go build -o <scratch>/out/cuts-linux .
const DATA = SP + '/run-desktop';
const PDFS = DATA + '/pdfs';
const INVOICE = new URL('./sample/HaloNine_HaloNine_202607_2026-07_100231.pdf', import.meta.url).pathname;   // made up, see make-sample-invoice.mjs
const CHROME = process.env.CUTS_BROWSER || chromium.executablePath();
const BASE = 'http://127.0.0.1:47615';
rmSync(DATA, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startHelper() {
  const p = spawn(BIN, [], { env: { ...process.env, CUTS_NO_WINDOW: '1', CUTS_DATA_DIR: DATA, CUTS_PDF_DIR: PDFS, CUTS_BROWSER: CHROME }, stdio: 'inherit' });
  for (let i = 0; i < 50; i += 1) {
    try { const r = await fetch(BASE + '/native/ping'); if (r.ok) return p; } catch (e) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('the helper did not start');
}
async function stopHelper(p) { p.kill('SIGTERM'); await new Promise((r) => p.once('exit', r)); }
// a request with full control over its headers (fetch won't let Host be set)
function raw(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 47615, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const gh = fakeGitHub();
const TOKEN = 'github_pat_' + 'Zx9Yw8Vu7T'.repeat(8);
gh.add('ardasharafi/cuts-ledger', { [TOKEN]: 'rw' });
const KEY = 'ardasharafi/cuts-ledger#' + TOKEN;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n += 1; }; const eq = (a, b, m) => { assert.deepEqual(a, b, m); n += 1; };

let helper = await startHelper();
const browser = await chromium.launch();
let phone = null;
let page = null;
const logs = [];
try {
const context = await browser.newContext({ viewport: { width: 1380, height: 880 }, deviceScaleFactor: 1 });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
await context.route('https://api.github.com/**', (route) => gh.route(route));
page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));
page.on('response', (r) => { if (r.status() >= 400) logs.push('HTTP ' + r.status() + ' ' + r.url().replace(/github_pat_\w+/, 'github_pat_…')); });
const shot = (name, opts = {}) => page.screenshot({ path: SP + '/shots/desk-' + name + '.png', ...opts });
const text = async (sel) => (await page.innerText(sel)).replace(/\s+/g, ' ').trim();
const toastText = async () => (await page.locator('#toasts .toast').allInnerTexts()).join(' | ').replace(/\s+/g, ' ');
const waitToast = (re) => page.waitForFunction((src) => [...document.querySelectorAll('#toasts .toast')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout: 90000 });

// ---- first run
await page.goto(BASE + '/');
await page.waitForSelector('.lock-card h1');
eq(await text('.lock-card h1'), 'Welcome');
ok(!(await page.evaluate(() => document.body.classList.contains('is-phone'))), 'computer layout');
await page.waitForTimeout(400);
await shot('01-welcome');
await page.click('[data-step="new"]');
await page.fill('#su-pw', 'open sesame');
await page.fill('#su-pw2', 'open sesam');
await page.click('[data-act="setup"]');
eq(await text('#form-error'), 'The passwords don’t match.');
await page.fill('#su-pw2', 'open sesame');
await shot('02-password');
await page.click('[data-act="setup"]');
await page.waitForSelector('.modal .code-box');
const code = await text('.modal .code-box');
ok(/^([A-Z2-7]{4}-){5}[A-Z2-7]{4}$/.test(code), 'recovery code ' + code);
ok(await page.locator('#code-done').isDisabled(), 'Done waits for the tick');
await shot('03-recovery-code');
await page.check('.modal [data-saved]');
await page.click('#code-done');
await page.waitForSelector('.modal #m-key');
eq(await text('.modal .modal-title'), 'Sync with GitHub');
await page.fill('#m-key', 'ardasharafi/cuts-ledger#' + 'github_pat_' + 'wrongwrong'.repeat(8));
await page.click('.modal .btn-primary');
await page.waitForSelector('.modal [data-error]:not([hidden])');
ok(/invalid or has expired/.test(await text('.modal [data-error]')), 'bad key message');
await page.fill('#m-key', KEY);
await shot('04-offer-sync');
await page.click('.modal .btn-primary');
await waitToast(/Connected to GitHub/);
ok(gh.repo('ardasharafi/cuts-ledger').files.has('cuts-ledger.json'), 'the ledger went to GitHub');
await page.waitForTimeout(600);
await shot('05-empty');
eq(await text('.empty-title'), 'No invoices yet');

// ---- the invoice, the share
await page.setInputFiles('#file-input', INVOICE);
await page.waitForSelector('tbody tr', { timeout: 30000 });
ok((await text('tbody tr')).includes('HaloNine July 2026, invoice 100231 €822.19'), 'row: ' + await text('tbody tr'));
ok(await page.evaluate(() => document.activeElement && document.activeElement.dataset.input === 'pct'), 'the share field has the focus');
await page.keyboard.type('۱۰');           // Persian digits, as a Persian keyboard would send them
await page.waitForTimeout(250);
eq(await page.inputValue('tbody input[data-input="pct"]'), '10');
eq(await text('tbody tr td:nth-child(5)'), '€82.22');
eq(await text('.hero-figure'), '€82.22');
eq(await text('.hero-sub'), '10% of €822.19 from 1 artist');
// the same file again is not counted twice
await page.setInputFiles('#file-input', INVOICE);
await waitToast(/already in the list/);
eq(await page.locator('tbody tr').count(), 1);

// ---- two more artists by hand
async function addByHand(name, total, pct) {
  await page.click('[data-act="add-manual"]');
  await page.waitForSelector('.modal #m-name');
  await page.fill('#m-name', name);
  await page.fill('#m-total', total);
  await page.fill('#m-invoice', String(100300 + name.length));
  if (pct) await page.fill('#m-pct', pct);
  if (name === 'Aster') { await page.waitForTimeout(250); await shot('06-add-artist'); }
  await page.click('.modal .btn-primary');
  await page.waitForSelector('.modal', { state: 'detached' });
}
await addByHand('Aster', '200.38', '3');
await addByHand('Teal', '2,662.84', '17');
await addByHand('Goldmoth', '327,33', '');
eq(await page.locator('tbody tr').count(), 4);
eq(await text('.page-sub'), '4 artists in July 2026, 1 without a share');
eq(await text('.nav-item.active .nav-count'), '1');
ok((await text('.notice')).startsWith('1 artist has no share yet.'), 'notice');
// 82.22 + 6.01 + 452.68 = 540.91
eq(await text('.hero-figure'), '€540.91');
eq(await text('tfoot'), 'Total €4,012.74 €540.91');
eq(await page.locator('.splitbar-part').first().getAttribute('data-label'), '14.7%');
await page.waitForTimeout(1200);
await page.mouse.move(700, 20);
await shot('07-shares');

// ---- typing an impossible share marks the field and leaves it out
const guc = page.locator('tbody tr', { hasText: 'Goldmoth' }).locator('input[data-input="pct"]');
await guc.fill('120');
ok(await guc.evaluate((el) => el.classList.contains('invalid')), 'over 100 is marked');
eq(await text('.hero-figure'), '€540.91');
await guc.fill('12,5');
await guc.press('Enter');
eq(await text('.hero-figure'), '€581.83');      // + 40.92 (327.33 × 12.5% = 40.916)
eq(await guc.inputValue(), '12.5');
eq(await text('tfoot'), 'Total €4,012.74 14.5% €581.83');
ok(await page.evaluate(() => document.activeElement.getAttribute('aria-label') === 'Share in percent for HaloNine'), 'Enter moves to the next share');

// ---- selection bar: set one share for several artists, undo
await page.check('tbody tr:nth-child(1) input[type=checkbox]');
await page.check('tbody tr:nth-child(2) input[type=checkbox]');
eq(await text('.bulk .count'), '2 selected');
await page.mouse.move(700, 20);
await shot('08-selection');
await page.click('[data-act="bulk-share"]');
await page.fill('.modal #m-pct', '5');
await page.click('.modal .btn-primary');
await waitToast(/Set the share of 2 artists to 5%/);
eq(await text('.hero-figure'), '€561.29');      // Aster 10.02 + Goldmoth 16.37 + HaloNine 82.22 + Teal 452.68
await page.locator('#toasts .toast', { hasText: 'Set the share' }).locator('button').click();
await page.waitForTimeout(400);
eq(await text('.hero-figure'), '€581.83');

// ---- delete with undo
await page.click('tbody tr:nth-child(1) [data-act="delete"]');
await waitToast(/Deleted Aster/);
eq(await page.locator('tbody tr').count(), 3);
await page.locator('#toasts .toast', { hasText: 'Deleted Aster' }).locator('button').click();
await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 4);

// ---- the PDF, as the app saves it
await page.click('[data-act="save-pdf"]');
await waitToast(/Saved Manager statement - July 2026\.pdf/);
ok((await toastText()).includes('Open') && (await toastText()).includes('Show in folder'), 'toast actions');
await shot('09-saved');
let pdf = PDFS + '/Manager statement - July 2026.pdf';
ok(existsSync(pdf), 'the PDF is in the folder');
let pdfText = execFileSync('pdftotext', ['-layout', pdf, '-']).toString();
for (const piece of ['Manager statement', 'Statement for', 'July 2026', '10 Tir – 9 Mordad 1405', 'HaloNine', '100231', '€822.19', '10%', '€82.22', 'Goldmoth', '12.5%', '€40.92', 'Total', '€4,012.74', '€581.83', 'Amounts in euros']) {
  ok(pdfText.includes(piece), 'PDF has "' + piece + '"');
}
const fonts = execFileSync('pdffonts', [pdf]).toString();
ok(/Inter/.test(fonts) && /Adventor/.test(fonts), 'the kit fonts are in the PDF:\n' + fonts);
const info = execFileSync('pdfinfo', [pdf]).toString();
ok(/Pages:\s+1\b/.test(info) && /A4/.test(info), 'one A4 page');

// ---- settings: the names on the statement
await page.click('.side-foot [data-page="settings"]');
await page.fill('#set-manager', 'Morrow');
await page.press('#set-manager', 'Enter');
await waitToast(/^Saved$/);
await page.fill('#set-business', 'Northside');
await page.press('#set-business', 'Tab');
await page.waitForTimeout(500);
ok((await text('#sync')).includes('ardasharafi/cuts-ledger'), 'sync panel shows the repository');
await page.mouse.move(700, 20);
await page.waitForTimeout(4200);
await shot('10-settings', { fullPage: true });

// ---- the statement page and the second PDF
await page.click('.nav [data-page="statement"]');
await page.waitForSelector('#sheet-scale .st-sheet');
eq(await text('.st-name'), 'Morrow');
eq(await text('.st-brand-name'), 'Northside');
await page.waitForTimeout(400);
await shot('11-statement', { fullPage: true });
await page.click('[data-act="save-pdf"]');
await waitToast(/Saved Manager Morrow - July 2026\.pdf/);
pdf = PDFS + '/Manager Morrow - July 2026.pdf';
pdfText = execFileSync('pdftotext', ['-layout', pdf, '-']).toString();
ok(pdfText.includes('Morrow') && pdfText.includes('Northside') && pdfText.includes('€581.83'), 'second PDF content');
execFileSync('pdftoppm', ['-r', '80', '-png', '-f', '1', '-l', '1', pdf, SP + '/out/desk-statement']);

// ---- the QR code for the iPhone: read it back and pair a phone engine with it
await page.click('.side-foot [data-page="settings"]');
await page.click('[data-act="phone-link"]');
await page.waitForSelector('.modal .qr-box svg');
await page.waitForTimeout(300);
await shot('12-phone-qr');
await page.locator('.modal .qr-box').screenshot({ path: SP + '/out/qr.png', scale: 'css' });
const decoded = execFileSync('python3', ['-c', 'import cv2,sys\nimg=cv2.imread(sys.argv[1])\nimg=cv2.resize(img,None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST)\nt,_,_=cv2.QRCodeDetectorAruco().detectAndDecode(img)\nprint(t)', SP + '/out/qr.png']).toString().trim();
ok(decoded.startsWith('https://ardasharafi.github.io/cuts/#p='), 'QR decodes to the phone link: ' + decoded.slice(0, 60));
await page.click('.modal .btn-ghost');     // Copy link
const copied = await page.evaluate(() => navigator.clipboard.readText());
eq(decoded, copied, 'the QR code and the copied link are the same');
await page.click('.modal .btn-primary');
phone = createEngine({ storage: memoryStorage(), platform: 'iphone', fetch: gh.fetch, version: 'test' });
phone.keepPhoneLink(decoded);
await phone.call('POST', '/api/pair', { password: 'open sesame' });
const onPhone = (await phone.call('GET', '/api/data')).colls;
eq(onPhone.rows.map((r) => r.b.name).sort(), ['Aster', 'Goldmoth', 'HaloNine', 'Teal']);
eq(onPhone.settings.find((s) => s.id === 'manager').b.value, 'Morrow');
// the phone changes a share; the window shows it after a sync
const teal = onPhone.rows.find((r) => r.b.name === 'Teal');
await phone.call('POST', '/api/mutate', { ops: [{ op: 'put', c: 'rows', id: teal.id, b: { ...teal.b, pct: '15' } }] });
await phone.call('POST', '/api/sync/now');
await page.click('[data-act="sync-now"]');
await waitToast(/Synced/);
await page.click('.nav [data-page="shares"]');
await page.waitForSelector('tbody tr');
const tealRow = page.locator('tbody tr').filter({ has: page.locator('.who-name', { hasText: /^Teal$/ }) });
eq(await tealRow.locator('input[data-input="pct"]').inputValue(), '15');

// ---- the sync key for another computer needs the password
await page.click('.side-foot [data-page="settings"]');
await page.click('[data-act="sync-key"]');
await page.fill('#m-password', 'nope');
await page.click('.modal .btn-primary');
await page.waitForSelector('.modal [data-error]:not([hidden])');
await page.fill('#m-password', 'open sesame');
await page.click('.modal .btn-primary');
await page.waitForSelector('.modal .mono-box');
eq(await text('.modal .mono-box'), KEY);
await page.click('.modal .btn-ghost');

// ---- lock, wrong password, unlock
await page.click('[data-act="lock"]');
await page.waitForSelector('#unlock-pw');
await page.waitForTimeout(300);
await shot('13-lock');
ok(!(await page.content()).includes('HaloNine'), 'nothing on screen while locked');
await page.fill('#unlock-pw', 'wrong');
await page.press('#unlock-pw', 'Enter');
await page.waitForSelector('#form-error:not([hidden])');
await page.fill('#unlock-pw', 'open sesame');
await page.press('#unlock-pw', 'Enter');
await page.waitForSelector('.side');
eq(await text('.page-title'), 'Settings', 'unlocking returns to the page that was open');
await page.click('.nav [data-page="shares"]');
await page.waitForSelector('tbody tr');

// ---- what is on disk is locked; a daily copy appears at the next start
await page.waitForTimeout(800);
const vault = readFileSync(DATA + '/data/vault.json', 'utf8');
const local = readFileSync(DATA + '/data/local.json', 'utf8');
ok(JSON.parse(vault).format === 'cuts-vault' && !vault.includes('HaloNine') && !vault.includes('Morrow'), 'the ledger file is locked');
ok(!local.includes('github_pat_'), 'the GitHub key is sealed on disk');

// ---- close and open again: everything is still there
await stopHelper(helper);
await page.waitForSelector('.gone', { timeout: 20000 });
ok((await text('.gone')).includes('Cuts has closed'), 'the window says the app has closed');
helper = await startHelper();
ok(readdirSync(DATA + '/data/backups').some((f) => /^cuts-ledger-\d{4}-\d\d-\d\d\.json$/.test(f)), 'daily copy');
await page.goto(BASE + '/');
await page.waitForSelector('#unlock-pw');
await page.fill('#unlock-pw', 'open sesame');
await page.click('[data-act="unlock"]');
await page.waitForSelector('tbody tr');
eq(await page.locator('tbody tr').count(), 4);
eq(await text('.hero-label'), 'Morrow’s share for July 2026');

// ---- the helper turns strangers away
const H = { Host: '127.0.0.1:47615' };
eq((await raw('/native/info', { headers: { ...H } })).status, 403, 'no header');
eq((await raw('/native/info', { headers: { ...H, 'X-Cuts': '1' } })).status, 200, 'the page itself');
eq((await raw('/native/info', { headers: { Host: 'evil.example:47615', 'X-Cuts': '1' } })).status, 403, 'another host name');
eq((await raw('/', { headers: { Host: 'evil.example' } })).status, 403, 'page under another host name');
eq((await raw('/native/store', { headers: { ...H, 'X-Cuts': '1', Origin: 'https://evil.example' } })).status, 403, 'another origin');
eq((await raw('/native/store', { headers: { ...H, 'X-Cuts': '1', 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'cross-site fetch');
eq((await raw('/native/events', { headers: { ...H, 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'cross-site event stream');
eq((await raw('/native/store/..%2f..%2fsecret', { method: 'PUT', headers: { ...H, 'X-Cuts': '1' }, body: '{}' })).status, 404, 'no other file names');
eq((await raw('/native/store/cuts.vault', { method: 'PUT', headers: { ...H, 'X-Cuts': '1' }, body: 'not json' })).status, 400, 'only ledger files');
eq((await raw('/native/open', { method: 'POST', headers: { ...H, 'X-Cuts': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/etc/passwd' }) })).status, 403, 'only saved PDFs open');
ok([301, 404].includes((await raw('/../main.go', { headers: H })).status), 'no files outside the app (the path is cleaned first)');
eq((await raw('/main.go', { headers: H })).status, 404, 'the program itself is not served');
eq((await raw('/assets/js/..%2f..%2f..%2fmain.go', { headers: H })).status, 404, 'no escaping the web folder');
eq((await raw('/sw.js', { headers: H })).status, 404, 'no service worker on the computer');
eq((await raw('/print/doesnotexist', { headers: H })).status, 404, 'print pages are one-time');
ok((await raw('/', { headers: H })).body.includes('data-native="1"'), 'the page is marked as the Windows app');
ok((await raw('/assets/js/pdfjs/pdf.worker.min.mjs', { headers: H })).headers['content-type'].startsWith('text/javascript'), 'module scripts have the right type');

// ---- a second start asks the first to show its window and leaves
const second = spawn(BIN, [], { env: { ...process.env, CUTS_NO_WINDOW: '1', CUTS_DATA_DIR: DATA, CUTS_PDF_DIR: PDFS, CUTS_BROWSER: CHROME } });
const exitCode = await new Promise((r) => second.once('exit', r));
eq(exitCode, 0, 'the second copy exits');
eq((await fetch(BASE + '/native/ping')).status, 200, 'the first keeps running');

writeFileSync(SP + '/out/desk-log.txt', logs.join('\n'));
console.log('desktop: all', n, 'checks passed' + (logs.length ? '; console: ' + [...new Set(logs)].slice(0, 6).join(' | ') : '; clean console'));
} catch (e) {
  console.log('FAILED after', n, 'checks:', e && e.message ? e.message.split('\n').slice(0, 12).join('\n') : e);
  try { await page.screenshot({ path: SP + '/shots/desk-FAILED.png' }); } catch (x) { /* no page */ }
  if (logs.length) console.log('console:', [...new Set(logs)].slice(0, 8).join(' | '));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  if (phone) phone.stop();
  await stopHelper(helper).catch(() => {});
}
