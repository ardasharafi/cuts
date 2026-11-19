/* Cuts — the app window, on the computer and on the iPhone.
   Markup and class names follow the design kit. The ledger engine (engine.js) runs in
   the page; on the computer a small helper keeps the files and prints the PDFs. */

import * as L from './lib.js';
import { readInvoice } from './invoice.js';
import { createEngine } from './engine.js';
import * as QR from './qr.js';
import * as PDF from './pdfkit.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const app = $('#app');
const modalRoot = $('#modals');
const toastRoot = $('#toasts');

let PHONE = true;        // the engine keeps its files in the browser (iPhone, or any browser on the web)
let STANDALONE = false;  // opened from the Home Screen
let engine = null;
let native = null;       // the computer's helper: { version, pdfDir, dataDir }

/* ---------------------------------------------------------------- icons */

const ICONS = Object.assign({}, window.ICONS || {}, {
  // not in the kit: drawn in the same style (24 grid, 1.8 stroke, round caps)
  print: '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="8" rx="2.2"/><path d="M7 14h10v6H7z"/>',
});

function icon(name, size = 18) {
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
}

/* ---------------------------------------------------------------- state */

const st = {
  server: null,                               // what the engine says: set up? locked? syncing?
  db: null,                                   // { rows: { id: record }, settings: { key: { value } } }
  rev: -1,
  page: 'shares',                             // shares | statement | settings
  q: '',
  cur: 'all',
  heroCur: '',
  sort: { key: 'name', dir: 1 },
  selected: new Set(),
  setup: { step: 'welcome' },
  lockView: 'password',
  focusAfter: null,
  growBar: true,
  keepOrder: false,
  lastOrder: null,
  gone: false,
};

function newId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return 'r' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------------- the engine and the computer's helper */

function call(method, path, body) {
  return engine.call(method, path, body);
}
const api = {
  get: (path) => call('GET', path),
  post: (path, body) => call('POST', path, body || {}),
};

async function nativeCall(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      cache: 'no-store',
      headers: Object.assign({ 'X-Cuts': '1' }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error('Cuts stopped responding.');
    err.gone = true;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong (' + res.status + ').');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* On the computer the ledger files live next to the app's data, not in the browser.
   The engine reads from memory; every change is written through to the helper, in order. */
function helperStorage(initial) {
  const cache = new Map();
  Object.keys(initial || {}).forEach((k) => { if (typeof initial[k] === 'string') cache.set(k, initial[k]); });
  const dirty = new Set();
  let running = false;
  async function pump() {
    if (running) return;
    running = true;
    let failures = 0;
    while (dirty.size) {
      const key = dirty.values().next().value;
      dirty.delete(key);
      const value = cache.has(key) ? cache.get(key) : null;
      try {
        const res = await fetch('/native/store/' + encodeURIComponent(key), {
          method: value === null ? 'DELETE' : 'PUT',
          cache: 'no-store',
          headers: { 'X-Cuts': '1', 'Content-Type': 'text/plain; charset=utf-8' },
          body: value === null ? undefined : value,
        });
        if (!res.ok) throw new Error('store ' + res.status);
        failures = 0;
      } catch (e) {
        dirty.add(key);
        failures += 1;
        if (failures >= 4) { showGone(); break; }
        await new Promise((resolve) => { setTimeout(resolve, 700 * failures); });
      }
    }
    running = false;
  }
  return {
    get: (k) => (cache.has(k) ? cache.get(k) : null),
    set(k, v) { cache.set(k, String(v)); dirty.add(k); pump(); },
    del(k) { cache.delete(k); dirty.add(k); pump(); },
  };
}

function handleError(e) {
  if (e && e.gone) { showGone(); return; }
  if (e && e.status === 423) { st.db = null; refreshState(); render(); return; }
  toast(e && e.message ? e.message : String(e), { error: true });
}

function refreshState() {
  st.server = engine.state();
  return st.server;
}

async function loadData() {
  const res = await api.get('/api/data');
  const db = { rows: {}, settings: {} };
  Object.keys(res.colls || {}).forEach((c) => {
    db[c] = db[c] || {};
    res.colls[c].forEach((r) => { db[c][r.id] = Object.assign({}, r.b, { id: r.id }); });
  });
  st.db = db;
  st.rev = res.rev;
}

const ROW_FIELDS = ['name', 'total', 'cur', 'period', 'invoiceNo', 'customerId', 'file', 'pct'];
function rowBody(row) {
  const b = {};
  ROW_FIELDS.forEach((k) => { b[k] = row[k] === undefined ? '' : row[k]; });
  return b;
}
const putRow = (row) => ({ op: 'put', c: 'rows', id: row.id, b: rowBody(row) });
const delRow = (id) => ({ op: 'del', c: 'rows', id });
const setOp = (key, value) => ({ op: 'put', c: 'settings', id: key, b: { value } });

async function commit(ops) {
  if (!ops.length) return null;
  try {
    const res = await api.post('/api/mutate', { ops });
    (res.recs || []).forEach((r) => {
      if (!st.db[r.c]) st.db[r.c] = {};
      if (r.del) delete st.db[r.c][r.id];
      else st.db[r.c][r.id] = Object.assign({}, r.b, { id: r.id });
    });
    st.rev = res.rev;
    refreshState();
    updateSyncChip();
    return res;
  } catch (e) {
    handleError(e);
    throw e;
  }
}

/* Shares are typed fast, one field after another. The page shows each keystroke at once;
   the ledger gets the rows a moment after the typing stops. */
const pendingRows = new Set();
let pendingTimer = null;
let reloadWanted = false;

function queueRow(id) {
  pendingRows.add(id);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => { flushRows().catch(() => {}); }, 250);
}
async function flushRows() {
  clearTimeout(pendingTimer);
  if (!pendingRows.size || !st.db) { pendingRows.clear(); return; }
  const ops = [...pendingRows].map((id) => st.db.rows[id]).filter(Boolean).map(putRow);
  pendingRows.clear();
  if (ops.length) await commit(ops);
  if (reloadWanted && st.db) {
    reloadWanted = false;
    await loadData();
    st.keepOrder = true;
    render();
    st.keepOrder = false;
  }
}

/* ---------------------------------------------------------------- numbers for the page */

function settings() {
  const s = (st.db && st.db.settings) || {};
  const text = (key) => (s[key] && typeof s[key].value === 'string' ? s[key].value : '');
  return { business: text('business'), manager: text('manager') };
}

function rawRows() {
  return Object.keys((st.db && st.db.rows) || {}).map((id) => {
    const r = st.db.rows[id];
    return {
      id,
      name: String(r.name || 'Unnamed'),
      total: Number.isFinite(r.total) ? Math.round(r.total) : 0,
      cur: String(r.cur || 'EUR'),
      period: L.parsePeriod(r.period),
      invoiceNo: String(r.invoiceNo || ''),
      customerId: String(r.customerId || ''),
      file: String(r.file || ''),
      pct: String(r.pct == null ? '' : r.pct),
    };
  });
}

function computed() {
  return L.computeRows(rawRows());
}

function compareRows(a, b) {
  const { key, dir } = st.sort;
  let d = 0;
  if (key === 'total') d = a.total - b.total;
  else if (key === 'pct' || key === 'amount') {
    const av = key === 'pct' ? a.milli : a.amount;
    const bv = key === 'pct' ? b.milli : b.amount;
    if (av == null && bv == null) d = 0;
    else if (av == null) return 1;            // rows without a share stay at the end
    else if (bv == null) return -1;
    else d = av - bv;
  }
  const byName = a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) ||
    String(a.period || '').localeCompare(String(b.period || '')) || String(a.invoiceNo).localeCompare(String(b.invoiceNo)) || a.id.localeCompare(b.id);
  if (key === 'name') return byName * dir;
  return d !== 0 ? d * dir : byName;
}

function visibleRows(all) {
  const q = st.q.trim().toLowerCase();
  const rows = all
    .filter((r) => (st.cur === 'all' || r.cur === st.cur) && (!q || r.name.toLowerCase().includes(q) || String(r.invoiceNo).includes(q)))
    .sort(compareRows);
  // While a share is being typed the rows stay where they are, even when the list is
  // sorted by share or amount. They are sorted again at the next click.
  if (st.keepOrder && st.lastOrder && rows.length === st.lastOrder.length && rows.every((r) => st.lastOrder.includes(r.id))) {
    rows.sort((a, b) => st.lastOrder.indexOf(a.id) - st.lastOrder.indexOf(b.id));
  }
  return rows;
}

function statementModel() {
  const s = settings();
  return { business: s.business, manager: s.manager, issued: new Date(), rows: computed() };
}

function managerName() {
  return settings().manager.trim();
}

/* ---------------------------------------------------------------- shell */

function ago(ms) {
  if (!ms) return '';
  const d = Math.max(0, Date.now() - ms) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return Math.round(d / 60) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' h ago';
  return L.formatDate(new Date(ms));
}

function syncInfo() {
  const sy = (st.server && st.server.sync) || { state: 'off' };
  const here = PHONE ? 'Saved on this iPhone' : 'Saved on this computer';
  switch (sy.state) {
    case 'ok': return sy.pending || sy.busy ? { dot: 'busy', title: 'Syncing', sub: 'Saving to GitHub' } : { dot: 'ok', title: 'Synced', sub: ago(sy.lastOk) };
    case 'syncing': return { dot: 'busy', title: 'Syncing', sub: sy.repo || '' };
    case 'offline': return { dot: 'warn', title: 'Offline', sub: here };
    case 'auth': return { dot: 'bad', title: 'Sync stopped', sub: PHONE ? 'Connect this iPhone again' : 'GitHub key needs replacing' };
    case 'mismatch': return { dot: 'bad', title: 'Sync needs you', sub: 'Open Settings' };
    case 'error': return { dot: 'bad', title: 'Sync problem', sub: sy.message || '' };
    case 'locked': return { dot: '', title: 'Locked', sub: '' };
    default: return { dot: '', title: 'Not syncing', sub: PHONE ? '' : 'Connect GitHub in Settings' };
  }
}

function syncChip() {
  const i = syncInfo();
  const sy = (st.server && st.server.sync) || {};
  const tip = sy.message || (sy.repo ? 'GitHub: ' + sy.repo : 'Sync with GitHub');
  return '<button type="button" class="sync-chip" data-act="nav" data-page="settings" data-tip="' + L.esc(tip) + '"><span class="sync-dot ' + i.dot + '"></span>' +
    '<span class="sync-text"><b>' + L.esc(i.title) + '</b>' + (i.sub ? '<span>' + L.esc(i.sub) + '</span>' : '') + '</span></button>';
}

