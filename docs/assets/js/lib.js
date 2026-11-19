/* Cuts — pure helpers: money, percentages, dates, names, the statement sheet.
   No DOM access in this file, so it can be tested on its own. */

export const APP_NAME = 'Cuts';
export const APP_VERSION = '1.0.1';

/* ---------------------------------------------------------------- text */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESC[c]);
}

/* Persian and Arabic-Indic digits and separators become plain ASCII. */
export function latinDigits(value) {
  return String(value == null ? '' : value)
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/٪/g, '%');
}

/* ---------------------------------------------------------------- money */

const CURRENCY_LIST = [
  { code: 'EUR', symbol: '€', name: 'Euro', plural: 'euros', marks: ['€', 'EUR', 'EURO'] },
  { code: 'USD', symbol: '$', name: 'US dollar', plural: 'US dollars', marks: ['$', 'USD', 'US$'] },
  { code: 'GBP', symbol: '£', name: 'British pound', plural: 'British pounds', marks: ['£', 'GBP'] },
  { code: 'CAD', symbol: 'CA$', name: 'Canadian dollar', plural: 'Canadian dollars', marks: ['CA$', 'C$', 'CAD'] },
  { code: 'AUD', symbol: 'A$', name: 'Australian dollar', plural: 'Australian dollars', marks: ['A$', 'AU$', 'AUD'] },
  { code: 'TRY', symbol: '₺', name: 'Turkish lira', plural: 'Turkish lira', marks: ['₺', 'TRY', 'TL'] },
  { code: 'CHF', symbol: 'CHF ', name: 'Swiss franc', plural: 'Swiss francs', marks: ['CHF'] },
  { code: 'AED', symbol: 'AED ', name: 'UAE dirham', plural: 'UAE dirhams', marks: ['AED'] },
];
const CURRENCY_BY_CODE = new Map(CURRENCY_LIST.map((c) => [c.code, c]));

export function currencyCodes() {
  return CURRENCY_LIST.map((c) => c.code);
}

/* Turns whatever stands next to an amount ("€", "USD", "CA$") into a code. */
export function currencyFromMark(mark) {
  const m = String(mark || '').trim().toUpperCase();
  if (!m) return null;
  for (const c of CURRENCY_LIST) {
    if (c.marks.includes(m)) return c.code;
  }
  if (/^[A-Z]{3}$/.test(m)) return m;
  return null;
}

export function currencyInfo(code) {
  const known = CURRENCY_BY_CODE.get(code);
  if (known) return known;
  const c = String(code || '').toUpperCase() || 'EUR';
  return { code: c, symbol: c + ' ', name: c, plural: c };
}

/* "1,234.56", "1.234,56", "822.19 €", "−5.15" → whole cents. null when it is not a number. */
export function parseAmount(value) {
  let s = latinDigits(value).trim();
  if (!s) return null;
  s = s.replace(/[\s  ]/g, '').replace(/[−–—]/g, '-');
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-/.test(s)) negative = true;
  s = s.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimalAt = -1;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalAt = Math.max(lastDot, lastComma);
  } else if (lastDot >= 0) {
    decimalAt = s.indexOf('.') === lastDot ? lastDot : -1;       // several dots are thousands marks
  } else if (lastComma >= 0) {
    const after = s.length - lastComma - 1;
    const single = s.indexOf(',') === lastComma;
    decimalAt = single && after !== 3 ? lastComma : -1;           // "1,234" is a thousands mark
  }

  let whole = decimalAt >= 0 ? s.slice(0, decimalAt) : s;
  let frac = decimalAt >= 0 ? s.slice(decimalAt + 1) : '';
  whole = whole.replace(/[.,]/g, '');
  frac = frac.replace(/[.,]/g, '');
  if (!whole && !frac) return null;
  if (whole.length > 13) return null;

  let cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;
  return negative ? -cents : cents;
}

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* 82219 → "822.19" (for putting an amount back into a field). */
export function plainAmount(cents) {
  const n = Math.abs(Math.round(cents));
  const text = groupThousands(String(Math.floor(n / 100))) + '.' + String(n % 100).padStart(2, '0');
  return (cents < 0 ? '-' : '') + text;
}

