import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import type { z } from 'zod';
import type { Logger } from './types.js';

/** Replace `$VAR` / `${VAR}` with the value from `process.env` (empty when unset). */
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{?(\w+)\}?/g, (_match, name: string) => {
    const v = process.env[name];
    return v !== undefined ? v : '';
  });
}

function expandDeep(value: unknown): unknown {
  if (typeof value === 'string') return expandEnvVars(value);
  if (Array.isArray(value)) return value.map(expandDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandDeep(v);
    return out;
  }
  return value;
}

export interface LoadYamlConfigOpts<T> {
  filePath: string;
  schema: z.ZodType<T>;
  fallback?: T;
  expandEnv?: boolean;
  cache?: boolean;
  logger?: Logger;
  /** Warning logged through `logger` when the file is missing (path already resolved). */
  missingMessage?: string;
  /** Throw when the file is missing instead of returning the fallback. */
  throwOnMissing?: boolean;
}

let cache = new Map<string, unknown>();

export function clearConfigCache(): void {
  cache = new Map();
}

export function loadYamlConfigSync<T>(opts: LoadYamlConfigOpts<T>): T {
  const resolved = path.resolve(opts.filePath);
  if (opts.cache && cache.has(resolved)) return cache.get(resolved) as T;
  let result: T;
  // codeql[js/path-injection] Callers derive filePath from operator-controlled
  // CLI/env config, or validate user input at the HTTP boundary (scenarios
  // route: strict name regex + isWithin check) before reaching this loader.
  if (!fs.existsSync(resolved)) {
    if (opts.throwOnMissing || opts.fallback === undefined) {
      throw new Error(`Config file not found: ${opts.filePath}`);
    }
    opts.logger?.warn(opts.missingMessage ?? `Config not found at ${resolved}, using defaults`);
    result = opts.fallback;
  } else {
    // codeql[js/path-injection] See existsSync suppression above: every caller
    // passes an operator-controlled path or a pre-validated one.
    const content = fs.readFileSync(resolved, 'utf8');
    const parsed = load(content);
    const expanded = opts.expandEnv ? expandDeep(parsed) : parsed;
    result = opts.schema.parse(expanded);
  }
  if (opts.cache) cache.set(resolved, result);
  return result;
}

export function loadYamlConfig<T>(opts: LoadYamlConfigOpts<T>): Promise<T> {
  return Promise.resolve(loadYamlConfigSync(opts));
}