function updateSyncChip() {
  const slot = $('#sync-slot');
  if (slot) slot.innerHTML = syncChip();
  const status = $('#sync-status');
  const typed = $('#sync-key');
  if (status && st.page === 'settings' && !modalRoot.children.length && !(typed && typed.value) && !(document.activeElement && document.activeElement.closest('#sync'))) {
    const body = $('#sync .panel-body');
    if (body) body.innerHTML = syncSettings();
  }
}

function navItem(page, iconName, label, count, countLabel) {
  const active = st.page === page;
  return '<button type="button" class="nav-item' + (active ? ' active' : '') + '"' + (active ? ' aria-current="page"' : '') + ' data-act="nav" data-page="' + page + '">' +
    icon(iconName, 19) + '<span class="label">' + label + '</span>' +
    (count ? '<span class="nav-count" aria-label="' + L.esc(countLabel) + '">' + count + '</span>' : '') + '</button>';
}

function sidebar(missing) {
  return '<aside class="side"><div class="side-brand">' + L.logoMark(34, 'dark') + '<span class="word">' + L.APP_NAME + '</span></div>' +
    '<nav class="nav" aria-label="Main">' +
    navItem('shares', 'overview', 'Shares', missing, L.plural(missing, 'artist') + ' without a share') +
    navItem('statement', 'file', 'Statement') +
    '</nav><div class="side-foot">' + navItem('settings', 'settings', 'Settings') +
    '<div class="side-sep"></div><div id="sync-slot">' + syncChip() + '</div>' +
    '<button type="button" class="nav-item" data-act="lock">' + icon('lock', 19) + '<span class="label">Lock</span></button></div></aside>';
}

function phoneTop() {
  return '<header class="phone-top"><div class="phone-brand">' + L.logoMark(26, 'dark') + '<span class="word">' + L.APP_NAME + '</span></div>' +
    '<div id="sync-slot">' + syncChip() + '</div>' +
    '<button type="button" class="icon-btn phone-lock" aria-label="Lock" data-act="lock">' + icon('lock', 20) + '</button></header>';
}

function phoneTabs(missing) {
  const tab = (page, label, iconName, count) => {
    const active = st.page === page;
    return '<button type="button" class="tab' + (active ? ' active' : '') + '"' + (active ? ' aria-current="page"' : '') + ' data-act="nav" data-page="' + page + '">' +
      '<span class="tab-ico">' + icon(iconName, 21) + (count ? '<span class="tab-count" aria-label="' + count + ' without a share">' + count + '</span>' : '') + '</span>' +
      '<span class="tab-label">' + label + '</span></button>';
  };
  return '<nav class="phone-tabs tabs-3" aria-label="Main">' + tab('shares', 'Shares', 'overview', missing) + tab('statement', 'Statement', 'file') + tab('settings', 'Settings', 'settings') + '</nav>';
}

function shell(all) {
  const missing = all.filter((r) => r.amount == null).length;
  let page;
  if (st.page === 'settings') page = settingsPage();
  else if (st.page === 'statement') page = statementPage(all);
  else page = sharesPage(all);
  if (PHONE) return '<div class="shell phone-shell">' + phoneTop() + '<main class="main" id="main"><div>' + page + '</div></main>' + phoneTabs(missing) + '</div>';
  return '<div class="shell">' + sidebar(missing) + '<main class="main" id="main"><div>' + page + '</div></main></div>';
}

/* ---------------------------------------------------------------- page: shares */

function spanOf(all) {
  return L.periodSpan(all.map((r) => r.period), L.currentPeriod());
}

function sharesSub(all) {
  if (!all.length) return 'Add the invoice PDFs. Cuts reads the total earnings from each one, you type the share.';
  const missing = all.filter((r) => r.amount == null).length;
  const span = spanOf(all);
  let text = L.plural(all.length, 'artist') + (span.single ? ' in ' : ' from ') + span.label;
  if (missing) text += ', ' + missing + ' without a share';
  return text;
}

function heroPanel(all) {
  const totals = L.totalsByCurrency(all);
  if (!totals.some((t) => t.cur === st.heroCur)) st.heroCur = totals[0].cur;
  const t = totals.find((x) => x.cur === st.heroCur);
  const span = spanOf(all.filter((r) => r.cur === t.cur));
  const name = managerName();
  const label = (name ? L.esc(name) + '’s share' : 'Manager share') + ' for ' + L.esc(span.label);
  const ratio = L.formatRatio(t.amount, t.countedEarnings);
  let sub;
  if (!t.counted) sub = 'Type a share for an artist to see the amount';
  else {
    const uniform = t.percents.size === 1 ? L.formatPercent([...t.percents][0]) : ratio;
    sub = uniform + ' of ' + L.formatMoney(t.countedEarnings, t.cur) + ' from ' + L.plural(t.counted, 'artist');
    if (t.counted < t.count) sub += ', ' + (t.count - t.counted) + ' more without a share';
  }
  const basis = t.counted ? t.countedEarnings : t.earnings;
  const rest = Math.max(basis - t.amount, 0);
  const mineRatio = L.formatRatio(t.amount, basis);
  const restRatio = L.formatRatio(rest, basis);
  const part = (labelText, value, ratioText, color, light) =>
    '<div class="splitbar-part' + (light ? ' on-light' : '') + '" role="img" tabindex="0" aria-label="' + L.esc(labelText) + ': ' + L.formatMoney(value, t.cur) + ', ' + ratioText +
    '" data-tip="' + L.esc(labelText + '\n' + L.formatMoney(value, t.cur) + '  (' + ratioText + ')') + '" data-label="' + ratioText + '" data-grow="' + Math.max(value, 0) +
    '" style="background: ' + color + '; flex-grow: ' + (st.growBar ? 0 : Math.max(value, 0)) + ';"></div>';
  const seg = totals.length > 1
    ? '<div class="seg" role="group" aria-label="Currency">' + totals.map((x) => '<button type="button" class="' + (x.cur === t.cur ? 'on' : '') + '" aria-pressed="' + (x.cur === t.cur) + '" data-act="hero-cur" data-cur="' + L.esc(x.cur) + '">' + L.esc(x.cur) + '</button>').join('') + '</div>'
    : '';
  const managerLabel = name || 'Manager';
  return '<section class="panel hero"><div class="hero-top"><div>' +
    '<div class="hero-label">' + label + '</div>' +
    '<div class="hero-figure">' + L.formatMoney(t.amount, t.cur) + '</div>' +
    '<div class="hero-sub">' + L.esc(sub) + '</div></div>' + seg + '</div>' +
    '<div class="splitbar">' + part(managerLabel, t.amount, mineRatio, '#6b46c1', false) + part('Rest of the earnings', rest, restRatio, '#d6cfe3', true) + '</div>' +
    '<div class="legend"><span class="legend-item"><span class="swatch" style="background: #6b46c1;"></span>' + L.esc(managerLabel) + '</span>' +
    '<span class="legend-item"><span class="swatch" style="background: #d6cfe3;"></span>Rest of the earnings</span></div></section>';
}

function sortHeader(key, label, numeric) {
  const sorted = st.sort.key === key;
  const arrow = sorted ? (st.sort.dir > 0 ? '↑' : '↓') : '';
  return '<th class="' + (numeric ? 'num ' : '') + 'sortable' + (sorted ? ' sorted' : '') + '" aria-sort="' + (sorted ? (st.sort.dir > 0 ? 'ascending' : 'descending') : 'none') + '">' +
    '<button type="button" class="th-btn" data-act="sort" data-key="' + key + '">' + label + '<span class="sort-arrow" aria-hidden="true">' + arrow + '</span></button></th>';
}

function rowSub(row) {
  const bits = [];
  if (row.period) bits.push(L.periodLabel(row.period));
  if (row.invoiceNo) bits.push((bits.length ? 'invoice ' : 'Invoice ') + row.invoiceNo);
  if (!bits.length) bits.push('Added by hand');
  return bits.join(', ');
}

function tableRow(row) {
  const selected = st.selected.has(row.id);
  const name = L.esc(row.name);
  const id = L.esc(row.id);
  return '<tr class="' + (selected ? 'selected' : '') + '" data-row="' + id + '">' +
    '<td class="check-col" data-label=""><label class="check"><input type="checkbox" data-act="check" data-id="' + id + '"' + (selected ? ' checked' : '') + ' aria-label="Select ' + name + '"></label></td>' +
    '<td class="cell-main"><div class="who">' + L.avatar(row.name) + '<div class="who-text"><div class="who-name">' + name + '</div><span class="sub">' + L.esc(rowSub(row)) + '</span></div></div></td>' +
    '<td class="num" data-label="Total earnings">' + L.formatMoney(row.total, row.cur) + '</td>' +
    '<td class="num" data-label="Share %"><input class="input rate-input pct' + (row.pctState === 'invalid' ? ' invalid' : '') + '" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="%" data-input="pct" data-id="' + id + '" data-fk="pct-' + id + '" aria-label="Share in percent for ' + name + '"' +
    (row.pctState === 'invalid' ? ' data-tip="Type a number from 0 to 100"' : '') + ' value="' + L.esc(row.pct) + '"></td>' +
    '<td class="num strong" data-label="Manager amount">' + (row.amount != null ? L.formatMoney(row.amount, row.cur) : '<span class="faint">—</span>') + '</td>' +
    '<td class="act-col"><button type="button" class="icon-btn" data-act="edit" data-id="' + id + '" data-tip="Edit artist" aria-label="Edit ' + name + '">' + icon('edit') + '</button>' +
    '<button type="button" class="icon-btn danger" data-act="delete" data-id="' + id + '" data-tip="Delete this artist" aria-label="Delete ' + name + '">' + icon('trash') + '</button></td></tr>';
}

