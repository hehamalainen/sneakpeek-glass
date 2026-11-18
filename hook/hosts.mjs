import { isObject } from '../relay/risk.mjs';

export const hosts = ['Claude Code', 'Codex', 'Antigravity', 'GitHub Copilot'];

export function normalize(host, ev) {
  if (!isObject(ev)) return;
  let tool, args, session, cwd;
  if (host === 'Antigravity') {
    if (!Array.isArray(ev.workspacePaths) || ev.workspacePaths.length !== 1) return;
    ({ name: tool, args } = ev.toolCall || {});
    cwd = ev.workspacePaths[0];
    session = ev.conversationId;
  } else if (host === 'GitHub Copilot') {
    ({ toolName: tool, toolArgs: args, sessionId: session, cwd } = ev);
    if (typeof args === 'string') args = JSON.parse(args);
  } else if (host === 'Claude Code' || host === 'Codex') {
    if (ev.hook_event_name !== 'PermissionRequest') return;
    ({ tool_name: tool, tool_input: args, session_id: session, cwd } = ev);
  } else return;
  if (!isObject(args) || ![cwd, tool, session].every((s) => typeof s === 'string' && s.length))
    return;
  return { host, tool, args, session, cwd };
}

export function hostResponse(host, decision) {
  const message = 'The operator denied this request on SneakPeek Glass.';
  if (host === 'Antigravity') {
    if (decision === 'defer') return { decision: 'force_ask' };
    if (decision === 'allow') return { decision: 'auto_approve' };
    if (decision === 'deny') return { decision: 'deny', reason: message };
    // On failure or timeout, delegate to normal Antigravity policy.
    return { decision: 'allow' };
  }
  if (host === 'GitHub Copilot') {
    if (decision === 'defer')
      return {
        permissionDecision: 'ask',
        permissionDecisionReason: 'Review requested on the host.',
      };
    if (decision === 'deny')
      return { permissionDecision: 'deny', permissionDecisionReason: message };
    return;
  }
  if (decision === 'deny' || decision === 'allow') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: decision === 'deny' ? { behavior: 'deny', message } : { behavior: 'allow' },
      },
    };
  }
}
