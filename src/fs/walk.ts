import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_EXCLUDE = new Set(['node_modules', '.git']);

export interface WalkOptions {
  /** Also include directory paths (post-order) in the result. */
  dirs?: boolean;
  /** Extra basenames to skip, on top of the default {node_modules, .git}. */
  exclude?: string[];
}

/**
 * Depth-first recursive walk of `root`. Returns absolute paths, SORTED for
 * deterministic output. Does NOT follow symlinks (matches sandbox
 * escape-prevention: a symlinked dir is never descended and a symlinked file is
 * never returned). Skips unreadable directories silently and excludes
 * `node_modules`/`.git` by default.
 */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const exclude = new Set<string>([...DEFAULT_EXCLUDE, ...(opts.exclude ?? [])]);
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (exclude.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        visit(p);
        if (opts.dirs) out.push(p);
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  };
  visit(root);
  out.sort();
  return out;
}
