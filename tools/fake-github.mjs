// A stand-in for the GitHub contents API, for tests. Keeps files in memory.
import { createHash } from 'node:crypto';

export function fakeGitHub() {
  const repos = new Map();           // 'owner/repo' → { files: Map, tokens: Map(token → 'rw' | 'ro'), commits: [] }
  const log = [];
  const json = (status, body, headers = {}) => new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
  const header = (opts, name) => {
    const h = (opts && opts.headers) || {};
    const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? h[key] : '';
  };
  async function handler(url, opts = {}) {
    const u = new URL(url);
    const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return json(404, { message: 'Not Found' });
    const repo = repos.get(decodeURIComponent(m[1]) + '/' + decodeURIComponent(m[2]));
    const token = String(header(opts, 'Authorization')).replace(/^Bearer /, '');
    log.push((opts.method || 'GET') + ' ' + u.pathname);
    if (handler.down) throw new TypeError('network down');
    if (!repo) return json(404, { message: 'Not Found' });
    const mode = repo.tokens.get(token);
    if (!mode) return json(401, { message: 'Bad credentials' });
    const rest = m[3] || '';
    if (rest === '') return json(200, { full_name: m[1] + '/' + m[2] });
    const cm = rest.match(/^\/contents\/(.+)$/);
    if (!cm) return json(404, { message: 'Not Found' });
    const path = decodeURIComponent(cm[1]);
    const file = repo.files.get(path);
    if ((opts.method || 'GET') === 'GET') {
      if (!file) return json(404, { message: 'Not Found' });
      const etag = '"' + file.sha + '"';
      if (header(opts, 'If-None-Match') === etag) return json(304, null, { ETag: etag });
      return json(200, { type: 'file', encoding: 'base64', content: file.content.replace(/(.{60})/g, '$1\n'), sha: file.sha, size: file.content.length }, { ETag: etag });
    }
    if (opts.method === 'PUT') {
      if (mode !== 'rw') return json(403, { message: 'Resource not accessible by personal access token' });
      const body = JSON.parse(opts.body);
      if (file && body.sha !== file.sha) return json(409, { message: 'is at ' + file.sha + ' but expected ' + body.sha });
      if (!file && body.sha) return json(422, { message: 'sha was supplied but the file does not exist' });
      const sha = createHash('sha1').update(body.content).digest('hex');
      repo.files.set(path, { content: body.content, sha });
      repo.commits.push(body.message);
      return json(file ? 200 : 201, { content: { sha } });
    }
    return json(405, { message: 'no' });
  }
  return {
    fetch: handler, log,
    add(name, tokens) { repos.set(name, { files: new Map(), tokens: new Map(Object.entries(tokens)), commits: [] }); return repos.get(name); },
    repo(name) { return repos.get(name); },
    /* Answers a Playwright route with the stand-in, CORS headers included. */
    async route(route) {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, PUT, OPTIONS' } });
        return;
      }
      let res;
      try {
        res = await handler(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() || undefined });
      } catch (e) { await route.abort('internetdisconnected'); return; }
      const headers = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag, X-RateLimit-Remaining', 'content-type': 'application/json; charset=utf-8' };
      if (res.headers.get('ETag')) headers.etag = res.headers.get('ETag');
      await route.fulfill({ status: res.status, headers, body: res.status === 304 ? '' : await res.text() });
    },
  };
}

export function memoryStorage() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); }, del: (k) => { m.delete(k); }, _m: m };
}