function tablePanel(all) {
  const rows = visibleRows(all);
  st.lastOrder = rows.map((r) => r.id);
  const totals = L.totalsByCurrency(all);
  const shownTotals = L.totalsByCurrency(rows);
  const allChecked = rows.length > 0 && rows.every((r) => st.selected.has(r.id));
  const seg = totals.length > 1
    ? '<div class="seg" role="group" aria-label="Currency">' + ['all', ...totals.map((t) => t.cur)].map((c) =>
      '<button type="button" class="' + (st.cur === c ? 'on' : '') + '" aria-pressed="' + (st.cur === c) + '" data-act="cur" data-cur="' + L.esc(c) + '">' + (c === 'all' ? 'All' : L.esc(c)) + '</button>').join('') + '</div>'
    : '';
  const toolbar = '<div class="toolbar"><label class="search">' + icon('search', 16) +
    '<input class="input" type="search" placeholder="Search artists" aria-label="Search artists" data-input="q" data-fk="q" value="' + L.esc(st.q) + '"></label>' + seg +
    '<div class="spacer"></div><button type="button" class="btn btn-sm" data-act="add-manual" data-tip="For an artist without an invoice PDF">' + icon('plus', 16) + 'Add artist</button>' +
    '<span class="faint small">' + L.plural(rows.length, 'row') + '</span></div>';

  if (!rows.length) {
    return '<section class="panel panel-flush">' + toolbar + '<div class="empty"><div class="empty-title">No artist matches</div><p>Try another name, or clear the search.</p>' +
      '<button type="button" class="btn" data-act="clear-search">Clear the search</button></div></section>';
  }

  const foot = shownTotals.map((t) =>
    '<tr><td class="check-col" data-label=""></td><td class="cell-main">Total' + (shownTotals.length > 1 ? ' ' + L.esc(t.cur) : '') + '</td>' +
    '<td class="num" data-label="Total earnings">' + L.formatMoney(t.earnings, t.cur) + '</td>' +
    '<td class="num muted" data-label="Share %">' + (t.counted && t.counted === t.count ? L.formatRatio(t.amount, t.earnings) : '') + '</td>' +
    '<td class="num" data-label="Manager amount">' + L.formatMoney(t.amount, t.cur) + '</td><td class="act-col"></td></tr>').join('');

  return '<section class="panel panel-flush">' + toolbar + '<div class="table-wrap"><table class="tbl"><thead><tr>' +
    '<th class="check-col"><label class="check"><input type="checkbox" id="check-all" data-act="check-all"' + (allChecked ? ' checked' : '') + ' aria-label="Select all"></label></th>' +
    sortHeader('name', 'Artist', false) + sortHeader('total', 'Total earnings', true) + sortHeader('pct', 'Share %', true) + sortHeader('amount', 'Manager amount', true) +
    '<th class="act-col"></th></tr></thead><tbody>' + rows.map(tableRow).join('') + '</tbody><tfoot>' + foot + '</tfoot></table></div></section>';
}

function selectedIds() {
  return [...st.selected].filter((id) => st.db && st.db.rows[id]);
}

function bulkBar() {
  const count = selectedIds().length;
  if (!count) return '';
  return '<div class="bulk" role="region" aria-label="Selected artists"><span class="count">' + count + ' selected</span>' +
    '<button type="button" class="btn btn-sm" data-act="bulk-share">' + icon('overview', 16) + 'Set share</button>' +
    '<button type="button" class="btn btn-sm bulk-danger" data-act="bulk-delete">' + icon('trash', 16) + 'Delete</button>' +
    '<button type="button" class="icon-btn" data-act="bulk-clear" aria-label="Clear selection">' + icon('x') + '</button></div>';
}

function sharesPage(all) {
  const head = '<header class="page-head"><div><h1 class="page-title">Manager share</h1><div class="page-sub">' + L.esc(sharesSub(all)) + '</div></div>';
  if (!all.length) {
    return head + '</header><div class="page-body"><section class="panel"><div class="empty">' +
      '<div class="empty-title">No invoices yet</div><p>' + (PHONE ? 'Choose the invoice PDFs from Files.' : 'Choose the invoice PDFs, or drop them anywhere in this window.') + ' Each one becomes a row with its total earnings.</p>' +
      '<button type="button" class="btn btn-primary" data-act="add-invoices">' + icon('import', 17) + 'Add invoices</button>' +
      '<button type="button" class="link-btn" data-act="add-manual">Add an artist by hand</button></div></section></div>';
  }
  const counted = all.filter((r) => r.amount != null).length;
  const missing = all.length - counted;
  const invalid = all.filter((r) => r.pctState === 'invalid').length;
  let notice = '';
  if (missing) {
    notice = '<div class="notice">' + icon('alert') + '<div style="flex: 1;"><b>' + L.plural(missing, 'artist') + (missing === 1 ? ' has' : ' have') + ' no share yet.</b>' +
      '<div>' + (invalid ? 'A share is a number from 0 to 100. ' : '') + 'Type a percentage in the Share column. Until then ' + (missing === 1 ? 'that amount is' : 'those amounts are') + ' not counted.</div></div>' +
      '<button type="button" class="btn btn-sm" data-act="next-missing">Go to the first one</button></div>';
  }
  return head + '<div class="page-actions">' +
    '<button type="button" class="btn" data-act="add-invoices">' + icon('import', 17) + 'Add invoices</button>' +
    '<button type="button" class="btn btn-primary" data-act="save-pdf"' + (counted ? '' : ' disabled') + '>' + icon('file', 17) + 'Save PDF</button>' +
    '</div></header><div class="page-body">' + notice + heroPanel(all) + tablePanel(all) + bulkBar() + '</div>';
}

/* ---------------------------------------------------------------- page: statement */

function statementPage(all) {
  const head = '<header class="page-head"><div><h1 class="page-title">Statement</h1><div class="page-sub">' +
    (all.length ? 'This is the PDF for ' + L.esc(managerName() || 'the manager') + ': ' + L.plural(all.length, 'artist') + ', ' + L.esc(spanOf(all).label) : 'The PDF for the manager shows up here.') + '</div></div>';
  if (!all.length) {
    return head + '</header><div class="page-body"><section class="panel"><div class="empty"><div class="empty-title">Nothing to show yet</div>' +
      '<p>Add the invoices first. The statement is drawn from them.</p>' +
      '<button type="button" class="btn btn-primary" data-act="add-invoices">' + icon('import', 17) + 'Add invoices</button></div></section></div>';
  }
  const counted = all.filter((r) => r.amount != null).length;
  let notice = '';
  if (!managerName()) {
    notice = '<div class="notice">' + icon('alert') + '<div style="flex: 1;"><b>The statement has no manager name.</b><div>Add it in Settings so it shows at the top of the PDF.</div></div>' +
      '<button type="button" class="btn btn-sm" data-act="nav" data-page="settings" data-focus="set-manager">Open settings</button></div>';
  }
  return head + '<div class="page-actions">' +
    (PHONE ? '' : '<button type="button" class="btn" data-act="print">' + icon('print', 17) + 'Print</button>') +
    '<button type="button" class="btn btn-primary" data-act="save-pdf"' + (counted ? '' : ' disabled') + '>' + icon(PHONE ? 'share' : 'file', 17) + 'Save PDF</button>' +
    '</div></header><div class="page-body">' + notice +
    '<div class="sheet-frame sheet-page" id="sheet-frame"><div class="sheet-scale" id="sheet-scale">' + L.statementHTML(statementModel()) + '</div></div></div>';
}

function fitSheet() {
  const frame = $('#sheet-frame');
  const scaler = $('#sheet-scale');
  if (!frame || !scaler) return;
  const sheet = scaler.firstElementChild;
  if (!sheet) return;
  const style = getComputedStyle(frame);
  const room = frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const scale = Math.min(1, room / sheet.offsetWidth);
  scaler.style.transform = 'scale(' + scale + ')';
  scaler.style.height = Math.ceil(sheet.offsetHeight * scale) + 'px';
}

/* ---------------------------------------------------------------- page: settings */

function setRow(label, hint, control, forId) {
  const tag = forId ? 'label' : 'div';
  return '<div class="set-row"><' + tag + ' class="set-label"' + (forId ? ' for="' + forId + '"' : '') + '>' + label + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</' + tag + '>' + control + '</div>';
}

function panel(title, body, id) {
  return '<section class="panel"' + (id ? ' id="' + id + '"' : '') + '><div class="panel-head"><h2 class="panel-title">' + title + '</h2></div><div class="panel-body">' + body + '</div></section>';
}

function syncSettings() {
  const sy = (st.server && st.server.sync) || { state: 'off' };
  const info = syncInfo();
  if (sy.state === 'off') info.sub = '';
  const statusLine = '<div class="status-line" id="sync-status"><span class="sync-dot ' + info.dot + '"></span><b>' + L.esc(info.title) + '</b>' + (info.sub ? '<span class="muted">' + L.esc(info.sub) + '</span>' : '') + '</div>';
  const keyField = (label, hint) => setRow(label, hint,
    '<div class="field"><div class="row"><input class="input" id="sync-key" placeholder="owner/repository#github_pat_…" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Sync key">' +
    '<button type="button" class="btn btn-primary" data-act="sync-connect">' + icon('link', 16) + 'Connect</button></div><div class="error-text" id="sync-error" hidden></div></div>');

  if (sy.state === 'off') {
    if (PHONE) return setRow('Status', '', statusLine);
    return setRow('Status', '', statusLine) +
      keyField('Sync key', 'Keeps a locked copy on GitHub, so your iPhone and your other computers stay up to date, even after working offline.');
  }

  let rows = setRow('Status', '', '<div>' + statusLine + (sy.message && sy.state !== 'ok' ? '<div class="hint" style="margin-top: 6px;">' + L.esc(sy.message) + '</div>' : '') + '</div>') +
    setRow('Repository', '', '<div><div>' + L.esc(sy.repo || '') + '</div>' + (sy.lastOk ? '<div class="hint">Last synced ' + L.esc(ago(sy.lastOk)) + '</div>' : '') + '</div>');
  const syncNow = '<button type="button" class="btn" data-act="sync-now">' + icon('refresh', 16) + 'Sync now</button>';

  if (PHONE) {
    if (sy.state === 'mismatch' || sy.state === 'auth') {
      rows += '<div class="notice bad">' + icon('alert') + '<div><b>Connect this iPhone again.</b><div>' + L.esc(sy.message || 'GitHub turned this iPhone away.') +
        '</div><div>Remove Cuts from this iPhone below, then scan the QR code on your computer again.</div></div></div>';
    }
    return rows + setRow('Actions', '', '<div class="row wrap">' + syncNow + '</div>');
  }
  if (sy.state === 'auth') rows += keyField('New sync key', 'The old key stopped working. Paste a new one.');
  return rows + setRow('Actions', '', '<div class="row wrap">' + syncNow +
    '<button type="button" class="btn" data-act="sync-key">' + icon('copy', 16) + 'Key for another computer</button>' +
    '<button type="button" class="btn" data-act="phone-link">' + icon('phone', 16) + 'Use Cuts on your iPhone</button>' +
    '<button type="button" class="btn btn-ghost btn-danger" data-act="sync-stop">Stop syncing</button></div>');
}

