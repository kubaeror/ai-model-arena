import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { z } from 'zod/v4';
import { validateArgs } from './util.js';
import { safeResolve, sandboxEnv } from '../sandbox/sandbox.js';
import { isShellCommandAllowed } from '../sandbox/shell-policy.js';
import { walkFiles } from '../fs/walk.js';
import { wrapFileContent } from '../security/prompt-injection.js';
import { sanitizeSecrets } from '../security/shell-secrets.js';
import { webFetch, webSearch } from './web.js';
import { todoRead, todoWrite } from './todo.js';
import { task } from './task.js';
import type { ToolExecutor, ToolExecutorMap } from '../types.js';

const MAX_READ_BYTES = 200 * 1024; // 200 KB per read
const MAX_LIST_FILES = 5000;
const MAX_SEARCH_MATCHES = 200;
const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5 MB per write

// Tool argument Zod schemas
const ReadFileArgs = z.object({ path: z.string().min(1) }).strict();
const WriteFileArgs = z.object({ path: z.string().min(1), content: z.string() }).strict();
const ListFilesArgs = z.object({ path: z.string().optional().default('.'), recursive: z.boolean().optional().default(true) }).strict();
const RunShellArgs = z.object({ command: z.string().min(1) }).strict();
const SearchCodeArgs = z.object({
  query: z.string().min(1),
  regex: z.boolean().optional().default(false),
  caseSensitive: z.boolean().optional().default(false),
}).strict();
const TaskCompleteArgs = z.object({ summary: z.string().optional().default('') }).strict();
const EditFileArgs = z.object({
  path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional().default(false),
}).strict();
const GlobArgs = z.object({
  pattern: z.string().min(1),
  path: z.string().optional().default('.'),
}).strict();

const IGNORE_DIRS = ['node_modules', '.git', 'dist', '.cache', '.npm'];

function toRel(sandboxDir: string, abs: string): string {
  return path.relative(sandboxDir, abs).replace(/\\/g, '/');
}

// ── read_file ───────────────────────────────────────────────────────────────
export const readFile: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(ReadFileArgs, args);
  if (!v.ok) return { content: v.error, isError: true };
  const { path: rel } = v.data;
  if (!rel) return { content: 'Error: "path" is required.', isError: true };
  const abs = safeResolve(ctx.sandboxDir, rel);
  if (!fs.existsSync(abs)) return { content: `Error: file not found: ${rel}`, isError: true };
  const stat = fs.statSync(abs);
  if (!stat.isFile()) return { content: `Error: not a file: ${rel}`, isError: true };
  if (stat.size > MAX_READ_BYTES) {
    return { content: `Error: file is ${stat.size} bytes, exceeds max read size of ${MAX_READ_BYTES} bytes.`, isError: true };
  }
  const buf = fs.readFileSync(abs);
  const text = buf.toString('utf8');
  return { content: wrapFileContent(rel, text), isError: false };
};

// ── write_file ──────────────────────────────────────────────────────────────
export const writeFile: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(WriteFileArgs, args);
  if (!v.ok) return { content: v.error, isError: true };
  const { path: rel, content } = v.data;
  if (!rel) return { content: 'Error: "path" is required.', isError: true };
  const byteLen = Buffer.byteLength(content, 'utf8');
  if (byteLen > MAX_WRITE_BYTES) {
    return { content: `Error: content is ${byteLen} bytes, exceeds max write size of ${MAX_WRITE_BYTES} bytes.`, isError: true };
  }
  const abs = safeResolve(ctx.sandboxDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { content: `Wrote ${byteLen} bytes to ${rel}`, isError: false };
};

// ── list_files ──────────────────────────────────────────────────────────────
export const listFiles: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(ListFilesArgs, args);
  if (!v.ok) return { content: v.error, isError: true };
  let rel = v.data.path;
  const recursive = v.data.recursive;
  if (rel === '') rel = '.';
  const abs = safeResolve(ctx.sandboxDir, rel);
  if (!fs.existsSync(abs)) return { content: `Error: directory not found: ${rel}`, isError: true };
  if (!fs.statSync(abs).isDirectory()) return { content: `Error: not a directory: ${rel}`, isError: true };
  const files = walkFiles(abs, { exclude: [...IGNORE_DIRS] })
    .filter((f) => recursive || path.dirname(f) === abs)
    .slice(0, MAX_LIST_FILES)
    .map((f) => toRel(ctx.sandboxDir, f));
  files.sort();
  return { content: files.length ? files.join('\n') : '(empty workspace)', isError: false };
};

