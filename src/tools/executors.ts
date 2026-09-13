import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { z } from 'zod/v4';
import { validateArgs } from './util.js';
import { safeResolve, sandboxEnv, assertSafeWriteTarget, isWithin } from '../sandbox/sandbox.js';
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
const SEARCH_REGEX_BUDGET_MS = 2000;
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
  try {
    assertSafeWriteTarget(abs);
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true };
  }
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
      let outputBytes = 0;
      let maxBufferExceeded = false;
      let timedOut = false;

      const killGroup = (): void => {
        try {
          if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
        } catch { /* already dead */ }
      };

      const collect = (chunk: Buffer, toStderr: boolean): void => {
        if (maxBufferExceeded) return;
        outputBytes += chunk.length;
        if (outputBytes > ctx.maxShellOutputBytes) {
          // Stop accumulating and kill the tree: Node's own maxBuffer kill is
          // indistinguishable from a timeout at the ChildProcess level, so the
          // byte counter is the source of truth for the maxBuffer branch.
          maxBufferExceeded = true;
          killGroup();
          return;
        }
        if (toStderr) stderr += chunk.toString();
        else stdout += chunk.toString();
      };

      proc.stdout?.on('data', (d: Buffer) => collect(d, false));
      proc.stderr?.on('data', (d: Buffer) => collect(d, true));

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, ctx.shellTimeoutMs);

      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        if (maxBufferExceeded) {
          reject(Object.assign(new Error('output exceeded maxBuffer'), {
            stdout, stderr, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', signal,
          }));
        } else if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(Object.assign(new Error(`exit code ${code}`), {
            stdout, stderr, code, signal,
            // `proc.killed` is only set by Node's own kill (timeout / maxBuffer);
            // `timedOut` covers our process-group kill.
            killed: proc.killed === true || timedOut || signal === 'SIGKILL',
          }));
        }
      });
      proc.on('error', reject);
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

    // Output exceeded maxBuffer — return what we have, it's still useful.
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        content: `(output truncated at ${ctx.maxShellOutputBytes} bytes)\n` +
          formatShell(e.stdout ?? '', e.stderr ?? '', 'maxbuffer', ctx.maxShellOutputBytes),
        isError: false,
      };
    }

    // Command exceeded the time limit.
    if (e.killed || e.signal === 'SIGTERM') {
      return {
        content: `Error: command timed out after ${ctx.shellTimeoutMs}ms.\n` +
          formatShell(e.stdout ?? '', e.stderr ?? '', null, ctx.maxShellOutputBytes),
        isError: true,
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

// Regex matching is synchronous, so the between-lines budget cannot interrupt a
// single catastrophic match; this shallow syntactic analysis is a best-effort
// bound, not a proof. It tracks quantifiers and alternations per group, trusts
// only alternation branches whose first characters are provably disjoint, and
// rejects large nullable/variable-length repeats. Anything it cannot prove is
// treated as ambiguous, so the failure mode is a false rejection, never a hang.

type CharRange = readonly [number, number];
type CharSet = readonly CharRange[];

const DIGIT_SET: CharSet = [[0x30, 0x39]];
const WORD_SET: CharSet = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
const SPACE_SET: CharSet = [
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680],
  [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f],
  [0x3000, 0x3000], [0xfeff, 0xfeff],
];

function complementCharSet(ranges: CharSet): CharSet {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: CharRange[] = [];
  let next = 0;
  for (const [lo, hi] of sorted) {
    if (lo > next) out.push([next, lo - 1]);
    next = Math.max(next, hi + 1);
  }
  if (next <= 0xffff) out.push([next, 0xffff]);
  return out;
}

const ESCAPE_SETS: Record<string, CharSet> = {
  d: DIGIT_SET,
  D: complementCharSet(DIGIT_SET),
  w: WORD_SET,
  W: complementCharSet(WORD_SET),
  s: SPACE_SET,
  S: complementCharSet(SPACE_SET),
  n: [[0x0a, 0x0a]],
  r: [[0x0d, 0x0d]],
  t: [[0x09, 0x09]],
  f: [[0x0c, 0x0c]],
  v: [[0x0b, 0x0b]],
};

function singleCharSet(code: number): CharSet {
  return [[code, code]];
}

/** Resolve the escape at `index` (a backslash) to the characters it can start a match with, or null when not understood. */
function parseEscapeSet(pattern: string, index: number): { set: CharSet | null; end: number } {
  const at = index + 1;
  const ch = pattern[at];
  if (ch === undefined) return { set: null, end: at };
  const known = ESCAPE_SETS[ch];
  if (known) return { set: known, end: at };
  if (ch === 'x') {
    const hex = pattern.slice(at + 1, at + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) return { set: singleCharSet(parseInt(hex, 16)), end: at + 2 };
    return { set: null, end: at };
  }
  if (ch === 'u') {
    // Only the fixed-width form; without the u flag `\u{...}` is not a code-point escape.
    const hex = pattern.slice(at + 1, at + 5);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) return { set: singleCharSet(parseInt(hex, 16)), end: at + 4 };
    return { set: null, end: at };
  }
  if (/[A-Za-z0-9]/.test(ch)) return { set: null, end: at };
  return { set: singleCharSet(ch.charCodeAt(0)), end: at };
}

