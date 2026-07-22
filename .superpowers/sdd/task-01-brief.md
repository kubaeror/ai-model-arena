### Task 0.1: Fix sandbox symlink escape (F-002 — CRITICAL)

**Files:**
- Modify: src/sandbox/sandbox.ts:41-63
- Create: tests/sandbox/sandbox.test.ts

**Interfaces:**
- Consumes: safeResolve(sandboxDir, relativePath) — existing function; isWithin(sandboxDir, targetAbs) — existing function
- Produces: No signature change. safeResolve() now calls fs.realpathSync on the resolved path before isWithin() check.

**Steps:**

1. Write the failing test

// tests/sandbox/sandbox.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safeResolve, isWithin } from '../../src/sandbox/sandbox.js';

describe('safeResolve symlink containment', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sandbox-test-'));
  const sandbox = path.join(tmp, 'sandbox');
  const outsideFile = path.join(tmp, 'outside.txt');

  before(() => {
    fs.mkdirSync(sandbox, { recursive: true });
    fs.writeFileSync(outsideFile, 'secret', 'utf8');
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('should reject a symlink that points outside the sandbox', () => {
    const symlinkPath = path.join(sandbox, 'escape-link');
    fs.symlinkSync(path.join(tmp, 'outside.txt'), symlinkPath);

    assert.throws(
      () => safeResolve(sandbox, 'escape-link'),
      /escapes the sandbox/,
    );
  });

  it('should reject a symlink to a directory outside the sandbox', () => {
    const symlinkDir = path.join(sandbox, 'escape-dir');
    fs.symlinkSync(path.join(tmp), symlinkDir, 'dir');

    assert.throws(
      () => safeResolve(sandbox, 'escape-dir/outside.txt'),
      /escapes the sandbox/,
    );
  });

  it('should allow a symlink that stays inside the sandbox', () => {
    const realFile = path.join(sandbox, 'real.txt');
    fs.writeFileSync(realFile, 'safe', 'utf8');
    const goodLink = path.join(sandbox, 'good-link');
    fs.symlinkSync(realFile, goodLink);

    const resolved = safeResolve(sandbox, 'good-link');
    assert.ok(isWithin(sandbox, resolved));
  });
});

2. Run test: npx tsx --test tests/sandbox/sandbox.test.ts — FAIL

3. Modify safeResolve in src/sandbox/sandbox.ts:41-63 to add realpathSync before isWithin:

export function safeResolve(sandboxDir: string, relativePath: string): string {
  if (!relativePath || relativePath.trim() === '') {
    throw new Error('Path is required.');
  }

  if (path.isAbsolute(relativePath)) {
    const abs = path.resolve(relativePath);
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    if (isWithin(sandboxDir, real)) return real;
    throw new Error("Absolute path "" + relativePath + "" is outside the sandbox.");
  }

  if (/^[a-zA-Z]:/.test(relativePath)) {
    throw new Error("Drive-relative path "" + relativePath + "" is not allowed; use a relative path.");
  }

  const target = path.resolve(sandboxDir, relativePath);
  const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
  if (!isWithin(sandboxDir, real)) {
    throw new Error("Path "" + relativePath + "" escapes the sandbox.");
  }
  return real;
}

4. Run test: npx tsx --test tests/sandbox/sandbox.test.ts — PASS

5. Run npm test — all existing tests pass

6. Commit with:
fix: resolve symlinks in safeResolve to prevent sandbox escape (F-002)

safeResolve previously used string-only path comparison via path.resolve
+ isWithin, allowing LLM-created symlinks inside the sandbox to point
outside and bypass all file containment. Added fs.realpathSync call
before isWithin check on both absolute and relative paths.

**Test command:** npm test
**Typecheck:** npm run typecheck
**Lint:** npm run lint
