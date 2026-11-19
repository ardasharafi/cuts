// The ledger engine against a stand-in GitHub: setup, lock, sync between two computers
// and an iPhone, merges, deletions, password change, recovery, wrong keys.
import assert from 'node:assert/strict';
import { fakeGitHub, memoryStorage as memory } from './fake-github.mjs';
import { createEngine, parseSyncKey, parsePhoneLink } from '../docs/assets/js/engine.js';

const gh = fakeGitHub();
const TOKEN = 'github_pat_' + 'A1b2C3d4E5'.repeat(8);
const RO = 'github_pat_' + 'readonly00'.repeat(8);
gh.add('ardasharafi/cuts-ledger', { [TOKEN]: 'rw', [RO]: 'ro' });
const KEY = 'ardasharafi/cuts-ledger#' + TOKEN;
let clock = 1_800_000_000_000;
const now = () => (clock += 7);
const mk = (platform, storage = memory()) => ({ storage, e: createEngine({ storage, platform, fetch: gh.fetch, apiBase: 'https://api.github.test', now, kdfIter: 1500, version: 'test' }) });
const put = (id, b) => ({ op: 'put', c: 'rows', id, b });
const rowsOf = async (e) => Object.fromEntries((await e.call('GET', '/api/data')).colls.rows.map((r) => [r.id, r.b]));
const rejects = async (p, re) => { let err = null; try { await p; } catch (e) { err = e; } assert.ok(err, 'expected a failure'); if (re) assert.match(err.message, re); return err; };
let n = 0; const ok = (c, m) => { assert.ok(c, m); n += 1; }; const eq = (a, b, m) => { assert.deepEqual(a, b, m); n += 1; };

// ---- sync key parsing
eq(parseSyncKey(KEY), { owner: 'ardasharafi', repo: 'cuts-ledger', token: TOKEN });
eq(parseSyncKey(' https://github.com/ardasharafi/cuts-ledger.git # ' + TOKEN + ' ').repo, 'cuts-ledger');
assert.throws(() => parseSyncKey('nonsense')); n += 1;
assert.throws(() => parseSyncKey('a/b#short')); n += 1;

// ---- computer A: a new ledger
const A = mk('windows');
eq((await A.e.call('GET', '/api/state')).initialized, false);
const setup = await A.e.call('POST', '/api/setup', { password: 'correct horse' });
ok(/^([A-Z2-7]{4}-){5}[A-Z2-7]{4}$/.test(setup.recoveryCode), 'recovery code shape');
let st = await A.e.call('GET', '/api/state');
eq([st.initialized, st.locked, st.sync.state, st.platform], [true, false, 'off', 'windows']);
await rejects(A.e.call('POST', '/api/setup', { password: 'x' }), /already set up/);
await A.e.call('POST', '/api/mutate', { ops: [put('r1', { name: 'HaloNine', total: 82219, cur: 'EUR', period: '2026-07', invoiceNo: '100231', pct: '10' }), { op: 'put', c: 'settings', id: 'manager', b: { value: 'Morrow' } }] });
eq((await rowsOf(A.e)).r1.total, 82219);
ok(!A.storage.get('cuts.vault').includes('HaloNine'), 'the saved file is locked');

// ---- lock and unlock
st = await A.e.call('POST', '/api/lock');
eq(st.locked, true);
await rejects(A.e.call('GET', '/api/data'), /locked/);
const wrong = await rejects(A.e.call('POST', '/api/unlock', { password: 'nope' }), /password isn.t right/);
eq(wrong.data.bad, 'password');
st = await A.e.call('POST', '/api/unlock', { password: 'correct horse' });
eq(st.locked, false);
eq((await rowsOf(A.e)).r1.name, 'HaloNine');

// ---- a fresh engine over the same storage (the app was closed and opened again)
const A2 = mk('windows', A.storage);
st = await A2.e.call('GET', '/api/state');
eq([st.initialized, st.locked], [true, true]);
await A2.e.call('POST', '/api/unlock', { password: 'correct horse' });
eq((await rowsOf(A2.e)).r1.pct, '10');
A2.e.stop();

// ---- connect to GitHub: a read-only key is refused and nothing is kept
const refused = await rejects(A.e.call('POST', '/api/sync/connect', { key: 'ardasharafi/cuts-ledger#' + RO }), /refused the change/);
ok(refused, 'read-only key refused');
eq((await A.e.call('GET', '/api/state')).sync.state, 'off');
await rejects(A.e.call('POST', '/api/sync/connect', { key: 'ardasharafi/nope#' + TOKEN }), /find the repository/);
await rejects(A.e.call('POST', '/api/sync/connect', { key: 'ardasharafi/cuts-ledger#' + 'github_pat_' + 'zzzzzzzzzz'.repeat(8) }), /invalid or has expired/);
st = await A.e.call('POST', '/api/sync/connect', { key: KEY });
eq([st.sync.state, st.sync.repo, st.sync.pending], ['ok', 'ardasharafi/cuts-ledger', false]);
const remote = () => Buffer.from(gh.repo('ardasharafi/cuts-ledger').files.get('cuts-ledger.json').content, 'base64').toString();
ok(JSON.parse(remote()).format === 'cuts-vault', 'ledger is on GitHub');
ok(!remote().includes('HaloNine') && !remote().includes('Morrow') && !remote().includes(TOKEN), 'nothing readable on GitHub');
eq(gh.repo('ardasharafi/cuts-ledger').commits[0], 'Create ledger');
eq((await A.e.call('POST', '/api/sync/key', { password: 'correct horse' })).key, KEY);
await rejects(A.e.call('POST', '/api/sync/key', { password: 'bad' }), /password/);