interface ClassAtom {
  single: number | null;
  set: CharSet | null;
  end: number;
}

function parseClassAtom(pattern: string, index: number): ClassAtom {
  const ch = pattern[index]!;
  if (ch !== '\\') {
    const code = ch.charCodeAt(0);
    return { single: code, set: singleCharSet(code), end: index };
  }
  const esc = parseEscapeSet(pattern, index);
  const first = esc.set?.[0];
  const single = esc.set && esc.set.length === 1 && first !== undefined && first[0] === first[1] ? first[0] : null;
  return { single, set: esc.set, end: esc.end };
}

/** Parse the character class at `start` (a `[`); null set means it was not understood. */
function parseCharClass(pattern: string, start: number): { set: CharSet | null; end: number } {
  let i = start + 1;
  let negated = false;
  if (pattern[i] === '^') {
    negated = true;
    i += 1;
  }
  if (pattern[i] === ']') {
    // JS closes `[]`/`[^]` here (unlike POSIX, where a leading `]` is literal):
    // `[]` never matches and `[^]` matches any code unit.
    return { set: negated ? complementCharSet([]) : [], end: i };
  }
  const ranges: CharRange[] = [];
  let understood = true;
  while (i < pattern.length && pattern[i] !== ']') {
    const a = parseClassAtom(pattern, i);
    const next = a.end + 1;
    if (a.single !== null && pattern[next] === '-' && next + 1 < pattern.length && pattern[next + 1] !== ']') {
      const b = parseClassAtom(pattern, next + 1);
      if (b.single === null) understood = false;
      else ranges.push([a.single, b.single]);
      i = b.end + 1;
      continue;
    }
    if (a.set) ranges.push(...a.set);
    else understood = false;
    i = next;
  }
  if (!understood) return { set: null, end: i };
  return { set: negated ? complementCharSet(ranges) : ranges, end: i };
}

function charSetsDisjoint(a: CharSet, b: CharSet): boolean {
  return !a.some(([a0, a1]) => b.some(([b0, b1]) => a0 <= b1 && b0 <= a1));
}

function branchFirstSetsDisjoint(sets: CharSet[]): boolean {
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      if (!charSetsDisjoint(sets[i]!, sets[j]!)) return false;
    }
  }
  return true;
}

function unionCharSets(a: CharSet | null, b: CharSet | null): CharSet | null {
  if (a === null || b === null) return null;
  return [...a, ...b];
}

const foldedCharSetCache = new WeakMap<CharSet, CharSet>();
const foldedCodePointCache = new Map<number, CharSet>();

function addCaseVariants(points: Set<number>, code: number): void {
  points.add(code);
  const ch = String.fromCharCode(code);
  const lower = ch.toLowerCase();
  const upper = ch.toUpperCase();
  if (lower.length === 1) points.add(lower.charCodeAt(0));
  if (upper.length === 1) points.add(upper.charCodeAt(0));
}

