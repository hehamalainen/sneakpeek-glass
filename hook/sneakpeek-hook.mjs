#!/usr/bin/env node
// Claude Code PermissionRequest hook -> SneakPeek Glass relay.
// Fires only when Claude Code would show you a permission dialog.
// Fail-safe: any error, timeout or "defer" prints nothing -> the normal terminal dialog appears.
//
// Env: SNEAKPEEK_URL (e.g. https://sneakpeek.example.com), SNEAKPEEK_TOKEN

import { readFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import path from 'node:path';

const URL_BASE = process.env.SNEAKPEEK_URL;
const TOKEN = process.env.SNEAKPEEK_TOKEN;
const WAIT_MS = Number(process.env.SNEAKPEEK_WAIT_MS || 115_000);

function quietExit() { process.exit(0); } // no output = Claude Code shows its usual dialog

function summarize(tool, input = {}) {
  switch (tool) {
    case 'Bash': return String(input.command || '').replace(/\s+/g, ' ').trim();
    case 'Write': return `write ${path.basename(input.file_path || '')} (${String(input.content || '').split('\n').length} lines)`;
    case 'Edit': return `edit ${path.basename(input.file_path || '')}: "${String(input.old_string || '').slice(0, 40)}" → "${String(input.new_string || '').slice(0, 40)}"`;
    case 'MultiEdit': return `edit ${path.basename(input.file_path || '')} (${(input.edits || []).length} changes)`;
    case 'WebFetch': return `fetch ${input.url || ''}`;
    default: return JSON.stringify(input).slice(0, 160);
  }
}

// "Where is it heading?" — last assistant text from the transcript tail (best effort).
function lastIntent(transcriptPath) {
  try {
    const fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, 64_000);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString('utf8').trim().split('\n').reverse();
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        const content = e?.message?.role === 'assistant' ? e.message.content : null;
        const text = Array.isArray(content) ? content.find((c) => c.type === 'text')?.text : null;
        if (text) return text.replace(/\s+/g, ' ').trim().slice(0, 180);
      } catch { /* partial line */ }
    }
  } catch { /* no transcript */ }
  return '';
}

async function main() {
  if (!URL_BASE || !TOKEN) quietExit();
  let ev;
  try { ev = JSON.parse(readFileSync(0, 'utf8')); } catch { quietExit(); }

  const payload = {
    agent: 'claude-code',
    session: ev.session_id,
    cwd: ev.cwd,
    project: path.basename(ev.cwd || ''),
    tool: ev.tool_name,
    input: ev.tool_input,
    summary: summarize(ev.tool_name, ev.tool_input),
    intent: ev.transcript_path ? lastIntent(ev.transcript_path) : '',
  };

  let result;
  try {
    const r = await fetch(`${URL_BASE.replace(/\/$/, '')}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sneakpeek-token': TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (!r.ok) quietExit();
    result = await r.json();
  } catch { quietExit(); }

  if (result.decision === 'allow') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    }));
  } else if (result.decision === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied by operator via SneakPeek Glass. Stop and propose a safer alternative.' },
      },
    }));
  }
  // defer / timeout -> no output -> terminal dialog
  process.exit(0);
}

main();
