import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { z } from 'zod/v4';
import { safeResolve, sandboxEnv } from '../sandbox/sandbox.js';
import { isShellCommandAllowed } from '../sandbox/shell-policy.js';
import { wrapFileContent } from '../security/prompt-injection.js';
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

function validateArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(args);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: `Invalid arguments: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
}

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

  const spawnCmd = (): ReturnType<typeof exec> => {
    if (ctx.shellPolicy === 'permissive') {
      return exec(command, {
        cwd: ctx.sandboxDir,
        timeout: ctx.shellTimeoutMs,
        maxBuffer: ctx.maxShellOutputBytes,
        env: sandboxEnv(),
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        windowsHide: true,
        killSignal: 'SIGKILL',
      });
    }
    // Strict mode: use execFile with explicit arg array — no shell injection
    // possible even if the regex missed something.
    const parts = command.trim().split(/\s+/);
    const bin = parts[0]!;
    const binArgs = parts.slice(1);
    return execFile(bin, binArgs, {
      cwd: ctx.sandboxDir,
      timeout: ctx.shellTimeoutMs,
      maxBuffer: ctx.maxShellOutputBytes,
      env: sandboxEnv(),
      windowsHide: true,
      killSignal: 'SIGKILL',
    });
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
  const v = validateArgs(TaskCompleteArgs, args);
  if (!v.ok) return { content: `Error: ${v.error}`, isError: true };
  const { summary } = v.data;
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
