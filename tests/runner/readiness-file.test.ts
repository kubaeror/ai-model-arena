import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markReady, unmarkReady } from '../../src/runner.js';

test('markReady writes a regular file with content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ready-'));
  try {
    const f = path.join(dir, 'ready');
    markReady(f);
    assert.ok(fs.existsSync(f));
    assert.ok(!fs.lstatSync(f).isSymbolicLink(), 'readiness file must be a regular file');
    assert.ok(fs.statSync(f).size > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markReady does not follow a pre-existing symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ready-'));
  try {
    const target = path.join(dir, 'victim');
    fs.writeFileSync(target, 'sentinel');
    const link = path.join(dir, 'ready');
    fs.symlinkSync(target, link);
    markReady(link);
    assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel', 'symlink target must never be written through');
    assert.ok(!fs.lstatSync(link).isSymbolicLink(), 'link path must be replaced with a regular file');
    assert.ok(fs.readFileSync(link, 'utf8').length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unmarkReady removes the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ready-'));
  try {
    const f = path.join(dir, 'ready');
    markReady(f);
    unmarkReady(f);
    assert.ok(!fs.existsSync(f));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
