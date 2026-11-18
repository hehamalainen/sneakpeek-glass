import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { classify, describe, isObject, preview } from './risk.mjs';

const port = Number(process.env.PORT ?? 8787);
const holdMs = Number(process.env.SNEAKPEEK_HOLD_MS || 110000);
const submitToken = process.env.SNEAKPEEK_TOKEN;
let pairCode = process.env.SNEAKPEEK_PAIR_CODE;
if (
  !submitToken ||
  !pairCode ||
  [submitToken, pairCode].some((s) => s.length < 24) ||
  submitToken === pairCode
) {
  throw new Error(
    'Set distinct SNEAKPEEK_TOKEN and SNEAKPEEK_PAIR_CODE values of at least 24 characters.',
  );
}
if (!Number.isInteger(holdMs) || holdMs < 1 || holdMs > 110000)
  throw new Error('Invalid hold time');
const pairDeadline = Date.now() + 600000;
const viewerToken = randomBytes(32).toString('hex');
const pending = new Map();
const recent = [];
let lastPoll = 0;
const viewerLeaseMs = 10000;
const html = await readFile(new URL('../webapp/index.html', import.meta.url));

function matches(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(res, status, body, type = 'application/json') {
  if (res.destroyed) return;
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw new Error();
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isObject(body)) throw new Error();
  return body;
}
function settle(id, decision, by) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  const { tool, project, session } = entry.item;
  const record = { id, tool, project, session, decision, by, at: new Date().toISOString() };
  recent.unshift(record);
  if (recent.length > 5) recent.pop();
  console.log(JSON.stringify(record));
  send(entry.res, 200, { id, decision });
}
const server = http.createServer(async (req, res) => {
  try {
    const route = req.url;
    if (req.method === 'GET' && ['/', '/index.html'].includes(route))
      return send(res, 200, html, 'text/html; charset=utf-8');
    if (req.method === 'GET' && route === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'POST' && route === '/api/pair') {
      if (Date.now() >= pairDeadline || !matches(req.headers['x-sneakpeek-token'], pairCode))
        return send(res, 401, {});
      pairCode = undefined;
      return send(res, 200, { token: viewerToken });
    }
    const submission = req.method === 'POST' && route === '/api/requests';
    if (!matches(req.headers['x-sneakpeek-token'], submission ? submitToken : viewerToken))
      return send(res, 401, {});
    if (submission) {
      const { tool, input, cwd, session } = await readJson(req);
      if (
        !isObject(input) ||
        typeof cwd !== 'string' ||
        !path.isAbsolute(cwd) ||
        typeof session !== 'string' ||
        !session ||
        typeof tool !== 'string' ||
        !tool
      )
        return send(res, 400, {});
      const sessionTag = createHash('sha256').update(session).digest('hex').slice(0, 8);
      if (
        pending.size >= 32 ||
        [...pending.values()].filter((p) => p.item.session === sessionTag).length >= 4
      )
        return send(res, 429, {});
      if (Date.now() - lastPoll > viewerLeaseMs) return send(res, 200, { decision: 'defer' });
      const id = randomUUID();
      const item = {
        id,
        project: preview(path.basename(cwd), 24),
        session: sessionTag,
        tool: preview(tool, 22),
        risk: classify(tool, input, cwd),
        summary: describe(tool, input, cwd),
      };
      const timer = setTimeout(() => settle(id, 'defer', 'timeout'), holdMs);
      pending.set(id, { res, item, timer });
      res.once('close', () => settle(id, 'defer', 'disconnect'));
      return;
    }
    if (req.method === 'GET' && route === '/api/pending') {
      lastPoll = Date.now();
      return send(res, 200, { items: [...pending.values()].map((p) => p.item), recent });
    }
    const match = route.match(/^\/api\/requests\/([a-f0-9-]{36})\/decision$/);
    if (req.method === 'POST' && match) {
      const { decision } = await readJson(req);
      const entry = pending.get(match[1]);
      if (!entry) return send(res, 404, {});
      if (!['allow', 'deny', 'defer'].includes(decision)) return send(res, 400, {});
      if (decision === 'allow' && entry.item.risk !== 'low') return send(res, 403, {});
      settle(match[1], decision, 'paired-viewer');
      return send(res, 200, { ok: true });
    }
    send(res, 404, {});
  } catch {
    send(res, 400, { error: 'Invalid request' });
  }
});
setInterval(() => {
  if (Date.now() - lastPoll > viewerLeaseMs) {
    for (const id of pending.keys()) settle(id, 'defer', 'viewer-offline');
  }
}, 1000).unref();
server.listen(port, '127.0.0.1', () =>
  console.log('Listening on http://127.0.0.1:' + server.address().port),
);