function settingsPage() {
  const s = settings();
  const statements = panel('Statements',
    setRow('Business name', 'Shown at the top of every PDF.', '<input class="input" id="set-business" data-setting="business" data-fk="set-business" placeholder="Your label or company" autocomplete="off" value="' + L.esc(s.business) + '">', 'set-business') +
    setRow('Manager', 'The statement is made out to this name.', '<input class="input" id="set-manager" data-setting="manager" data-fk="set-manager" placeholder="The manager’s name" autocomplete="off" value="' + L.esc(s.manager) + '">', 'set-manager'));

  const sync = panel('Sync with GitHub', syncSettings(), 'sync');

  const security = panel('Password and security',
    setRow('Password', 'Opens Cuts and locks the ledger file and the copy on GitHub.', '<div class="row wrap"><button type="button" class="btn" data-act="change-password">' + icon('key', 16) + 'Change password</button></div>') +
    setRow('Recovery code', 'The only way back in if you forget your password.', '<div class="row wrap"><button type="button" class="btn" data-act="new-recovery">' + icon('shield', 16) + 'Make a new recovery code</button></div>'));

  let last;
  if (PHONE) {
    last = panel('This iPhone',
      (STANDALONE ? '' : '<div class="notice">' + icon('phone') + '<div><b>Add Cuts to your Home Screen</b><div>In Safari, tap the Share button, then Add to Home Screen. Cuts then opens like an app, full screen.</div></div></div>') +
      setRow('Version', '', '<div class="set-value">' + L.APP_NAME + ' ' + L.esc(L.APP_VERSION) + ' for iPhone</div>') +
      setRow('Remove', 'Takes the ledger off this iPhone. Your computer and GitHub keep everything.', '<div><button type="button" class="btn btn-ghost btn-danger" data-act="remove-phone">Remove Cuts from this iPhone</button></div>'));
  } else {
    last = panel('Files',
      setRow('PDFs', 'Saved PDFs go here.', '<div class="folder-row"><div class="mono-box">' + L.esc((native && native.pdfDir) || '') + '</div><button type="button" class="btn btn-sm" data-act="open-dir" data-dir="pdf">' + icon('folder', 16) + 'Open folder</button></div>') +
      setRow('Ledger', 'The locked file with your list. A copy is kept every day you use Cuts.', '<div class="folder-row"><div class="mono-box">' + L.esc((native && native.dataDir) || '') + '</div><button type="button" class="btn btn-sm" data-act="open-dir" data-dir="data">' + icon('folder', 16) + 'Open folder</button></div>') +
      setRow('Version', '', '<div class="set-value">' + L.APP_NAME + ' ' + L.esc(L.APP_VERSION) + '</div>'));
  }
  return '<header class="page-head"><div><h1 class="page-title">Settings</h1></div></header><div class="page-body"><div class="settings">' + statements + sync + security + last + '</div></div>';
}

/* ---------------------------------------------------------------- modals */

/* Opens a modal. o: { title, text, body (html), wide, sticky, actions: [{ label, kind, icon, left, run(ctx) }], onMount(ctx) }
   kind: primary | ghost | danger | plain. Enter in a field runs the primary action. */
function openModal(o) {
  const previous = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'scrim modal-scrim';
  const box = document.createElement('div');
  box.className = 'modal' + (o.wide ? ' wide' : '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML = '<div class="modal-head"><div><h2 class="modal-title"></h2>' + (o.text ? '<p class="modal-text"></p>' : '') + '</div></div>' +
    (o.body ? '<div class="modal-body">' + o.body + '<div class="error-text" data-error hidden></div></div>' : '') + '<div class="modal-foot"></div>';
  $('.modal-title', box).textContent = o.title;
  if (o.text) $('.modal-text', box).textContent = o.text;
  let closed = false;
  const ctx = {
    root: box,
    close() {
      if (closed) return;
      closed = true;
      scrim.remove(); box.remove();
      document.removeEventListener('keydown', onKey, true);
      if (previous && previous.focus && document.body.contains(previous)) previous.focus();
      if (o.onClose) o.onClose();
    },
    error(message) {
      const slot = $('[data-error]', box);
      if (!slot) { toast(message, { error: true }); return; }
      slot.textContent = message || '';
      slot.hidden = !message;
    },
    busy(on) { $$('.modal-foot button', box).forEach((b) => { if (!b.dataset.keep) b.disabled = !!on; }); },
    value(name) { const el = $('[name="' + name + '"]', box); return el ? el.value : ''; },
  };
  let primary = null;
  const foot = $('.modal-foot', box);
  (o.actions || []).forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (a.kind === 'primary' ? ' btn-primary' : a.kind === 'ghost' ? ' btn-ghost' : a.kind === 'danger' ? ' btn-danger' : '') + (a.left ? ' left' : '');
    b.innerHTML = (a.icon ? icon(a.icon, 17) : '') + L.esc(a.label);
    if (a.disabled) b.disabled = true;
    if (a.id) b.id = a.id;
    b.addEventListener('click', () => { if (a.run) a.run(ctx); else ctx.close(); });
    if (a.kind === 'primary') primary = b;
    foot.appendChild(b);
  });
  function onKey(event) {
    if (modalRoot.lastElementChild !== box) return;
    if (event.key === 'Escape') { event.stopPropagation(); if (!o.sticky) ctx.close(); return; }
    if (event.key === 'Enter' && event.target.tagName === 'INPUT' && event.target.type !== 'checkbox' && box.contains(event.target)) {
      event.preventDefault();
      if (primary && !primary.disabled) primary.click();
      return;
    }
    if (event.key === 'Tab') {
      const stops = $$('input, select, textarea, button', box).filter((el) => !el.disabled && el.offsetParent !== null);
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!box.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  scrim.addEventListener('mousedown', () => { if (!o.sticky) ctx.close(); });
  modalRoot.appendChild(scrim);
  modalRoot.appendChild(box);
  document.addEventListener('keydown', onKey, true);
  if (o.onMount) o.onMount(ctx);
  const first = $('[autofocus]', box) || $('input:not([type=checkbox]), select, textarea', box) || primary;
  // The first field takes the focus. The second try a moment later is for a click that is
  // still finishing; it never pulls the focus back from a field that is already in use.
  const takeFocus = () => {
    const active = document.activeElement;
    if (!first || !box.isConnected || active === first) return;
    if (active && active !== box && box.contains(active)) return;
    first.focus();
    if (first.select && first.type !== 'month' && first.tagName === 'INPUT') first.select();
  };
  if (!PHONE) takeFocus();
  setTimeout(takeFocus, 30);
  return ctx;
}

function closeModals() {
  modalRoot.replaceChildren();
}

function confirmDialog(o) {
  return new Promise((resolve) => {
    let done = false;
    openModal({
      title: o.title, text: o.text, onClose: () => resolve(done),
      actions: [{ label: o.cancel || 'Cancel', kind: 'ghost' }, { label: o.confirm || 'OK', kind: o.danger ? 'danger' : 'primary', run: (ctx) => { done = true; ctx.close(); } }],
    });
  });
}

/* Asks for the password, then runs fn(password). The dialog stays open on a wrong password. */
function withPassword(o, fn) {
  openModal({
    title: o.title, text: o.text,
    body: '<div class="field"><label for="m-password">' + (o.label || 'Password') + '</label><input class="input" id="m-password" name="password" type="password" autocomplete="current-password" placeholder="Password" autofocus></div>',
    actions: [{ label: 'Cancel', kind: 'ghost' }, {
      label: o.confirm || 'Continue', kind: 'primary',
      run: (ctx) => {
        ctx.busy(true);
        Promise.resolve(fn(ctx.value('password'))).then(() => ctx.close()).catch((e) => {
          ctx.busy(false);
          if (e && e.gone) { ctx.close(); showGone(); return; }
          ctx.error(e.message);
          const input = $('#m-password', ctx.root);
          if (input) input.select();
        });
      },
    }],
  });
}

function field(id, label, control, extra) {
  return '<div class="field"><label for="' + id + '">' + label + '</label>' + control + (extra || '') + '</div>';
}

function currencyOptions(selected) {
  const codes = L.currencyCodes();
  if (selected && !codes.includes(selected)) codes.push(selected);
  return codes.map((c) => '<option value="' + L.esc(c) + '"' + (c === selected ? ' selected' : '') + '>' + L.esc(c + ' ' + L.currencyInfo(c).name) + '</option>').join('');
}

function rowForm(d, withShare, fromInvoice) {
  return field('m-name', 'Name', '<input class="input" id="m-name" name="name" autocomplete="off" value="' + L.esc(d.name) + '" autofocus>') +
    '<div class="cols-2">' +
    field('m-total', 'Total earnings', '<input class="input" id="m-total" name="total" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + L.esc(d.total) + '">', fromInvoice ? '<span class="hint">Read from the invoice.</span>' : '') +
    field('m-cur', 'Currency', '<select class="select" id="m-cur" name="cur">' + currencyOptions(d.cur) + '</select>') +
    '</div><div class="cols-2">' +
    field('m-period', 'Period', '<input class="input" id="m-period" name="period" type="month" value="' + L.esc(d.period) + '">') +
    field('m-invoice', 'Invoice number', '<input class="input" id="m-invoice" name="invoiceNo" autocomplete="off" placeholder="Optional" value="' + L.esc(d.invoiceNo) + '">') +
    '</div>' +
    (withShare ? field('m-pct', 'Share %', '<input class="input" id="m-pct" name="pct" inputmode="decimal" autocomplete="off" placeholder="You can type it later" value="">') : '');
}

/* Reads and checks the artist form. Returns null (after showing what is wrong) or the values. */
function readRowForm(ctx, withShare) {
  const name = ctx.value('name').trim();
  const total = L.parseAmount(ctx.value('total'));
  const periodText = ctx.value('period');
  const period = periodText ? L.parsePeriod(periodText) : null;
  let pct = '';
  let problem = '';
  let where = '';
  if (!name) { problem = 'Type the artist’s name.'; where = 'name'; }
  else if (total == null) { problem = 'Type the total earnings as an amount, like 1,240.00.'; where = 'total'; }
  else if (periodText && !period) { problem = 'Pick a month for the period.'; where = 'period'; }
  else if (withShare) {
    const milli = L.parsePercent(ctx.value('pct'));
    if (milli === null) { problem = 'The share is a number from 0 to 100. You can also leave it empty.'; where = 'pct'; }
    else if (typeof milli === 'number') pct = L.plainPercent(milli);
  }
  $$('.input', ctx.root).forEach((el) => el.classList.toggle('invalid', el.name === where));
  ctx.error(problem);
  if (problem) { const el = $('[name="' + where + '"]', ctx.root); if (el) el.focus(); return null; }
  return { name, total, cur: ctx.value('cur') || 'EUR', period, invoiceNo: ctx.value('invoiceNo').trim(), pct };
}

function openEdit(id) {
  const row = rawRows().find((r) => r.id === id);
  if (!row) return;
  const bits = [];
  if (row.invoiceNo) bits.push('Invoice ' + row.invoiceNo);
  if (row.period) bits.push(L.periodLabel(row.period));
  openModal({
    title: row.name, text: bits.join(', ') || 'Added by hand',
    body: rowForm({ name: row.name, total: L.plainAmount(row.total), cur: row.cur, period: row.period || '', invoiceNo: row.invoiceNo }, false, !!row.file),
    actions: [
      { label: 'Delete', kind: 'danger', icon: 'trash', left: true, run: (ctx) => { ctx.close(); removeRows([id]); } },
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Save', kind: 'primary', run: async (ctx) => {
        const v = readRowForm(ctx, false);
        if (!v) return;
        ctx.busy(true);
        try {
          await flushRows();
          const current = st.db.rows[id];
          if (current) await commit([putRow(Object.assign({}, current, v, { pct: current.pct }))]);
          ctx.close();
          render();
          toast('Saved ' + v.name);
        } catch (e) { ctx.busy(false); }
      } },
    ],
  });
}

