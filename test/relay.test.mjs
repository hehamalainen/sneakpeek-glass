import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classify } from '../relay/risk.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const secret = () => randomBytes(24).toString('hex');
const cwd = process.cwd();
const sample = (tool_name = 'Glob', tool_input = { pattern: '*.md' }) => ({
  cwd,
  session_id: 'demo',
  hook_event_name: 'PermissionRequest',
  tool_name,
  tool_input,
});

async function relay(t, hold = 8000) {
  const submit = secret(),
    code = secret();
  const server = spawn(process.execPath, ['relay/relay.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      SNEAKPEEK_TOKEN: submit,
      SNEAKPEEK_PAIR_CODE: code,
      PORT: '0',
      SNEAKPEEK_HOLD_MS: String(hold),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => server.kill());
  const [line] = await once(server.stdout, 'data');
  const url = String(line).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const api = (route, token, body, signal) =>
    fetch(url + route, {
      method: body ? 'POST' : 'GET',
      signal,
      headers: { 'x-sneakpeek-token': token, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
  const paired = await api('/api/pair', code, {});
  assert.equal(paired.status, 200);
  const { token } = await paired.json();
  const queue = async () => (await (await api('/api/pending', token)).json()).items;
  const waitFor = async (size) => {
    for (let i = 0; i < 200; i++) {
      const items = await queue();
      if (items.length === size) return items;
      await delay(10);
    }
    assert.fail('Expected queue length ' + size);
  };
  const decide = (id, decision) => api('/api/requests/' + id + '/decision', token, { decision });
  return { url, submit, code, token, api, queue, waitFor, decide, server };
}
function hook(event, url, token, timeout = 4000) {
  const child = spawn(process.execPath, ['hook/sneakpeek-hook.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      SNEAKPEEK_URL: url,
      SNEAKPEEK_TOKEN: token,
      SNEAKPEEK_WAIT_MS: String(timeout),
    },
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (s) => (stdout += s));
  child.stderr.on('data', (s) => (stderr += s));
  const done = once(child, 'close').then(([code]) => {
    assert.equal(code, 0, stderr);
    return stdout;
  });
  child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
  return done;
}
function decision(stdout) {
  const { hookSpecificOutput } = JSON.parse(stdout);
  assert.equal(hookSpecificOutput.hookEventName, 'PermissionRequest');
  return hookSpecificOutput.decision;
}
test('paired reviewer and submitter have disjoint permissions', async (t) => {
  const r = await relay(t);
  assert.equal((await r.api('/api/pair', r.code, {})).status, 401);
  assert.equal((await r.api('/api/pending', r.submit)).status, 401);
  assert.equal((await r.api('/api/pending?t=' + r.token, '')).status, 401);
  assert.equal((await r.api('/api/requests', r.token, {})).status, 401);
  assert.equal((await r.api('/api/requests', r.submit, {})).status, 400);
  assert.equal(await hook(sample(), r.url, r.submit), ''); // no active viewer
});
test('approved file search resolves exactly once', async (t) => {
  const r = await relay(t);
  await r.queue();
  const output = hook(sample(), r.url, r.submit);
  const [item] = await r.waitFor(1);
  assert.equal(item.summary, '*.md');
  assert.equal(item.risk, 'low');
  const results = await Promise.all([r.decide(item.id, 'allow'), r.decide(item.id, 'allow')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);
  assert.deepEqual(decision(await output), { behavior: 'allow' });
});
test('shell requests show both ends and can only be denied or deferred', async (t) => {
  const r = await relay(t);
  await r.queue();
  const output = hook(
    sample('Bash', {
      command: 'echo ' + 'x'.repeat(250) + ' && echo tail',
      description: 'Harmless',
    }),
    r.url,
    r.submit,
  );
  const [item] = await r.waitFor(1);
  assert.match(item.summary, /^echo .*omitted.*echo tail$/);
  assert.equal(item.risk, 'high');
  assert.equal((await r.decide(item.id, 'allow')).status, 403);
  assert.equal((await r.decide(item.id, 'deny')).status, 200);
  assert.equal(decision(await output).behavior, 'deny');
});
test('concurrent sessions stay independent and terminal returns silence', async (t) => {
  const r = await relay(t);
  await r.queue();
  const a = hook(sample(), r.url, r.submit);
  const [first] = await r.waitFor(1);
  const b = hook({ ...sample(), session_id: 'other' }, r.url, r.submit);
  const [, second] = await r.waitFor(2);
  assert.notEqual(first.session, second.session);
  await r.decide(second.id, 'deny');
  await r.decide(first.id, 'defer');
  assert.equal(await a, '');
  assert.equal(decision(await b).behavior, 'deny');
});
test('invalid events, offline relay, timeout and invalid credentials fall back', async (t) => {
  const r = await relay(t, 150);
  await r.queue();
  for (const event of [
    '{',
    'null',
    { ...sample(), hook_event_name: 'PreToolUse' },
    sample('Read', null),
    sample(),
  ]) {
    assert.equal(await hook(event, r.url, r.submit), '');
  }
  assert.equal(await hook(sample(), r.url, secret()), '');
  const stopped = once(r.server, 'exit');
  r.server.kill();
  await stopped;
  assert.equal(await hook(sample(), r.url, r.submit), '');
});
test('per-session cap and disconnect cleanup', async (t) => {
  const r = await relay(t);
  await r.queue();
  const payload = { tool: 'Glob', cwd, input: { pattern: '*.ts' }, session: 'cap' };
  const cancel = new AbortController();
  const pending = Array.from({ length: 4 }, () =>
    r.api('/api/requests', r.submit, payload, cancel.signal).catch(() => {}),
  );
  await r.waitFor(4);
  assert.equal((await r.api('/api/requests', r.submit, payload)).status, 429);
  cancel.abort();
  await Promise.all(pending);
  await r.waitFor(0);
});
test('hook rechecks policy independently of the response', async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    res.end(JSON.stringify({ decision: 'allow' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  assert.equal(
    await hook(
      sample('Write', { file_path: 'example', content: 'hello' }),
      'http://127.0.0.1:' + server.address().port,
      secret(),
    ),
    '',
  );
});
test('only exact file lists and ordinary project documents qualify', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'glass-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const readme = path.join(dir, 'README.md');
  await writeFile(readme, 'hello');
  await symlink(readme, path.join(dir, 'LICENSE'));
  assert.equal(classify('Read', { file_path: readme }, dir), 'low');
  for (const [tool, input] of [
    ['Read', { file_path: path.join(dir, 'LICENSE') }],
    ['Read', { file_path: readme, limit: 1 }],
    ['Read', { file_path: path.join(dir, '.env') }],
    ['Read', { file_path: dir + '/../README.md' }],
    ['Read', { file_path: dir + '-other/README.md' }],
    ['Glob', { pattern: '*.md', path: '/tmp' }],
    ['Glob', { pattern: '**/*' }],
    ['Write', {}],
    ['Bash', { command: 'pwd' }],
    ['mcp__demo', {}],
  ])
    assert.equal(classify(tool, input, dir), 'high');
});
