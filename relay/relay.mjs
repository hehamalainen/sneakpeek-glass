// SneakPeek Glass relay — zero dependencies (Node 18+).
// Holds agent permission requests until the human decides on the glasses.
//
//   SNEAKPEEK_TOKEN=some-long-secret node relay/relay.mjs
//
// Endpoints (all require ?t=<token> or header x-sneakpeek-token):
//   POST /api/requests              hook -> relay, long-polls until decided/timeout
//   GET  /api/pending               glasses poll the queue
//   POST /api/requests/:id/decision glasses answer {decision: allow|deny|defer}
//   GET  /                          serves the glasses Web App (same origin, no CORS)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classify } from './risk.mjs';

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.SNEAKPEEK_TOKEN;
const HOLD_MS = Number(process.env.SNEAKPEEK_HOLD_MS || 110_000); // keep < hook timeout
const here = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP = path.join(here, '..', 'webapp', 'index.html');

if (!TOKEN || TOKEN.length < 16) {
  console.error('Set SNEAKPEEK_TOKEN (16+ chars). The relay is internet-facing.');
  process.exit(1);
}

/** id -> { req, resolve, timer } */
const pending = new Map();
const log = []; // last decisions, for the glasses "recent" strip

function authed(req, url) {
  const got = Buffer.from(req.headers['x-sneakpeek-token'] || url.searchParams.get('t') || '');
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 256_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function settle(id, decision, by, note) {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  log.unshift({ id, project: p.req.project, tool: p.req.tool, decision, by, at: Date.now() });
  log.length = Math.min(log.length, 20);
  p.resolve({ decision, by, note });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, await readFile(WEBAPP, 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (!authed(req, url)) return send(res, 401, { error: 'unauthorized' });

    // Hook -> relay. Long-poll: the HTTP response IS the decision.
    if (req.method === 'POST' && url.pathname === '/api/requests') {
      const body = await readJson(req);
      const risk = classify(body.tool, body.input, body.cwd);
      const id = randomUUID().slice(0, 8);
      const item = {
        id,
        project: body.project || path.basename(body.cwd || '') || 'agent',
        agent: body.agent || 'claude-code',
        tool: body.tool || 'unknown',
        summary: body.summary || '',
        intent: body.intent || '',
        risk: risk.level,
        riskReasons: risk.reasons,
        createdAt: Date.now(),
      };
      const decided = new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, 'defer', 'timeout'), HOLD_MS);
        pending.set(id, { req: item, resolve, timer });
      });
      req.on('close', () => { if (!res.writableEnded) settle(id, 'defer', 'hook-gone'); });
      console.log(`[req ${id}] ${item.project} ${item.tool} risk=${item.risk} :: ${item.summary.slice(0, 80)}`);
      const result = await decided;
      console.log(`[req ${id}] -> ${result.decision} (${result.by})`);
      return send(res, 200, { id, risk: item.risk, ...result });
    }

    if (req.method === 'GET' && url.pathname === '/api/pending') {
      const items = [...pending.values()].map((p) => p.req).sort((a, b) => a.createdAt - b.createdAt);
      return send(res, 200, { now: Date.now(), items, recent: log.slice(0, 5) });
    }

    const m = url.pathname.match(/^\/api\/requests\/([\w-]+)\/decision$/);
    if (req.method === 'POST' && m) {
      const { decision } = await readJson(req);
      const p = pending.get(m[1]);
      if (!p) return send(res, 404, { error: 'not pending' });
      if (!['allow', 'deny', 'defer'].includes(decision)) return send(res, 400, { error: 'bad decision' });
      // Server-side guardrail: high-risk actions can never be approved from a glance.
      if (decision === 'allow' && p.req.risk === 'high') {
        return send(res, 403, { error: 'high risk: approve at the terminal' });
      }
      settle(m[1], decision, 'glasses');
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 400, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => console.log(`SneakPeek Glass relay on http://localhost:${PORT}`));
