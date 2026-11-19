// Writes tools/sample/HaloNine_HaloNine_202607_2026-07_100231.pdf: a made-up invoice with
// the same labels in the same places as the invoices Cuts reads. Every name and number in it
// is invented, so the tests need nobody's real invoice.
import { writeFile, mkdir } from 'node:fs/promises';

const B = true;   // bold
// [x, y, size, bold, text] in PDF points from the bottom-left corner of an A4 page.
// The order is deliberately not reading order: values and labels are found by position.
const footer = (n) => [
  [49.5, 45.5, 9, !B, 'support@example.com'], [465.0, 45.5, 9, !B, 'Print Date'], [541.1, 45.5, 9, !B, 'Page No.'],
  [18.3, 45.5, 9, !B, 'E-mail:'], [464.0, 31.3, 9, !B, '2026-10-2'], [528.4, 31.3, 9, !B, 'Page ' + n + ' of 2'],
];
const page1 = [
  [20.2, 801.6, 17, B, 'Invoice'], [92.2, 799.4, 10, !B, 'Detailed Report'],
  ...footer(1),
  [18.5, 756.7, 10, !B, 'Billed to:'], [64.2, 756.1, 12, B, 'HaloNine_HaloNine_202607'],
  [18.5, 719.8, 10, !B, 'Accounting Period:'], [109.2, 719.8, 10, !B, '2026-09'],
  [18.5, 736.8, 10, !B, 'Reporting Period:'], [103.5, 736.8, 10, !B, '2026-07'],
  [455.1, 753.9, 10, !B, 'Customer ID'], [460.5, 736.8, 10, !B, 'Contract ID'], [460.9, 719.8, 10, !B, 'Invoice No.'],
  [547.3, 753.5, 11, B, '40112'], [547.3, 736.5, 11, B, '40110'], [541.5, 719.5, 11, B, '100231'],
  [211.6, 671.0, 12, B, 'Extra Expense List'], [211.3, 651.8, 10, !B, 'Title'], [340.0, 651.8, 10, !B, 'Total'],
  [211.3, 634.4, 10, !B, 'Invoice'], [211.3, 623.6, 10, !B, 'Amendment'], [433.7, 629.0, 10, !B, '0.00 €'],
  [373.7, 629.0, 10, !B, '100'], [427.4, 605.6, 12, B, '0.00 €'], [211.3, 606.2, 10, B, 'Sum'],
  [211.6, 563.1, 12, B, 'Payment List'], [381.2, 651.8, 10, !B, '%'], [430.4, 651.8, 10, !B, 'Amount'],
  [517.5, 651.8, 10, !B, 'Description'], [211.3, 543.8, 10, !B, 'Title'], [419.4, 543.8, 10, !B, 'Total'],
  [461.4, 543.8, 10, !B, 'XR'], [532.4, 543.8, 10, !B, 'Amount'], [211.3, 524.0, 10, !B, 'Bank'],
  [403.6, 524.0, 10, !B, '575.53 €'], [456.1, 524.0, 10, !B, '1.00'], [528.3, 524.0, 10, !B, '575.53 €'],
  [302.1, 524.0, 10, !B, '2026/10/02'], [528.3, 504.1, 10, B, '575.53 €'], [211.3, 504.1, 10, B, 'Sum'],
  [403.6, 504.1, 10, B, '575.53 €'], [211.3, 458.8, 10, !B, 'Remaining Amount:'], [308.7, 457.0, 16, B, '0.00 €'],
  [329.8, 543.8, 10, !B, 'Date'],
  [18.5, 649.0, 10, !B, 'Contract Share'], [18.5, 632.0, 10, !B, 'Customer Share'], [18.5, 666.0, 10, !B, 'Total Earnings'],
  [18.9, 682.4, 12, B, 'Earnings'], [18.5, 484.6, 10, !B, 'Pre-Payment'], [18.9, 608.7, 12, B, 'Extras'],
  [18.5, 433.5, 10, !B, 'Exchange Amount'], [159.1, 484.6, 10, !B, '0.00 €'], [148.5, 649.0, 10, !B, '246.66 €'],
  [148.5, 632.0, 10, !B, '575.53 €'], [148.5, 433.5, 10, !B, '575.53 €'], [18.5, 558.3, 10, !B, 'VAT'],
  [18.5, 541.3, 10, !B, 'TAX'], [18.5, 575.3, 10, !B, 'Extra Credits'], [159.1, 558.3, 10, !B, '0.00 €'],
  [159.1, 541.3, 10, !B, '0.00 €'], [148.5, 666.0, 10, !B, '822.19 €'], [159.1, 575.3, 10, !B, '0.00 €'],
  [18.5, 592.3, 10, !B, 'Extra Debts'], [18.5, 450.5, 10, !B, 'Cleared Amount'], [18.5, 467.6, 10, !B, 'Uncleared Balance'],
  [18.9, 518.0, 12, B, 'Balance'], [18.5, 382.5, 10, !B, 'Payable Amount'], [159.1, 592.3, 10, !B, '0.00 €'],
  [148.5, 450.5, 10, !B, '575.53 €'], [159.1, 467.6, 10, !B, '0.00 €'], [140.7, 381.9, 12, B, '575.53 €'],
  [18.5, 501.6, 10, !B, 'Invoice Balance'], [148.5, 501.6, 10, !B, '575.53 €'], [18.5, 405.2, 10, !B, 'Uninclusive for clearance'],
];
const page2 = [
  [20.2, 801.6, 17, B, 'Invoice'], [92.2, 799.4, 10, !B, 'Detailed Report'],
  ...footer(2),
  [29.9, 734.0, 10, !B, 'Total Earning'], [159.8, 734.0, 10, !B, '822.19 €'], [29.9, 717.0, 10, !B, 'Contract Share'],
  [214.1, 700.0, 10, !B, 'Earning VAT'], [214.1, 683.0, 10, !B, 'Earning TAX'], [159.8, 717.0, 10, !B, '246.66 €'],
  [354.7, 683.0, 10, !B, '0.00 €'], [354.7, 700.0, 10, !B, '0.00 €'], [29.9, 700.0, 10, !B, 'Customer Share'],
  [214.1, 734.0, 10, !B, 'Extra Debts'], [214.1, 717.0, 10, !B, 'Extra Credits'], [354.7, 717.0, 10, !B, '0.00 €'],
  [159.8, 700.0, 10, !B, '575.53 €'], [354.7, 734.0, 10, !B, '0.00 €'], [398.4, 734.0, 10, !B, 'Invoice Balance'],
  [398.4, 717.0, 10, !B, 'Uncleared Balance'], [29.9, 643.3, 10, !B, 'Payable Amount'], [528.3, 734.0, 10, !B, '575.53 €'],
  [538.9, 717.0, 10, !B, '0.00 €'], [398.4, 700.0, 10, !B, 'Cleared Amount'], [398.4, 683.0, 10, !B, 'Exchanged Amount'],
  [110.3, 641.5, 16, B, '575.53 €'], [528.3, 700.0, 10, !B, '575.53 €'], [528.3, 683.0, 10, !B, '575.53 €'],
  [30.2, 756.1, 12, B, 'All Invoices Summary'],
];

// text in a PDF string: brackets and backslashes escaped, the euro sign as its WinAnsi code
const pdfString = (s) => '(' + s.replace(/[\\()]/g, '\\$&').replace(/€/g, '\\200') + ')';
const stream = (items) => items.map(([x, y, size, bold, text]) => 'BT /F' + (bold ? 2 : 1) + ' ' + size + ' Tf 1 0 0 1 ' + x + ' ' + y + ' Tm ' + pdfString(text) + ' Tj ET').join('\n');

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [5 0 R 7 0 R] /Count 2 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
];
for (const items of [page1, page2]) {
  const body = stream(items);
  const pageNo = objects.length + 1;
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (pageNo + 1) + ' 0 R >>');
  objects.push('<< /Length ' + body.length + ' >>\nstream\n' + body + '\nendstream');
}
let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((o, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
const xref = pdf.length;
pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R /Info << /Title (Sample invoice with invented data) >> >>\nstartxref\n' + xref + '\n%%EOF\n';

const dir = new URL('./sample/', import.meta.url).pathname;
await mkdir(dir, { recursive: true });
await writeFile(dir + 'HaloNine_HaloNine_202607_2026-07_100231.pdf', pdf, 'latin1');
console.log('sample invoice written:', pdf.length, 'bytes');
