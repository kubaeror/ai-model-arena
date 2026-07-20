import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { safeResolve, sandboxEnv } from '../sandbox/sandbox.js';
import type { ToolExecutor, ToolExecutorMap } from '../types.js';

const execAsync = promisify(exec);

const MAX_READ_BYTES = 200 * 1024; // 200 KB per read
const MAX_LIST_FILES = 5000;
const MAX_SEARCH_MATCHES = 200;

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '.npm']);

function walkFiles(dir: string, recursive: boolean, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) walkFiles(full, recursive, acc);
    } else if (e.isFile()) {
      acc.push(full);
      if (acc.length >= MAX_LIST_FILES) break;
    }
  }
  return acc;
}

function toRel(sandboxDir: string, abs: string): string {
  return path.relative(sandboxDir, abs).replace(/\\/g, '/');
}

function fmtBool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

// ── read_file ───────────────────────────────────────────────────────────────
export const readFile: ToolExecutor = async (args, ctx) => {
  const rel = String(args.path ?? '');
  if (!rel) return { content: 'Error: "path" is required.', isError: true };
  const abs = safeResolve(ctx.sandboxDir, rel);
  if (!fs.existsSync(abs)) return { content: `Error: file not found: ${rel}`, isError: true };
  const stat = fs.statSync(abs);
  if (!stat.isFile()) return { content: `Error: not a file: ${rel}`, isError: true };
  const buf = fs.readFileSync(abs);
  let text = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
  if (buf.length > MAX_READ_BYTES) text += `\n…[truncated, file is ${buf.length} bytes]`;
  return { content: text, isError: false };
};

// ── write_file ──────────────────────────────────────────────────────────────
export const writeFile: ToolExecutor = async (args, ctx) => {
  const rel = String(args.path ?? '');
  if (!rel) return { content: 'Error: "path" is required.', isError: true };
  const content = String(args.content ?? '');
  const abs = safeResolve(ctx.sandboxDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { content: `Wrote ${Buffer.byteLength(content)} bytes to ${rel}`, isError: false };
};

// ── list_files ──────────────────────────────────────────────────────────────
export const listFiles: ToolExecutor = async (args, ctx) => {
  let rel = String(args.path ?? '.');
  if (rel === '') rel = '.';
  const recursive = fmtBool(args.recursive, true);
  const abs = safeResolve(ctx.sandboxDir, rel);
  if (!fs.existsSync(abs)) return { content: `Error: directory not found: ${rel}`, isError: true };
  if (!fs.statSync(abs).isDirectory()) return { content: `Error: not a directory: ${rel}`, isError: true };
  const files = walkFiles(abs, recursive).map((f) => toRel(ctx.sandboxDir, f));
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
  return out.trimEnd();
}

export const runShellCommand: ToolExecutor = async (args, ctx) => {
  const command = String(args.command ?? '');
  if (!command.trim()) return { content: 'Error: "command" is required.', isError: true };

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: ctx.sandboxDir,
      timeout: ctx.shellTimeoutMs,
      maxBuffer: ctx.maxShellOutputBytes,
      env: sandboxEnv(),
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
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

    // Non-zero exit codes are legitimate results the model should read.
    const code = typeof e.code === 'number' ? e.code : null;
    return {
      content: formatShell(e.stdout ?? '', e.stderr ?? '', code, ctx.maxShellOutputBytes),
      isError: false,
    };
  }
};

// ── search_code ──────────────────────────────────────────────────────────────
export const searchCode: ToolExecutor = async (args, ctx) => {
  const query = String(args.query ?? '');
  if (!query) return { content: 'Error: "query" is required.', isError: true };
  const useRegex = fmtBool(args.regex, false);
  const caseSensitive = fmtBool(args.caseSensitive, false);

  let re: RegExp | null = null;
  if (useRegex) {
    try {
      re = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } catch (e) {
      return { content: `Error: invalid regular expression: ${(e as Error).message}`, isError: true };
    }
  }

  const files = walkFiles(ctx.sandboxDir, true);
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

// ── task_complete ─────────────────────────────────────────────────────────────
export const taskComplete: ToolExecutor = async (args) => {
  const summary = String(args.summary ?? '');
  return { content: `Task marked as complete. ${summary}`.trim(), isError: false };
};

/** Build the { name -> executor } map. The agent loop passes a fresh ctx per call. */
export function buildToolExecutors(): ToolExecutorMap {
  return {
    read_file: readFile,
    write_file: writeFile,
    list_files: listFiles,
    run_shell_command: runShellCommand,
    search_code: searchCode,
    task_complete: taskComplete,
  };
}
