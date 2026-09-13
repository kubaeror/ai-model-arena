import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { safeResolve, isWithin, assertSafeWriteTarget } from '../../src/sandbox/sandbox.js';

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

// ── Hardlink write containment ───────────────────────────────────────────
// safeResolve cannot detect hardlinks: a link inside the sandbox to an inode
// outside it is a regular file with nlink > 1. write_file/edit_file must
// reject such targets or a write truncates the shared inode.

test('assertSafeWriteTarget allows a brand-new file', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hl-new-'));
  try {
    assert.doesNotThrow(() => assertSafeWriteTarget(path.join(base, 'new.txt')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('assertSafeWriteTarget allows an existing single-link file', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hl-single-'));
  try {
    const file = path.join(base, 'single.txt');
    fs.writeFileSync(file, 'ok');
    assert.doesNotThrow(() => assertSafeWriteTarget(file));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('assertSafeWriteTarget rejects an existing hardlinked file', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hl-multi-'));
  try {
    const original = path.join(base, 'original.txt');
    const alias = path.join(base, 'alias.txt');
    fs.writeFileSync(original, 'shared inode');
    fs.linkSync(original, alias);
    assert.throws(() => assertSafeWriteTarget(alias), /hardlink/i);
    assert.throws(() => assertSafeWriteTarget(original), /hardlink/i);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── FIFO / special-file write containment ────────────────────────────────
// A model can create a FIFO inside the sandbox. Opening it O_WRONLY blocks
// the event loop until a reader appears, so the guard must open non-blocking
// (ENXIO when there is no reader) and reject non-regular inodes via fstat.

const SANDBOX_MODULE_URL = new URL('../../src/sandbox/sandbox.ts', import.meta.url).href;

/** Run assertSafeWriteTarget on `absPath` in a child process so a blocking
 *  open cannot hang the test runner; a blocked child is killed by the timeout. */
function runWriteTargetInChild(absPath: string) {
  const code = `import(${JSON.stringify(SANDBOX_MODULE_URL)}).then((m) => {
    try { m.assertSafeWriteTarget(process.argv[1]); console.log('OPENED_OK'); process.exit(1); }
    catch (err) { console.log('REJECTED:' + err.message); process.exit(0); }
  });`;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, absPath], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
  });
}

test('assertSafeWriteTarget rejects a reader-less FIFO without blocking', { skip: process.platform === 'win32' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-fifo-noreader-'));
  const fifo = path.join(base, 'pipe');
  try {
    execFileSync('mkfifo', [fifo]);
    const result = runWriteTargetInChild(fifo);
    assert.equal(result.error, undefined, `guard must not block waiting for a FIFO reader: ${(result.error as NodeJS.ErrnoException | undefined)?.code ?? ''}`);
    assert.equal(result.status, 0, `guard must reject the FIFO, got status ${result.status}`);
    assert.match(result.stdout, /REJECTED/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('assertSafeWriteTarget rejects a FIFO even when a reader is present', { skip: process.platform === 'win32' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-fifo-reader-'));
  const fifo = path.join(base, 'pipe');
  try {
    execFileSync('mkfifo', [fifo]);
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      assert.throws(() => assertSafeWriteTarget(fifo), /non-regular|FIFO/i);
    } finally {
      fs.closeSync(readerFd);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
