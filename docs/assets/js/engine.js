/* Cuts — the ledger engine. It runs in the page on the computer and on the iPhone.
 * The ledger is one locked file: the records are gzipped and sealed with AES-256-GCM,
 * and the key that opens them is itself locked by the password (PBKDF2-SHA256) and by
 * the recovery code. The same file is kept on GitHub in a private repository; devices
 * merge record by record (the newest write wins, deletions travel as tombstones).
 * Nothing leaves the device unencrypted. Same design as the Splits ledger. */

const FORMAT = 'cuts-vault';
const LEDGER = 'cuts-ledger.json';
const COLLS = ['rows', 'settings'];
const te = new TextEncoder();
const td = new TextDecoder();
const CORRUPT = 'The ledger is damaged or not a Cuts ledger.';
const BAD_PW = 'That password isn’t right.';
const BAD_CODE = 'That recovery code isn’t right.';
const root = globalThis;

/* ------------------------------------------------------------------ bytes */
function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(String(s || '').replace(/[\r\n\s]/g, ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
  return u8;
}
function b64url(u8) { return b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s) { let t = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return unb64(t); }
function rand(n) { const u = new Uint8Array(n); root.crypto.getRandomValues(u); return u; }
function hex(u8) { let s = ''; for (let i = 0; i < u8.length; i += 1) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16); return s; }
function unhex(s) { const u = new Uint8Array(s.length / 2); for (let i = 0; i < u.length; i += 1) u[i] = parseInt(s.substr(i * 2, 2), 16); return u; }
function concat(...list) {
  let len = 0;
  list.forEach((x) => { len += x.length; });
  const u = new Uint8Array(len);
  let at = 0;
  list.forEach((x) => { u.set(x, at); at += x.length; });
  return u;
}
function pipe(u8, stream) {
  return new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer().then((ab) => new Uint8Array(ab));
}
function gzip(u8) { return pipe(u8, new CompressionStream('gzip')); }
function gunzip(u8) { return pipe(u8, new DecompressionStream('gzip')); }

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(u8) {
  let out = '';
  let bits = 0;
  let val = 0;
  for (let i = 0; i < u8.length; i += 1) {
    val = (val << 8) | u8[i];
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
/* A recovery code as typed: letters and digits only, look-alikes mapped back. */
function normalizeCode(code) {
  let out = '';
  String(code || '').toUpperCase().split('').forEach((r) => {
    if ((r >= 'A' && r <= 'Z') || (r >= '2' && r <= '7')) out += r;
    else if (r === '0') out += 'O';
    else if (r === '1') out += 'I';
    else if (r === '8') out += 'B';
  });
  return out;
}
function groupCode(code) { return code.match(/.{1,4}/g).join('-'); }

/* ------------------------------------------------------------------ errors */
function fail(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.data = Object.assign({ error: message }, extra || {});
  return e;
}
function offline(cause) { const e = fail(503, 'offline'); e.offline = true; e.cause = cause; return e; }

/* ------------------------------------------------------------------ the lock */
const subtle = root.crypto && root.crypto.subtle;
let newKdfIter = 600000;

function derive(kdf, secret) {
  let salt;
  try { salt = unb64(kdf && kdf.salt); } catch (e) { salt = new Uint8Array(0); }
  if (!kdf || kdf.alg !== 'pbkdf2-sha256' || !(kdf.iter >= 1000) || salt.length < 8) return Promise.reject(fail(400, CORRUPT));
  return subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveBits'])
    .then((base) => subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: kdf.iter }, base, 256))
    .then((bits) => new Uint8Array(bits));
}
function aesKey(raw) { return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
function seal(raw, plain, aad) {
  const iv = rand(12);
  return aesKey(raw)
    .then((k) => subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, plain))
    .then((ct) => concat(iv, new Uint8Array(ct)));
}
function unseal(raw, blob, aad) {
  if (!blob || blob.length < 28) return Promise.reject(fail(400, CORRUPT));
  return aesKey(raw)
    .then((k) => subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12), additionalData: aad, tagLength: 128 }, k, blob.subarray(12)))
    .then((pt) => new Uint8Array(pt));
}
function aadFor(env, kind) { return te.encode('cuts/' + kind + '/' + env.keyId); }
function newKdf() { return { alg: 'pbkdf2-sha256', iter: newKdfIter, salt: b64(rand(16)) }; }
function validEnv(e) { return !!(e && e.format === FORMAT && /^[0-9a-f]{16}$/.test(e.keyId || '') && e.pwWrap); }