// ── run_shell_command ───────────────────────────────────────────────────────
function formatShell(stdout: string, stderr: string, code: number | string | null | undefined, maxBytes: number): string {
  let out = '';
  if (stdout) out += `stdout:\n${stdout}\n`;
  if (stderr) out += `stderr:\n${stderr}\n`;
  if (code !== null && code !== undefined) out += `(exit code: ${code})\n`;
  if (out.length > maxBytes) out = out.slice(0, maxBytes) + `\n…[truncated at ${maxBytes} bytes]`;

  // Sanitize potential secrets in output before returning to agent
  const { sanitized, findings } = sanitizeSecrets(out);
  if (findings.length > 0) {
    return `(note: ${findings.length} potential secret pattern(s) redacted: ${findings.join(', ')})\n${sanitized}`.trimEnd();
  }

  return out.trimEnd();
}

export const runShellCommand: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(RunShellArgs, args);
  if (!v.ok) return { content: v.error, isError: true };
  const { command } = v.data;
  if (!command.trim()) return { content: 'Error: "command" is required.', isError: true };
  if (!isShellCommandAllowed(command, ctx.shellPolicy)) {
    return {
      content: `Error: command rejected by shell policy (contains shell metacharacters). Use a plain command without | ; & $ \` > < ( ) \\ or newlines.`,
      isError: true,
    };
  }

// exec/execFile forward unknown options to spawn at runtime; the published
// ExecOptions/ExecFileOptions types omit `detached`, which we need for
// process-group kills. detached: true puts the child in its own process group
// so the timeout kill (-pgid) reaches the whole tree, not just the direct
// child. The untyped shared object infers compatible with both option types.
const spawnCmd = (): ReturnType<typeof exec> => {
  const common = {
    cwd: ctx.sandboxDir,
    timeout: ctx.shellTimeoutMs,
    maxBuffer: ctx.maxShellOutputBytes,
    env: sandboxEnv(),
    windowsHide: true,
    killSignal: 'SIGKILL' as const,
    detached: true,
  };
  if (ctx.shellPolicy === 'permissive') {
    return exec(command, {
      ...common,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    });
  }
  // Strict mode: use execFile with explicit arg array — no shell injection
  // possible even if the regex missed something.
  const parts = command.trim().split(/\s+/);
  const bin = parts[0]!;
  const binArgs = parts.slice(1);
  return execFile(bin, binArgs, common);
};

  try {
    const proc = spawnCmd();
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(Object.assign(new Error(`exit code ${code}`), { stdout, stderr, code }));
      });
      proc.on('error', reject);
      const timer = setTimeout(() => {
        // Kill entire process tree on timeout — send SIGKILL to process group
        try {
          if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
        } catch { /* already dead */ }
      }, ctx.shellTimeoutMs);
      proc.on('close', () => clearTimeout(timer));
    });
    return { content: formatShell(stdout, stderr, 0, ctx.maxShellOutputBytes), isError: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };

    // Command exceeded the time limit.
    if (e.killed || e.signal === 'SIGTERM') {
      return {
        content: `Error: command timed out after ${ctx.shellTimeoutMs}ms.\n` +
          formatShell(e.stdout ?? '', e.stderr ?? '', null, ctx.maxShellOutputBytes),
        isError: true,
      };
    }

    // Output exceeded maxBuffer — return what we have, it's still useful.
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        content: `(output truncated at ${ctx.maxShellOutputBytes} bytes)\n` +
          formatShell(e.stdout ?? '', e.stderr ?? '', 'maxbuffer', ctx.maxShellOutputBytes),
        isError: false,
      };
    }

    // Binary missing / not executable — the command never ran. Must be an
    // error: reporting a typo'd command as a clean success pollutes the
    // agent's view and the tool success metrics.
    if (e.code === 'ENOENT' || e.code === 'EACCES') {
      return {
        content: `Error: command not found or not executable (${e.code}).\n` +
          formatShell(e.stdout ?? '', e.stderr ?? '', null, ctx.maxShellOutputBytes),
        isError: true,
      };
    }

    // Non-zero exit codes are legitimate results the model should read.
    const code = typeof e.code === 'number' ? e.code : null;
    return {
      content: formatShell(e.stdout ?? '', e.stderr ?? '', code, ctx.maxShellOutputBytes),
      isError: false,
    };
  }
};