function pointsToRanges(points: Set<number>): CharSet {
  const out: [number, number][] = [];
  for (const code of [...points].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] + 1 === code) last[1] = code;
    else out.push([code, code]);
  }
  return out;
}

/** Case-fold a set the way `/i` matches: every code point plus its single-code-unit lower/upper variants. */
function foldCharSet(set: CharSet): CharSet {
  const cached = foldedCharSetCache.get(set);
  if (cached) return cached;
  const single = set.length === 1 && set[0]![0] === set[0]![1] ? set[0]![0] : -1;
  const cachedSingle = single >= 0 ? foldedCodePointCache.get(single) : undefined;
  if (cachedSingle) return cachedSingle;

  let span = 0;
  for (const [lo, hi] of set) span += hi - lo + 1;
  let folded: CharSet;
  if (span <= 4096) {
    const points = new Set<number>();
    for (const [lo, hi] of set) {
      for (let code = lo; code <= hi; code++) addCaseVariants(points, code);
    }
    folded = pointsToRanges(points);
  } else {
    const present = new Uint8Array(0x10000);
    for (const [lo, hi] of set) {
      for (let code = lo; code <= hi; code++) present[code] = 1;
    }
    for (let code = 0; code <= 0xffff; code++) {
      if (!present[code]) continue;
      const ch = String.fromCharCode(code);
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      if (lower.length === 1) present[lower.charCodeAt(0)] = 1;
      if (upper.length === 1) present[upper.charCodeAt(0)] = 1;
    }
    const ranges: [number, number][] = [];
    let runStart = -1;
    for (let code = 0; code <= 0xffff; code++) {
      if (present[code]) {
        if (runStart === -1) runStart = code;
      } else if (runStart !== -1) {
        ranges.push([runStart, code - 1]);
        runStart = -1;
      }
    }
    if (runStart !== -1) ranges.push([runStart, 0xffff]);
    folded = ranges;
  }
  foldedCharSetCache.set(set, folded);
  if (single >= 0) foldedCodePointCache.set(single, folded);
  return folded;
}

interface RegexGroupState {
  start: number;
  hasUnboundedQuantifier: boolean;
  hasAmbiguousAlternation: boolean;
  hasVariableRepeat: boolean;
  hasAmbiguousSequence: boolean;
  first: CharSet | null;
  nullable: boolean;
  branchFirst: CharSet | null | undefined; // undefined = the current branch has no atom yet
  branchNullable: boolean;
  branchFirsts: (CharSet | null)[];
  branchNullables: boolean[];
  sawAlternation: boolean;
  nullableRun: number;
  nullableRunStart: number;
}

function newGroupState(start: number): RegexGroupState {
  return {
    start,
    hasUnboundedQuantifier: false,
    hasAmbiguousAlternation: false,
    hasVariableRepeat: false,
    hasAmbiguousSequence: false,
    first: null,
    nullable: true,
    branchFirst: undefined,
    branchNullable: true,
    branchFirsts: [],
    branchNullables: [],
    sawAlternation: false,
    nullableRun: 0,
    nullableRunStart: start,
  };
}

interface RegexShapeFinding {
  kind: 'nested-quantifier' | 'ambiguous-alternation' | 'ambiguous-repeat';
  construct: string;
}

interface RegexQuantifier {
  end: number;
  min: number;
  max: number | null; // null = unbounded
}

/** Parse a quantifier at `index`; null means no quantifier (e.g. a literal `{`). */
function quantifierAt(pattern: string, index: number): RegexQuantifier | null {
  const ch = pattern[index];
  if (ch === '*') return { end: index, min: 0, max: null };
  if (ch === '+') return { end: index, min: 1, max: null };
  if (ch === '?') return { end: index, min: 0, max: 1 };
  if (ch !== '{') return null;
  const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
  if (!match) return null;
  const end = index + match[0].length - 1;
  const min = Number(match[1]);
  if (match[2] === undefined) return { end, min, max: min };
  const digits = match[3];
  if (digits === undefined || digits === '') return { end, min, max: null };
  return { end, min, max: Number(digits) };
}

