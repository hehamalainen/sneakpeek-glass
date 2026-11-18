// Risk tiers decide what the glasses are allowed to do.
//   low    -> approve with one confirm
//   medium -> approve with one confirm (default for anything that reached a permission prompt)
//   high   -> deny or defer only; approval must happen at the terminal
// Tune these rules to your own repos. Rules are deliberately conservative.

const HIGH_BASH = [
  [/\brm\s+(-\w*r\w*f|-\w*f\w*r)\b/, 'recursive force delete'],
  [/\bgit\s+push\b.*(--force|-f\b|--force-with-lease)/, 'force push'],
  [/\bgit\s+reset\s+--hard\b/, 'hard reset'],
  [/\bgit\s+clean\s+-\w*f/, 'git clean'],
  [/\bgit\s+push\b.*\b(main|master|prod|production|release)\b/, 'push to protected branch'],
  [/\bsudo\b/, 'sudo'],
  [/(curl|wget)[^|]*\|\s*(ba|z)?sh\b/, 'pipe to shell'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'destructive SQL'],
  [/\bkubectl\s+(delete|apply|scale)\b/, 'kubectl mutate'],
  [/\bterraform\s+(apply|destroy)\b/, 'terraform apply/destroy'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, 'publish package'],
  [/\bgh\s+(repo\s+delete|release\s+create|pr\s+merge)\b/, 'gh irreversible'],
  [/\bchmod\s+-R\b|\bchown\s+-R\b/, 'recursive permission change'],
  [/>\s*\/(etc|usr|bin|System)\b/, 'write to system path'],
];

const SENSITIVE_PATH = /(^|\/)(\.env(\..*)?|\.ssh\/|\.aws\/|id_rsa|credentials|secrets?\.)|\.pem$|\.key$/i;

export function classify(tool = '', input = {}, cwd = '') {
  const reasons = [];
  const t = String(tool);

  if (t === 'Bash') {
    const cmd = String(input.command || '');
    for (const [re, why] of HIGH_BASH) if (re.test(cmd)) reasons.push(why);
    if (SENSITIVE_PATH.test(cmd)) reasons.push('touches secrets');
    return { level: reasons.length ? 'high' : 'medium', reasons };
  }

  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(t)) {
    const p = String(input.file_path || input.notebook_path || '');
    if (SENSITIVE_PATH.test(p)) reasons.push('secrets file');
    if (cwd && p.startsWith('/') && !p.startsWith(cwd)) reasons.push('outside project');
    return { level: reasons.length ? 'high' : 'medium', reasons };
  }

  if (t.startsWith('mcp__')) return { level: 'medium', reasons: ['external tool'] };
  if (['WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep'].includes(t)) return { level: 'low', reasons };
  return { level: 'medium', reasons };
}
