#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { classify, describe } from '../relay/risk.mjs';

import { normalize, hostResponse } from './hosts.mjs';

const host = process.argv[2] || 'Claude Code';

async function main() {
  const token = process.env.SNEAKPEEK_TOKEN;
  if (!token) return;
  const request = normalize(host, JSON.parse(readFileSync(0, 'utf8')));
  if (!request) return;
  const { tool, args: raw, cwd, session } = request;
  const eligible = classify(tool, raw, cwd, host) === 'low';
  const input = eligible ? raw : { terminalOnly: true, detail: describe(tool, raw, cwd, host) };
  const base = new URL(process.env.SNEAKPEEK_URL || 'http://127.0.0.1:8787');
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password)
    return;
  const response = await fetch(new URL('/api/requests', base), {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-sneakpeek-token': token },
    body: JSON.stringify({ host, tool, input, cwd, session }),
    signal: AbortSignal.timeout(Number(process.env.SNEAKPEEK_WAIT_MS || 115000)),
  });
  if (!response.ok) return;
  const result = await response.json();
  if (result?.decision === 'defer' && result.by === 'paired-viewer') return 'defer';
  if (result?.decision === 'deny') return 'deny';
  if (result?.decision === 'allow' && eligible && classify(tool, raw, cwd, host) === 'low')
    return 'allow';
}

const decision = await main().catch(() => undefined);
const output = hostResponse(host, decision);
if (output) process.stdout.write(JSON.stringify(output));