/** End of an atom's quantifier, including a trailing laziness modifier (`*?`, `{2,3}?`). */
function quantifierEnd(pattern: string, quantifier: RegexQuantifier | null, fallback: number): number {
  if (!quantifier) return fallback;
  return pattern[quantifier.end + 1] === '?' ? quantifier.end + 1 : quantifier.end;
}

/**
 * Find the first quantified group that can backtrack exponentially: a nested
 * unbounded quantifier (`(a+)+`), a variable-length inner repeat (`(a{2,3})+`,
 * `(a{2,3}){35}`), a nullable body under a large bounded repeat (`(a?){35}`),
 * an ambiguous nullable sequence (`(a?b?)+`), or an ambiguous alternation,
 * including one hidden behind wrapper groups (`((a|aa))+`). Ambiguous
 * alternations are rejected under any outer quantifier with max >= 2; nullable
 * bodies and variable-length inner repeats only at max >= 8, so IPv4's
 * `([0-9]{1,3}\.){3}` stays usable. Fixed-length inner repeats (`(a{2}){35}`)
 * are permitted: they consume an exact number of characters per iteration.
 * Alternations whose branches start with provably disjoint characters after
 * case folding (`(foo|bar)+`) are permitted. A long run of nullable atoms
 * followed by a required atom (`a?a?…a?b`) is also rejected, since every
 * required atom leaves exponentially many ways to split the run. Anything the
 * analysis cannot prove stays ambiguous, so the failure mode is a false
 * rejection. Shapes the syntactic scanner cannot analyze (e.g. exotic
 * backreference use) remain best-effort; the between-lines budget in searchCode
 * bounds them.
 */

/** Bounded outer repeats below this max run too few iterations to explode. */
const BOUNDED_OUTER_REPEAT_MAX = 8;