function openAdd() {
  const rows = rawRows();
  const periods = rows.map((r) => r.period).filter(Boolean).sort();
  openModal({
    title: 'Add artist', text: 'For an artist without an invoice PDF.',
    body: rowForm({ name: '', total: '', cur: rows.length ? rows[rows.length - 1].cur : 'EUR', period: periods.length ? periods[periods.length - 1] : L.currentPeriod(), invoiceNo: '' }, true, false),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Add artist', kind: 'primary', run: async (ctx) => {
        const v = readRowForm(ctx, true);
        if (!v) return;
        ctx.busy(true);
        const row = Object.assign({ id: newId(), customerId: '', file: '' }, v);
        try {
          await commit([putRow(row)]);
          ctx.close();
          st.page = 'shares';
          st.q = '';
          if (st.cur !== 'all' && st.cur !== row.cur) st.cur = 'all';
          if (!row.pct) st.focusAfter = 'pct-' + row.id;
          render();
          toast('Added ' + row.name, { actions: [{ label: 'Undo', run: () => removeRows([row.id], true) }] });
        } catch (e) { ctx.busy(false); }
      } },
    ],
  });
}

function openBulkShare() {
  const ids = selectedIds();
  if (!ids.length) return;
  openModal({
    title: 'Set share', text: 'For the ' + L.plural(ids.length, 'selected artist') + '.',
    body: field('m-pct', 'Share %', '<input class="input" id="m-pct" name="pct" inputmode="decimal" autocomplete="off" placeholder="For example 10" autofocus>'),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Set share', kind: 'primary', run: async (ctx) => {
        const milli = L.parsePercent(ctx.value('pct'));
        if (typeof milli !== 'number') { ctx.error('Type a number from 0 to 100, like 10 or 12.5.'); return; }
        ctx.busy(true);
        const value = L.plainPercent(milli);
        try {
          await flushRows();
          const before = ids.map((id) => st.db.rows[id]).filter(Boolean).map((r) => Object.assign({}, r));
          await commit(before.map((r) => putRow(Object.assign({}, r, { pct: value }))));
          ctx.close();
          st.selected.clear();
          render();
          toast('Set the share of ' + L.plural(before.length, 'artist') + ' to ' + value + '%', {
            actions: [{ label: 'Undo', run: () => commit(before.filter((r) => st.db.rows[r.id]).map(putRow)).then(render).catch(() => {}) }],
          });
        } catch (e) { ctx.busy(false); }
      } },
    ],
  });
}

function copyText(text) {
  const done = () => toast('Copied');
  const failed = () => toast('Couldn’t copy. Select the text and copy it yourself.', { error: true });
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, failed);
  else failed();
}

function showRecoveryCode(code, then) {
  openModal({
    title: 'Your recovery code', sticky: true,
    text: 'Write it down or keep it in a safe note. If you forget your password, this code is the only way back in.',
    body: '<div class="code-box">' + L.esc(code) + '</div><div class="row"><button type="button" class="btn btn-sm" data-copy data-keep="1">' + icon('copy', 16) + 'Copy code</button></div>' +
      '<label class="check"><input type="checkbox" data-saved>I saved my recovery code</label>',
    actions: [{ label: 'Done', kind: 'primary', disabled: true, id: 'code-done', run: (ctx) => { ctx.close(); if (then) then(); } }],
    onMount: (ctx) => {
      $('[data-copy]', ctx.root).addEventListener('click', () => copyText(code));
      $('[data-saved]', ctx.root).addEventListener('change', (e) => { $('#code-done', ctx.root).disabled = !e.target.checked; });
    },
  });
}

/* After a new ledger: offer GitHub right away (the computer only). */
function offerSync() {
  if (PHONE) return;
  openModal({
    title: 'Sync with GitHub',
    text: 'Paste your sync key to keep a locked copy on GitHub and use the list on your iPhone too. You can also do this later in Settings.',
    body: field('m-key', 'Sync key', '<input class="input" id="m-key" name="key" placeholder="owner/repository#github_pat_…" spellcheck="false" autocomplete="off" autofocus>'),
    actions: [{ label: 'Later', kind: 'ghost' }, {
      label: 'Connect', kind: 'primary', icon: 'link',
      run: (ctx) => {
        ctx.busy(true);
        api.post('/api/sync/connect', { key: ctx.value('key') }).then(() => { refreshState(); ctx.close(); render(); toast('Connected to GitHub'); })
          .catch((e) => { ctx.busy(false); ctx.error(e.message); });
      },
    }],
  });
}

function showSyncKey() {
  withPassword({ title: 'Key for another computer', text: 'Type your password to see the sync key. On the other computer, open Cuts, choose “Connect to my ledger” and paste it.' }, (pw) =>
    api.post('/api/sync/key', { password: pw }).then((res) => {
      setTimeout(() => {
        openModal({
          title: 'Sync key', text: 'Keep it private. Anyone with this key can change the copy on GitHub, but only your password opens it.',
          body: '<div class="mono-box">' + L.esc(res.key) + '</div>',
          actions: [{ label: 'Close', kind: 'ghost' }, { label: 'Copy key', kind: 'primary', icon: 'copy', run: () => copyText(res.key) }],
        });
      }, 50);
    }));
}

/* The QR code that connects an iPhone. It only carries locked data, so it needs the password too. */
function showPhoneLink() {
  api.get('/api/phone').then((res) => {
    openModal({
      title: 'Use Cuts on your iPhone', wide: true,
      text: 'The iPhone gets the same list from GitHub and stays in sync with this computer.',
      body: '<div class="qr-wrap"><div class="qr-box" aria-label="QR code for the iPhone">' + QR.svg(res.url, { size: 280 }) + '</div>' +
        '<ol class="phone-steps"><li>Open the Camera on your iPhone and point it at this code.</li><li>Tap the link that appears. Safari opens Cuts.</li>' +
        '<li>Tap the Share button, then Add to Home Screen, then Add.</li><li>Open Cuts from your Home Screen and type your password.</li></ol></div>' +
        '<p class="hint">The code is locked with your password, so it’s safe to keep on screen. You can make it again any time.</p>',
      actions: [{ label: 'Copy link', kind: 'ghost', icon: 'copy', run: () => copyText(res.url) }, { label: 'Done', kind: 'primary' }],
    });
  }).catch(handleError);
}

function changePassword() {
  openModal({
    title: 'Change password',
    body: field('m-cur-pw', 'Current password', '<input class="input" id="m-cur-pw" name="current" type="password" autocomplete="current-password" autofocus>') +
      field('m-new-pw', 'New password', '<input class="input" id="m-new-pw" name="next" type="password" autocomplete="new-password">') +
      field('m-new-pw2', 'New password again', '<input class="input" id="m-new-pw2" name="again" type="password" autocomplete="new-password">'),
    actions: [{ label: 'Cancel', kind: 'ghost' }, {
      label: 'Change password', kind: 'primary',
      run: (ctx) => {
        if (!ctx.value('next')) { ctx.error('Type a new password.'); return; }
        if (ctx.value('next') !== ctx.value('again')) { ctx.error('The new passwords don’t match.'); return; }
        ctx.busy(true);
        api.post('/api/password', { current: ctx.value('current'), next: ctx.value('next') })
          .then(() => { ctx.close(); toast('Password changed. Your other devices use the new one after their next sync.'); })
          .catch((e) => { ctx.busy(false); ctx.error(e.message); });
      },
    }],
  });
}

function newRecovery() {
  withPassword({ title: 'Make a new recovery code', text: 'The old code stops working.', confirm: 'Make code' }, (pw) =>
    api.post('/api/recovery', { password: pw }).then((res) => { setTimeout(() => showRecoveryCode(res.recoveryCode), 50); }));
}

/* ---------------------------------------------------------------- rows */

async function removeRows(ids, quiet) {
  try {
    await flushRows();
    const removed = ids.map((id) => st.db.rows[id]).filter(Boolean).map((r) => Object.assign({}, r));
    if (!removed.length) return;
    await commit(removed.map((r) => delRow(r.id)));
    removed.forEach((r) => st.selected.delete(r.id));
    if (st.cur !== 'all' && !rawRows().some((r) => r.cur === st.cur)) st.cur = 'all';
    render();
    if (quiet) return;
    const what = removed.length === 1 ? removed[0].name : L.plural(removed.length, 'artist');
    toast('Deleted ' + what, { actions: [{ label: 'Undo', run: () => commit(removed.map(putRow)).then(render).catch(() => {}) }] });
  } catch (e) { /* the error is already on screen */ }
}

function isDuplicate(candidate, rows) {
  return rows.some((r) => {
    if (candidate.invoiceNo && r.invoiceNo) return r.invoiceNo === candidate.invoiceNo;
    return r.name.toLowerCase() === candidate.name.toLowerCase() && r.total === candidate.total && r.cur === candidate.cur && (r.period || '') === (candidate.period || '');
  });
}

function shortList(names) {
  if (names.length <= 2) return names.join(' and ');
  return names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more';
}

let importing = false;