/* 82219, "EUR" → "€822.19". Negative amounts use the real minus sign. */
export function formatMoney(cents, code) {
  const info = currencyInfo(code);
  const n = Math.abs(Math.round(cents));
  const text = info.symbol + groupThousands(String(Math.floor(n / 100))) + '.' + String(n % 100).padStart(2, '0');
  return (cents < 0 ? '−' : '') + text;
}

/* ---------------------------------------------------------------- percentages */

/* "10", "10%", "12,5", "۱۰" → thousandths of a percent (10% = 10000). null when it is not a
   percentage between 0 and 100. An empty field gives undefined. */
export function parsePercent(value) {
  let s = latinDigits(value).trim();
  if (!s) return undefined;
  s = s.replace(/[\s %]/g, '').replace(',', '.');
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (whole.length > 3) return null;
  let milli = Number(whole || '0') * 1000 + Number((frac + '000').slice(0, 3));
  if (frac.length > 3 && Number(frac[3]) >= 5) milli += 1;
  if (milli > 100000) return null;
  return milli;
}

/* 10000 → "10", 12500 → "12.5" (what goes back into the field). */
export function plainPercent(milli) {
  const whole = Math.floor(milli / 1000);
  const frac = String(milli % 1000).padStart(3, '0').replace(/0+$/, '');
  return frac ? whole + '.' + frac : String(whole);
}

export function formatPercent(milli) {
  return plainPercent(milli) + '%';
}

/* A share of a total, shown with one decimal at most: "9.1%", "80%". */
export function formatRatio(part, total) {
  if (!total) return '0%';
  const tenths = Math.round((part / total) * 1000);
  const whole = Math.trunc(tenths / 10);
  const rest = Math.abs(tenths % 10);
  return (rest ? whole + '.' + rest : String(whole)) + '%';
}

/* The manager's amount for one artist, in cents, rounded half up. */
export function shareOf(cents, milli) {
  const negative = cents < 0;
  const value = (BigInt(Math.abs(cents)) * BigInt(milli) + 50000n) / 100000n;
  return negative ? -Number(value) : Number(value);
}

/* ---------------------------------------------------------------- dates */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const JALALI_MONTHS = ['Farvardin', 'Ordibehesht', 'Khordad', 'Tir', 'Mordad', 'Shahrivar', 'Mehr', 'Aban', 'Azar', 'Dey', 'Bahman', 'Esfand'];

const div = (a, b) => Math.trunc(a / b);
const mod = (a, b) => a - Math.trunc(a / b) * b;

