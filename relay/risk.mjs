import path from 'node:path';
import { lstatSync } from 'node:fs';

const documents = new Set(['README.md', 'CHANGELOG.md', 'LICENSE']);
const patterns = new Set(['*.md', '*.js', '*.mjs', '*.ts', '*.py', '*.json']);
export const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Render control and direction-changing characters visibly, including line breaks.
export function preview(value, limit = 68) {
  if (typeof value !== 'string') return '';
  const visible = value.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (c) => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'),
  );
  if (visible.length <= limit) return visible;
  const half = Math.floor(limit / 2);
  return (
    visible.slice(0, half) +
    ' … [' +
    (visible.length - 2 * half) +
    ' omitted] … ' +
    visible.slice(-half)
  );
}

export function classify(tool, input, cwd, host = 'Claude Code') {
  if (!isObject(input) || typeof cwd !== 'string') return 'high';
  if (host !== 'Claude Code') {
    // The Codex permission hook covers escalations and external tools.
    const fields = {
      Antigravity: { view_file: 'AbsolutePath', read_file: 'Path' },
      'GitHub Copilot': { view: 'path' },
    };
    const field =
      Object.hasOwn(fields, host) && Object.hasOwn(fields[host], tool) && fields[host][tool];
    if (!field || Object.keys(input).length !== 1) return 'high';
    return classify('Read', { file_path: input[field] }, cwd);
  }
  if (!path.isAbsolute(cwd) || cwd === path.parse(cwd).root) return 'high';
  if (Object.keys(input).length !== 1) return 'high';
  if (tool === 'Glob' && patterns.has(input.pattern)) return 'low';
  if (tool === 'Read' && typeof input.file_path === 'string') {
    const name = path.basename(input.file_path);
    if (documents.has(name) && input.file_path === path.join(cwd, name)) {
      try {
        if (lstatSync(input.file_path).isFile()) return 'low';
      } catch {
        /* Missing or inaccessible files require terminal review. */
      }
    }
  }
  return 'high';
}

export function describe(tool, input, cwd, host = 'Claude Code') {
  if (host !== 'Claude Code' && classify(tool, input, cwd, host) === 'low') {
    return './' + path.basename(input.AbsolutePath || input.Path || input.path);
  }
  if (input.terminalOnly === true) return preview(input.detail, 120) || 'Review in the host.';
  if (tool === 'Read' && classify(tool, input, cwd) === 'low')
    return './' + path.basename(input.file_path);
  if (tool === 'Glob') return preview(input.pattern) || 'File search';
  if (['Bash', 'bash', 'powershell', 'run_command'].includes(tool))
    return preview(input.command || input.CommandLine) || 'Shell command';
  return (
    preview(
      input.file_path ||
        input.notebook_path ||
        input.AbsolutePath ||
        input.Path ||
        input.TargetFile ||
        input.path,
    ) || 'Inspect the arguments in the host.'
  );
}
