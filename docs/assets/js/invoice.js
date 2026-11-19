/* Cuts — reading an invoice PDF: who it is billed to, the period, the invoice number
   and the "Total Earnings" figure. */

import { parseAmount, currencyFromMark, parsePeriod, cleanBilledName, latinDigits } from './lib.js';

const SAME_LINE = 3.2;   // text on one visual line can sit a few units higher or lower

/* The text that stands to the right of a label, on the same line.
   maxGap is how far apart two pieces may be and still belong together. */
function rightOf(items, label, maxGap) {
  const row = items
    .filter((it) => it !== label && Math.abs(it.y - label.y) <= SAME_LINE && it.x > label.x + 1)
    .sort((a, b) => a.x - b.x);
  if (!row.length) return '';
  let text = row[0].str.trim();
  let end = row[0].x + row[0].w;
  for (let i = 1; i < row.length; i += 1) {
    const gap = row[i].x - end;
    if (gap > maxGap) break;
    text += (gap > 0.6 ? ' ' : '') + row[i].str.trim();
    end = row[i].x + row[i].w;
  }
  return text.trim();
}

/* Finds a label and returns its value. The value may be in the same piece of text as the
   label ("Billed to: Name") or in the pieces to its right. */
function valueOf(items, labelRe, maxGap) {
  for (const it of items) {
    const m = labelRe.exec(it.str.trim());
    if (!m) continue;
    const inline = (m[1] || '').trim();
    const value = inline || rightOf(items, it, maxGap);
    if (value) return value;
  }
  return '';
}

function splitAmount(text) {
  const clean = latinDigits(text);
  const cents = parseAmount(clean);
  if (cents == null) return null;
  const mark = clean.replace(/[\d.,\s ()\-−]/g, '');
  return { cents, cur: currencyFromMark(mark) };
}

/* "HaloNine_HaloNine_202607_2026-07_100231.pdf" → what the file name itself says. */
export function fieldsFromFileName(fileName) {
  const base = String(fileName || '').replace(/\.pdf$/i, '').replace(/\s*\(\d+\)$/, '');
  const m = /^(.*?)[_\s-]+(\d{4}-\d{2})[_\s-]+(\d{3,})$/.exec(base);
  if (!m) return { name: '', period: null, invoiceNo: '' };
  return { name: cleanBilledName(m[1]), period: parsePeriod(m[2]), invoiceNo: m[3] };
}

/* pages: one list of text pieces per page, each { str, x, y, w }. */
export function fieldsFromPages(pages, fileName) {
  const first = pages[0] || [];
  const fromName = fieldsFromFileName(fileName);

  let total = null;
  for (const items of pages) {
    const text = valueOf(items, /^Total\s+Earnings?\s*:?\s*(.*)$/i, 6);
    total = text ? splitAmount(text) : null;
    if (total) break;
  }

  const billed = valueOf(first, /^Billed\s+to\s*:?\s*(.*)$/i, 22);
  const periodText = valueOf(first, /^Reporting\s+Period\s*:?\s*(.*)$/i, 6);
  const invoiceText = valueOf(first, /^Invoice\s+(?:No|Number|#)\.?\s*:?\s*(.*)$/i, 6);
  const customerText = valueOf(first, /^Customer\s+ID\s*:?\s*(.*)$/i, 6);

  const periodMatch = /(\d{4})\s*[-/.]\s*(\d{1,2})/.exec(latinDigits(periodText));
  const period = periodMatch ? parsePeriod(periodMatch[1] + '-' + periodMatch[2]) : null;

  return {
    ok: !!total,
    total: total ? total.cents : null,
    cur: total ? total.cur : null,
    billedTo: billed,
    name: cleanBilledName(billed) || fromName.name,
    period: period || fromName.period,
    invoiceNo: (invoiceText.match(/[\w-]+/) || [''])[0] || fromName.invoiceNo,
    customerId: (customerText.match(/[\w-]+/) || [''])[0],
    hasText: pages.some((p) => p.length > 0),
  };
}

let pdfjsReady = null;
function loadPdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = import('./pdfjs/pdf.min.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return pdfjs;
    });
    pdfjsReady.catch(() => { pdfjsReady = null; });
  }
  return pdfjsReady;
}

/* Reads one PDF file. Resolves with the fields above; rejects when the file can't be opened. */
export async function readInvoice(file) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages = [];
    const count = Math.min(doc.numPages, 3);
    for (let n = 1; n <= count; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items
        .filter((it) => typeof it.str === 'string' && it.str.trim())
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 })));
      if (n === 1 && fieldsFromPages(pages, file.name).ok) break;
    }
    return fieldsFromPages(pages, file.name);
  } finally {
    try { await task.destroy(); } catch (e) { /* nothing to clean up */ }
  }
}