function findCatastrophicRegexShape(pattern: string, caseSensitive: boolean): RegexShapeFinding | null {
  const stack: RegexGroupState[] = [newGroupState(0)];

  const fold = (set: CharSet | null): CharSet | null =>
    set !== null && !caseSensitive ? foldCharSet(set) : set;

  // Branch first sets only grow through atoms while everything before them can
  // match empty; that is what makes `(a?b|b)+` collide on `b`. A nullable prefix
  // followed by a nullable or overlapping atom (`(a?b?)+`, `(a?a)+`) also
  // leaves the repeat boundary ambiguous.
  const applyAtom = (group: RegexGroupState, first: CharSet | null, nullable: boolean, at: number): RegexShapeFinding | null => {
    if (nullable) {
      if (group.nullableRun === 0) group.nullableRunStart = at;
      group.nullableRun++;
    } else {
      // Eight or more optional atoms before a mandatory one is the `a?…a?b`
      // shape: matching a mandatory atom requires splitting an ambiguous run.
      if (group.nullableRun >= 8) {
        return {
          kind: 'ambiguous-repeat',
          construct: pattern.slice(group.nullableRunStart, at + 1),
        };
      }
      group.nullableRun = 0;
    }
    if (group.branchFirst === undefined) {
      group.branchFirst = first;
    } else if (group.branchNullable) {
      if (
        nullable ||
        group.branchFirst === null ||
        first === null ||
        !charSetsDisjoint(group.branchFirst, first)
      ) {
        group.hasAmbiguousSequence = true;
      }
      group.branchFirst = unionCharSets(group.branchFirst, first);
    }
    group.branchNullable = group.branchNullable && nullable;
    return null;
  };

  const noteQuantifier = (group: RegexGroupState, q: RegexQuantifier | null): void => {
    if (!q) return;
    if (q.max === null) group.hasUnboundedQuantifier = true;
    // Only a variable-length bounded repeat (`{1,3}`, `{2,3}`) makes the group
    // ambiguous when it is repeated: a fixed `{2}` consumes an exact number of
    // characters per iteration under any outer quantifier.
    else if (q.max >= 2 && q.min !== q.max) group.hasVariableRepeat = true;
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const current = stack[stack.length - 1]!;

    if (ch === '\\') {
      const esc = parseEscapeSet(pattern, i);
      const q = quantifierAt(pattern, esc.end + 1);
      noteQuantifier(current, q);
      const escShape = applyAtom(current, fold(esc.set), q !== null && q.min === 0, i);
      if (escShape) return escShape;
      i = quantifierEnd(pattern, q, esc.end);
      continue;
    }
    if (ch === '[') {
      const cls = parseCharClass(pattern, i);
      const q = quantifierAt(pattern, cls.end + 1);
      noteQuantifier(current, q);
      const clsShape = applyAtom(current, fold(cls.set), q !== null && q.min === 0, i);
      if (clsShape) return clsShape;
      i = quantifierEnd(pattern, q, cls.end);
      continue;
    }
    if (ch === '(') {
      let content = i + 1;
      if (pattern[content] === '?') {
        if (pattern[content + 1] === '<' && (pattern[content + 2] === '=' || pattern[content + 2] === '!')) {
          content += 3; // lookbehind
        } else if (pattern[content + 1] === '<') {
          const close = pattern.indexOf('>', content + 2);
          content = close === -1 ? content + 2 : close + 1; // named capture
        } else {
          content += 2; // (?: (?= (?!
        }
      }
      stack.push(newGroupState(i));
      i = content - 1;
      continue;
    }
    if (ch === ')') {
      const group = stack.pop()!;
      const parent = stack[stack.length - 1]!;
      group.branchFirsts.push(group.branchFirst ?? null);
      group.branchNullables.push(group.branchNullable);
      group.nullable = group.sawAlternation
        ? group.branchNullables.some(Boolean)
        : group.branchNullable;
      if (group.sawAlternation) {
        const branches = group.branchFirsts;
        const disjoint = branches.every((b) => b !== null) && branchFirstSetsDisjoint(branches as CharSet[]);
        group.hasAmbiguousAlternation = !disjoint;
        group.first = disjoint ? branches.flat() : null;
      } else {
        group.first = group.branchFirsts[0] ?? null;
      }

      const q = quantifierAt(pattern, i + 1);
      // An unbounded outer quantifier composes any repeated inner shape
      // exponentially. A bounded outer only does so at a large max: a nullable
      // body or a variable-length inner repeat needs many iterations before the
      // split count explodes, while small counts (IPv4's `(...){3}`) stay
      // cheap. Fixed-length inner repeats (`(a{2}){35}`) are linear either way.
      if (q && (q.max === null || q.max >= 2)) {
        if (group.hasUnboundedQuantifier) {
          return { kind: 'nested-quantifier', construct: pattern.slice(group.start, q.end + 1) };
        }
        if (group.hasAmbiguousAlternation) {
          return { kind: 'ambiguous-alternation', construct: pattern.slice(group.start, q.end + 1) };
        }
        if (q.max === null || q.max >= BOUNDED_OUTER_REPEAT_MAX) {
          if (group.hasVariableRepeat) {
            return { kind: 'nested-quantifier', construct: pattern.slice(group.start, q.end + 1) };
          }
          if (q.max !== null && group.nullable) {
            return { kind: 'ambiguous-repeat', construct: pattern.slice(group.start, q.end + 1) };
          }
        }
        if (group.hasAmbiguousSequence) {
          return { kind: 'ambiguous-repeat', construct: pattern.slice(group.start, q.end + 1) };
        }
      }

      if (q && q.max !== null && q.max >= 2 && q.min !== q.max) parent.hasVariableRepeat = true;
      if (q && q.max === null) parent.hasUnboundedQuantifier = true;
      else parent.hasUnboundedQuantifier ||= group.hasUnboundedQuantifier;
      parent.hasAmbiguousAlternation ||= group.hasAmbiguousAlternation;
      parent.hasVariableRepeat ||= group.hasVariableRepeat;
      parent.hasAmbiguousSequence ||= group.hasAmbiguousSequence;
      const groupShape = applyAtom(parent, group.first, group.nullable || (q !== null && q.min === 0), group.start);
      if (groupShape) return groupShape;
      i = quantifierEnd(pattern, q, i);
      continue;
    }
    if (ch === '|') {
      current.branchFirsts.push(current.branchFirst ?? null);
      current.branchNullables.push(current.branchNullable);
      current.branchFirst = undefined;
      current.branchNullable = true;
      current.sawAlternation = true;
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      const stray = quantifierAt(pattern, i);
      if (stray) {
        if (stray.max === null) current.hasUnboundedQuantifier = true;
        i = stray.end;
        continue;
      }
    }
    const q = quantifierAt(pattern, i + 1);
    noteQuantifier(current, q);
    if (ch === '.' || ch === '^' || ch === '$') {
      // Wildcards and anchors cannot prove a disjoint first character.
      const charShape = applyAtom(current, null, ch === '^' || ch === '$' || (q !== null && q.min === 0), i);
      if (charShape) return charShape;
    } else {
      const charShape = applyAtom(current, fold(singleCharSet(ch!.charCodeAt(0))), q !== null && q.min === 0, i);
      if (charShape) return charShape;
    }
    i = quantifierEnd(pattern, q, i);
  }
  return null;
}

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
    const shape = findCatastrophicRegexShape(query, caseSensitive);
    if (shape) {
      const offending = shape.kind === 'nested-quantifier'
        ? `nested quantifier in \`${shape.construct}\``
        : shape.kind === 'ambiguous-alternation'
          ? `ambiguous alternation in \`${shape.construct}\``
          : `ambiguous nullable repetition in \`${shape.construct}\``;
      return {
        content: `Error: regular expression rejected: ${offending} can cause catastrophic backtracking. Rewrite branches so each starts with a distinct character (e.g. \`(foo|bar)+\`) and avoid repeating a quantified group.`,
        isError: true,
      };
    }
  }

  const files = walkFiles(ctx.sandboxDir, { exclude: [...IGNORE_DIRS] }).slice(0, MAX_LIST_FILES);
  const matches: string[] = [];
  const lowerQuery = query.toLowerCase();
  const startedAt = Date.now();

  for (const file of files) {
    if (re && Date.now() - startedAt > SEARCH_REGEX_BUDGET_MS) {
      return {
        content: `Error: regex search exceeded the ${SEARCH_REGEX_BUDGET_MS}ms budget; narrow the pattern or search a smaller directory.`,
        isError: true,
      };
    }
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re && Date.now() - startedAt > SEARCH_REGEX_BUDGET_MS) {
        return {
          content: `Error: regex search exceeded the ${SEARCH_REGEX_BUDGET_MS}ms budget; narrow the pattern or search a smaller directory.`,
          isError: true,
        };
      }
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
  try {
    assertSafeWriteTarget(abs);
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true };
  }

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

/**
 * Patterns fs.globSync would resolve against the host filesystem instead of the
 * sandbox cwd: absolute paths, `..` segments, and `~` home-relative forms.
 */
function escapesSandboxGlob(pattern: string): boolean {
  if (path.isAbsolute(pattern) || pattern.startsWith('~')) return true;
  return pattern.split(/[\\/]/).some((segment) => segment === '..');
}

export const globFiles: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(GlobArgs, args);
  if (!v.ok) return { content: v.error, isError: true };
  const { pattern, path: relPath } = v.data;
  if (!pattern) return { content: 'Error: "pattern" is required.', isError: true };
  if (escapesSandboxGlob(pattern)) {
    return { content: 'Error: glob pattern must be relative and must not traverse outside the sandbox.', isError: true };
  }

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
    const candidate = path.resolve(absDir, relMatch);
    let abs: string;
    try {
      abs = safeResolve(ctx.sandboxDir, candidate);
    } catch {
      // Match resolves outside the sandbox (e.g. via a symlinked directory).
      continue;
    }
    if (!isWithin(ctx.sandboxDir, abs)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    // Only regular files (not directories, not symlinks) — matches walkFiles semantics.
    if (!stat.isFile()) continue;
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