// ── search_code ──────────────────────────────────────────────────────────────
const searchCode: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(SearchCodeArgs, args);
  if (!v.ok) return { content: v.error, isError: true };
  const { query, regex: useRegex, caseSensitive } = v.data;
  if (!query) return { content: 'Error: "query" is required.', isError: true };

  let re: RegExp | null = null;
  if (useRegex) {
    // ReDoS guard: limit regex length to prevent catastrophic backtracking
    if (query.length > 500) {
      return { content: 'Error: regular expression is too long (max 500 characters).', isError: true };
    }
    try {
      re = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } catch (e) {
      return { content: `Error: invalid regular expression: ${(e as Error).message}`, isError: true };
    }
  }

  const files = walkFiles(ctx.sandboxDir, { exclude: [...IGNORE_DIRS] }).slice(0, MAX_LIST_FILES);
  const matches: string[] = [];
  const lowerQuery = query.toLowerCase();

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const hit = re
        ? re.test(line)
        : caseSensitive
          ? line.includes(query)
          : line.toLowerCase().includes(lowerQuery);
      if (re) re.lastIndex = 0; // reset for stateful 'g' flag reuse
      if (hit) {
        matches.push(`${toRel(ctx.sandboxDir, file)}:${i + 1}: ${line}`);
        if (matches.length >= MAX_SEARCH_MATCHES) {
          matches.push('…[truncated, too many matches]');
          return { content: matches.join('\n'), isError: false };
        }
      }
    }
  }
  return { content: matches.length ? matches.join('\n') : 'No matches found.', isError: false };
};

// ── edit_file ───────────────────────────────────────────────────────────────
export const editFile: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(EditFileArgs, args);
  if (!v.ok) return { content: v.error, isError: true };
  const { path: rel, old_string: oldStr, new_string: newStr, replace_all: replaceAll } = v.data;
  if (!rel) return { content: 'Error: "path" is required.', isError: true };
  if (oldStr === newStr) return { content: 'Error: old_string and new_string are identical.', isError: true };

  const abs = safeResolve(ctx.sandboxDir, rel);
  if (!fs.existsSync(abs)) return { content: `Error: file not found: ${rel}`, isError: true };
  if (!fs.statSync(abs).isFile()) return { content: `Error: not a file: ${rel}`, isError: true };

  const original = fs.readFileSync(abs, 'utf8');

  if (replaceAll) {
    const count = original.split(oldStr).length - 1;
    if (count === 0) return { content: `Error: old_string not found in ${rel}`, isError: true };
    const modified = original.split(oldStr).join(newStr);
    fs.writeFileSync(abs, modified, 'utf8');
    return { content: `Replaced ${count} occurrence${count > 1 ? 's' : ''} in ${rel}`, isError: false };
  }

  // Single replacement: must appear exactly once
  let idx = 0;
  let matchCount = 0;
  let matchLine = 0;
  let line = 1;
  const lines: number[] = [];

  for (let i = 0; i < original.length; i++) {
    if (original[i] === '\n') line++;
    if (original.slice(i, i + oldStr.length) === oldStr) {
      matchCount++;
      if (matchCount === 1) { idx = i; matchLine = line; }
      lines.push(line);
    }
  }

  if (matchCount === 0) {
    return { content: `Error: old_string not found in ${rel}`, isError: true };
  }
  if (matchCount > 1) {
    return {
      content: `Error: old_string found ${matchCount} times in ${rel} (lines: ${lines.join(', ')}). Use replace_all=true or provide more surrounding context to make it unique.`,
      isError: true,
    };
  }

  const modified = original.slice(0, idx) + newStr + original.slice(idx + oldStr.length);
  fs.writeFileSync(abs, modified, 'utf8');
  return { content: `Replaced 1 occurrence in ${rel} at line ${matchLine}`, isError: false };
};

