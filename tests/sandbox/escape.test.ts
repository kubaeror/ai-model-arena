import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { safeResolve, isWithin } from '../../src/sandbox/sandbox.js';

test('rejects .. traversal', () => {
  assert.throws(() => safeResolve('/sandbox', '../../etc/passwd'));
});

test('rejects absolute path outside sandbox', () => {
  assert.throws(() => safeResolve('/sandbox', '/etc/passwd'));
});

test('allows absolute path inside sandbox', () => {
  const p = safeResolve('/sandbox', '/sandbox/sub/file.txt');
  assert.ok(p.includes('sub'));
});

test('rejects drive-relative path', () => {
  assert.throws(() => safeResolve('/sandbox', 'C:foo'));
});

test('isWithin true for descendant', () => {
  assert.equal(isWithin('/sandbox', '/sandbox/a/b'), true);
});

test('isWithin false for sibling', () => {
  assert.equal(isWithin('/sandbox', '/other'), false);
});

test('isWithin false for parent', () => {
  assert.equal(isWithin('/sandbox/a', '/sandbox'), false);
});

// ── Symlink escape hardening ─────────────────────────────────────────────
test('blocks symlink escape via ancestor directory', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-escape-'));
  const sandbox = path.join(base, 'sandbox');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'classified');

  // Create a symlink inside the sandbox pointing outside
  fs.symlinkSync(outside, path.join(sandbox, 'escape-link'), 'dir');

  // Attempting to resolve through the symlink to an existing file should block
  assert.throws(() => safeResolve(sandbox, 'escape-link/secret.txt'), /escape/i);

  // Cleanup
  fs.rmSync(base, { recursive: true });
});

test('blocks symlink escape for non-existent path under symlinked ancestor', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-escape2-'));
  const sandbox = path.join(base, 'sandbox');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  // Symlink inside sandbox → outside
  fs.symlinkSync(outside, path.join(sandbox, 'escape-link'), 'dir');

  // Non-existent file under the symlinked directory should also be blocked
  assert.throws(() => safeResolve(sandbox, 'escape-link/new-file.txt'), /escape/i);

  fs.rmSync(base, { recursive: true });
});

test('allows symlink that stays inside sandbox', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-escape3-'));
  const sandbox = path.join(base, 'sandbox');
  const subdir = path.join(sandbox, 'sub');
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, 'safe.txt'), 'hello');

  // Symlink inside sandbox → another location inside sandbox
  fs.symlinkSync(subdir, path.join(sandbox, 'safe-link'), 'dir');

  const resolved = safeResolve(sandbox, 'safe-link/safe.txt');
  assert.ok(resolved.endsWith('safe.txt'), 'should resolve safe symlink');
  assert.match(resolved, /sandbox/);

  fs.rmSync(base, { recursive: true });
});