function unlockPassword(env, pw) {
  return derive(env.pwKdf, pw).then((kek) => unseal(kek, unb64(env.pwWrap), aadFor(env, 'pw')).catch(() => { throw fail(400, BAD_PW, { bad: 'password' }); }));
}
function unlockRecovery(env, code) {
  const norm = normalizeCode(code);
  if (norm.length !== 24 || !env.rcWrap) return Promise.reject(fail(400, BAD_CODE, { bad: 'code' }));
  return derive(env.rcKdf, norm).then((kek) => unseal(kek, unb64(env.rcWrap), aadFor(env, 'rc')).catch(() => { throw fail(400, BAD_CODE, { bad: 'code' }); }));
}
function setPassword(env, dek, pw, at) {
  const k = newKdf();
  return derive(k, pw).then((kek) => seal(kek, dek, aadFor(env, 'pw'))).then((w) => {
    env.pwKdf = k; env.pwWrap = b64(w); env.pwAt = at;
  });
}
function newRecovery(env, dek, at) {
  const code = base32(rand(15));
  const k = newKdf();
  return derive(k, code).then((kek) => seal(kek, dek, aadFor(env, 'rc'))).then((w) => {
    env.rcKdf = k; env.rcWrap = b64(w); env.rcAt = at;
    return groupCode(code);
  });
}
function openData(env, dek) {
  if (!env.data) return Promise.resolve('');
  let blob;
  try { blob = unb64(env.data); } catch (e) { return Promise.reject(fail(400, CORRUPT)); }
  return unseal(dek, blob, aadFor(env, 'data')).catch(() => { throw fail(400, CORRUPT); }).then(gunzip).then((u8) => td.decode(u8));
}
function sealData(env, dek, json) {
  return gzip(te.encode(json)).then((z) => seal(dek, z, aadFor(env, 'data'))).then((blob) => { env.data = b64(blob); });
}
function sealSecret(env, dek, kind, secret) { return seal(dek, te.encode(secret), aadFor(env, kind)).then(b64); }
function openSecret(env, dek, kind, blob64) { return unseal(dek, unb64(blob64), aadFor(env, kind)).then((u8) => td.decode(u8)); }

/* ------------------------------------------------------------------ the records */
function newDataset() { const ds = { schema: 1, colls: {} }; COLLS.forEach((c) => { ds.colls[c] = {}; }); return ds; }
function ensure(ds) {
  if (!ds.schema) ds.schema = 1;
  if (!ds.colls || typeof ds.colls !== 'object') ds.colls = {};
  COLLS.forEach((c) => { if (!ds.colls[c] || typeof ds.colls[c] !== 'object') ds.colls[c] = {}; });
  return ds;
}
function parseDataset(json) {
  if (!json) return newDataset();
  let ds;
  try { ds = JSON.parse(json); } catch (e) { throw fail(400, CORRUPT); }
  if (!ds || typeof ds !== 'object') throw fail(400, CORRUPT);
  ensure(ds);
  Object.keys(ds.colls).forEach((c) => {
    const m = ds.colls[c];
    Object.keys(m).forEach((id) => { if (!m[id] || typeof m[id] !== 'object') delete m[id]; });
  });
  return ds;
}
function cloneRec(r) {
  const c = { id: r.id, u: r.u };
  if (r.dev) c.dev = r.dev;
  if (r.del) c.del = true;
  if (r.b !== undefined && r.b !== null) c.b = JSON.parse(JSON.stringify(r.b));
  return c;
}
function newer(a, b) {
  if (a.u !== b.u) return a.u > b.u;
  return (a.dev || '') > (b.dev || '');
}
/* Merges src into dst. changed: dst took something from src. ahead: dst has writes src lacks. */
export function mergeInto(dst, src) {
  ensure(dst); ensure(src);
  let changed = false;
  let ahead = false;
  Object.keys(src.colls).forEach((c) => {
    const s = src.colls[c] || {};
    const d = dst.colls[c] || (dst.colls[c] = {});
    Object.keys(s).forEach((id) => {
      const sr = s[id];
      const dr = d[id];
      if (!sr) return;
      if (!dr || newer(sr, dr)) { d[id] = cloneRec(sr); changed = true; }
    });
  });
  const names = Object.keys(dst.colls);
  for (let i = 0; i < names.length && !ahead; i += 1) {
    const d2 = dst.colls[names[i]];
    const s2 = src.colls[names[i]] || {};
    const ids = Object.keys(d2);
    for (let j = 0; j < ids.length; j += 1) {
      const sr2 = s2[ids[j]];
      if (!sr2 || newer(d2[ids[j]], sr2)) { ahead = true; break; }
    }
  }
  return { changed, ahead };
}
function mergeHeader(local, remote) {
  let changed = false;
  let ahead = false;
  if ((remote.pwAt || 0) > (local.pwAt || 0)) { local.pwKdf = remote.pwKdf; local.pwWrap = remote.pwWrap; local.pwAt = remote.pwAt; changed = true; }
  else if ((remote.pwAt || 0) < (local.pwAt || 0)) ahead = true;
  if ((remote.rcAt || 0) > (local.rcAt || 0)) { local.rcKdf = remote.rcKdf; local.rcWrap = remote.rcWrap; local.rcAt = remote.rcAt; changed = true; }
  else if ((remote.rcAt || 0) < (local.rcAt || 0)) ahead = true;
  return { changed, ahead };
}
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
function applyOp(ds, op, now, dev) {
  if (!op || COLLS.indexOf(op.c) < 0) throw fail(400, 'unknown collection "' + (op && op.c) + '"');
  if (typeof op.id !== 'string' || !ID_RE.test(op.id)) throw fail(400, 'invalid record id');
  const coll = ds.colls[op.c];
  const prev = coll[op.id];
  let u = now;
  if (prev && prev.u >= u) u = prev.u + 1;
  const rec = { id: op.id, u, dev };
  if (op.op === 'put') {
    if (!op.b || typeof op.b !== 'object' || Array.isArray(op.b)) throw fail(400, 'record must be a JSON object');
    const s = JSON.stringify(op.b);
    if (te.encode(s).length > 64 * 1024) throw fail(400, 'record is too large');
    rec.b = JSON.parse(s);
  } else if (op.op === 'del') {
    if (!prev || prev.del) return null;
    rec.del = true;
  } else throw fail(400, 'unknown operation "' + op.op + '"');
  coll[op.id] = rec;
  return rec;
}
function cloneDataset(ds) { return parseDataset(JSON.stringify(ds)); }
function clientView(ds) {
  const out = {};
  Object.keys(ds.colls).forEach((c) => {
    const m = ds.colls[c];
    out[c] = Object.keys(m).filter((id) => !m[id].del).sort().map((id) => ({ id, u: m[id].u, b: m[id].b || {} }));
  });
  return out;
}

