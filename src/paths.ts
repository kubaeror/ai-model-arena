import fs from 'node:fs';
import path from 'node:path';

/**
 * Locate the project root by walking up from this module's directory until a
 * `package.json` is found. This is robust to whether the code is run from
 * `dist/` (built) or `src/` (tsx dev) and to nesting depth
 * (e.g. `dist/orchestrator/orchestrator.js` is two levels under root).
 */
export function findProjectRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