async function importFiles(fileList) {
  const picked = [...fileList];
  if (!picked.length || importing || !st.db) return;
  const files = picked.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) {
    toast('Those are not PDF files. Add the invoices as PDF.', { error: true });
    return;
  }
  importing = true;
  const busy = toast('Reading ' + L.plural(files.length, 'invoice') + '…', { spin: true });
  const added = [];
  const skipped = [];
  const failed = [];      // opened, but no total earnings in it
  const unreadable = [];  // not a PDF that can be opened
  const known = rawRows();
  const fallbackCur = known.length ? known[known.length - 1].cur : 'EUR';
  for (const file of files) {
    try {
      const f = await readInvoice(file);
      if (!f.ok) { failed.push(file.name); continue; }
      const row = {
        id: newId(),
        name: f.name || file.name.replace(/\.pdf$/i, '') || 'Unnamed',
        total: f.total,
        cur: f.cur || fallbackCur,
        period: f.period,
        invoiceNo: f.invoiceNo || '',
        customerId: f.customerId || '',
        file: file.name,
        pct: '',
      };
      if (isDuplicate(row, known.concat(added))) { skipped.push(row.name); continue; }
      added.push(row);
    } catch (e) {
      unreadable.push(file.name);
    }
  }
  importing = false;
  busy.close();

  if (added.length) {
    try {
      await flushRows();
      await commit(added.map(putRow));
    } catch (e) { return; }
    st.page = 'shares';
    st.q = '';
    st.cur = 'all';
    const sorted = L.computeRows(added).sort(compareRows);
    st.focusAfter = PHONE ? null : 'pct-' + sorted[0].id;
    render();
    const ids = added.map((r) => r.id);
    toast('Added ' + L.plural(added.length, 'invoice') + (skipped.length ? ', skipped ' + skipped.length + ' already in the list' : ''), {
      actions: [{ label: 'Undo', run: () => removeRows(ids, true) }],
    });
  } else if (skipped.length) {
    toast(skipped.length === 1 ? 'The invoice of ' + skipped[0] + ' is already in the list' : 'Those ' + skipped.length + ' invoices are already in the list');
  }
  if (failed.length) {
    toast('Couldn’t find the total earnings in ' + shortList(failed) + '. Add ' + (failed.length === 1 ? 'that artist' : 'those artists') + ' by hand.', {
      error: true, actions: [{ label: 'Add artist', run: openAdd }],
    });
  }
  if (unreadable.length) {
    toast('Couldn’t open ' + shortList(unreadable) + '. Check that ' + (unreadable.length === 1 ? 'it is' : 'they are') + ' the invoice PDF.', { error: true });
  }
}

/* ---------------------------------------------------------------- PDF */

let makingPdf = false;

/* iPhone: files are handed to the share sheet (Save to Files, Telegram, Mail, Print). */
function readySheet(file) {
  const kb = file.size / 1024;
  const size = kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(kb)) + ' KB';
  openModal({
    title: file.name,
    text: 'Ready, ' + size + '. Share opens the iPhone menu: Save to Files, Telegram, Mail or Print.',
    actions: [{ label: 'Done', kind: 'ghost' }, {
      label: 'Share', kind: 'primary', icon: 'share',
      run: (ctx) => { PDF.share([file], file.name).then((done) => { if (done) ctx.close(); }).catch((e) => toast(e.message || String(e), { error: true })); },
    }],
  });
}

async function savePdf() {
  if (makingPdf || !st.db) return;
  await flushRows().catch(() => {});
  const model = statementModel();
  if (!model.rows.some((r) => r.amount != null)) return;
  const name = L.statementFileName(model);
  makingPdf = true;
  const busy = toast('Making the PDF…', { spin: true });
  try {
    if (PHONE) {
      const holder = document.createElement('div');
      holder.innerHTML = L.statementHTML(model);
      const blob = await PDF.statementPdf([holder.firstElementChild], name);
      busy.close();
      readySheet(PDF.makeFile(blob, name + '.pdf'));
    } else {
      const result = await nativeCall('POST', '/native/pdf', { html: L.statementHTML(model), name, title: 'Manager statement' });
      busy.close();
      toast('Saved ' + result.name, {
        actions: [
          { label: 'Open', keep: true, run: () => openSaved(result.path, false) },
          { label: 'Show in folder', keep: true, run: () => openSaved(result.path, true) },
        ],
      });
    }
  } catch (e) {
    busy.close();
    if (e && e.gone) showGone();
    else if (PHONE) toast('Couldn’t make the PDF. Try again.', { error: true });
    else toast('Couldn’t save the PDF. Try again, or print it instead.', { error: true, actions: [{ label: 'Print', run: printStatement }] });
  }
  makingPdf = false;
}

function openSaved(path, reveal) {
  nativeCall('POST', '/native/open', { path, reveal }).catch(() => toast('Couldn’t open the file. It may have been moved or deleted.', { error: true }));
}

function fillPrintRoot() {
  $('#print-root').innerHTML = st.db ? L.statementHTML(statementModel()) : '';
}

function printStatement() {
  fillPrintRoot();
  window.print();
}

/* ---------------------------------------------------------------- toasts and tooltips */

function toast(message, options = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (options.error ? ' error' : '');
  el.setAttribute('role', options.error ? 'alert' : 'status');
  el.innerHTML = (options.spin ? '<span class="spin" aria-hidden="true"></span>' : '') + '<div class="toast-msg"></div>' + (options.actions && options.actions.length ? '<div class="toast-actions"></div>' : '');
  $('.toast-msg', el).textContent = message;
  let timer = null;
  const close = () => { clearTimeout(timer); el.remove(); };
  (options.actions || []).forEach((action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => { if (!action.keep) close(); action.run(); });
    $('.toast-actions', el).appendChild(button);
  });
  toastRoot.appendChild(el);
  while (toastRoot.children.length > (PHONE ? 2 : 4)) toastRoot.firstElementChild.remove();
  if (!options.spin) {
    const ms = options.error ? 10000 : options.actions && options.actions.length ? (PHONE ? 6500 : 9000) : (PHONE ? 3200 : 4500);
    const arm = () => { clearTimeout(timer); timer = setTimeout(close, ms); };
    arm();
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', arm);
  }
  return { close };
}

let tipEl = null;
let tipFor = null;

function hideTip() {
  if (tipEl) tipEl.remove();
  tipEl = null;
  tipFor = null;
}

function showTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text || PHONE) return;
  hideTip();
  tipFor = target;
  tipEl = document.createElement('div');
  tipEl.className = 'tip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.textContent = text;
  document.body.appendChild(tipEl);
  const box = target.getBoundingClientRect();
  const own = tipEl.getBoundingClientRect();
  let left = box.left + box.width / 2 - own.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - own.width - 8));
  let top = box.top - own.height - 8;
  if (top < 8) top = box.bottom + 8;
  tipEl.style.left = Math.round(left) + 'px';
  tipEl.style.top = Math.round(top) + 'px';
}

/* ---------------------------------------------------------------- lock and setup screens */

function brand() {
  return '<div class="lock-brand" id="lock-brand">' + L.logoMark(88, 'dark') + '<div class="lock-word">' + L.APP_NAME + '</div></div>';
}
function lockWrap(card, foot, wide) {
  return '<div class="lock"><div class="lock-wrap' + (wide ? ' wide' : '') + '">' + brand() + '<div class="lock-card">' + card + '<div class="error-text" id="form-error" hidden></div></div>' + (foot || '') + '</div></div>';
}
function lockFoot(label, act) {
  return '<div class="lock-foot"><button type="button" class="link-btn" data-act="' + act + '">' + label + '</button></div>';
}
function pwField(id, label, autocomplete, extra) {
  return '<div class="field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" type="password" autocomplete="' + autocomplete + '"' + (extra || '') + '></div>';
}
function formError(message) {
  const slot = $('#form-error');
  if (!slot) { if (message) toast(message, { error: true }); return; }
  slot.textContent = message || '';
  slot.hidden = !message;
}
function working(on) {
  const b = $('#lock-brand');
  if (b) b.classList.toggle('working', !!on);
  $$('.lock-card .btn-primary').forEach((btn) => { btn.disabled = !!on; });
}
const val = (id) => { const el = $('#' + id); return el ? el.value : ''; };

function lockScreen() {
  if (st.lockView === 'recover') {
    return lockWrap('<h1>Reset your password</h1><p>Type the recovery code you saved when you set up Cuts.</p>' +
      '<div class="field"><label for="rc-code">Recovery code</label><input class="input" id="rc-code" data-fk="rc-code" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" spellcheck="false" autocomplete="off" autocapitalize="characters"></div>' +
      pwField('rc-new', 'New password', 'new-password') + pwField('rc-new2', 'New password again', 'new-password') +
      '<button type="button" class="btn btn-primary btn-wide" data-act="recover" data-submit>Reset password</button>',
    lockFoot('Back to unlock', 'lock-back'));
  }
  return lockWrap(pwField('unlock-pw', 'Password', 'current-password', ' placeholder="Password" data-fk="unlock-pw"') +
    '<button type="button" class="btn btn-primary btn-wide" data-act="unlock" data-submit>' + icon('lock', 17) + 'Unlock</button>',
  lockFoot('Forgot your password?', 'lock-forgot'));
}

let lockoutTimer = null;
function showLockout(until) {
  clearTimeout(lockoutTimer);
  const left = Math.ceil((until - Date.now()) / 1000);
  const button = $('.lock-card [data-submit]');
  if (left <= 0) { formError(''); if (button) button.disabled = false; return; }
  if (button) button.disabled = true;
  formError('Too many wrong tries. Try again in ' + left + ' seconds.');
  lockoutTimer = setTimeout(() => { if ($('#form-error')) showLockout(until); }, 1000);
}

function setupScreen() {
  if (PHONE) return phoneSetup();
  const step = st.setup.step;
  if (step === 'new') {
    return lockWrap('<div class="steps"><i class="on"></i><i></i><i></i></div><h1>Choose a password</h1>' +
      '<p>You type it each time you open Cuts. It also locks the copy on GitHub.</p>' +
      pwField('su-pw', 'Password', 'new-password', ' data-fk="su-pw"') + pwField('su-pw2', 'Password again', 'new-password') +
      '<button type="button" class="btn btn-primary btn-wide" data-act="setup" data-submit>Create ledger</button>',
    lockFoot('Back', 'setup-back'));
  }
  if (step === 'join') {
    return lockWrap('<h1>Connect to my ledger</h1><p>On your other computer, open Settings, then Sync with GitHub, then “Key for another computer”.</p>' +
      '<div class="field"><label for="jn-key">Sync key</label><input class="input" id="jn-key" data-fk="jn-key" placeholder="owner/repository#github_pat_…" spellcheck="false" autocomplete="off"></div>' +
      pwField('jn-pw', 'Password of the ledger', 'current-password') +
      '<button type="button" class="btn btn-primary btn-wide" data-act="join" data-submit>' + icon('link', 17) + 'Connect</button>',
    lockFoot('Back', 'setup-back'));
  }
  return lockWrap('<h1>Welcome</h1><p>Cuts works out a manager’s share of your artists’ earnings and keeps it in one locked ledger.</p>' +
    '<button type="button" class="choice" data-act="setup-step" data-step="new"><span class="ico">' + icon('plus', 20) + '</span><span><b>Start a new ledger</b><span>Use this on your first computer.</span></span></button>' +
    '<button type="button" class="choice" data-act="setup-step" data-step="join"><span class="ico">' + icon('link', 20) + '</span><span><b>Connect to my ledger</b><span>Already using Cuts on another computer? Paste your sync key.</span></span></button>',
  '', true);
}

