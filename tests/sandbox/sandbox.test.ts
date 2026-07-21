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
