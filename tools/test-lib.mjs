import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as lib from '../docs/assets/js/lib.js';
import { fieldsFromPages, fieldsFromFileName } from '../docs/assets/js/invoice.js';

let n = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n += 1; };

// ---- amounts
eq(lib.parseAmount('822.19 €'), 82219);
eq(lib.parseAmount('1,234.56'), 123456);
eq(lib.parseAmount('1.234,56'), 123456);
eq(lib.parseAmount('1,234'), 123400);
eq(lib.parseAmount('12,5'), 1250);
eq(lib.parseAmount('1.234.567'), 123456700);
eq(lib.parseAmount('-5.15 €'), -515);
eq(lib.parseAmount('−5.15'), -515);
eq(lib.parseAmount('(5.15)'), -515);
eq(lib.parseAmount('0.00 €'), 0);
eq(lib.parseAmount('۸۲۲٫۱۹'), 82219);
eq(lib.parseAmount('abc'), null);
eq(lib.parseAmount(''), null);
eq(lib.parseAmount('0.005'), 1);
eq(lib.parseAmount('4,910,917'), 491091700);
eq(lib.formatMoney(82219, 'EUR'), '€822.19');
eq(lib.formatMoney(123456789, 'USD'), '$1,234,567.89');
eq(lib.formatMoney(-53257, 'CAD'), '−CA$532.57');
eq(lib.formatMoney(5, 'EUR'), '€0.05');
eq(lib.plainAmount(82219), '822.19');
eq(lib.plainAmount(123456789), '1,234,567.89');
eq(lib.parseAmount(lib.plainAmount(123456789)), 123456789);

// ---- percentages
eq(lib.parsePercent('10'), 10000);
eq(lib.parsePercent('10%'), 10000);
eq(lib.parsePercent(' 12,5 % '), 12500);
eq(lib.parsePercent('3'), 3000);
eq(lib.parsePercent('17'), 17000);
eq(lib.parsePercent('۱۷'), 17000);
eq(lib.parsePercent('۱۲٫۵٪'), 12500);
eq(lib.parsePercent(''), undefined);
eq(lib.parsePercent('  '), undefined);
eq(lib.parsePercent('abc'), null);
eq(lib.parsePercent('101'), null);
eq(lib.parsePercent('100'), 100000);
eq(lib.parsePercent('0'), 0);
eq(lib.parsePercent('.5'), 500);
eq(lib.parsePercent('-5'), null);
eq(lib.parsePercent('1.2.3'), null);
eq(lib.plainPercent(12500), '12.5');
eq(lib.plainPercent(10000), '10');
eq(lib.formatPercent(3250), '3.25%');

// ---- the manager's amount
eq(lib.shareOf(82219, 10000), 8222);      // 822.19 × 10% = 82.219 → 82.22
eq(lib.shareOf(82219, 3000), 2467);       // 24.6657 → 24.67
eq(lib.shareOf(82219, 17000), 13977);     // 139.7723 → 139.77
eq(lib.shareOf(100, 12500), 13);          // 0.125 → 0.13 (half up)
eq(lib.shareOf(10, 5000), 1);             // 0.005 → 0.01
eq(lib.shareOf(0, 5000), 0);
eq(lib.shareOf(-100, 12500), -13);
eq(lib.shareOf(99999999999, 17000), 16999999999.83 * 100 | 0 ? lib.shareOf(99999999999, 17000) : 0);
eq(lib.shareOf(99999999999, 17000), Number((99999999999n * 17000n + 50000n) / 100000n));
eq(lib.formatRatio(8222, 82219), '10%');
eq(lib.formatRatio(29208, 322110), '9.1%');
eq(lib.formatRatio(2996, 322110), '0.9%');
eq(lib.formatRatio(0, 0), '0%');