/* ------------------------------------------------------------------ sync key and phone link */
const RE_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const RE_TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/* "owner/repository#key" → its three parts. */
export function parseSyncKey(key) {
  const k = String(key || '').trim().replace(/^https:\/\//, '').replace(/^github\.com\//, '');
  const m = k.match(/[#| \t\r\n]/);
  const bad = fail(400, 'This doesn’t look like a sync key. It should look like owner/repository#key.');
  if (!m) throw bad;
  const left = k.slice(0, m.index);
  const right = k.slice(m.index).replace(/^[#| \t\r\n]+|[#| \t\r\n]+$/g, '');
  const parts = left.replace(/\.git$/, '').split('/');
  if (parts.length !== 2 || !RE_PART.test(parts[0]) || !RE_PART.test(parts[1]) || !RE_TOKEN.test(right)) throw bad;
  return { owner: parts[0], repo: parts[1], token: right };
}

/* The link the computer shows as a QR code:
   #p=<version 1, key id, password KDF and wrap, the sync key sealed with the data key>.
   It only carries locked data, so it needs the password too. */
export function parsePhoneLink(s) {
  const str = String(s || '').trim();
  const m = str.match(/[#&?]p=([A-Za-z0-9_-]+)/);
  const code = m ? m[1] : str;
  const bad = fail(400, 'This isn’t a Cuts link for the iPhone. Make a new one on your computer: Settings, Use Cuts on your iPhone.');
  let b;
  try { b = unb64url(code); } catch (e) { throw bad; }
  if (b.length < 60 || b[0] !== 1) throw bad;
  let i = 1;
  const take = (n) => { if (i + n > b.length) throw bad; const x = b.subarray(i, i + n); i += n; return x; };
  const keyId = hex(take(8));
  const it = take(4);
  const iter = ((it[0] << 24) >>> 0) + (it[1] << 16) + (it[2] << 8) + it[3];
  const salt = take(take(1)[0]);
  const wrap = take(take(1)[0]);
  const ln = take(2);
  const sealed = take((ln[0] << 8) | ln[1]);
  if (i !== b.length) throw bad;
  return { keyId, pwKdf: { alg: 'pbkdf2-sha256', iter, salt: b64(salt) }, pwWrap: b64(wrap), sealed, code };
}
function buildPhoneCode(env, sealed) {
  const salt = unb64(env.pwKdf.salt);
  const wrap = unb64(env.pwWrap);
  const iter = env.pwKdf.iter;
  return b64url(concat(
    new Uint8Array([1]), unhex(env.keyId),
    new Uint8Array([(iter >>> 24) & 255, (iter >>> 16) & 255, (iter >>> 8) & 255, iter & 255]),
    new Uint8Array([salt.length]), salt,
    new Uint8Array([wrap.length]), wrap,
    new Uint8Array([(sealed.length >> 8) & 255, sealed.length & 255]), sealed));
}

/* ------------------------------------------------------------------ storage */
export function browserStorage() {
  return {
    get(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) {
      try { root.localStorage.setItem(k, v); } catch (e) { throw fail(507, 'This device has no room left for the Cuts ledger. Free some space and try again.'); }
    },
    del(k) { try { root.localStorage.removeItem(k); } catch (e) { /* gone */ } },
  };
}

/* ------------------------------------------------------------------ the engine */
export function createEngine(opt = {}) {
  const store = opt.storage || browserStorage();
  const apiBase = (opt.apiBase || 'https://api.github.com').replace(/\/+$/, '');
  const fetchFn = opt.fetch || ((u, o) => root.fetch(u, o));
  const now = opt.now || (() => Date.now());
  const phone = opt.platform === 'iphone';
  const here = phone ? 'this iPhone' : 'this computer';
  const version = opt.version || '';
  const phoneUrl = opt.phoneUrl || ((owner) => 'https://' + String(owner).toLowerCase() + '.github.io/cuts/');
  if (opt.kdfIter) newKdfIter = opt.kdfIter;
  const K = { vault: 'cuts.vault', local: 'cuts.local', pair: 'cuts.pair' };
  const NOT_SET_UP = 'Cuts isn’t set up on ' + here + ' yet.';
  const RECONNECT = phone ? 'Connect this iPhone again: make a new link on your computer.' : 'Connect to GitHub again with your sync key.';

  const S = {
    env: null, dek: null, data: null, rev: 1, local: null, pending: false, seq: 0,
    cache: { etag: '', content: null, sha: '' },
    sync: { state: 'off', message: '', lastOk: 0, repo: '', busy: false },
    timer: null, running: null, again: false, fails: 0, saving: Promise.resolve(), listeners: [],
  };

  function saveLocal() { store.set(K.local, JSON.stringify(S.local)); }
  function loadLocal() {
    let l = null;
    try { l = JSON.parse(store.get(K.local) || 'null'); } catch (e) { l = null; }
    S.local = l && typeof l === 'object' ? l : {};
    if (!S.local.deviceId) { S.local.deviceId = (phone ? 'iphone-' : 'pc-') + hex(rand(4)); saveLocal(); }
    if (S.local.sync) S.sync.repo = S.local.sync.owner + '/' + S.local.sync.repo;
    if (S.local.sync && S.local.sync.lastSync) S.sync.lastOk = S.local.sync.lastSync;
  }
  function loadVault() {
    const raw = store.get(K.vault);
    if (!raw) { S.env = null; return; }
    try { const e = JSON.parse(raw); S.env = validEnv(e) ? e : null; } catch (x) { S.env = null; }
  }
  loadLocal();
  loadVault();

  function touch() { S.seq += 1; S.pending = true; }
  function clearPending(seq) { if (S.seq === seq) S.pending = false; else kick(1000); }
  function changed() { S.rev += 1; S.listeners.forEach((fn) => { try { fn(); } catch (e) { /* a listener's own trouble */ } }); }
  function notify() { S.listeners.forEach((fn) => { try { fn(); } catch (e) { /* a listener's own trouble */ } }); }

  /* Seals the records into the file and keeps it on the device. Saves run one after
     another. Resolves to { json, seq }: the file and the change count it contains. */
  function sealVault() {
    const p = S.saving.then(() => {
      if (!S.env) throw fail(400, NOT_SET_UP);
      let step = Promise.resolve();
      const seq = S.seq;
      if (S.dek && S.data) {
        const dek = S.dek;
        const json = JSON.stringify(S.data);
        step = sealData(S.env, dek, json).then(() => { S.env.savedAt = now(); S.env.savedBy = S.local.deviceId; });
      }
      return step.then(() => {
        const out = JSON.stringify(S.env);
        store.set(K.vault, out);
        return { json: out, seq };
      });
    });
    S.saving = p.catch(() => { /* keep the chain going */ });
    return p;
  }
  function saveVault() { return sealVault().then((r) => r.json); }

  /* -------------------------------------------------------------- wrong passwords */
  function lockout() {
    if ((S.local.lockUntil || 0) > now()) {
      const secs = Math.ceil((S.local.lockUntil - now()) / 1000);
      throw fail(429, 'Too many wrong tries. Try again in ' + secs + ' seconds.', { lockUntil: S.local.lockUntil });
    }
  }
  function failed() {
    S.local.failCount = (S.local.failCount || 0) + 1;
    if (S.local.failCount >= 5) {
      const d = Math.min(30000 * Math.pow(2, Math.min(S.local.failCount - 5, 5)), 15 * 60000);
      S.local.lockUntil = now() + d;
    }
    saveLocal();
  }
  function succeeded() { S.local.failCount = 0; S.local.lockUntil = 0; saveLocal(); }
  function checkPassword(pw) {
    lockout();
    return unlockPassword(S.env, pw).catch((e) => { if (e.data && e.data.bad) failed(); throw e; });
  }

  /* -------------------------------------------------------------- GitHub */
  function ghError(res) {
    let msg = '';
    try { msg = JSON.parse(res.text).message || ''; } catch (e) { /* not JSON */ }
    if (res.status === 401) return fail(400, 'The GitHub key is invalid or has expired. ' + (phone ? 'Make a new link on your computer.' : 'Make a new key on GitHub and connect again.'), { gh: 401 });
    if (res.status === 403) {
      if (res.headers && res.headers.get && res.headers.get('X-RateLimit-Remaining') === '0') return fail(400, 'GitHub is limiting requests for a while. Cuts will try again shortly.', { gh: 403 });
      return fail(400, 'GitHub refused the change. Check that the key can read and write this repository. (' + msg + ')', { gh: 403 });
    }
    if (res.status === 404) return fail(400, 'Can’t find the repository, or the key doesn’t have access to it.', { gh: 404 });
    if (res.status >= 500) return offline(new Error('GitHub error ' + res.status));
    return fail(400, 'GitHub error ' + res.status + ': ' + msg, { gh: res.status });
  }
  function ghDo(g, method, path, body, hdr) {
    const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + g.token, 'X-GitHub-Api-Version': '2022-11-28' };
    if (body) headers['Content-Type'] = 'application/json';
    Object.keys(hdr || {}).forEach((k) => { headers[k] = hdr[k]; });
    const url = apiBase + '/repos/' + encodeURIComponent(g.owner) + '/' + encodeURIComponent(g.repo) + path;
    return Promise.resolve()
      .then(() => fetchFn(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }))
      .then((res) => res.text().then((text) => ({ status: res.status, headers: res.headers, text })), (e) => { throw offline(e); });
  }
  function ghCheck(g) { return ghDo(g, 'GET', '').then((r) => { if (r.status !== 200) throw ghError(r); }); }
  function ghGet(g, etag) {
    return ghDo(g, 'GET', '/contents/' + LEDGER, null, etag ? { 'If-None-Match': etag } : null).then((r) => {
      if (r.status === 304) return { status: 304, etag };
      if (r.status === 404) return ghCheck(g).then(() => ({ status: 404 }));
      if (r.status !== 200) throw ghError(r);
      let c;
      try { c = JSON.parse(r.text); } catch (e) { throw fail(400, 'GitHub sent an unexpected answer.'); }
      if (c.type && c.type !== 'file') throw fail(400, LEDGER + ' on GitHub isn’t a file.');
      const etagOut = r.headers && r.headers.get ? (r.headers.get('ETag') || '') : '';
      let step = Promise.resolve(c.content);
      if ((c.encoding !== 'base64' || !c.content) && c.size > 0) {
        step = ghDo(g, 'GET', '/git/blobs/' + c.sha).then((br) => {
          if (br.status !== 200) throw ghError(br);
          try { return JSON.parse(br.text).content; } catch (e) { throw fail(400, 'GitHub sent an unexpected answer.'); }
        });
      }
      return step.then((content64) => {
        let text;
        try { text = td.decode(unb64(content64 || '')); } catch (e) { throw fail(400, 'GitHub sent a damaged file.'); }
        return { status: 200, content: text, sha: c.sha, etag: etagOut };
      });
    });
  }
  function ghPut(g, content, sha, msg) {
    const body = { message: msg, content: b64(te.encode(content)) };
    if (sha) body.sha = sha;
    return ghDo(g, 'PUT', '/contents/' + LEDGER, body).then((r) => {
      if (r.status === 200 || r.status === 201) {
        let s = '';
        try { s = JSON.parse(r.text).content.sha; } catch (e) { /* keep empty */ }
        return { sha: s };
      }
      if (r.status === 409 || (r.status === 422 && /sha/i.test(r.text))) return { conflict: true };
      throw ghError(r);
    });
  }
  function client() {
    const cfg = S.local.sync;
    if (!cfg) return Promise.reject(fail(400, 'GitHub isn’t connected.'));
    if (!S.dek) return Promise.reject(fail(423, 'Cuts is locked'));
    if (cfg.keyId !== S.env.keyId) return Promise.reject(fail(400, RECONNECT));
    return openSecret(S.env, S.dek, 'token', cfg.tokenSeal).then((token) => ({ owner: cfg.owner, repo: cfg.repo, token }), () => { throw fail(400, RECONNECT); });
  }

  function setSync(state, msg) {
    S.sync.state = state;
    S.sync.message = msg || '';
    if (state === 'ok') S.sync.lastOk = now();
  }
  function syncFailed(e) {
    if (e && e.offline) setSync('offline', 'No connection to GitHub. Changes are saved on ' + here + ' and will sync when you’re back online.');
    else if (e && e.data && e.data.mismatch) setSync('mismatch', e.message);
    else if (e && e.data && e.data.gh === 401) setSync('auth', e.message);
    else setSync('error', (e && e.message) || String(e));
    throw e;
  }

  /* One pull, merge, push cycle. */
  function once() {
    const cfg = S.local.sync;
    if (!cfg) { setSync('off'); return Promise.resolve(); }
    if (!S.dek) { setSync('locked', 'Unlock Cuts to sync.'); return Promise.resolve(); }
    let pending = S.pending;
    S.sync.busy = true;
    if (S.sync.state !== 'ok') setSync('syncing');
    let attempt = 0;
    function round(g) {
      const etag = attempt === 0 && S.cache.content ? S.cache.etag : '';
      return ghGet(g, etag).then((r) => {
        let content;
        let sha;
        if (r.status === 304) {
          if (!pending && !S.pending) { setSync('ok'); return 'done'; }
          content = S.cache.content; sha = S.cache.sha;
        } else if (r.status === 200) {
          S.cache = { etag: r.etag, content: r.content, sha: r.sha };
          content = r.content; sha = r.sha;
        } else S.cache = { etag: '', content: null, sha: '' };
        if (!S.dek || S.local.sync !== cfg) return 'done';
        let payloadP;
        let putSha = '';
        let msg = 'Update ledger from ' + S.local.deviceId;
        let mergedSeq = S.seq;
        if (r.status === 404) {
          payloadP = sealVault();
          msg = 'Create ledger';
        } else {
          let renv;
          try { renv = JSON.parse(content); } catch (e) { renv = null; }
          if (!validEnv(renv)) throw fail(400, LEDGER + ' on GitHub isn’t a Cuts ledger.');
          if (renv.keyId !== S.env.keyId) {
            throw fail(400, 'GitHub has a different ledger. ' + (phone ? 'Remove Cuts from this iPhone in Settings and connect it again.' : 'Stop syncing in Settings and connect to the right repository.'), { mismatch: true });
          }
          payloadP = openData(renv, S.dek).catch(() => { throw fail(400, 'Cuts can’t read the ledger on GitHub. It may be damaged.'); }).then((plain) => {
            let rds;
            try { rds = parseDataset(plain); } catch (e) { throw fail(400, 'Cuts can’t read the ledger on GitHub. It may be damaged.'); }
            if (!S.dek || !S.data) return 'abort';
            const seqAtMerge = S.seq;
            const m = mergeInto(S.data, rds);
            const hm = mergeHeader(S.env, renv);
            const save = m.changed || hm.changed ? saveVault().then(() => { changed(); }) : Promise.resolve();
            return save.then(() => {
              if (!m.ahead && !hm.ahead) { mergedSeq = seqAtMerge; return null; }
              putSha = sha;
              return sealVault();
            });
          });
        }
        return payloadP.then((payload) => {
          if (payload === 'abort') return 'done';
          if (payload === null) {
            clearPending(mergedSeq);
            cfg.lastSha = sha; cfg.lastSync = now();
            saveLocal();
            setSync('ok');
            return 'done';
          }
          const sentSeq = payload.seq;
          const json = payload.json;
          return ghPut(g, json, putSha, msg).then((pr) => {
            if (pr.conflict) {
              S.pending = true; pending = true;
              S.cache = { etag: '', content: null, sha: '' };
              attempt += 1;
              if (attempt >= 6) throw fail(400, 'Another device kept changing the ledger. Cuts will try again shortly.');
              return new Promise((res) => { setTimeout(res, 400 * attempt); }).then(() => round(g));
            }
            S.cache = { etag: '', content: json, sha: pr.sha };
            clearPending(sentSeq);
            cfg.lastSha = pr.sha; cfg.lastSync = now();
            saveLocal();
            setSync('ok');
            return 'done';
          });
        });
      });
    }
    return client().then(round).then(() => { S.fails = 0; }, (e) => { S.fails += 1; return syncFailed(e); })
      .finally(() => { S.sync.busy = false; notify(); });
  }

  function kick(ms) {
    if (S.timer) clearTimeout(S.timer);
    S.timer = setTimeout(() => { S.timer = null; run(); }, ms);
    if (S.timer && S.timer.unref) S.timer.unref();
  }
  function run() {
    if (S.running) { S.again = true; return S.running; }
    S.running = once().catch(() => { /* the status shows it */ }).finally(() => {
      S.running = null;
      if (!S.local.sync) return;
      if (S.again) { S.again = false; kick(200); return; }
      let next = 60000;
      if (S.sync.state === 'offline') next = Math.min(10000 * Math.pow(2, Math.min(Math.max(S.fails - 1, 0), 5)), 300000);
      else if (S.sync.state === 'error' || S.sync.state === 'auth' || S.sync.state === 'mismatch') next = 180000;
      kick(next);
    });
    return S.running;
  }
  function syncNow() {
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    if (S.running) { S.again = true; return S.running.then(() => S.running || run()); }
    return run();
  }

  /* -------------------------------------------------------------- opening the ledger */
  function openWithKey(dek) {
    return openData(S.env, dek).then((plain) => {
      S.data = parseDataset(plain);
      S.dek = dek;
      succeeded();
      changed();
      if (S.local.sync) kick(300);
    });
  }
  /* Joins the ledger that is on GitHub. getDek(remote file) returns the data key. */
  function joinWith(k, getDek) {
    const g = { owner: k.owner, repo: k.repo, token: k.token };
    return ghGet(g, '').catch((e) => {
      if (e.offline) throw fail(400, 'Can’t reach GitHub. Check the internet connection and try again.');
      throw e;
    }).then((r) => {
      if (r.status !== 200) throw fail(400, 'There’s no ledger on GitHub yet. Start Cuts on your computer and connect it to GitHub first.');
      let renv;
      try { renv = JSON.parse(r.content); } catch (e) { renv = null; }
      if (!validEnv(renv)) throw fail(400, LEDGER + ' in this repository isn’t a Cuts ledger.');
      return Promise.resolve(getDek(renv)).then((dek) => openData(renv, dek).then((plain) => {
        const ds = parseDataset(plain);
        return sealSecret(renv, dek, 'token', k.token).then((tokenSeal) => {
          S.env = renv;
          store.set(K.vault, r.content);
          S.local.sync = { owner: k.owner, repo: k.repo, path: LEDGER, tokenSeal, keyId: renv.keyId, lastSha: r.sha, lastSync: now() };
          S.local.failCount = 0; S.local.lockUntil = 0;
          saveLocal();
          store.del(K.pair);
          S.cache = { etag: r.etag, content: r.content, sha: r.sha };
          S.dek = dek; S.data = ds; S.pending = false;
          S.sync.repo = k.owner + '/' + k.repo;
          setSync('ok');
          changed();
          kick(60000);
        });
      }));
    });
  }

  /* -------------------------------------------------------------- what the screens call */
  function state() {
    const t = now();
    const st = {
      version, initialized: !!S.env, locked: !S.dek, rev: S.rev, device: S.local.deviceId,
      platform: phone ? 'iphone' : 'windows', phone, now: t, pairing: phone && !S.env && !!store.get(K.pair),
    };
    if ((S.local.lockUntil || 0) > t) st.lockUntil = S.local.lockUntil;
    if (!S.local.sync) st.sync = { state: 'off', busy: false, pending: false };
    else {
      st.sync = { state: S.sync.state, message: S.sync.message, lastOk: S.sync.lastOk, repo: S.sync.repo, busy: S.sync.busy, pending: S.pending };
      if (st.locked) st.sync.state = 'locked';
    }
    return st;
  }
  function needOpen() {
    if (!S.env) throw fail(400, NOT_SET_UP);
    if (!S.dek) throw fail(423, 'Cuts is locked');
  }

  const routes = {
    'GET /api/state': () => state(),
    'POST /api/setup': (b) => {
      if (S.env) throw fail(400, 'Cuts is already set up on ' + here + '.');
      if (!b.password) throw fail(400, 'Choose a password');
      const env = { format: FORMAT, v: 1, keyId: hex(rand(8)), createdAt: now() };
      const dek = rand(32);
      return setPassword(env, dek, b.password, now()).then(() => newRecovery(env, dek, now())).then((code) => {
        S.env = env; S.dek = dek; S.data = newDataset(); S.pending = false;
        return saveVault().then(() => { succeeded(); changed(); return { recoveryCode: code }; });
      });
    },
    'POST /api/unlock': (b) => {
      if (!S.env) throw fail(400, NOT_SET_UP);
      if (S.dek) return state();
      return checkPassword(b.password || '').then(openWithKey).then(state);
    },
    'POST /api/lock': () => S.saving.then(() => {
      if (S.dek) { S.dek = null; S.data = null; changed(); }
      return state();
    }),
    'GET /api/data': () => { needOpen(); return { rev: S.rev, colls: clientView(S.data) }; },
    'POST /api/mutate': (b) => {
      needOpen();
      const ops = (b && b.ops) || [];
      if (ops.length > 5000) throw fail(400, 'too many changes at once');
      const work = cloneDataset(S.data);
      const t = now();
      const out = [];
      ops.forEach((op) => {
        const rec = applyOp(work, op, t, S.local.deviceId);
        if (rec) out.push({ c: op.c, id: rec.id, u: rec.u, del: rec.del || undefined, b: rec.b });
      });
      S.data = work;
      if (!out.length) return { rev: S.rev, recs: [] };
      S.rev += 1;
      touch();
      return saveVault().then(() => { if (S.local.sync) kick(2000); return { rev: S.rev, recs: out }; });
    },
    'POST /api/pairlink': (b) => {
      const p = parsePhoneLink(b.link);
      store.set(K.pair, p.code);
      return state();
    },
    'POST /api/pair': (b) => {
      if (S.env) throw fail(400, 'Cuts is already connected on ' + here + '.');
      lockout();
      const p = parsePhoneLink(store.get(K.pair));
      const envLike = { keyId: p.keyId };
      return derive(p.pwKdf, b.password || '')
        .then((kek) => unseal(kek, unb64(p.pwWrap), aadFor(envLike, 'pw')).catch(() => { failed(); throw fail(400, BAD_PW, { bad: 'password' }); }))
        .then((dek) => unseal(dek, p.sealed, aadFor(envLike, 'phone')).catch(() => { throw fail(400, 'This link is damaged. Make a new one on your computer.'); }).then((u8) => {
          const k = parseSyncKey(td.decode(u8));
          return joinWith(k, (renv) => {
            if (renv.keyId !== p.keyId) throw fail(400, 'This link is for another ledger. Make a new one on your computer.');
            return dek;
          });
        })).then(state);
    },
    'POST /api/pair/forget': () => { store.del(K.pair); return state(); },
    'POST /api/join': (b) => {
      if (S.env) throw fail(400, 'Cuts is already set up on ' + here + '.');
      lockout();
      const k = parseSyncKey(b.key);
      return joinWith(k, (renv) => unlockPassword(renv, b.password || '').catch((e) => {
        if (e.data && e.data.bad) { failed(); throw fail(400, 'That’s not the password of the ledger on GitHub.', { bad: 'password' }); }
        throw e;
      })).then(state);
    },
    'POST /api/recover': (b) => {
      if (!S.env) throw fail(400, NOT_SET_UP);
      if (!b.next) throw fail(400, 'Choose a new password');
      lockout();
      return unlockRecovery(S.env, b.code).catch((e) => { if (e.data && e.data.bad) failed(); throw e; })
        .then((dek) => setPassword(S.env, dek, b.next, now()).then(() => openWithKey(dek)))
        .then(() => { touch(); return saveVault(); }).then(() => { if (S.local.sync) kick(500); return state(); });
    },
    'POST /api/password': (b) => {
      needOpen();
      if (!b.next) throw fail(400, 'Choose a new password');
      return checkPassword(b.current || '').then(() => { succeeded(); return setPassword(S.env, S.dek, b.next, now()); })
        .then(() => { touch(); return saveVault(); }).then(() => { if (S.local.sync) kick(500); return { ok: true }; });
    },
    'POST /api/recovery': (b) => {
      needOpen();
      return checkPassword(b.password || '').then(() => { succeeded(); return newRecovery(S.env, S.dek, now()); }).then((code) => {
        touch();
        return saveVault().then(() => { if (S.local.sync) kick(500); return { recoveryCode: code }; });
      });
    },
    /* The computer: connect this ledger to a repository. The first sync runs right away,
       so a key that can't write is caught here and not later. */
    'POST /api/sync/connect': (b) => {
      needOpen();
      const k = parseSyncKey(b.key);
      const g = { owner: k.owner, repo: k.repo, token: k.token };
      const before = S.local.sync || null;
      return ghGet(g, '').catch((e) => {
        if (e.offline) throw fail(400, 'Can’t reach GitHub. Check the internet connection and try again.');
        throw e;
      }).then((r) => {
        if (r.status === 200) {
          let renv;
          try { renv = JSON.parse(r.content); } catch (e) { renv = null; }
          if (!validEnv(renv)) throw fail(400, LEDGER + ' in this repository isn’t a Cuts ledger.');
          if (renv.keyId !== S.env.keyId) {
            throw fail(400, 'This repository already holds another Cuts ledger. Use an empty repository, or start over on this computer with “Connect to my ledger”.', { mismatch: true });
          }
        }
        return sealSecret(S.env, S.dek, 'token', k.token);
      }).then((tokenSeal) => {
        if (S.timer) { clearTimeout(S.timer); S.timer = null; }
        S.local.sync = { owner: k.owner, repo: k.repo, path: LEDGER, tokenSeal, keyId: S.env.keyId, lastSha: '', lastSync: 0 };
        S.sync.repo = k.owner + '/' + k.repo;
        S.sync.lastOk = 0;
        S.cache = { etag: '', content: null, sha: '' };
        S.pending = true;
        const wait = S.running ? S.running.catch(() => {}) : Promise.resolve();
        return wait.then(() => once()).then(() => {
          saveLocal();
          kick(60000);
          return state();
        }, (e) => {
          S.local.sync = before;
          S.sync.repo = before ? before.owner + '/' + before.repo : '';
          setSync(before ? 'error' : 'off', before ? e.message : '');
          if (e.offline) throw fail(400, 'Can’t reach GitHub. Check the internet connection and try again.');
          throw e;
        });
      });
    },
    'POST /api/sync/now': () => syncNow().then(state, state),
    'POST /api/sync/key': (b) => {
      needOpen();
      return checkPassword(b.password || '').then(() => { succeeded(); return client(); }).then((g) => ({ key: g.owner + '/' + g.repo + '#' + g.token }));
    },
    /* The link and QR code that connect an iPhone. Only locked data goes into it. */
    'GET /api/phone': () => {
      needOpen();
      return client().then((g) => seal(S.dek, te.encode(g.owner + '/' + g.repo + '#' + g.token), aadFor(S.env, 'phone')).then((sealed) => ({
        url: phoneUrl(g.owner) + '#p=' + buildPhoneCode(S.env, sealed),
      })));
    },
    /* On the computer this stops syncing and keeps the ledger. On the iPhone it also
       takes the ledger off the phone. */
    'POST /api/sync/disconnect': () => S.saving.then(() => {
      if (S.timer) { clearTimeout(S.timer); S.timer = null; }
      S.cache = { etag: '', content: null, sha: '' };
      if (phone) {
        S.env = null; S.dek = null; S.data = null; S.pending = false;
        store.del(K.vault); store.del(K.pair);
        S.local = { deviceId: S.local.deviceId };
      } else {
        delete S.local.sync;
        S.pending = false;
      }
      saveLocal();
      setSync('off');
      S.sync.repo = '';
      S.sync.lastOk = 0;
      changed();
      return state();
    }),
  };

  function call(method, path, body) {
    const fn = routes[method + ' ' + path.split('?')[0]];
    return Promise.resolve().then(() => {
      if (!fn) throw fail(404, 'This isn’t available here.');
      if (!subtle || typeof CompressionStream === 'undefined') {
        throw fail(400, phone ? 'Update your iPhone to use Cuts: it needs iOS 16.4 or newer.' : 'This browser is too old for Cuts. Update Microsoft Edge or Chrome.');
      }
      return fn(body || {});
    }).then((data) => (data === undefined ? null : JSON.parse(JSON.stringify(data))));
  }

  /* Sync when the device comes back online or the app comes back to the front. */
  if (root.addEventListener) root.addEventListener('online', () => { if (S.local.sync) kick(500); });
  if (root.document && root.document.addEventListener) {
    root.document.addEventListener('visibilitychange', () => {
      if (root.document.visibilityState === 'visible' && S.local.sync) kick(300);
    });
  }
  if (S.local.sync) kick(1500);

  return {
    call,
    /* Keeps a link from the computer (#p=…) until the password is typed. Throws if it isn't one. */
    keepPhoneLink(link) { if (!S.env) store.set(K.pair, parsePhoneLink(link).code); },
    syncNow,
    state,
    onChange(fn) { S.listeners.push(fn); },
    stop() { if (S.timer) { clearTimeout(S.timer); S.timer = null; } },
    _S: S,
  };
}