function jalaliYearInfo(jy) {
  const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  const gy = jy + 621;
  let leapJ = -14;
  let jp = breaks[0];
  let jump = 0;
  for (let i = 1; i < breaks.length; i += 1) {
    const jm = breaks[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function gregorianToDayNumber(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

/* Gregorian date → Jalali (Persian) date. */
export function toJalali(gy, gm, gd) {
  const jdn = gregorianToDayNumber(gy, gm, gd);
  let jy = gy - 621;
  const info = jalaliYearInfo(jy);
  const firstDay = gregorianToDayNumber(gy, 3, info.march);
  let k = jdn - firstDay;
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (info.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/* "Nov 19, 2026" */
export function formatDate(date) {
  return MONTHS_SHORT[date.getMonth()] + ' ' + date.getDate() + ', ' + date.getFullYear();
}

/* "28 Aban 1405" */
export function formatJalali(date) {
  const j = toJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return j.jd + ' ' + JALALI_MONTHS[j.jm - 1] + ' ' + j.jy;
}

/* "10 Aban – 9 Azar 1405" for the days from one Gregorian date to another. */
export function jalaliRange(fromY, fromM, fromD, toY, toM, toD) {
  const a = toJalali(fromY, fromM, fromD);
  const b = toJalali(toY, toM, toD);
  const left = a.jd + ' ' + JALALI_MONTHS[a.jm - 1] + (a.jy !== b.jy ? ' ' + a.jy : '');
  return left + ' – ' + b.jd + ' ' + JALALI_MONTHS[b.jm - 1] + ' ' + b.jy;
}

/* A period is a month written "2026-07". */
export function parsePeriod(value) {
  const m = /^\s*(\d{4})\s*[-/.]\s*(\d{1,2})\s*$/.exec(latinDigits(value));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || year < 1990 || year > 2200) return null;
  return year + '-' + String(month).padStart(2, '0');
}

export function periodLabel(period) {
  const p = parsePeriod(period);
  if (!p) return '';
  return MONTHS[Number(p.slice(5)) - 1] + ' ' + p.slice(0, 4);
}

export function currentPeriod(date = new Date()) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

/* The period line of the statement for a list of months: one month, or a span. */
export function periodSpan(periods, fallback) {
  const list = [...new Set(periods.map(parsePeriod).filter(Boolean))].sort();
  if (!list.length) list.push(parsePeriod(fallback) || currentPeriod());
  const first = list[0];
  const last = list[list.length - 1];
  const fy = Number(first.slice(0, 4)), fm = Number(first.slice(5));
  const ly = Number(last.slice(0, 4)), lm = Number(last.slice(5));
  let label;
  if (first === last) label = MONTHS[fm - 1] + ' ' + fy;
  else if (fy === ly) label = MONTHS_SHORT[fm - 1] + ' – ' + MONTHS_SHORT[lm - 1] + ' ' + ly;
  else label = MONTHS_SHORT[fm - 1] + ' ' + fy + ' – ' + MONTHS_SHORT[lm - 1] + ' ' + ly;
  return {
    label,
    jalali: jalaliRange(fy, fm, 1, ly, lm, daysInMonth(ly, lm)),
    single: first === last,
    first,
    last,
  };
}

/* ---------------------------------------------------------------- names */

const TINTS = [
  ['#ece6fa', '#4b2f86'], ['#dcf1ed', '#0b5e54'], ['#f8eccd', '#6b4a00'],
  ['#f9e0e8', '#8c2a48'], ['#e2eafb', '#1c4d8c'], ['#eceaf0', '#4a4555'],
];

export function initials(name) {
  const words = String(name || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]];
  const text = words.length > 1 ? first[0] + [...words[1]][0] : first.slice(0, 2).join('');
  return text.toUpperCase();
}

/* The same name always gets the same tint. */
export function tintFor(name) {
  let h = 0;
  for (const ch of String(name || '').toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

export function avatar(name, large) {
  const [bg, fg] = tintFor(name);
  return '<span class="av' + (large ? ' lg' : '') + '" aria-hidden="true" style="background: ' + bg + '; color: ' + fg + ';">' + esc(initials(name)) + '</span>';
}

/* "HaloNine_HaloNine_202607" → "HaloNine" */
export function cleanBilledName(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/[_\s-]+\d{6}$/, '').replace(/[_\s-]+\d{4}[-_]\d{2}$/, '');
  const parts = s.split(/_+/).map((p) => p.trim()).filter(Boolean);
  const unique = parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1].toLowerCase());
  return unique.join(' ').replace(/\s+/g, ' ').trim();
}

export function plural(count, one, many) {
  return count + ' ' + (count === 1 ? one : many || one + 's');
}

/* A name that is safe as a Windows file name. */
export function safeFileName(name) {
  let s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/, '');
  if (!s) s = 'Statement';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s.slice(0, 120);
}

/* ---------------------------------------------------------------- logo */

const RING = 2 * Math.PI * 21;
const RING_GAP = 2.2;
const CUT = 0.17;        // the slice that is pulled out of the ring
const PULL = 3.6;

function ringArc(color, from, to, dx, dy) {
  const length = (to - from) * RING - RING_GAP;
  const cx = (32 + dx).toFixed(3);
  const cy = (32 + dy).toFixed(3);
  return '<circle cx="' + cx + '" cy="' + cy + '" r="21" fill="none" stroke="' + color + '" stroke-width="12" stroke-dasharray="' +
    length.toFixed(3) + ' ' + (RING - length).toFixed(3) + '" stroke-dashoffset="' + (-from * RING).toFixed(3) +
    '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>';
}

/* The Cuts mark: a thick ring with one slice pulled out of it. */
export function logoMark(size, kind) {
  const dark = kind === 'dark';
  const ring = dark ? '#8b6ad6' : '#6b46c1';
  const slice = dark ? '#e3a512' : '#d89a00';
  const dot = dark ? '#26173a' : '#2a1d3d';
  const angle = (-90 + 360 * (CUT / 2)) * Math.PI / 180;
  return '<svg class="logo-mark" viewBox="0 0 64 64" width="' + size + '" height="' + size + '" aria-hidden="true">' +
    ringArc(ring, CUT, 1, 0, 0) +
    ringArc(slice, 0, CUT, PULL * Math.cos(angle), PULL * Math.sin(angle)) +
    '<circle cx="32" cy="32" r="5.2" fill="' + dot + '"/></svg>';
}

/* ---------------------------------------------------------------- rows and totals */

/* Adds the worked-out numbers to each saved row. */
export function computeRows(rows) {
  return rows.map((row) => {
    const milli = parsePercent(row.pct);
    const hasPct = typeof milli === 'number';
    return {
      ...row,
      milli: hasPct ? milli : null,
      pctState: milli === undefined ? 'empty' : milli === null ? 'invalid' : 'ok',
      amount: hasPct ? shareOf(row.total, milli) : null,
    };
  });
}

/* One total per currency, in the order the currencies first appear. */
export function totalsByCurrency(computed) {
  const map = new Map();
  for (const row of computed) {
    if (!map.has(row.cur)) map.set(row.cur, { cur: row.cur, count: 0, counted: 0, earnings: 0, countedEarnings: 0, amount: 0, percents: new Set() });
    const t = map.get(row.cur);
    t.count += 1;
    t.earnings += row.total;
    if (row.amount != null) {
      t.counted += 1;
      t.countedEarnings += row.total;
      t.amount += row.amount;
      t.percents.add(row.milli);
    }
  }
  return [...map.values()];
}

/* ---------------------------------------------------------------- the statement sheet */

function sortForStatement(rows) {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) ||
    String(a.period || '').localeCompare(String(b.period || '')) || String(a.invoiceNo || '').localeCompare(String(b.invoiceNo || '')));
}

