import fs from 'node:fs';
import path from 'node:path';

/**
 * An isolated workspace directory the agent operates in. Every run gets its own
 * directory (outputs/<model>/<runId>/files) optionally seeded from a scenario
 * template. File tools resolve paths relative to `dir` and reject anything that
 * escapes it.
 */
export class Sandbox {
  constructor(public readonly dir: string) {}

  ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Recursively copy a template directory into the sandbox root (merge). */
  seedFrom(templateDir: string): void {
    if (!templateDir) return;
    if (!fs.existsSync(templateDir)) return;
    const stat = fs.statSync(templateDir);
    if (!stat.isDirectory()) return;
    fs.cpSync(templateDir, this.dir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: true,
    });
  }

  /** Resolve a (relative) path inside the sandbox, throwing on escape. */
  resolvePath(relativePath: string): string {
    return safeResolve(this.dir, relativePath);
  }
}

/**
 * Resolve `relativePath` against `sandboxDir`, enforcing that the final path
 * stays within the sandbox. Relative paths must not traverse above the root.
 */
export function safeResolve(sandboxDir: string, relativePath: string): string {
  if (!relativePath || relativePath.trim() === '') {
    throw new Error('Path is required.');
  }

  // Allow absolute paths only if they already resolve inside the sandbox.
  if (path.isAbsolute(relativePath)) {
    const abs = path.resolve(relativePath);
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    if (isWithin(sandboxDir, real)) return real;
    throw new Error(`Absolute path "${relativePath}" is outside the sandbox.`);
  }

  // Reject Windows drive-relative paths like "C:foo".
  if (/^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`Drive-relative path "${relativePath}" is not allowed; use a relative path.`);
  }

  const target = path.resolve(sandboxDir, relativePath);
  const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
  if (!isWithin(sandboxDir, real)) {
    throw new Error(`Path "${relativePath}" escapes the sandbox.`);
  }
  return real;
}

/** True iff `targetAbs` is `sandboxDir` or a descendant of it. */
export function isWithin(sandboxDir: string, targetAbs: string): boolean {
  const sb = path.resolve(sandboxDir);
  const t = path.resolve(targetAbs);
  if (t === sb) return true;
  const rel = path.relative(sb, t);
  // A path is inside iff the relative path does not start with ".." and is not
  // absolute (which happens when the two are on different Windows roots).
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Sensitive environment variable names/prefixes stripped from sandboxed commands.
 *
 * Matching: `key === prefix` (exact) OR `key.startsWith(prefix)` (prefix).
 * Entries without a trailing `_` act as both exact names AND prefixes — i.e.,
 * OPENAI_API_KEY blocks OPENAI_API_KEY itself and OPENAI_API_KEY_2, etc.
 * ARENA_API_KEY_ (with trailing `_`) blocks ARENA_API_KEY_CI, ARENA_API_KEY_READONLY, etc.
 * DASHBOARD_JWT_SECRET and DASHBOARD_PASSWORD are exact names that also cover
 * any variable starting with those strings.
 *
 * To add a new secret family, append the common prefix here.
 */
const BLOCKED_ENV_PREFIXES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DASHBOARD_JWT_SECRET',
  'DASHBOARD_PASSWORD',
  'ARENA_API_KEY_',
];

/**
 * Returns a copy of process.env with all sensitive credentials stripped.
 * Use this instead of process.env when spawning LLM-controlled subprocesses.
 */
export function sandboxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const blocked = BLOCKED_ENV_PREFIXES.some(
      (prefix) => key === prefix || key.startsWith(prefix),
    );
    if (!blocked) env[key] = value;
  }
  return env;
}