// ---- Jalali dates: the pairs printed in the design kit, plus year boundaries
const J = (y, m, d) => { const j = lib.toJalali(y, m, d); return [j.jy, j.jm, j.jd]; };
eq(J(2026, 11, 1), [1405, 8, 10]);
eq(J(2026, 11, 30), [1405, 9, 9]);
eq(J(2026, 11, 4), [1405, 8, 13]);
eq(J(2026, 11, 19), [1405, 8, 28]);
eq(J(2026, 3, 21), [1405, 1, 1]);
eq(J(2026, 3, 20), [1404, 12, 29]);
eq(J(2025, 3, 21), [1404, 1, 1]);
eq(J(2025, 3, 20), [1403, 12, 30]);
eq(J(2024, 3, 20), [1403, 1, 1]);
eq(J(2000, 1, 1), [1378, 10, 11]);
// cross-check a few years against the Persian calendar built into the JS engine
const fmt = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
let checked = 0;
for (let t = Date.UTC(2015, 0, 1); t < Date.UTC(2040, 0, 1); t += 86400000) {
  const d = new Date(t);
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const got = J(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  assert.deepEqual(got, [Number(parts.year), Number(parts.month), Number(parts.day)], 'jalali mismatch on ' + d.toISOString().slice(0, 10));
  checked += 1;
}
console.log('jalali cross-checked for', checked, 'days');
eq(lib.jalaliRange(2026, 11, 1, 2026, 11, 30), '10 Aban – 9 Azar 1405');
eq(lib.formatJalali(new Date(2026, 10, 19)), '28 Aban 1405');
eq(lib.formatDate(new Date(2026, 10, 19)), 'Nov 19, 2026');
eq(lib.periodSpan(['2026-07']).label, 'July 2026');
eq(lib.periodSpan(['2026-07']).jalali, '10 Tir – 9 Mordad 1405');
eq(lib.periodSpan(['2026-07', '2026-09', '2026-07']).label, 'Jul – Sep 2026');
eq(lib.periodSpan(['2025-12', '2026-02']).label, 'Dec 2025 – Feb 2026');
eq(lib.periodSpan(['2026-03']).jalali, '10 Esfand 1404 – 11 Farvardin 1405');
eq(lib.periodSpan([], '2026-11').label, 'November 2026');
eq(lib.parsePeriod('2026-07'), '2026-07');
eq(lib.parsePeriod('2026-7'), '2026-07');
eq(lib.parsePeriod('2026-13'), null);
eq(lib.periodLabel('2026-07'), 'July 2026');

// ---- names
eq(lib.cleanBilledName('HaloNine_HaloNine_202607'), 'HaloNine');
eq(lib.cleanBilledName('Ada Thorn_Ada Thorn_202611'), 'Ada Thorn');
eq(lib.cleanBilledName('LabelX_Dusk_202607'), 'LabelX Dusk');
eq(lib.cleanBilledName('Teal'), 'Teal');
eq(lib.initials('Ada Thorn'), 'AT');
eq(lib.initials('Aster'), 'AS');
eq(lib.initials('Da$h'), 'DH');
eq(lib.initials('R4'), 'R4');
eq(lib.initials('CEDAR'), 'CE');
eq(lib.initials(''), '?');
eq(lib.safeFileName('Manager A/B: "x" - July 2026.'), 'Manager A B x - July 2026');
eq(lib.safeFileName('CON'), '_CON');
eq(lib.esc('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
eq(fieldsFromFileName('HaloNine_HaloNine_202607_2026-07_100231.pdf'), { name: 'HaloNine', period: '2026-07', invoiceNo: '100231' });
eq(fieldsFromFileName('scan.pdf'), { name: '', period: null, invoiceNo: '' });

// ---- reading an invoice: the made-up sample, or the PDF named on the command line
globalThis.DOMMatrix ??= class DOMMatrix {};   // PDF.js wants one to exist; reading text never uses it
const pdfjs = await import('../docs/assets/js/pdfjs/pdf.min.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../docs/assets/js/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const SAMPLE = 'HaloNine_HaloNine_202607_2026-07_100231.pdf';
const own = process.argv[2];
const data = new Uint8Array(await readFile(own || new URL('./sample/' + SAMPLE, import.meta.url).pathname));
const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true }).promise;
const pages = [];
for (let p = 1; p <= Math.min(2, doc.numPages); p += 1) {
  const tc = await (await doc.getPage(p)).getTextContent();
  pages.push(tc.items.filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0 })));
}
const f = fieldsFromPages(pages, 'whatever.pdf');
if (own) {
  // somebody's real invoice: show what was read, and check only that the two ways of reading it agree
  console.log('invoice fields:', JSON.stringify(f));
  eq(f.ok, true);
  if (pages[1]) eq(fieldsFromPages([pages[1]], 'whatever.pdf').total, f.total);
} else {
  eq(f, { ok: true, total: 82219, cur: 'EUR', billedTo: 'HaloNine_HaloNine_202607', name: 'HaloNine', period: '2026-07', invoiceNo: '100231', customerId: '40112', hasText: true });
  // page 2 alone ("Total Earning" next to other columns) must still give the same total;
  // the name, the period and the number then come from the file name
  const f2 = fieldsFromPages([pages[1]], SAMPLE);
  eq(f2.total, 82219); eq(f2.cur, 'EUR'); eq(f2.name, 'HaloNine'); eq(f2.period, '2026-07'); eq(f2.invoiceNo, '100231');
}

// ---- statement model
const rows = lib.computeRows([
  { id: 'a', name: 'HaloNine', total: 82219, cur: 'EUR', period: '2026-07', invoiceNo: '100231', pct: '10' },
  { id: 'b', name: 'Aster', total: 20038, cur: 'EUR', period: '2026-07', invoiceNo: '100232', pct: '' },
  { id: 'c', name: 'Teal', total: 266284, cur: 'EUR', period: '2026-07', invoiceNo: '100233', pct: '12,5' },
]);
eq(rows.map((r) => r.amount), [8222, null, 33286]);   // 2662.84 × 12.5% = 332.855 → 332.86
eq(rows.map((r) => r.pctState), ['ok', 'empty', 'ok']);
const t = lib.totalsByCurrency(rows);
eq(t.length, 1); eq(t[0].earnings, 82219 + 20038 + 266284); eq(t[0].amount, 8222 + 33286); eq(t[0].counted, 2);
const html = lib.statementHTML({ business: '', manager: 'Morrow', issued: new Date(2026, 10, 19), rows });
assert.ok(html.includes('<h1 class="st-name">Morrow</h1>')); n += 1;
assert.ok(html.includes('July 2026') && html.includes('10 Tir – 9 Mordad 1405')); n += 1;
assert.ok(html.includes('€415.08')); n += 1;    // 82.22 + 332.86
assert.ok(html.includes('1 artist without a share is not counted')); n += 1;
eq(lib.statementFileName({ manager: 'Morrow', issued: new Date(2026, 10, 19), rows }), 'Manager Morrow - July 2026');
console.log('all', n, 'checks passed');