/* The A4 sheet. The same HTML draws the preview in the app and the PDF.
   model: { business, manager, issued: Date, rows: computed rows } */
export function statementHTML(model) {
  const rows = sortForStatement(model.rows);
  const totals = totalsByCurrency(rows);
  const span = periodSpan(rows.map((r) => r.period), currentPeriod(model.issued));
  const manager = (model.manager || '').trim() || 'Manager';
  const business = (model.business || '').trim() || APP_NAME;
  const withInvoice = rows.some((r) => r.invoiceNo);
  const withPeriod = !span.single;
  const dash = '—';

  const head =
    '<header class="st-head"><div class="st-brand">' + logoMark(26, 'flat') + '<span class="st-brand-name">' + esc(business) + '</span></div>' +
    '<div class="st-doc"><div class="st-doc-type">Manager statement</div><div class="st-doc-date">Issued ' + esc(formatDate(model.issued)) + '</div></div></header>';

  const intro =
    '<div class="st-intro"><div><div class="st-label">Statement for</div><h1 class="st-name">' + esc(manager) + '</h1></div>' +
    '<div class="st-period"><div class="st-label">Period</div><div class="st-period-g">' + esc(span.label) + '</div><div class="st-period-j">' + esc(span.jalali) + '</div></div></div>';

  let shareBar = '';
  if (totals.length === 1 && totals[0].earnings > 0 && totals[0].amount > 0 && totals[0].counted === totals[0].count) {
    const t = totals[0];
    const rest = Math.max(t.earnings - t.amount, 0);
    const mine = formatRatio(t.amount, t.earnings);
    const other = formatRatio(rest, t.earnings);
    shareBar =
      '<div class="st-share"><div class="st-share-bar" role="img" aria-label="Your share ' + mine + ', Rest of the earnings ' + other + '">' +
      '<span class="st-share-part" style="flex-grow: ' + t.amount + '; background: #6b46c1;"></span>' +
      '<span class="st-share-part" style="flex-grow: ' + rest + '; background: #d6cfe3;"></span></div>' +
      '<div class="st-share-legend"><span class="st-key"><i style="background: #6b46c1;"></i>Your share <b>' + mine + '</b></span>' +
      '<span class="st-key"><i style="background: #d6cfe3;"></i>Rest of the earnings <b>' + other + '</b></span></div></div>';
  }

  const allPercents = new Set(rows.filter((r) => r.amount != null).map((r) => r.milli));
  let lead;
  if (!rows.length) lead = 'There are no artists on this statement yet.';
  else if (allPercents.size === 1) lead = 'Your share is ' + formatPercent([...allPercents][0]) + ' of the total earnings of the artists below.';
  else lead = 'Your share is a percentage of the total earnings of each artist below. The percentage for each artist is in the Share column.';
  if (totals.length > 1) lead += ' The amounts are listed in the currency of each invoice.';

  const sections = totals.map((t) => {
    const info = currencyInfo(t.cur);
    const list = rows.filter((r) => r.cur === t.cur);
    const title = totals.length > 1 ? info.name : 'Artists';
    const body = list.map((r) =>
      '<tr><td>' + esc(r.name) + '</td>' +
      (withPeriod ? '<td class="muted">' + esc(periodLabel(r.period) || dash) + '</td>' : '') +
      (withInvoice ? '<td class="muted">' + esc(r.invoiceNo || dash) + '</td>' : '') +
      '<td class="num">' + formatMoney(r.total, r.cur) + '</td>' +
      '<td class="num">' + (r.amount != null ? formatPercent(r.milli) : dash) + '</td>' +
      '<td class="num">' + (r.amount != null ? formatMoney(r.amount, r.cur) : dash) + '</td></tr>').join('');
    const labelSpan = 1 + (withPeriod ? 1 : 0) + (withInvoice ? 1 : 0);
    return '<section class="st-section"><h2>' + esc(title) + '<span class="st-h2-sub">' + plural(list.length, 'artist') + '</span></h2>' +
      '<table class="st-table"><thead><tr><th>Artist</th>' + (withPeriod ? '<th>Period</th>' : '') + (withInvoice ? '<th>Invoice</th>' : '') +
      '<th class="num">Total earnings</th><th class="num">Share</th><th class="num">Your amount</th></tr></thead>' +
      '<tbody>' + body + '</tbody>' +
      '<tfoot><tr><td' + (labelSpan > 1 ? ' colspan="' + labelSpan + '"' : '') + '>Total</td><td class="num">' + formatMoney(t.earnings, t.cur) +
      '</td><td></td><td class="num">' + formatMoney(t.amount, t.cur) + '</td></tr></tfoot></table></section>';
  }).join('');

  let summary = '';
  if (totals.length) {
    const main = totals[0];
    const others = totals.slice(1).map((t) => '<div class="st-total-cur">' + formatMoney(t.amount, t.cur) + '</div>').join('');
    summary = '<section class="st-summary"><div class="st-lines"></div><div class="st-total"><div class="st-total-label">Total</div>' +
      '<div class="st-total-values"><div class="st-total-toman">' + formatMoney(main.amount, main.cur) + '</div>' + others + '</div></div></section>';
  } else {
    summary = '<p class="st-empty">Add an invoice to see the amounts here.</p>';
  }

  const missing = rows.filter((r) => r.amount == null).length;
  const footLeft = totals.length === 1 ? 'Amounts in ' + currencyInfo(totals[0].cur).plural : totals.length > 1 ? 'Amounts in ' + totals.map((t) => currencyInfo(t.cur).plural).join(' and ') : '';
  const footRight = missing ? plural(missing, 'artist') + ' without a share ' + (missing === 1 ? 'is' : 'are') + ' not counted' : '';
  const foot = '<footer class="st-foot"><span>' + esc(footLeft) + '</span><span>' + esc(footRight) + '</span></footer>';

  return '<article class="st-sheet">' + head + intro + shareBar + '<p class="st-lead">' + esc(lead) + '</p>' + sections + summary + foot + '</article>';
}

/* The name of the PDF: "Manager Morrow - July 2026" */
export function statementFileName(model) {
  const span = periodSpan(model.rows.map((r) => r.period), currentPeriod(model.issued));
  const manager = (model.manager || '').trim();
  return safeFileName((manager ? 'Manager ' + manager : 'Manager statement') + ' - ' + span.label.replace(/–/g, 'to'));
}
