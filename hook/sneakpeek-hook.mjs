#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { classify, isObject, describe } from '../relay/risk.mjs';

async function main() {
  const token = process.env.SNEAKPEEK_TOKEN;
  if (!token) return;
  const ev = JSON.parse(readFileSync(0, 'utf8'));
  if (
    ev?.hook_event_name !== 'PermissionRequest' ||
    !isObject(ev.tool_input) ||
    typeof ev.cwd !== 'string' ||
    typeof ev.session_id !== 'string' ||
    !ev.session_id ||
    typeof ev.tool_name !== 'string' ||
    !ev.tool_name
  )
    return;

  // Keep full write contents, transcripts, and unbounded arguments off the wire.
  const { tool_name: tool, tool_input: raw, cwd, session_id: session } = ev;
  const eligible = classify(tool, raw, cwd) === 'low';
  const input = eligible ? raw : { terminalOnly: true, detail: describe(tool, raw, cwd) };
  const base = new URL(process.env.SNEAKPEEK_URL || 'http://127.0.0.1:8787');
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password)
    return;
  const response = await fetch(new URL('/api/requests', base), {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-sneakpeek-token': token },
    body: JSON.stringify({ tool, input, cwd, session }),
    signal: AbortSignal.timeout(Number(process.env.SNEAKPEEK_WAIT_MS || 115000)),
  });
  if (!response.ok) return;
  const result = await response.json();
  let decision;
  if (result?.decision === 'deny')
    decision = {
      behavior: 'deny',
      message: 'The operator denied this request on SneakPeek Glass.',
    };
  if (result?.decision === 'allow' && eligible && classify(tool, raw, cwd) === 'low')
    decision = { behavior: 'allow' };
  if (decision)
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }),
    );
}

// Empty stdout leaves the normal permission flow in charge.
main().catch(() => {});