// ── glob ─────────────────────────────────────────────────────────────────────
const MAX_GLOB_FILES = 5000;
/** Directories always excluded from glob results (mirrors IGNORE_DIRS). */
const GLOB_EXCLUDE_PATTERNS = IGNORE_DIRS.map((name) => `**/${name}/**`);

export const globFiles: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(GlobArgs, args);
  if (!v.ok) return { content: v.error, isError: true };
  const { pattern, path: relPath } = v.data;
  if (!pattern) return { content: 'Error: "pattern" is required.', isError: true };

  let targetDir = relPath;
  if (!targetDir || targetDir === '') targetDir = '.';
  const absDir = safeResolve(ctx.sandboxDir, targetDir);
  if (!fs.existsSync(absDir)) return { content: `Error: directory not found: ${targetDir}`, isError: true };
  if (!fs.statSync(absDir).isDirectory()) return { content: `Error: not a directory: ${targetDir}`, isError: true };

  let rawMatches: string[];
  try {
    rawMatches = fs.globSync(pattern, { cwd: absDir, exclude: GLOB_EXCLUDE_PATTERNS });
  } catch (e) {
    return { content: `Error: invalid glob pattern: ${(e as Error).message}`, isError: true };
  }

  const matches: string[] = [];
  for (const relMatch of rawMatches) {
    const abs = path.resolve(absDir, relMatch);
    // Only regular files (not directories, not symlinks) — matches walkFiles semantics.
    if (!fs.lstatSync(abs).isFile()) continue;
    matches.push(toRel(ctx.sandboxDir, abs));
    if (matches.length >= MAX_GLOB_FILES) {
      matches.push('…[truncated, too many matches]');
      break;
    }
  }
  return { content: matches.length ? matches.join('\n') : 'No files matched.', isError: false };
};

// ── task_complete ─────────────────────────────────────────────────────────────
const taskComplete: ToolExecutor = async (args) => {
  const v = validateArgs(TaskCompleteArgs, args);
  if (!v.ok) return { content: `Error: ${v.error}`, isError: true };
  const { summary } = v.data;
  return { content: `Task marked as complete. ${summary}`.trim(), isError: false };
};

function wrapWithProfile(executor: ToolExecutor, toolName: string): ToolExecutor {
  return async (args, ctx) => {
    // Only enforce if a profile is explicitly set (backward compatible)
    if (ctx.allowedTools && ctx.allowedTools.size > 0 && !ctx.allowedTools.has(toolName)) {
      return {
        content: `Error: tool "${toolName}" is not allowed by execution profile "${ctx.executionProfile ?? 'unknown'}". Allowed tools: ${[...ctx.allowedTools].sort().join(', ')}`,
        isError: true,
      };
    }
    if (toolName === 'web_fetch' || toolName === 'web_search') {
      if (!ctx.webAccess) {
        return {
          content: `Error: ${toolName} requires webAccess to be enabled in the scenario configuration.`,
          isError: true,
        };
      }
    }
    return executor(args, ctx);
  };
}

/** Build the { name -> executor } map. The agent loop passes a fresh ctx per call. */
export function buildToolExecutors(): ToolExecutorMap {
  return {
    read_file: wrapWithProfile(readFile, 'read_file'),
    write_file: wrapWithProfile(writeFile, 'write_file'),
    edit_file: wrapWithProfile(editFile, 'edit_file'),
    list_files: wrapWithProfile(listFiles, 'list_files'),
    glob: wrapWithProfile(globFiles, 'glob'),
    run_shell_command: wrapWithProfile(runShellCommand, 'run_shell_command'),
    search_code: wrapWithProfile(searchCode, 'search_code'),
    web_fetch: wrapWithProfile(webFetch, 'web_fetch'),
    web_search: wrapWithProfile(webSearch, 'web_search'),
    todo_read: wrapWithProfile(todoRead, 'todo_read'),
    todo_write: wrapWithProfile(todoWrite, 'todo_write'),
    task: wrapWithProfile(task, 'task'),
    task_complete: wrapWithProfile(taskComplete, 'task_complete'),
  };
}
