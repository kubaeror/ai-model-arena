import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox, safeResolve, isWithin } from '../../src/sandbox/sandbox.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('Sandbox.ensure creates directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-test-'));
  const sandbox = new Sandbox(dir);
  sandbox.ensure();
  assert.ok(fs.existsSync(dir));
  fs.rmSync(dir, { recursive: true });
});

test('Sandbox.seedFrom copies template files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-test-'));
  const template = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-template-'));
  fs.writeFileSync(path.join(template, 'seed.txt'), 'hello');

  const sandbox = new Sandbox(dir);
  sandbox.ensure();
  sandbox.seedFrom(template);
  assert.ok(fs.existsSync(path.join(dir, 'seed.txt')));
  assert.equal(fs.readFileSync(path.join(dir, 'seed.txt'), 'utf8'), 'hello');

  fs.rmSync(dir, { recursive: true });
  fs.rmSync(template, { recursive: true });
});

test('Sandbox.seedFrom skips missing template dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-test-'));
  const sandbox = new Sandbox(dir);
  sandbox.ensure();
  assert.doesNotThrow(() => sandbox.seedFrom('/nonexistent/path'));
  fs.rmSync(dir, { recursive: true });
});

test('safeResolve rejects empty path', () => {
  assert.throws(() => safeResolve('/tmp', ''), /required/i);
});

test('safeResolve resolves relative path within sandbox', () => {
  const result = safeResolve('/tmp/sandbox', 'sub/file.txt');
  assert.equal(result, path.resolve('/tmp/sandbox/sub/file.txt'));
});

test('safeResolve rejects traversal with ..', () => {
  assert.throws(() => safeResolve('/tmp/sandbox', '../escape.txt'), /escapes/i);
});

test('isWithin returns true for direct descendant', () => {
  assert.ok(isWithin('/tmp/sandbox', '/tmp/sandbox/sub/file.txt'));
});

test('isWithin returns true for root itself', () => {
  assert.ok(isWithin('/tmp/sandbox', '/tmp/sandbox'));
});

test('isWithin returns false for sibling directory', () => {
  assert.ok(!isWithin('/tmp/sandbox', '/tmp/other/file.txt'));
});