function phoneSetup() {
  const step = st.setup.step;
  if (st.server.pairing && !STANDALONE && step !== 'here') {
    return lockWrap('<h1>Add Cuts to your Home Screen</h1><p>Cuts works best as an app on your Home Screen.</p>' +
      '<ol class="phone-steps"><li>Tap the Share button at the bottom of Safari.</li><li>Choose Add to Home Screen, then Add.</li><li>Open Cuts from your Home Screen and type your password.</li></ol>' +
      '<p class="hint">If Cuts asks for the link there, copy it here and paste it.</p>' +
      '<div class="row wrap"><button type="button" class="btn" data-act="copy-link">' + icon('copy', 16) + 'Copy link</button>' +
      '<button type="button" class="btn btn-ghost" data-act="setup-step" data-step="here">Use it here in Safari</button></div>');
  }
  if (st.server.pairing) {
    return lockWrap('<h1>Connect this iPhone</h1><p>Type the password you use for Cuts on your computer.</p>' +
      pwField('pr-pw', 'Password', 'current-password', ' placeholder="Password" data-fk="pr-pw"') +
      '<button type="button" class="btn btn-primary btn-wide" data-act="pair" data-submit>' + icon('link', 17) + 'Connect</button>',
    lockFoot('Use another link', 'pair-forget'));
  }
  if (step === 'join') {
    return lockWrap('<h1>Connect with the sync key</h1><p>On your computer: Settings, Sync with GitHub, Key for another computer.</p>' +
      '<div class="field"><label for="jn-key">Sync key</label><input class="input" id="jn-key" data-fk="jn-key" placeholder="owner/repository#github_pat_…" spellcheck="false" autocomplete="off" autocapitalize="off"></div>' +
      pwField('jn-pw', 'Password', 'current-password') +
      '<button type="button" class="btn btn-primary btn-wide" data-act="join" data-submit>' + icon('link', 17) + 'Connect</button>',
    lockFoot('Back', 'setup-back'));
  }
  return lockWrap('<h1>Connect this iPhone</h1>' +
    '<ol class="phone-steps"><li>On your computer, open Cuts, then Settings, then Use Cuts on your iPhone.</li><li>Scan the QR code with the iPhone camera.</li></ol>' +
    '<p class="hint">Or paste the link here:</p>' +
    '<textarea class="input" id="pl-link" rows="3" placeholder="Paste the link from your computer" spellcheck="false" autocapitalize="off" style="height: auto; padding: 10px 12px; resize: none;"></textarea>' +
    '<button type="button" class="btn btn-primary btn-wide" data-act="pairlink" data-submit>Continue</button>',
  lockFoot('Use a sync key instead', 'setup-join'));
}

async function enterLedger(message) {
  refreshState();
  await loadData();
  st.setup = { step: 'welcome' };
  st.lockView = 'password';
  st.growBar = true;
  render();
  if (message) toast(message);
}

const lockActions = {
  unlock() {
    const pw = val('unlock-pw');
    if (!pw) return;
    working(true);
    api.post('/api/unlock', { password: pw }).then(() => enterLedger()).catch((e) => {
      working(false);
      if (e.data && e.data.lockUntil) { showLockout(e.data.lockUntil); return; }
      formError(e.message);
      const input = $('#unlock-pw');
      if (input) input.select();
    });
  },
  recover() {
    if (!val('rc-new')) { formError('Choose a new password.'); return; }
    if (val('rc-new') !== val('rc-new2')) { formError('The new passwords don’t match.'); return; }
    working(true);
    api.post('/api/recover', { code: val('rc-code'), next: val('rc-new') })
      .then(() => enterLedger('Password reset. Make a new recovery code in Settings if you like.'))
      .catch((e) => { working(false); formError(e.message); });
  },
  setup() {
    if (!val('su-pw')) { formError('Choose a password.'); return; }
    if (val('su-pw') !== val('su-pw2')) { formError('The passwords don’t match.'); return; }
    working(true);
    api.post('/api/setup', { password: val('su-pw') })
      .then((res) => enterLedger().then(() => showRecoveryCode(res.recoveryCode, offerSync)))
      .catch((e) => { working(false); formError(e.message); });
  },
  join() {
    working(true);
    api.post('/api/join', { key: val('jn-key'), password: val('jn-pw') })
      .then(() => enterLedger(PHONE ? 'Connected. This iPhone now shares your ledger.' : 'Connected. This computer now shares the ledger.'))
      .catch((e) => { working(false); formError(e.message); });
  },
  pair() {
    const pw = val('pr-pw');
    if (!pw) return;
    working(true);
    api.post('/api/pair', { password: pw })
      .then(() => enterLedger('Connected. This iPhone now shares your ledger.'))
      .catch((e) => { working(false); formError(e.message); const input = $('#pr-pw'); if (input) input.select(); });
  },
  pairlink() {
    api.post('/api/pairlink', { link: val('pl-link') })
      .then(() => { refreshState(); st.setup.step = 'here'; render(); })
      .catch((e) => formError(e.message));
  },
};

async function lockNow() {
  if (!st.db) return;
  try {
    await flushRows();
    await api.post('/api/lock');
  } catch (e) { handleError(e); return; }
  refreshState();
  st.db = null;
  st.lockView = 'password';
  st.selected.clear();
  closeModals();
  toastRoot.replaceChildren();
  render();
}

/* ---------------------------------------------------------------- render */

let rendering = false;

function render() {
  hideTip();
  const active = document.activeElement;
  const key = active && active.dataset && app.contains(active) ? active.dataset.fk : null;
  let selection = null;
  if (key) {
    try { selection = [active.selectionStart, active.selectionEnd]; } catch (e) { selection = null; }
  }
  const y = window.scrollY;
  let html;
  let inside = false;
  if (!st.server) html = '<div class="lock"></div>';
  else if (!st.server.initialized) html = setupScreen();
  else if (st.server.locked || !st.db) html = lockScreen();
  else { html = shell(computed()); inside = true; }
  rendering = true;
  app.innerHTML = html;
  rendering = false;
  if (inside) afterRender();
  window.scrollTo(0, y);

  let wanted = st.focusAfter || key;
  const fresh = st.focusAfter != null;
  st.focusAfter = null;
  if (!inside && !wanted && !modalRoot.children.length) {
    const first = $('.lock-card input, .lock-card textarea', app);
    if (first && !PHONE) { first.focus(); }
    return;
  }
  if (!wanted || modalRoot.children.length) return;
  const el = app.querySelector('[data-fk="' + (window.CSS && CSS.escape ? CSS.escape(wanted) : wanted) + '"]');
  if (!el) return;
  el.focus({ preventScroll: !fresh });
  if (fresh) {
    if (typeof el.select === 'function') { try { el.select(); } catch (e) { /* not a text field */ } }
    el.scrollIntoView({ block: 'nearest' });
  } else if (selection && selection[0] != null) {
    try { el.setSelectionRange(selection[0], selection[1]); } catch (e) { /* not a text field */ }
  }
}

function afterRender() {
  const all = $('#check-all');
  if (all) {
    const boxes = $$('tbody input[data-act="check"]', app);
    const on = boxes.filter((b) => b.checked).length;
    all.indeterminate = on > 0 && on < boxes.length;
  }
  const parts = $$('.splitbar-part', app);
  const settle = () => parts.forEach((p) => { p.textContent = p.offsetWidth >= 46 ? p.dataset.label : ''; });
  if (parts.length && st.growBar) {
    st.growBar = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      parts.forEach((p) => { p.style.flexGrow = p.dataset.grow; });
      setTimeout(settle, 1050);
    }));
  } else {
    settle();
  }
  fitSheet();
}

/* ---------------------------------------------------------------- events */

async function go(page, focusKey) {
  await flushRows().catch(() => {});
  st.page = page;
  st.growBar = page === 'shares';
  if (focusKey) st.focusAfter = focusKey;
  render();
  window.scrollTo(0, 0);
}

function syncConnect() {
  const input = $('#sync-key');
  const error = $('#sync-error');
  const button = $('[data-act="sync-connect"]');
  if (!input) return;
  if (button) button.disabled = true;
  if (error) error.hidden = true;
  api.post('/api/sync/connect', { key: input.value }).then(() => { refreshState(); render(); toast('Connected to GitHub'); }).catch((e) => {
    if (button) button.disabled = false;
    if (e && e.gone) { showGone(); return; }
    if (error) { error.textContent = e.message; error.hidden = false; } else toast(e.message, { error: true });
  });
}