// ---- computer B joins with the key and the password
const B = mk('windows');
await rejects(B.e.call('POST', '/api/join', { key: KEY, password: 'wrong one' }), /not the password of the ledger/);
st = await B.e.call('POST', '/api/join', { key: KEY, password: 'correct horse' });
eq([st.initialized, st.locked, st.sync.state], [true, false, 'ok']);
eq(Object.keys(await rowsOf(B.e)), ['r1']);
ok(A.e.state().device !== B.e.state().device, 'two devices');

// ---- B adds a row, A gets it
await B.e.call('POST', '/api/mutate', { ops: [put('r2', { name: 'Aster', total: 20038, cur: 'EUR', period: '2026-07', invoiceNo: '100232', pct: '' })] });
await B.e.call('POST', '/api/sync/now');
await A.e.call('POST', '/api/sync/now');
eq(Object.keys(await rowsOf(A.e)).sort(), ['r1', 'r2']);

// ---- both change things while apart; the newest write of each record wins
await A.e.call('POST', '/api/mutate', { ops: [put('r1', { name: 'HaloNine', total: 82219, cur: 'EUR', period: '2026-07', invoiceNo: '100231', pct: '12' })] });
await B.e.call('POST', '/api/mutate', { ops: [put('r1', { name: 'HaloNine', total: 82219, cur: 'EUR', period: '2026-07', invoiceNo: '100231', pct: '15' }), put('r3', { name: 'Teal', total: 266284, cur: 'EUR', period: '2026-07', invoiceNo: '100233', pct: '5' })] });
await A.e.call('POST', '/api/mutate', { ops: [put('r2', { name: 'Aster', total: 20038, cur: 'EUR', period: '2026-07', invoiceNo: '100232', pct: '7' })] });
await A.e.call('POST', '/api/sync/now');
await B.e.call('POST', '/api/sync/now');
await A.e.call('POST', '/api/sync/now');
const ra = await rowsOf(A.e); const rb = await rowsOf(B.e);
eq(ra, rb);
eq([ra.r1.pct, ra.r2.pct, ra.r3.pct], ['15', '7', '5']);

// ---- a deletion travels
await A.e.call('POST', '/api/mutate', { ops: [{ op: 'del', c: 'rows', id: 'r2' }] });
await A.e.call('POST', '/api/sync/now');
await B.e.call('POST', '/api/sync/now');
eq(Object.keys(await rowsOf(B.e)).sort(), ['r1', 'r3']);
// undo: the row comes back with a newer write
await A.e.call('POST', '/api/mutate', { ops: [put('r2', { name: 'Aster', total: 20038, cur: 'EUR', period: '2026-07', invoiceNo: '100232', pct: '7' })] });
await A.e.call('POST', '/api/sync/now');
await B.e.call('POST', '/api/sync/now');
eq(Object.keys(await rowsOf(B.e)).sort(), ['r1', 'r2', 'r3']);

// ---- offline: changes wait, then go up
gh.fetch.down = true;
await A.e.call('POST', '/api/mutate', { ops: [put('r4', { name: 'Pine', total: 268035, cur: 'EUR', period: '2026-07', invoiceNo: '100234', pct: '3' })] });
st = await A.e.call('POST', '/api/sync/now');
eq([st.sync.state, st.sync.pending], ['offline', true]);
gh.fetch.down = false;
st = await A.e.call('POST', '/api/sync/now');
eq([st.sync.state, st.sync.pending], ['ok', false]);
await B.e.call('POST', '/api/sync/now');
eq((await rowsOf(B.e)).r4.name, 'Pine');