function syncNowClicked() {
  const busy = toast('Syncing…', { spin: true });
  flushRows().catch(() => {}).then(() => api.post('/api/sync/now')).then(async (s) => {
    busy.close();
    st.server = s;
    if (s.rev !== st.rev && !s.locked) await loadData();
    render();
    const i = syncInfo();
    toast(i.title + (i.sub ? ', ' + i.sub : ''), { error: i.dot === 'bad' });
  }).catch((e) => { busy.close(); handleError(e); });
}

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (!target || target.disabled) return;
  const act = target.dataset.act;
  const id = target.dataset.id;
  if (lockActions[act]) { lockActions[act](); return; }
  switch (act) {
    case 'nav': go(target.dataset.page, target.dataset.focus); break;
    case 'lock': lockNow(); break;
    case 'lock-forgot': st.lockView = 'recover'; st.focusAfter = 'rc-code'; render(); break;
    case 'lock-back': st.lockView = 'password'; render(); break;
    case 'setup-step': st.setup.step = target.dataset.step; render(); break;
    case 'setup-back': st.setup.step = 'welcome'; render(); break;
    case 'setup-join': st.setup.step = 'join'; render(); break;
    case 'pair-forget': api.post('/api/pair/forget').then(() => { refreshState(); st.setup.step = 'welcome'; render(); }); break;
    case 'copy-link': copyText(location.href); break;
    case 'add-invoices': $('#file-input').click(); break;
    case 'add-manual': openAdd(); break;
    case 'save-pdf': savePdf(); break;
    case 'print': flushRows().catch(() => {}).then(printStatement); break;
    case 'open-dir': nativeCall('POST', '/native/open', { dir: target.dataset.dir }).catch(() => toast('Couldn’t open the folder.', { error: true })); break;
    case 'sort': {
      const sortKey = target.dataset.key;
      st.sort = st.sort.key === sortKey ? { key: sortKey, dir: -st.sort.dir } : { key: sortKey, dir: sortKey === 'name' ? 1 : -1 };
      render();
      break;
    }
    case 'cur': st.cur = target.dataset.cur; render(); break;
    case 'hero-cur': st.heroCur = target.dataset.cur; render(); break;
    case 'clear-search': st.q = ''; st.cur = 'all'; st.focusAfter = 'q'; render(); break;
    case 'edit': openEdit(id); break;
    case 'delete': removeRows([id]); break;
    case 'bulk-share': openBulkShare(); break;
    case 'bulk-delete': removeRows(selectedIds()); break;
    case 'bulk-clear': st.selected.clear(); render(); break;
    case 'next-missing': {
      const all = computed();
      const first = visibleRows(all.filter((r) => r.amount == null))[0] || all.find((r) => r.amount == null);
      if (first) {
        if (!visibleRows(all).some((r) => r.id === first.id)) { st.q = ''; st.cur = 'all'; }
        st.focusAfter = 'pct-' + first.id;
        render();
      }
      break;
    }
    case 'sync-connect': syncConnect(); break;
    case 'sync-now': syncNowClicked(); break;
    case 'sync-key': showSyncKey(); break;
    case 'phone-link': showPhoneLink(); break;
    case 'sync-stop':
      confirmDialog({ title: 'Stop syncing?', text: 'The list stays on this computer and on GitHub. Your iPhone and other computers stop getting this computer’s changes.', confirm: 'Stop syncing', danger: true }).then((yes) => {
        if (yes) api.post('/api/sync/disconnect').then(() => { refreshState(); render(); toast('Sync stopped'); }).catch(handleError);
      });
      break;
    case 'remove-phone':
      confirmDialog({ title: 'Remove Cuts from this iPhone?', text: 'The ledger is taken off this iPhone. Your computer and the copy on GitHub keep everything. To use Cuts here again, scan the QR code on your computer.', confirm: 'Remove', danger: true }).then((yes) => {
        if (!yes) return;
        api.post('/api/sync/disconnect').then(() => { refreshState(); st.db = null; st.setup = { step: 'welcome' }; render(); toast('Cuts was removed from this iPhone'); }).catch(handleError);
      });
      break;
    case 'change-password': changePassword(); break;
    case 'new-recovery': newRecovery(); break;
    default: break;
  }
});

app.addEventListener('change', (event) => {
  const target = event.target;
  if (target.dataset.act === 'check') {
    if (target.checked) st.selected.add(target.dataset.id); else st.selected.delete(target.dataset.id);
    render();
  } else if (target.dataset.act === 'check-all') {
    const rows = visibleRows(computed());
    if (target.checked) rows.forEach((r) => st.selected.add(r.id)); else rows.forEach((r) => st.selected.delete(r.id));
    render();
  } else if (target.dataset.setting && st.db) {
    const key = target.dataset.setting;
    const value = target.value.trim();
    if (value === settings()[key]) return;
    commit([setOp(key, value)]).then(() => toast('Saved')).catch(() => {});
  }
});

app.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset.input === 'pct' && st.db) {
    const row = st.db.rows[target.dataset.id];
    if (!row) return;
    const clean = L.latinDigits(target.value);
    if (clean !== target.value) {
      const at = target.selectionStart;
      target.value = clean;
      try { target.setSelectionRange(at, at); } catch (e) { /* keep typing */ }
    }
    row.pct = clean;
    queueRow(row.id);
    st.keepOrder = true;
    render();
    st.keepOrder = false;
  } else if (target.dataset.input === 'q') {
    st.q = target.value;
    render();
  }
});

/* Leaving a share field tidies what was typed ("12,5 %" becomes "12.5"). The field is
   changed in place: redrawing here would swallow the click that took the focus away. */
app.addEventListener('focusout', (event) => {
  const target = event.target;
  // Redrawing removes the focused field, and the browser reports that as leaving it.
  if (rendering || !target.isConnected) return;
  if (!target.dataset || target.dataset.input !== 'pct' || !st.db) return;
  const row = st.db.rows[target.dataset.id];
  if (!row) return;
  const typed = L.latinDigits(target.value);
  const milli = L.parsePercent(typed);
  const tidy = typeof milli === 'number' ? L.plainPercent(milli) : typed.trim();
  if (tidy !== target.value) target.value = tidy;
  if (tidy !== row.pct) {
    row.pct = tidy;
    queueRow(row.id);
  }
});

function movePct(from, step) {
  const fields = $$('input[data-input="pct"]', app);
  const next = fields[fields.indexOf(from) + step];
  if (!next) return false;
  next.focus();
  next.select();
  return true;
}

app.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target.dataset && target.dataset.input === 'pct') {
    if (event.key === 'Enter' || event.key === 'ArrowDown') { event.preventDefault(); if (!movePct(target, 1)) target.blur(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); movePct(target, -1); }
    return;
  }
  if (event.key !== 'Enter') return;
  if (target.id === 'sync-key') { event.preventDefault(); syncConnect(); return; }
  if (target.dataset && target.dataset.setting) { target.blur(); return; }
  const card = target.closest('.lock-card');
  if (card && target.tagName === 'INPUT') {
    event.preventDefault();
    const submit = $('[data-submit]', card);
    if (submit && !submit.disabled) submit.click();
  }
});

document.addEventListener('keydown', (event) => {
  if (modalRoot.children.length) return;
  if (event.key === 'Escape' && st.db) {
    const typing = event.target && event.target.closest && event.target.closest('input, textarea, select');
    if (!typing && st.selected.size) { st.selected.clear(); render(); }
  }
  if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'l' && st.db) { event.preventDefault(); lockNow(); }
});

document.addEventListener('mouseover', (event) => {
  const target = event.target.closest ? event.target.closest('[data-tip]') : null;
  if (target === tipFor) return;
  if (target) showTip(target); else hideTip();
});
document.addEventListener('focusin', (event) => {
  const target = event.target.closest ? event.target.closest('.splitbar-part[data-tip]') : null;
  if (target) showTip(target);
});
document.addEventListener('focusout', hideTip);
window.addEventListener('scroll', hideTip, true);

$('#file-input').addEventListener('change', (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  importFiles(files);
});

/* dropping PDFs anywhere on the window */
let dragDepth = 0;
const dropLayer = $('#drop-layer');
$('#drop-ico').innerHTML = icon('import', 20);
const hasFiles = (event) => event.dataTransfer && [...(event.dataTransfer.types || [])].includes('Files');
window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (!st.db || modalRoot.children.length) return;
  dragDepth += 1;
  dropLayer.hidden = false;
});
window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = st.db && !modalRoot.children.length ? 'copy' : 'none';
});
window.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropLayer.hidden = true;
});
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dropLayer.hidden = true;
  if (st.db && !modalRoot.children.length) importFiles(event.dataTransfer.files);
});

window.addEventListener('resize', fitSheet);
window.addEventListener('beforeprint', fillPrintRoot);
window.addEventListener('pagehide', () => { flushRows().catch(() => {}); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushRows().catch(() => {}); });

/* ---------------------------------------------------------------- staying in step with the engine */

let changeTimer = null;
function onEngineChange() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    const s = engine.state();
    st.server = s;
    if (s.locked || !s.initialized) {
      if (st.db) { st.db = null; closeModals(); render(); }
      return;
    }
    if (st.db && s.rev !== st.rev) {
      if (pendingRows.size) { reloadWanted = true; return; }
      try { await loadData(); } catch (e) { return; }
      st.keepOrder = true;
      render();
      st.keepOrder = false;
      return;
    }
    updateSyncChip();
  }, 40);
}

function showGone(message, title) {
  if (st.gone) return;
  st.gone = true;
  const el = document.createElement('div');
  el.className = 'gone';
  el.setAttribute('role', 'alert');
  el.innerHTML = '<div>' + L.logoMark(64, 'dark') + '<h2></h2><p></p></div>';
  $('h2', el).textContent = title || 'Cuts has closed';
  $('p', el).textContent = message || 'Close this window and open Cuts again. Your work is saved.';
  document.body.appendChild(el);
}

/* Two windows would each keep their own copy of the ledger in memory and overwrite one
   another. Only the first window on a device works with it. */
function onlyWindow() {
  if (!navigator.locks || !navigator.locks.request) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request('cuts-ledger', { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      return lock ? new Promise(() => {}) : undefined;   // held until this window closes
    }).catch(() => resolve(true));
  });
}

/* The computer: the helper stays alive as long as this window is listening. */
function watchHelper() {
  let failures = 0;
  const source = new EventSource('/native/events');
  source.onopen = () => { failures = 0; };
  source.onerror = () => {
    failures += 1;
    if (failures < 3) return;
    nativeCall('GET', '/native/info').then(() => { failures = 0; }, (e) => { if (e.gone) showGone(); });
  };
}

/* ---------------------------------------------------------------- start */

async function start() {
  if (!(await onlyWindow())) {
    showGone('Use the window that is already open, and close this one.', 'Cuts is already open');
    return;
  }
  // The Windows app marks its page; anywhere else (the iPhone, a browser) the engine keeps
  // its locked files in the browser itself.
  let stored = null;
  PHONE = document.documentElement.dataset.native !== '1';
  if (!PHONE) {
    try {
      native = await nativeCall('GET', '/native/info');
      stored = await nativeCall('GET', '/native/store');
    } catch (e) {
      showGone('Cuts couldn\u2019t read its files. Close this window and open Cuts again.');
      return;
    }
  }
  STANDALONE = PHONE && (window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));
  if (PHONE) document.body.classList.add('is-phone');

  engine = createEngine({
    storage: PHONE ? undefined : helperStorage(stored),
    platform: PHONE ? 'iphone' : 'windows',
    version: L.APP_VERSION,
  });

  if (PHONE) {
    if (/[#&]p=[A-Za-z0-9_-]+/.test(location.hash)) {
      try { engine.keepPhoneLink(location.href); } catch (e) { /* the screen asks for a link */ }
      // In Safari the link stays in the address so Add to Home Screen carries it over.
      if (STANDALONE) history.replaceState(null, '', location.pathname + location.search);
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* works without */ });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { /* fine */ });
  } else {
    watchHelper();
  }

  engine.onChange(onEngineChange);
  refreshState();
  if (!st.server.locked && st.server.initialized) {
    try { await loadData(); } catch (e) { /* the lock screen shows */ }
  }
  render();
  setInterval(() => { if (st.db) { refreshState(); updateSyncChip(); } }, 30000);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { fitSheet(); });
}

start();