// ---- the iPhone: the link from the computer plus the password
const link = (await A.e.call('GET', '/api/phone')).url;
ok(link.startsWith('https://ardasharafi.github.io/cuts/#p='), 'phone link ' + link.slice(0, 50));
ok(!link.includes(TOKEN) && link.length < 600, 'link is locked and short enough for a QR code: ' + link.length);
eq(parsePhoneLink(link).keyId, JSON.parse(A.storage.get('cuts.vault')).keyId);
const P = mk('iphone');
assert.throws(() => P.e.keepPhoneLink('https://example.com/#p=abc')); n += 1;
P.e.keepPhoneLink(link);
st = await P.e.call('GET', '/api/state');
eq([st.initialized, st.pairing, st.phone, st.platform], [false, true, true, 'iphone']);
await rejects(P.e.call('POST', '/api/pair', { password: 'guess' }), /password isn.t right/);
st = await P.e.call('POST', '/api/pair', { password: 'correct horse' });
eq([st.initialized, st.locked, st.sync.state, st.pairing], [true, false, 'ok', false]);
eq(Object.keys(await rowsOf(P.e)).sort(), ['r1', 'r2', 'r3', 'r4']);
ok(P.e.state().device.startsWith('iphone-'), 'phone device id');
ok(!P.storage.get('cuts.local').includes(TOKEN), 'the key is sealed on the phone');
// the phone changes a share; the computers get it
await P.e.call('POST', '/api/mutate', { ops: [put('r3', { name: 'Teal', total: 266284, cur: 'EUR', period: '2026-07', invoiceNo: '100233', pct: '17' })] });
await P.e.call('POST', '/api/sync/now');
await A.e.call('POST', '/api/sync/now');
eq((await rowsOf(A.e)).r3.pct, '17');
// the pasted-link way
const P2 = mk('iphone');
st = await P2.e.call('POST', '/api/pairlink', { link });
eq(st.pairing, true);
st = await P2.e.call('POST', '/api/pair/forget');
eq(st.pairing, false);
await rejects(P2.e.call('POST', '/api/pairlink', { link: 'hello' }), /isn.t a Cuts link/);
// the sync-key way on a phone
st = await P2.e.call('POST', '/api/join', { key: KEY, password: 'correct horse' });
eq(st.sync.state, 'ok');

// ---- changing the password reaches the other devices
await A.e.call('POST', '/api/password', { current: 'correct horse', next: 'new pass 2' });
await rejects(A.e.call('POST', '/api/password', { current: 'correct horse', next: 'x' }), /password isn.t right/);
await A.e.call('POST', '/api/sync/now');
await B.e.call('POST', '/api/sync/now');
await B.e.call('POST', '/api/lock');
await rejects(B.e.call('POST', '/api/unlock', { password: 'correct horse' }), /password isn.t right/);
st = await B.e.call('POST', '/api/unlock', { password: 'new pass 2' });
eq(st.locked, false);
eq(Object.keys(await rowsOf(B.e)).length, 4);

// ---- the recovery code resets a forgotten password
await A.e.call('POST', '/api/lock');
await rejects(A.e.call('POST', '/api/recover', { code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', next: 'z' }), /recovery code isn.t right/);
st = await A.e.call('POST', '/api/recover', { code: setup.recoveryCode.toLowerCase().replace(/-/g, ' '), next: 'third pass' });
eq(st.locked, false);
eq(Object.keys(await rowsOf(A.e)).length, 4);
const fresh = await A.e.call('POST', '/api/recovery', { password: 'third pass' });
ok(fresh.recoveryCode !== setup.recoveryCode, 'a new recovery code');
await A.e.call('POST', '/api/lock');
await rejects(A.e.call('POST', '/api/recover', { code: setup.recoveryCode, next: 'z' }), /recovery code isn.t right/);
await A.e.call('POST', '/api/unlock', { password: 'third pass' });

// ---- too many wrong tries locks for a while
const C = mk('windows', A.storage);
for (let i = 0; i < 5; i += 1) await rejects(C.e.call('POST', '/api/unlock', { password: 'bad' + i }), /password isn.t right/);
const locked = await rejects(C.e.call('POST', '/api/unlock', { password: 'third pass' }), /Too many wrong tries/);
ok(locked.data.lockUntil > clock, 'lockUntil is set');
clock += 16 * 60000;
st = await C.e.call('POST', '/api/unlock', { password: 'third pass' });
eq(st.locked, false);
C.e.stop();

// ---- a repository that already has another ledger is refused
gh.add('ardasharafi/other', { [TOKEN]: 'rw' });
const D = mk('windows');
await D.e.call('POST', '/api/setup', { password: 'd' });
await D.e.call('POST', '/api/sync/connect', { key: 'ardasharafi/other#' + TOKEN });
await rejects(A.e.call('POST', '/api/sync/connect', { key: 'ardasharafi/other#' + TOKEN }), /already holds another Cuts ledger/);
eq((await A.e.call('GET', '/api/state')).sync.repo, 'ardasharafi/cuts-ledger');
await rejects(D.e.call('POST', '/api/join', { key: KEY, password: 'd' }), /already set up/);

// ---- stop syncing: the computer keeps its ledger, the iPhone gives it up
st = await A.e.call('POST', '/api/sync/disconnect');
eq([st.sync.state, st.initialized, st.locked], ['off', true, false]);
eq(Object.keys(await rowsOf(A.e)).length, 4);
st = await P.e.call('POST', '/api/sync/disconnect');
eq([st.sync.state, st.initialized], ['off', false]);
eq(P.storage.get('cuts.vault'), null);

[A, B, P, P2, D].forEach((x) => x.e.stop());
console.log('engine: all', n, 'checks passed;', gh.log.length, 'requests to the stand-in GitHub');
